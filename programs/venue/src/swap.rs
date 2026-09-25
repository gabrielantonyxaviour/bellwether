//! Swap: credential → halt and heartbeat → activation and pause → share budget →
//! constant product with fee and slippage → transfer_checked CPIs → counters → tape event.

use {
    crate::{error::E, gate, rules, state::*, util::*},
    pinocchio::{cpi::Seed, error::ProgramError, AccountView, Address, ProgramResult},
};

pub const BUY: u8 = 0; // USDC in, stock out
pub const SELL: u8 = 1; // stock in, USDC out

/// Tape event, emitted once per swap through sol_log_data as a single 228-byte slice.
pub const EVENT_LEN: usize = 228;
const EVENT_TAG: &[u8; 8] = b"BWTRADE1";

/// direction u8 | amount_in u64 | min_out u64
pub fn swap(program_id: &Address, accounts: &mut [AccountView], p: &[u8]) -> ProgramResult {
    let [trader, venue, symbol, pool, stock_mint, usdc_mint, stock_vault, usdc_vault, user_stock, user_usdc, cred, stock_tp, usdc_tp, ..] = accounts
    else {
        return Err(ProgramError::NotEnoughAccountKeys);
    };
    if p.len() < 17 {
        return Err(ProgramError::InvalidInstructionData);
    }
    let (dir, amount_in, min_out) = (get(p, 0), rd(p, 1), rd(p, 9));
    if dir > SELL || amount_in == 0 {
        return Err(E::InvalidAmount.into());
    }
    signer(trader)?;
    let m = market(program_id, venue, symbol, pool, stock_mint, usdc_mint, stock_vault, usdc_vault, stock_tp, usdc_tp)?;
    own_accounts(trader, user_stock, user_usdc)?;
    let now = now()?;
    let v = load(venue, program_id, VENUE, VENUE_LEN)?;
    let s = load(symbol, program_id, SYMBOL, SYMBOL_LEN)?;
    gate::admit(program_id, venue.address(), v, cred, trader.address(), now)?;
    rules::check_swap(v, s, now)?;

    // Reserves are the vaults' live balances (an issuer's permanent delegate can move them).
    let (rs, ru) = (token_amount(stock_vault), token_amount(usdc_vault));
    if rs == 0 || ru == 0 {
        return Err(E::InvalidAmount.into());
    }
    let (r_in, r_out) = if dir == BUY { (ru, rs) } else { (rs, ru) };
    let fee = mul_div_ceil(amount_in, m.fee_bps as u64, 10_000)?;
    let net = amount_in - fee;
    let out = mul_div(net, r_out, r_in.checked_add(net).ok_or(E::InvalidAmount)?)?;
    let stock_leg = if dir == BUY { out } else { amount_in };
    let fill = rules::budget(v, s, now, stock_leg)?;
    if out == 0 {
        return Err(E::InvalidAmount.into());
    }
    if out < min_out {
        return Err(E::SlippageExceeded.into());
    }

    let symbol_key = *symbol.address().as_array();
    let b = [m.bump];
    let seeds = [Seed::from(b"pool"), Seed::from(&symbol_key), Seed::from(&b)];
    if dir == BUY {
        transfer(user_usdc, usdc_mint, usdc_vault, trader, amount_in, m.usdc_dec, usdc_tp, &[])?;
        transfer(stock_vault, stock_mint, user_stock, pool, out, m.stock_dec, stock_tp, &seeds)?;
    } else {
        transfer(user_stock, stock_mint, stock_vault, trader, amount_in, m.stock_dec, stock_tp, &[])?;
        transfer(usdc_vault, usdc_mint, user_usdc, pool, out, m.usdc_dec, usdc_tp, &seeds)?;
    }

    let (ns, nu) = if dir == BUY { (rs - out, ru + amount_in) } else { (rs + amount_in, ru - out) };
    let d = data_mut(pool);
    wr(d, P_RES_STOCK, ns);
    wr(d, P_RES_USDC, nu);
    rules::record_fill(data_mut(symbol), &fill);

    let (stock_amt, usdc_amt) = if dir == BUY { (out, amount_in) } else { (amount_in, out) };
    let mut e = [0u8; EVENT_LEN];
    put_bytes(&mut e, 0, EVENT_TAG);
    put_bytes(&mut e, 8, unsafe { symbol.borrow_unchecked().get_unchecked(S_TICKER..S_TICKER + 8) });
    set_key(&mut e, 16, stock_mint.address());
    set_key(&mut e, 48, usdc_mint.address());
    set_key(&mut e, 80, pool.address());
    set_key(&mut e, 112, program_id);
    put(&mut e, 144, dir);
    put(&mut e, 145, m.stock_dec);
    put(&mut e, 146, m.usdc_dec);
    wr(&mut e, 148, stock_amt);
    wr(&mut e, 156, usdc_amt);
    // Price: USDC base units per one whole stock token (saturating; decimals ≤ 18).
    let price = div_wide(usdc_amt as u128 * 10u64.pow(m.stock_dec as u32) as u128, stock_amt).map_or(u64::MAX, |(q, _)| q);
    wr(&mut e, 164, price);
    wri(&mut e, 172, now);
    wr(&mut e, 180, fill.shares);
    wri(&mut e, 188, fill.trade_date);
    wr(&mut e, 196, fill.traded);
    wr(&mut e, 204, ns);
    wr(&mut e, 212, nu);
    wr(&mut e, 220, fee);
    emit(&e);
    Ok(())
}

#[inline(always)]
fn emit(event: &[u8]) {
    #[cfg(target_os = "solana")]
    unsafe {
        let parts: [&[u8]; 1] = [event];
        pinocchio::syscalls::sol_log_data(parts.as_ptr() as *const u8, 1);
    }
    #[cfg(not(target_os = "solana"))]
    let _ = event;
}

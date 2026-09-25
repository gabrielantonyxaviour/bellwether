//! Liquidity: admitted wallets deposit both legs pro rata for an internal, non-transferable
//! LpPosition, and withdraw proportionally (also while halted or paused).

use {
    crate::{error::E, gate, rules, state::*, util::*},
    pinocchio::{cpi::Seed, error::ProgramError, AccountView, Address, ProgramResult},
};

/// Shares locked forever by the first deposit so the share price cannot be inflated.
pub const MIN_LIQUIDITY: u64 = 1_000;

/// stock_max u64 | usdc_max u64 | min_lp u64
pub fn add(program_id: &Address, accounts: &mut [AccountView], p: &[u8]) -> ProgramResult {
    let [owner, venue, symbol, pool, position, stock_mint, usdc_mint, stock_vault, usdc_vault, user_stock, user_usdc, cred, stock_tp, usdc_tp, ..] =
        accounts
    else {
        return Err(ProgramError::NotEnoughAccountKeys);
    };
    if p.len() < 24 {
        return Err(ProgramError::InvalidInstructionData);
    }
    let (stock_max, usdc_max, min_lp) = (rd(p, 0), rd(p, 8), rd(p, 16));
    signer(owner)?;
    let m = market(program_id, venue, symbol, pool, stock_mint, usdc_mint, stock_vault, usdc_vault, stock_tp, usdc_tp)?;
    own_accounts(owner, user_stock, user_usdc)?;
    let now = now()?;
    let v = load(venue, program_id, VENUE, VENUE_LEN)?;
    gate::admit(program_id, venue.address(), v, cred, owner.address(), now)?;
    rules::check_deposit(v, load(symbol, program_id, SYMBOL, SYMBOL_LEN)?, now)?;

    let total = rd(load(pool, program_id, POOL, POOL_LEN)?, P_LP_TOTAL);
    let (rs, ru) = (token_amount(stock_vault), token_amount(usdc_vault));
    let (minted, credited, s_in, u_in) = if total == 0 {
        let lp = isqrt(stock_max as u128 * usdc_max as u128);
        if lp <= MIN_LIQUIDITY {
            return Err(E::InvalidAmount.into());
        }
        (lp, lp - MIN_LIQUIDITY, stock_max, usdc_max)
    } else {
        let lp = mul_div(stock_max, total, rs)?.min(mul_div(usdc_max, total, ru)?);
        (lp, lp, mul_div_ceil(lp, rs, total)?, mul_div_ceil(lp, ru, total)?)
    };
    if credited == 0 {
        return Err(E::InvalidAmount.into());
    }
    if credited < min_lp {
        return Err(E::SlippageExceeded.into());
    }

    if position.owned_by(program_id) {
        let d = load(position, program_id, LP, LP_LEN)?;
        if !key_eq(d, L_POOL, pool.address()) || !key_eq(d, L_OWNER, owner.address()) {
            return Err(E::InvalidAccount.into());
        }
    } else {
        let bump = expect_pda(position, &[b"lp", pool.address().as_ref(), owner.address().as_ref()], program_id)?;
        let b = [bump];
        let seeds = [Seed::from(b"lp"), Seed::from(pool.address().as_ref()), Seed::from(owner.address().as_ref()), Seed::from(&b)];
        create_pda(owner, position, program_id, LP_LEN, &seeds)?;
        let d = data_mut(position);
        put(d, 0, LP);
        put(d, 1, bump);
        set_key(d, L_POOL, pool.address());
        set_key(d, L_OWNER, owner.address());
    }

    transfer(user_stock, stock_mint, stock_vault, owner, s_in, m.stock_dec, stock_tp, &[])?;
    transfer(user_usdc, usdc_mint, usdc_vault, owner, u_in, m.usdc_dec, usdc_tp, &[])?;

    let d = data_mut(position);
    wr(d, L_SHARES, rd(d, L_SHARES).checked_add(credited).ok_or(E::InvalidAmount)?);
    let d = data_mut(pool);
    wr(d, P_LP_TOTAL, total.checked_add(minted).ok_or(E::InvalidAmount)?);
    wr(d, P_RES_STOCK, rs + s_in);
    wr(d, P_RES_USDC, ru + u_in);
    Ok(())
}

/// lp u64 | min_stock u64 | min_usdc u64
pub fn remove(program_id: &Address, accounts: &mut [AccountView], p: &[u8]) -> ProgramResult {
    let [owner, venue, symbol, pool, position, stock_mint, usdc_mint, stock_vault, usdc_vault, user_stock, user_usdc, cred, stock_tp, usdc_tp, ..] =
        accounts
    else {
        return Err(ProgramError::NotEnoughAccountKeys);
    };
    if p.len() < 24 {
        return Err(ProgramError::InvalidInstructionData);
    }
    let (lp, min_stock, min_usdc) = (rd(p, 0), rd(p, 8), rd(p, 16));
    signer(owner)?;
    let m = market(program_id, venue, symbol, pool, stock_mint, usdc_mint, stock_vault, usdc_vault, stock_tp, usdc_tp)?;
    own_accounts(owner, user_stock, user_usdc)?;
    let now = now()?;
    let v = load(venue, program_id, VENUE, VENUE_LEN)?;
    gate::admit(program_id, venue.address(), v, cred, owner.address(), now)?;

    let d = load(position, program_id, LP, LP_LEN)?;
    if !key_eq(d, L_POOL, pool.address()) || !key_eq(d, L_OWNER, owner.address()) {
        return Err(E::InvalidAccount.into());
    }
    let owned = rd(d, L_SHARES);
    if lp == 0 {
        return Err(E::InvalidAmount.into());
    }
    if lp > owned {
        return Err(E::InsufficientShares.into());
    }
    let total = rd(load(pool, program_id, POOL, POOL_LEN)?, P_LP_TOTAL);
    let (rs, ru) = (token_amount(stock_vault), token_amount(usdc_vault));
    let (out_s, out_u) = (mul_div(lp, rs, total)?, mul_div(lp, ru, total)?);
    if out_s < min_stock || out_u < min_usdc {
        return Err(E::SlippageExceeded.into());
    }

    let symbol_key = *symbol.address().as_array();
    let b = [m.bump];
    let seeds = [Seed::from(b"pool"), Seed::from(&symbol_key), Seed::from(&b)];
    transfer(stock_vault, stock_mint, user_stock, pool, out_s, m.stock_dec, stock_tp, &seeds)?;
    transfer(usdc_vault, usdc_mint, user_usdc, pool, out_u, m.usdc_dec, usdc_tp, &seeds)?;

    wr(data_mut(position), L_SHARES, owned - lp);
    let d = data_mut(pool);
    wr(d, P_LP_TOTAL, total - lp);
    wr(d, P_RES_STOCK, rs - out_s);
    wr(d, P_RES_USDC, ru - out_u);
    Ok(())
}

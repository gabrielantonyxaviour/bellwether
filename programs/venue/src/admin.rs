//! Venue setup: config, symbols, pools and the fallback membership credential.

use {
    crate::{error::E, rules, state::*, util::*},
    pinocchio::{cpi::Seed, error::ProgramError, AccountView, Address, ProgramResult},
};

/// Payload shared by init_venue and update_venue:
/// gate u8 | heartbeat_max_age i64 | trade_date_cutoff i64 |
/// relay | data_authority | credential_issuer | sas_credential | sas_schema | affiliate_group.
const CONFIG_LEN: usize = 17 + 6 * 32;

fn write_config(d: &mut [u8], p: &[u8]) -> ProgramResult {
    if p.len() < CONFIG_LEN {
        return Err(ProgramError::InvalidInstructionData);
    }
    let (gate, hb, cutoff) = (get(p, 0), rdi(p, 1), rdi(p, 9));
    if gate == 0 || gate > 3 || hb <= 0 || !(0..86_400).contains(&cutoff) {
        return Err(E::InvalidArgument.into());
    }
    put(d, V_GATE, gate);
    wri(d, V_HB_MAX, hb);
    wri(d, V_CUTOFF, cutoff);
    put_bytes(d, V_RELAY, unsafe { p.get_unchecked(17..CONFIG_LEN) });
    Ok(())
}

pub fn init_venue(program_id: &Address, accounts: &mut [AccountView], p: &[u8]) -> ProgramResult {
    let [admin, venue, ..] = accounts else { return Err(ProgramError::NotEnoughAccountKeys) };
    signer(admin)?;
    if p.len() < CONFIG_LEN {
        return Err(ProgramError::InvalidInstructionData);
    }
    let bump = expect_pda(venue, &[b"venue", admin.address().as_ref()], program_id)?;
    let b = [bump];
    create_pda(admin, venue, program_id, VENUE_LEN, &[Seed::from(b"venue"), Seed::from(admin.address().as_ref()), Seed::from(&b)])?;
    let d = data_mut(venue);
    put(d, 0, VENUE);
    put(d, 1, bump);
    set_key(d, V_ADMIN, admin.address());
    write_config(d, p)
}

pub fn update_venue(program_id: &Address, accounts: &mut [AccountView], p: &[u8]) -> ProgramResult {
    let [admin, venue, ..] = accounts else { return Err(ProgramError::NotEnoughAccountKeys) };
    authorized(program_id, admin, venue, V_ADMIN)?;
    write_config(data_mut(venue), p)
}

/// tier u8 (1 | 2) | issuer_sponsored u8 | ticker [u8; 8]
pub fn register_symbol(program_id: &Address, accounts: &mut [AccountView], p: &[u8]) -> ProgramResult {
    let [admin, venue, symbol, mint, ..] = accounts else { return Err(ProgramError::NotEnoughAccountKeys) };
    authorized(program_id, admin, venue, V_ADMIN)?;
    if p.len() < 10 {
        return Err(ProgramError::InvalidInstructionData);
    }
    let (tier, sponsored) = (get(p, 0), get(p, 1));
    if !(1..=2).contains(&tier) || sponsored > 1 {
        return Err(E::InvalidArgument.into());
    }
    // The stock is an initialized Token-2022 mint (82-byte base, is_initialized at 45).
    if !mint.owned_by(&TOKEN_2022) || mint.data_len() < 82 || get(unsafe { mint.borrow_unchecked() }, 45) != 1 {
        return Err(E::InvalidAccount.into());
    }
    let bump = expect_pda(symbol, &[b"symbol", venue.address().as_ref(), mint.address().as_ref()], program_id)?;
    rules::on_register(data_mut(venue), tier)?;
    let b = [bump];
    let seeds = [Seed::from(b"symbol"), Seed::from(venue.address().as_ref()), Seed::from(mint.address().as_ref()), Seed::from(&b)];
    create_pda(admin, symbol, program_id, SYMBOL_LEN, &seeds)?;
    let d = data_mut(symbol);
    put(d, 0, SYMBOL);
    put(d, 1, bump);
    put(d, S_TIER, tier);
    put(d, S_SPONSORED, sponsored);
    put_bytes(d, S_TICKER, unsafe { p.get_unchecked(2..10) });
    set_key(d, S_VENUE, venue.address());
    set_key(d, S_MINT, mint.address());
    // Share units per token unit start at 1/1 until the data authority says otherwise.
    put(d, S_MULT_NUM, 1);
    put(d, S_MULT_DEN, 1);
    Ok(())
}

/// A vault is a token account of `mint` under `program`, owned by the pool PDA, with no
/// delegate and no close authority.
fn vault_ok(vault: &AccountView, mint: &AccountView, pool: &Address, program: &Address) -> bool {
    if !vault.owned_by(program) || vault.data_len() < 165 {
        return false;
    }
    let d = unsafe { vault.borrow_unchecked() };
    key_eq(d, 0, mint.address()) && key_eq(d, 32, pool) && rd32(d, 72) == 0 && rd32(d, 129) == 0
}

/// fee_bps u16
pub fn init_pool(program_id: &Address, accounts: &mut [AccountView], p: &[u8]) -> ProgramResult {
    let [admin, venue, symbol, pool, stock_mint, usdc_mint, stock_vault, usdc_vault, ..] = accounts else {
        return Err(ProgramError::NotEnoughAccountKeys);
    };
    authorized(program_id, admin, venue, V_ADMIN)?;
    if p.len() < 2 {
        return Err(ProgramError::InvalidInstructionData);
    }
    let s = load(symbol, program_id, SYMBOL, SYMBOL_LEN)?;
    let bump = expect_pda(pool, &[b"pool", symbol.address().as_ref()], program_id)?;
    if !key_eq(s, S_VENUE, venue.address())
        || !key_eq(s, S_MINT, stock_mint.address())
        || !usdc_mint.owned_by(&SPL_TOKEN)
        || usdc_mint.data_len() < 82
        || !vault_ok(stock_vault, stock_mint, pool.address(), &TOKEN_2022)
        || !vault_ok(usdc_vault, usdc_mint, pool.address(), &SPL_TOKEN)
    {
        return Err(E::InvalidAccount.into());
    }
    let fee = rd16(p, 0);
    let stock_dec = get(unsafe { stock_mint.borrow_unchecked() }, 44);
    let usdc_dec = get(unsafe { usdc_mint.borrow_unchecked() }, 44);
    if fee >= 10_000 || stock_dec > 18 || usdc_dec > 18 {
        return Err(E::InvalidArgument.into());
    }
    let b = [bump];
    create_pda(admin, pool, program_id, POOL_LEN, &[Seed::from(b"pool"), Seed::from(symbol.address().as_ref()), Seed::from(&b)])?;
    let d = data_mut(pool);
    put(d, 0, POOL);
    put(d, 1, bump);
    put(d, P_STOCK_DEC, stock_dec);
    put(d, P_USDC_DEC, usdc_dec);
    wr16(d, P_FEE, fee);
    set_key(d, P_SYMBOL, symbol.address());
    set_key(d, P_STOCK_MINT, stock_mint.address());
    set_key(d, P_USDC_MINT, usdc_mint.address());
    set_key(d, P_STOCK_VAULT, stock_vault.address());
    set_key(d, P_USDC_VAULT, usdc_vault.address());
    Ok(())
}

/// expires_at i64. Creates or renews the wallet's membership PDA.
pub fn grant_member(program_id: &Address, accounts: &mut [AccountView], p: &[u8]) -> ProgramResult {
    let [issuer, venue, member, wallet, ..] = accounts else { return Err(ProgramError::NotEnoughAccountKeys) };
    authorized(program_id, issuer, venue, V_ISSUER)?;
    if p.len() < 8 {
        return Err(ProgramError::InvalidInstructionData);
    }
    if !member.owned_by(program_id) {
        let bump = expect_pda(member, &[b"member", venue.address().as_ref(), wallet.address().as_ref()], program_id)?;
        let b = [bump];
        let seeds = [Seed::from(b"member"), Seed::from(venue.address().as_ref()), Seed::from(wallet.address().as_ref()), Seed::from(&b)];
        create_pda(issuer, member, program_id, MEMBER_LEN, &seeds)?;
        let d = data_mut(member);
        put(d, 0, MEMBER);
        put(d, 1, bump);
        set_key(d, M_VENUE, venue.address());
        set_key(d, M_WALLET, wallet.address());
    }
    let d = load(member, program_id, MEMBER, MEMBER_LEN)?;
    if !key_eq(d, M_VENUE, venue.address()) || !key_eq(d, M_WALLET, wallet.address()) {
        return Err(E::InvalidAccount.into());
    }
    wri(data_mut(member), M_EXPIRES, rdi(p, 0));
    Ok(())
}

/// Closes the membership PDA; its rent returns to the issuer.
pub fn revoke_member(program_id: &Address, accounts: &mut [AccountView], _p: &[u8]) -> ProgramResult {
    let [issuer, venue, member, ..] = accounts else { return Err(ProgramError::NotEnoughAccountKeys) };
    authorized(program_id, issuer, venue, V_ISSUER)?;
    let d = load(member, program_id, MEMBER, MEMBER_LEN)?;
    if !key_eq(d, M_VENUE, venue.address()) {
        return Err(E::InvalidAccount.into());
    }
    issuer.set_lamports(issuer.lamports() + member.lamports());
    member.set_lamports(0);
    member.close()
}

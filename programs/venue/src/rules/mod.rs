//! The venue rulebook seam. Core calls these hooks from register_symbol, add_liquidity and
//! swap; rules instructions (discriminators 16..=23) are dispatched here.
//! This is the core block's minimal version: only the setters a market needs to open.

use {
    crate::{error::E, state::*, util::*},
    pinocchio::{error::ProgramError, AccountView, Address, ProgramResult},
};

pub fn process(disc: u8, program_id: &Address, accounts: &mut [AccountView], p: &[u8]) -> ProgramResult {
    match disc {
        16 => set_cap(program_id, accounts, p),
        19 => heartbeat(program_id, accounts, p),
        23 => activate_pool(program_id, accounts, p),
        _ => Err(ProgramError::InvalidInstructionData),
    }
}

/// Accounts [authority (signer), venue, symbol (w)]; the authority is the venue key at `field`.
fn symbol_as<'a>(program_id: &Address, accounts: &'a mut [AccountView], field: usize) -> Result<&'a mut AccountView, ProgramError> {
    let [who, venue, symbol, ..] = accounts else { return Err(ProgramError::NotEnoughAccountKeys) };
    authorized(program_id, who, venue, field)?;
    let s = load(symbol, program_id, SYMBOL, SYMBOL_LEN)?;
    if !key_eq(s, S_VENUE, venue.address()) {
        return Err(E::InvalidAccount.into());
    }
    Ok(symbol)
}

/// cap_shares u64 | adv_shares u64 | mult_num u32 | mult_den u32 (data authority)
fn set_cap(program_id: &Address, accounts: &mut [AccountView], p: &[u8]) -> ProgramResult {
    let symbol = symbol_as(program_id, accounts, V_DATA)?;
    if p.len() < 24 {
        return Err(ProgramError::InvalidInstructionData);
    }
    if rd32(p, 16) == 0 || rd32(p, 20) == 0 {
        return Err(E::InvalidArgument.into());
    }
    let d = data_mut(symbol);
    wr(d, S_CAP, rd(p, 0));
    wr(d, S_ADV, rd(p, 8));
    put_bytes(d, S_MULT_NUM, unsafe { p.get_unchecked(16..24) });
    Ok(())
}

/// seq u64 (relay authority). Sequence must increase: a delayed relay message cannot rewind.
fn heartbeat(program_id: &Address, accounts: &mut [AccountView], p: &[u8]) -> ProgramResult {
    let symbol = symbol_as(program_id, accounts, V_RELAY)?;
    if p.len() < 8 {
        return Err(ProgramError::InvalidInstructionData);
    }
    let d = data_mut(symbol);
    let seq = rd(p, 0);
    if seq <= rd(d, S_SEQ) {
        return Err(E::StaleSequence.into());
    }
    wr(d, S_SEQ, seq);
    wri(d, S_HEARTBEAT, now()?);
    Ok(())
}

/// Makes the symbol available for trading (admin).
fn activate_pool(program_id: &Address, accounts: &mut [AccountView], _p: &[u8]) -> ProgramResult {
    let symbol = symbol_as(program_id, accounts, V_ADMIN)?;
    put(data_mut(symbol), S_ACTIVE, 1);
    Ok(())
}

pub fn on_register(venue: &mut [u8], tier: u8) -> ProgramResult {
    let at = if tier == 1 { V_TIER1 } else { V_TIER2 };
    wr16(venue, at, rd16(venue, at) + 1);
    Ok(())
}

pub fn check_swap(_venue: &[u8], _symbol: &[u8], _now: i64) -> ProgramResult {
    Ok(())
}

pub fn check_deposit(_venue: &[u8], _symbol: &[u8], _now: i64) -> ProgramResult {
    Ok(())
}

/// A swap's effect on the symbol's daily share counter.
pub struct Fill {
    pub trade_date: i64,
    pub traded: u64,
    pub shares: u64,
}

pub fn budget(_venue: &[u8], symbol: &[u8], _now: i64, stock_amount: u64) -> Result<Fill, ProgramError> {
    Ok(Fill { trade_date: rdi(symbol, S_TRADE_DATE), traded: rd(symbol, S_TRADED) + stock_amount, shares: stock_amount })
}

pub fn record_fill(symbol: &mut [u8], f: &Fill) {
    wri(symbol, S_TRADE_DATE, f.trade_date);
    wr(symbol, S_TRADED, f.traded);
}

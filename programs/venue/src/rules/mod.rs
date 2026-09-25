//! The venue rulebook. Core calls these hooks from register_symbol, add_liquidity and swap;
//! rules instructions (discriminators 16..=23) are dispatched here.
//!
//! Swap order: halt state and heartbeat freshness (fail closed) → activation → breach pause
//! → daily share budget. Deposits face the halt, heartbeat and pause checks; withdrawals face
//! none of them.

mod caps;
mod halts;
mod notices;

pub use caps::{budget, record_fill};
use {
    crate::{error::E, state::*, util::*},
    pinocchio::{error::ProgramError, AccountView, Address, ProgramResult},
};

/// Symbols per tier across the venue (the affiliate group). No grace: refused at registration.
pub const TIER1_MAX: u16 = 75;
pub const TIER2_MAX: u16 = 250;

pub fn process(disc: u8, program_id: &Address, accounts: &mut [AccountView], p: &[u8]) -> ProgramResult {
    match disc {
        16 => caps::set_cap(symbol_as(program_id, accounts, V_DATA)?, p),
        17 => halts::set_halt(symbol_as(program_id, accounts, V_RELAY)?, p),
        18 => halts::clear_halt(symbol_as(program_id, accounts, V_RELAY)?, p),
        19 => halts::heartbeat(symbol_as(program_id, accounts, V_RELAY)?, p),
        20 => caps::record_breach(symbol_as(program_id, accounts, V_DATA)?, p),
        21 => notices::record_issuer_notice(symbol_as(program_id, accounts, V_ADMIN)?, p),
        22 => notices::record_objection(symbol_as(program_id, accounts, V_ADMIN)?),
        23 => notices::activate_pool(symbol_as(program_id, accounts, V_ADMIN)?),
        _ => Err(ProgramError::InvalidInstructionData),
    }
}

/// Accounts [authority (signer), venue, symbol (w)]; the authority is the venue key at
/// `field`. Returns the symbol's data for writing.
#[inline(never)]
fn symbol_as<'a>(program_id: &Address, accounts: &'a mut [AccountView], field: usize) -> Result<&'a mut [u8], ProgramError> {
    let [who, venue, symbol, ..] = accounts else { return Err(ProgramError::NotEnoughAccountKeys) };
    authorized(program_id, who, venue, field)?;
    let s = load(symbol, program_id, SYMBOL, SYMBOL_LEN)?;
    if !key_eq(s, S_VENUE, venue.address()) {
        return Err(E::InvalidAccount.into());
    }
    Ok(data_mut(symbol))
}

/// Symbol-count cap per tier, checked before the new symbol exists.
pub fn on_register(venue: &mut [u8], tier: u8) -> ProgramResult {
    let (at, max) = if tier == 1 { (V_TIER1, TIER1_MAX) } else { (V_TIER2, TIER2_MAX) };
    let n = rd16(venue, at);
    if n >= max {
        return Err(E::SymbolCapReached.into());
    }
    wr16(venue, at, n + 1);
    Ok(())
}

/// Paused after a second (or later) recorded volume breach, until paused_until.
fn not_paused(symbol: &[u8], now: i64) -> ProgramResult {
    if now < rdi(symbol, S_PAUSED_UNTIL) {
        return Err(E::Paused.into());
    }
    Ok(())
}

pub fn check_swap(venue: &[u8], symbol: &[u8], now: i64) -> ProgramResult {
    halts::live(venue, symbol, now)?;
    if get(symbol, S_ACTIVE) == 0 {
        return Err(E::NotActive.into());
    }
    not_paused(symbol, now)
}

/// Deposits need a live, unpaused symbol but may precede activation (seeding a new pool).
pub fn check_deposit(venue: &[u8], symbol: &[u8], now: i64) -> ProgramResult {
    halts::live(venue, symbol, now)?;
    not_paused(symbol, now)
}

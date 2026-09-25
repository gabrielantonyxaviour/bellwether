//! Exchange-synced halts. The relay authority mirrors the primary listing exchange's halt
//! state per symbol and heartbeats it; stale or unknown status fails closed.
//! Every relay message carries a strictly increasing sequence, so a delayed or replayed
//! message can never rewind the state.

use {
    crate::{error::E, state::*, util::now},
    pinocchio::{error::ProgramError, ProgramResult},
};

/// Halted → TradingHalted; now − last_heartbeat > heartbeat_max_age → HaltDataStale.
pub fn live(venue: &[u8], symbol: &[u8], now: i64) -> ProgramResult {
    if get(symbol, S_HALTED) != 0 {
        return Err(E::TradingHalted.into());
    }
    if now.saturating_sub(rdi(symbol, S_HEARTBEAT)) > rdi(venue, V_HB_MAX) {
        return Err(E::HaltDataStale.into());
    }
    Ok(())
}

/// Accepts `seq` if it is newer than the last relay message, and stamps the heartbeat.
fn accept(symbol: &mut [u8], p: &[u8], len: usize) -> ProgramResult {
    if p.len() < len {
        return Err(ProgramError::InvalidInstructionData);
    }
    let seq = rd(p, 0);
    if seq <= rd(symbol, S_SEQ) {
        return Err(E::StaleSequence.into());
    }
    wr(symbol, S_SEQ, seq);
    wri(symbol, S_HEARTBEAT, now()?);
    Ok(())
}

/// seq u64 | reason [u8; 8] (Nasdaq code, e.g. "T1", "LUDP") | feed_ts i64 (halt instant)
pub fn set_halt(symbol: &mut [u8], p: &[u8]) -> ProgramResult {
    accept(symbol, p, 24)?;
    put(symbol, S_HALTED, 1);
    put_bytes(symbol, S_HALT_REASON, unsafe { p.get_unchecked(8..16) });
    wri(symbol, S_HALTED_AT, rdi(p, 16));
    Ok(())
}

/// seq u64. Lifting the halt is itself a fresh heartbeat.
pub fn clear_halt(symbol: &mut [u8], p: &[u8]) -> ProgramResult {
    accept(symbol, p, 8)?;
    put(symbol, S_HALTED, 0);
    put_bytes(symbol, S_HALT_REASON, &[0; 8]);
    wri(symbol, S_HALTED_AT, 0);
    Ok(())
}

/// seq u64
pub fn heartbeat(symbol: &mut [u8], p: &[u8]) -> ProgramResult {
    accept(symbol, p, 8)
}

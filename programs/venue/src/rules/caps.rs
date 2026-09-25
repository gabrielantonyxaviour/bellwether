//! Share-volume caps and the breach ledger.
//!
//! Each symbol has a per-trade-date share budget (tier % × prior-month consolidated ADV, set by
//! the data authority), enforced as a hard stop — stricter than the order's average-based
//! test. The trade date starts at the configured cutoff (default 08:00 UTC = 04:00 ET, when
//! trades must be reported to the SIP, order fn 69); Saturday and Sunday fold into Friday's
//! trade date. Breach #1 is a warning; each later breach pauses the symbol for three months.

use {
    crate::{error::E, state::*, util::*},
    pinocchio::{error::ProgramError, ProgramResult},
};

const DAY: i64 = 86_400;
/// Three calendar months never exceed 92 days, so the pause never ends early.
pub const PAUSE: i64 = 92 * DAY;

/// Day index of the trade date containing `now` (days since 1970-01-01, weekends → Friday).
pub fn trade_date(now: i64, cutoff: i64) -> i64 {
    let d = (now.saturating_sub(cutoff).max(0) as u64 / DAY as u64) as i64;
    // 1970-01-01 was a Thursday: (d + 4) % 7 gives 0 = Sunday … 6 = Saturday.
    match (d as u64 + 4) % 7 {
        6 => d - 1,
        0 => d - 2,
        _ => d,
    }
}

/// A swap's effect on the symbol's daily share counter.
pub struct Fill {
    pub trade_date: i64,
    pub traded: u64,
    pub shares: u64,
}

/// Converts the stock leg to share units (rounded up) and refuses it if the trade date's
/// counter would pass cap_shares. An unset (zero) budget refuses everything.
pub fn budget(venue: &[u8], symbol: &[u8], now: i64, stock_amount: u64) -> Result<Fill, ProgramError> {
    let td = trade_date(now, rdi(venue, V_CUTOFF));
    let traded = if rdi(symbol, S_TRADE_DATE) == td { rd(symbol, S_TRADED) } else { 0 };
    let shares = mul_div_ceil(stock_amount, rd32(symbol, S_MULT_NUM) as u64, rd32(symbol, S_MULT_DEN) as u64)?;
    match traded.checked_add(shares) {
        Some(after) if after <= rd(symbol, S_CAP) => Ok(Fill { trade_date: td, traded: after, shares }),
        _ => Err(E::CapReached.into()),
    }
}

pub fn record_fill(symbol: &mut [u8], f: &Fill) {
    wri(symbol, S_TRADE_DATE, f.trade_date);
    wr(symbol, S_TRADED, f.traded);
}

/// cap_shares u64 | adv_shares u64 | mult_num u32 | mult_den u32 (data authority).
/// Share units per token unit = mult_num / mult_den (the token's share multiplier).
pub fn set_cap(symbol: &mut [u8], p: &[u8]) -> ProgramResult {
    if p.len() < 24 {
        return Err(ProgramError::InvalidInstructionData);
    }
    if rd32(p, 16) == 0 || rd32(p, 20) == 0 {
        return Err(E::InvalidArgument.into());
    }
    wr(symbol, S_CAP, rd(p, 0));
    wr(symbol, S_ADV, rd(p, 8));
    put_bytes(symbol, S_MULT_NUM, unsafe { p.get_unchecked(16..24) });
    Ok(())
}

/// breach_ts i64 (0 = now; never in the future). The pause runs from the breach itself.
pub fn record_breach(symbol: &mut [u8], p: &[u8]) -> ProgramResult {
    if p.len() < 8 {
        return Err(ProgramError::InvalidInstructionData);
    }
    let now = now()?;
    let at = match rdi(p, 0) {
        0 => now,
        t if t > 0 && t <= now => t,
        _ => return Err(E::InvalidArgument.into()),
    };
    let n = get(symbol, S_BREACHES).saturating_add(1);
    put(symbol, S_BREACHES, n);
    if n >= 2 {
        wri(symbol, S_PAUSED_UNTIL, rdi(symbol, S_PAUSED_UNTIL).max(at + PAUSE));
    }
    Ok(())
}

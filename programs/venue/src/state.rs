//! Account layouts. Every account starts `[discriminator u8][bump u8]`; all integers are
//! little-endian. Offsets are the public contract read by the relay, jobs and indexer;
//! some fields are only touched by the rulebook (`rules`).
#![allow(dead_code)]

use {
    crate::error::E,
    pinocchio::{error::ProgramError, AccountView, Address},
};

pub const VENUE: u8 = 1;
pub const SYMBOL: u8 = 2;
pub const POOL: u8 = 3;
pub const LP: u8 = 4;
pub const MEMBER: u8 = 5;

/// VenueConfig, PDA ["venue", admin].
pub const VENUE_LEN: usize = 248;
pub const V_GATE: usize = 2; // u8 flags: 1 = SAS attestation, 2 = membership PDA
pub const V_TIER1: usize = 4; // u16 registered Tier-1 symbols
pub const V_TIER2: usize = 6; // u16 registered Tier-2 symbols
pub const V_HB_MAX: usize = 8; // i64 heartbeat_max_age seconds
pub const V_CUTOFF: usize = 16; // i64 trade-date start, seconds after 00:00 UTC
pub const V_ADMIN: usize = 24;
pub const V_RELAY: usize = 56;
pub const V_DATA: usize = 88;
pub const V_ISSUER: usize = 120;
pub const V_SAS_CRED: usize = 152;
pub const V_SAS_SCHEMA: usize = 184;

/// SymbolRecord, PDA ["symbol", venue, stock_mint].
pub const SYMBOL_LEN: usize = 168;
pub const S_TIER: usize = 2; // u8 1 | 2
pub const S_SPONSORED: usize = 3; // u8 issuer-sponsored tokenization
pub const S_ACTIVE: usize = 4; // u8 activation_state
pub const S_HALTED: usize = 5; // u8
pub const S_OBJECTED: usize = 6; // u8
pub const S_BREACHES: usize = 7; // u8 breach_count
pub const S_TICKER: usize = 8; // [u8; 8]
pub const S_HALT_REASON: usize = 16; // [u8; 8] Nasdaq reason code
pub const S_VENUE: usize = 24;
pub const S_MINT: usize = 56;
pub const S_ADV: usize = 88; // u64 prior-month ADV, share units
pub const S_CAP: usize = 96; // u64 daily share budget, share units
pub const S_MULT_NUM: usize = 104; // u32 share units per token unit, numerator
pub const S_MULT_DEN: usize = 108; // u32 denominator
pub const S_TRADE_DATE: usize = 112; // i64 day index of the current trade date
pub const S_TRADED: usize = 120; // u64 shares_traded_today, share units
pub const S_PAUSED_UNTIL: usize = 128; // i64
pub const S_HEARTBEAT: usize = 136; // i64 last_heartbeat
pub const S_SEQ: usize = 144; // u64 last relay sequence
pub const S_NOTICE_AT: usize = 152; // i64 notice_received_at
pub const S_HALTED_AT: usize = 160; // i64 feed timestamp of the current halt

/// Pool, PDA ["pool", symbol].
pub const POOL_LEN: usize = 192;
pub const P_STOCK_DEC: usize = 2;
pub const P_USDC_DEC: usize = 3;
pub const P_FEE: usize = 4; // u16 fee_bps
pub const P_SYMBOL: usize = 8;
pub const P_STOCK_MINT: usize = 40;
pub const P_USDC_MINT: usize = 72;
pub const P_STOCK_VAULT: usize = 104;
pub const P_USDC_VAULT: usize = 136;
pub const P_RES_STOCK: usize = 168;
pub const P_RES_USDC: usize = 176;
pub const P_LP_TOTAL: usize = 184;

/// LpPosition, PDA ["lp", pool, owner]. Internal and non-transferable.
pub const LP_LEN: usize = 80;
pub const L_POOL: usize = 8;
pub const L_OWNER: usize = 40;
pub const L_SHARES: usize = 72;

/// Membership (fallback credential), PDA ["member", venue, wallet].
pub const MEMBER_LEN: usize = 80;
pub const M_VENUE: usize = 8;
pub const M_WALLET: usize = 40;
pub const M_EXPIRES: usize = 72;

// Callers validate lengths once (`load`, payload checks), so these accessors skip bounds
// checks; that keeps panic formatting (core::fmt) out of the binary.
#[inline(always)]
pub fn get(d: &[u8], o: usize) -> u8 {
    unsafe { *d.as_ptr().add(o) }
}
#[inline(always)]
pub fn put(d: &mut [u8], o: usize, v: u8) {
    unsafe { *d.as_mut_ptr().add(o) = v }
}
#[inline(always)]
pub fn put_bytes(d: &mut [u8], o: usize, src: &[u8]) {
    unsafe { core::ptr::copy_nonoverlapping(src.as_ptr(), d.as_mut_ptr().add(o), src.len()) }
}
#[inline(always)]
pub fn rd(d: &[u8], o: usize) -> u64 {
    unsafe { (d.as_ptr().add(o) as *const u64).read_unaligned() }
}
#[inline(always)]
pub fn rdi(d: &[u8], o: usize) -> i64 {
    rd(d, o) as i64
}
#[inline(always)]
pub fn wr(d: &mut [u8], o: usize, v: u64) {
    unsafe { (d.as_mut_ptr().add(o) as *mut u64).write_unaligned(v) }
}
#[inline(always)]
pub fn wri(d: &mut [u8], o: usize, v: i64) {
    wr(d, o, v as u64)
}
#[inline(always)]
pub fn rd16(d: &[u8], o: usize) -> u16 {
    unsafe { (d.as_ptr().add(o) as *const u16).read_unaligned() }
}
#[inline(always)]
pub fn wr16(d: &mut [u8], o: usize, v: u16) {
    unsafe { (d.as_mut_ptr().add(o) as *mut u16).write_unaligned(v) }
}
#[inline(always)]
pub fn rd32(d: &[u8], o: usize) -> u32 {
    unsafe { (d.as_ptr().add(o) as *const u32).read_unaligned() }
}
#[inline(always)]
pub fn bytes32(d: &[u8], o: usize) -> &[u8; 32] {
    unsafe { &*(d.as_ptr().add(o) as *const [u8; 32]) }
}
#[inline(always)]
pub fn key_eq(d: &[u8], o: usize, k: &Address) -> bool {
    bytes32(d, o) == k.as_array()
}
#[inline(always)]
pub fn set_key(d: &mut [u8], o: usize, k: &Address) {
    put_bytes(d, o, k.as_ref())
}

/// Program-owned account of the expected kind and size. Only this program writes accounts
/// it owns, and it creates each kind only at its canonical PDA, so owner + discriminator +
/// the stored link fields bind the account without re-deriving the address.
#[inline(never)]
pub fn load<'a>(acc: &'a AccountView, program_id: &Address, disc: u8, len: usize) -> Result<&'a [u8], ProgramError> {
    if !acc.owned_by(program_id) || acc.data_len() < len {
        return Err(E::InvalidAccount.into());
    }
    let d = unsafe { acc.borrow_unchecked() };
    if get(d, 0) != disc {
        return Err(E::InvalidAccount.into());
    }
    Ok(d)
}

/// Mutable view of an account already validated with `load` in this instruction.
#[inline(always)]
pub fn data_mut(acc: &mut AccountView) -> &mut [u8] {
    unsafe { acc.borrow_unchecked_mut() }
}

//! Credential gate. A wallet is admitted by a Solana Attestation Service attestation pinned
//! to the venue's (credential, schema), or — behind a config flag — by a membership PDA.
//! Everything else, including a closed (revoked) attestation, fails closed with NotAdmitted.

use {
    crate::{error::E, state::*},
    pinocchio::{error::ProgramError, AccountView, Address},
};

pub const SAS_ID: Address = Address::from_str_const("22zoJMtdu4tQc2PzL74ZUT7FrwgB1Udec8DdW4yw4BdG");
pub const GATE_SAS: u8 = 1;
pub const GATE_MEMBER: u8 = 2;

/// SAS attestation: disc | nonce | credential | schema | u32 len | data | signer | expiry | token_account.
const A_DISC: u8 = 2;
const A_NONCE: usize = 1;
const A_CRED: usize = 33;
const A_SCHEMA: usize = 65;
const A_LEN: usize = 97;
const A_DATA: usize = 101;
const A_MIN: usize = 173;

pub fn admit(program_id: &Address, venue_key: &Address, venue: &[u8], cred: &AccountView, wallet: &Address, now: i64) -> Result<(), ProgramError> {
    let flags = get(venue, V_GATE);
    let d = unsafe { cred.borrow_unchecked() };
    let ok = if flags & GATE_SAS != 0 && cred.owned_by(&SAS_ID) {
        sas(venue, cred.address(), d, wallet, now)
    } else if flags & GATE_MEMBER != 0 && cred.owned_by(program_id) {
        d.len() >= MEMBER_LEN
            && get(d, 0) == MEMBER
            && key_eq(d, M_VENUE, venue_key)
            && key_eq(d, M_WALLET, wallet)
            && rdi(d, M_EXPIRES) > now
    } else {
        false
    };
    if ok {
        Ok(())
    } else {
        Err(E::NotAdmitted.into())
    }
}

fn sas(venue: &[u8], addr: &Address, d: &[u8], wallet: &Address, now: i64) -> bool {
    if d.len() < A_MIN
        || get(d, 0) != A_DISC
        || !key_eq(d, A_NONCE, wallet)
        || bytes32(d, A_CRED) != bytes32(venue, V_SAS_CRED)
        || bytes32(d, A_SCHEMA) != bytes32(venue, V_SAS_SCHEMA)
    {
        return false;
    }
    // expiry follows the variable-length data and the 32-byte signer; 0 (never) is refused.
    let expiry_at = A_DATA + rd32(d, A_LEN) as usize + 32;
    if d.len() < expiry_at + 8 + 32 || rdi(d, expiry_at) <= now {
        return false;
    }
    // Defence in depth: the account must sit at SAS's attestation PDA for this wallet.
    let seeds: [&[u8]; 4] = [b"attestation", bytes32(d, A_CRED), bytes32(d, A_SCHEMA), wallet.as_ref()];
    Address::try_find_program_address(&seeds, &SAS_ID).is_some_and(|(pda, _)| &pda == addr)
}

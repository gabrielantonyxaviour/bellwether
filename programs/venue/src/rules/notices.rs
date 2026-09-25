//! Issuer notice and activation. A third-party-tokenized symbol may be made available only
//! 30 days after the issuer received the Issuer Notice and only if no objection is on file;
//! an issuer-sponsored symbol activates directly.

use {
    crate::{error::E, state::*, util::now},
    pinocchio::{error::ProgramError, ProgramResult},
};

pub const NOTICE_WINDOW: i64 = 30 * 86_400;

fn third_party(symbol: &[u8]) -> ProgramResult {
    if get(symbol, S_SPONSORED) != 0 {
        return Err(E::InvalidArgument.into());
    }
    Ok(())
}

/// received_at i64: when the issuer received the notice (recorded once, never future-dated).
pub fn record_issuer_notice(symbol: &mut [u8], p: &[u8]) -> ProgramResult {
    if p.len() < 8 {
        return Err(ProgramError::InvalidInstructionData);
    }
    third_party(symbol)?;
    let at = rdi(p, 0);
    if at <= 0 || at > now()? {
        return Err(E::InvalidArgument.into());
    }
    if rdi(symbol, S_NOTICE_AT) != 0 {
        return Err(E::AlreadyInitialized.into());
    }
    wri(symbol, S_NOTICE_AT, at);
    Ok(())
}

/// A Notice of Issuer Objection: the symbol can never be (or stay) available.
pub fn record_objection(symbol: &mut [u8]) -> ProgramResult {
    third_party(symbol)?;
    put(symbol, S_OBJECTED, 1);
    put(symbol, S_ACTIVE, 0);
    Ok(())
}

pub fn activate_pool(symbol: &mut [u8]) -> ProgramResult {
    if get(symbol, S_SPONSORED) == 0 {
        if get(symbol, S_OBJECTED) != 0 {
            return Err(E::Objected.into());
        }
        let received = rdi(symbol, S_NOTICE_AT);
        if received == 0 || now()? < received + NOTICE_WINDOW {
            return Err(E::NoticeWindowOpen.into());
        }
    }
    put(symbol, S_ACTIVE, 1);
    Ok(())
}

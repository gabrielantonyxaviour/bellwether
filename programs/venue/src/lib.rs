//! Bellwether venue: permissioned stock-vs-USDC constant-product pools for a Tokenized
//! Securities Venue, with the rulebook (credential gate, exchange-synced halts, share-volume
//! caps, symbol caps, issuer-notice activation) enforced inside the program's own swap path.
//!
//! There is deliberately no borrow, lend, margin or stock-issuance instruction.
#![no_std]

mod admin;
mod error;
mod gate;
mod liquidity;
mod rules;
mod state;
mod swap;
mod util;

use pinocchio::{error::ProgramError, AccountView, Address, ProgramResult};

pinocchio::program_entrypoint!(process);
pinocchio::no_allocator!();
pinocchio::nostd_panic_handler!();

/// Instruction discriminator (first data byte) → handler. 0..=8 are core; 16..=23 are the
/// rulebook (see `rules`). Anything else is InvalidInstructionData.
pub fn process(program_id: &Address, accounts: &mut [AccountView], data: &[u8]) -> ProgramResult {
    let (&disc, p) = data.split_first().ok_or(ProgramError::InvalidInstructionData)?;
    match disc {
        0 => admin::init_venue(program_id, accounts, p),
        1 => admin::register_symbol(program_id, accounts, p),
        2 => admin::init_pool(program_id, accounts, p),
        3 => liquidity::add(program_id, accounts, p),
        4 => liquidity::remove(program_id, accounts, p),
        5 => swap::swap(program_id, accounts, p),
        6 => admin::grant_member(program_id, accounts, p),
        7 => admin::revoke_member(program_id, accounts, p),
        8 => admin::update_venue(program_id, accounts, p),
        _ => rules::process(disc, program_id, accounts, p),
    }
}

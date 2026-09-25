//! Shared helpers: clock, one raw CPI path for every system and token call, PDA creation,
//! panic-free wide math, authority checks and market cross-validation.

use {
    crate::{error::E, state::*},
    core::mem::MaybeUninit,
    pinocchio::{
        cpi::{invoke_signed_unchecked, CpiAccount, Seed, Signer},
        error::ProgramError,
        instruction::{InstructionAccount as Meta, InstructionView},
        sysvars::{clock::Clock, rent::Rent, Sysvar},
        AccountView, Address, ProgramResult,
    },
};

pub const TOKEN_2022: Address = Address::from_str_const("TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb");
pub const SPL_TOKEN: Address = Address::from_str_const("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA");
const SYSTEM: Address = Address::new_from_array([0; 32]);

/// Token account `amount` (same offset for SPL Token and Token-2022).
pub const T_AMOUNT: usize = 64;

#[inline(always)]
pub fn now() -> Result<i64, ProgramError> {
    Ok(Clock::get()?.unix_timestamp)
}

pub fn signer(acc: &AccountView) -> ProgramResult {
    if acc.is_signer() {
        Ok(())
    } else {
        Err(ProgramError::MissingRequiredSignature)
    }
}

/// Loads the venue and requires `who` to sign as the authority stored at `field`.
#[inline(never)]
pub fn authorized<'a>(program_id: &Address, who: &AccountView, venue: &'a AccountView, field: usize) -> Result<&'a [u8], ProgramError> {
    signer(who)?;
    let v = load(venue, program_id, VENUE, VENUE_LEN)?;
    if !key_eq(v, field, who.address()) {
        return Err(E::Unauthorized.into());
    }
    Ok(v)
}

/// Canonical PDA; `acct` must be it.
#[inline(never)]
pub fn expect_pda(acct: &AccountView, seeds: &[&[u8]], program_id: &Address) -> Result<u8, ProgramError> {
    match Address::try_find_program_address(seeds, program_id) {
        Some((pda, bump)) if &pda == acct.address() => Ok(bump),
        _ => Err(E::InvalidAccount.into()),
    }
}

/// The single CPI path (≤ 4 accounts). A failing callee aborts the whole transaction.
#[inline(never)]
fn invoke(program: &Address, metas: &[Meta], views: &[&AccountView], data: &[u8], seeds: &[Seed]) -> ProgramResult {
    let mut slots = [const { MaybeUninit::<CpiAccount>::uninit() }; 4];
    let mut n = 0;
    for (slot, view) in slots.iter_mut().zip(views) {
        CpiAccount::init_from_account_view(view, slot);
        n += 1;
    }
    let accounts = unsafe { core::slice::from_raw_parts(slots.as_ptr() as *const CpiAccount, n) };
    let signer = [Signer::from(seeds)];
    let signers: &[Signer] = if seeds.is_empty() { &[] } else { &signer };
    unsafe { invoke_signed_unchecked(&InstructionView { program_id: program, accounts: metas, data }, accounts, signers) };
    Ok(())
}

fn system(metas: &[Meta], views: &[&AccountView], tag: u32, a: u64, b: u64, owner: Option<&Address>, seeds: &[Seed]) -> ProgramResult {
    let mut d = [0u8; 52];
    put_bytes(&mut d, 0, &tag.to_le_bytes());
    wr(&mut d, 4, a);
    wr(&mut d, 12, b);
    let len = match (tag, owner) {
        (0, Some(o)) => {
            put_bytes(&mut d, 20, o.as_ref());
            52
        }
        (1, Some(o)) => {
            put_bytes(&mut d, 4, o.as_ref());
            36
        }
        _ => 12,
    };
    invoke(&SYSTEM, metas, views, unsafe { d.get_unchecked(..len) }, seeds)
}

/// Creates a program-owned PDA. A PDA pre-funded by a third party is still claimable
/// (top up, allocate, assign), so nobody can block creation by sending it lamports.
#[inline(never)]
pub fn create_pda(payer: &AccountView, acct: &AccountView, owner: &Address, space: usize, seeds: &[Seed]) -> ProgramResult {
    if acct.owned_by(owner) {
        return Err(E::AlreadyInitialized.into());
    }
    let rent = Rent::get()?.try_minimum_balance(space)?;
    let pay = || Meta::writable_signer(payer.address());
    let new = || Meta::writable_signer(acct.address());
    let have = acct.lamports();
    if have == 0 {
        return system(&[pay(), new()], &[payer, acct], 0, rent, space as u64, Some(owner), seeds);
    }
    if have < rent {
        system(&[pay(), Meta::writable(acct.address())], &[payer, acct], 2, rent - have, 0, None, &[])?;
    }
    system(&[new()], &[acct], 8, space as u64, 0, None, seeds)?;
    system(&[new()], &[acct], 1, 0, 0, Some(owner), seeds)
}

/// transfer_checked through `program` (Token-2022 for the stock, SPL Token for USDC).
/// Empty `seeds` means the authority signed the transaction itself.
#[inline(never)]
#[allow(clippy::too_many_arguments)]
pub fn transfer(
    from: &AccountView,
    mint: &AccountView,
    to: &AccountView,
    authority: &AccountView,
    amount: u64,
    decimals: u8,
    program: &AccountView,
    seeds: &[Seed],
) -> ProgramResult {
    let mut d = [12u8; 10];
    wr(&mut d, 1, amount);
    put(&mut d, 9, decimals);
    let metas = [
        Meta::writable(from.address()),
        Meta::readonly(mint.address()),
        Meta::writable(to.address()),
        Meta::readonly_signer(authority.address()),
    ];
    invoke(program.address(), &metas, &[from, mint, to, authority], &d, seeds)
}

/// The wallet's own stock (Token-2022) and USDC (SPL Token) accounts: trading and
/// withdrawal proceeds never reach a wallet that was not admitted.
#[inline(never)]
pub fn own_accounts(wallet: &AccountView, stock: &AccountView, usdc: &AccountView) -> ProgramResult {
    let own = |acc: &AccountView, program: &Address| {
        acc.owned_by(program) && acc.data_len() >= 165 && key_eq(unsafe { acc.borrow_unchecked() }, 32, wallet.address())
    };
    if own(stock, &TOKEN_2022) && own(usdc, &SPL_TOKEN) {
        Ok(())
    } else {
        Err(E::InvalidAccount.into())
    }
}

/// Live token balance of an account validated at pool init (length ≥ 165).
#[inline(always)]
pub fn token_amount(acc: &AccountView) -> u64 {
    rd(unsafe { acc.borrow_unchecked() }, T_AMOUNT)
}

/// (n / d, n % d) for a 128-bit numerator, if the quotient fits in 64 bits. Restoring long
/// division: a few hundred CUs, and it keeps compiler-rt's u128 division out of the binary.
#[inline(never)]
pub fn div_wide(n: u128, d: u64) -> Option<(u64, u64)> {
    let (mut r, lo) = ((n >> 64) as u64, n as u64);
    if d == 0 || r >= d {
        return None;
    }
    let mut q = 0u64;
    let mut i = 64;
    while i > 0 {
        i -= 1;
        let carry = r >> 63;
        r = (r << 1) | ((lo >> i) & 1);
        q <<= 1;
        if carry != 0 || r >= d {
            r = r.wrapping_sub(d);
            q |= 1;
        }
    }
    Some((q, r))
}

pub fn mul_div(a: u64, b: u64, c: u64) -> Result<u64, ProgramError> {
    div_wide(a as u128 * b as u128, c).map(|(q, _)| q).ok_or(E::InvalidAmount.into())
}

pub fn mul_div_ceil(a: u64, b: u64, c: u64) -> Result<u64, ProgramError> {
    match div_wide(a as u128 * b as u128, c) {
        Some((q, 0)) => Ok(q),
        Some((q, _)) => q.checked_add(1).ok_or(E::InvalidAmount.into()),
        None => Err(E::InvalidAmount.into()),
    }
}

/// Integer square root, digit by digit (no division).
pub fn isqrt(n: u128) -> u64 {
    let (mut x, mut r, mut bit) = (n, 0u128, 1u128 << 126);
    while bit > n {
        bit >>= 2;
    }
    while bit != 0 {
        if x >= r + bit {
            x -= r + bit;
            r = (r >> 1) + bit;
        } else {
            r >>= 1;
        }
        bit >>= 2;
    }
    r as u64
}

/// Venue, symbol and pool of one market, cross-linked, plus the exact token programs.
pub struct Market {
    pub bump: u8,
    pub stock_dec: u8,
    pub usdc_dec: u8,
    pub fee_bps: u16,
}

#[inline(never)]
#[allow(clippy::too_many_arguments)]
pub fn market(
    program_id: &Address,
    venue: &AccountView,
    symbol: &AccountView,
    pool: &AccountView,
    stock_mint: &AccountView,
    usdc_mint: &AccountView,
    stock_vault: &AccountView,
    usdc_vault: &AccountView,
    stock_tp: &AccountView,
    usdc_tp: &AccountView,
) -> Result<Market, ProgramError> {
    load(venue, program_id, VENUE, VENUE_LEN)?;
    let s = load(symbol, program_id, SYMBOL, SYMBOL_LEN)?;
    let p = load(pool, program_id, POOL, POOL_LEN)?;
    if !key_eq(s, S_VENUE, venue.address())
        || !key_eq(p, P_SYMBOL, symbol.address())
        || !key_eq(p, P_STOCK_MINT, stock_mint.address())
        || !key_eq(p, P_USDC_MINT, usdc_mint.address())
        || !key_eq(p, P_STOCK_VAULT, stock_vault.address())
        || !key_eq(p, P_USDC_VAULT, usdc_vault.address())
        || stock_tp.address() != &TOKEN_2022
        || usdc_tp.address() != &SPL_TOKEN
    {
        return Err(E::InvalidAccount.into());
    }
    Ok(Market { bump: get(p, 1), stock_dec: get(p, P_STOCK_DEC), usdc_dec: get(p, P_USDC_DEC), fee_bps: rd16(p, P_FEE) })
}

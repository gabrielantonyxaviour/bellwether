//! Instruction builders and PDA derivations for the venue program. Every byte layout here
//! is the documented client contract (little-endian, first byte = instruction discriminator).
#![allow(dead_code)]

use {
    super::{PROGRAM_ID, SAS_ID, SPL_TOKEN, SYSTEM, TOKEN_2022},
    solana_address::Address,
    solana_instruction::{AccountMeta, Instruction},
};

pub const GATE_SAS: u8 = 1;
pub const GATE_MEMBER: u8 = 2;
pub const BUY: u8 = 0; // USDC in, stock out
pub const SELL: u8 = 1; // stock in, USDC out

pub fn pda(seeds: &[&[u8]]) -> Address {
    Address::find_program_address(seeds, &PROGRAM_ID).0
}
pub fn venue_pda(admin: &Address) -> Address {
    pda(&[b"venue", admin.as_ref()])
}
pub fn symbol_pda(venue: &Address, mint: &Address) -> Address {
    pda(&[b"symbol", venue.as_ref(), mint.as_ref()])
}
pub fn pool_pda(symbol: &Address) -> Address {
    pda(&[b"pool", symbol.as_ref()])
}
pub fn lp_pda(pool: &Address, owner: &Address) -> Address {
    pda(&[b"lp", pool.as_ref(), owner.as_ref()])
}
pub fn member_pda(venue: &Address, wallet: &Address) -> Address {
    pda(&[b"member", venue.as_ref(), wallet.as_ref()])
}
pub fn attestation_pda(credential: &Address, schema: &Address, wallet: &Address) -> Address {
    Address::find_program_address(&[b"attestation", credential.as_ref(), schema.as_ref(), wallet.as_ref()], &SAS_ID).0
}

#[derive(Clone)]
pub struct VenueParams {
    pub gate: u8,
    pub heartbeat_max_age: i64,
    pub trade_date_cutoff: i64,
    pub relay: Address,
    pub data_authority: Address,
    pub credential_issuer: Address,
    pub sas_credential: Address,
    pub sas_schema: Address,
    pub affiliate_group: Address,
}

fn venue_payload(disc: u8, p: &VenueParams) -> Vec<u8> {
    let mut d = vec![disc, p.gate];
    d.extend_from_slice(&p.heartbeat_max_age.to_le_bytes());
    d.extend_from_slice(&p.trade_date_cutoff.to_le_bytes());
    for k in [&p.relay, &p.data_authority, &p.credential_issuer, &p.sas_credential, &p.sas_schema, &p.affiliate_group] {
        d.extend_from_slice(k.as_ref());
    }
    d
}

fn ix(data: Vec<u8>, accounts: Vec<AccountMeta>) -> Instruction {
    Instruction::new_with_bytes(PROGRAM_ID, &data, accounts)
}
fn w(k: &Address) -> AccountMeta {
    AccountMeta::new(*k, false)
}
fn r(k: &Address) -> AccountMeta {
    AccountMeta::new_readonly(*k, false)
}
fn signer(k: &Address) -> AccountMeta {
    AccountMeta::new(*k, true)
}

pub fn init_venue(admin: &Address, p: &VenueParams) -> Instruction {
    ix(venue_payload(0, p), vec![signer(admin), w(&venue_pda(admin)), r(&SYSTEM)])
}
pub fn update_venue(admin: &Address, p: &VenueParams) -> Instruction {
    ix(venue_payload(8, p), vec![signer(admin), w(&venue_pda(admin))])
}

pub fn ticker(s: &str) -> [u8; 8] {
    let mut t = [0u8; 8];
    t[..s.len()].copy_from_slice(s.as_bytes());
    t
}

pub fn register_symbol(admin: &Address, venue: &Address, mint: &Address, tier: u8, sponsored: bool, sym: &str) -> Instruction {
    let mut d = vec![1, tier, sponsored as u8];
    d.extend_from_slice(&ticker(sym));
    ix(d, vec![signer(admin), w(venue), w(&symbol_pda(venue, mint)), r(mint), r(&SYSTEM)])
}

#[derive(Clone, Copy)]
pub struct PoolKeys {
    pub venue: Address,
    pub symbol: Address,
    pub pool: Address,
    pub stock_mint: Address,
    pub usdc_mint: Address,
    pub stock_vault: Address,
    pub usdc_vault: Address,
}

pub fn init_pool(admin: &Address, k: &PoolKeys, fee_bps: u16) -> Instruction {
    let mut d = vec![2];
    d.extend_from_slice(&fee_bps.to_le_bytes());
    ix(d, vec![
        signer(admin), r(&k.venue), r(&k.symbol), w(&k.pool), r(&k.stock_mint), r(&k.usdc_mint),
        r(&k.stock_vault), r(&k.usdc_vault), r(&SYSTEM),
    ])
}

fn trade_tail(k: &PoolKeys, stock: &Address, usdc: &Address, cred: &Address) -> Vec<AccountMeta> {
    vec![
        r(&k.stock_mint), r(&k.usdc_mint), w(&k.stock_vault), w(&k.usdc_vault), w(stock), w(usdc), r(cred),
        r(&TOKEN_2022), r(&SPL_TOKEN),
    ]
}

fn three_u64(disc: u8, a: u64, b: u64, c: u64) -> Vec<u8> {
    let mut d = vec![disc];
    for v in [a, b, c] {
        d.extend_from_slice(&v.to_le_bytes());
    }
    d
}

pub fn swap(k: &PoolKeys, trader: &Address, stock: &Address, usdc: &Address, cred: &Address, dir: u8, amount_in: u64, min_out: u64) -> Instruction {
    let mut d = vec![5, dir];
    d.extend_from_slice(&amount_in.to_le_bytes());
    d.extend_from_slice(&min_out.to_le_bytes());
    let mut a = vec![AccountMeta::new_readonly(*trader, true), r(&k.venue), w(&k.symbol), w(&k.pool)];
    a.extend(trade_tail(k, stock, usdc, cred));
    ix(d, a)
}

pub fn add_liquidity(k: &PoolKeys, owner: &Address, stock: &Address, usdc: &Address, cred: &Address, stock_max: u64, usdc_max: u64, min_lp: u64) -> Instruction {
    let mut a = vec![signer(owner), r(&k.venue), r(&k.symbol), w(&k.pool), w(&lp_pda(&k.pool, owner))];
    a.extend(trade_tail(k, stock, usdc, cred));
    a.push(r(&SYSTEM));
    ix(three_u64(3, stock_max, usdc_max, min_lp), a)
}

/// `position` is normally `lp_pda(pool, owner)`; tests pass other positions to prove binding.
pub fn remove_liquidity(k: &PoolKeys, owner: &Address, position: &Address, stock: &Address, usdc: &Address, cred: &Address, lp: u64, min_stock: u64, min_usdc: u64) -> Instruction {
    let mut a = vec![signer(owner), r(&k.venue), r(&k.symbol), w(&k.pool), w(position)];
    a.extend(trade_tail(k, stock, usdc, cred));
    ix(three_u64(4, lp, min_stock, min_usdc), a)
}

pub fn grant_member(issuer: &Address, venue: &Address, wallet: &Address, expires_at: i64) -> Instruction {
    let mut d = vec![6];
    d.extend_from_slice(&expires_at.to_le_bytes());
    ix(d, vec![signer(issuer), r(venue), w(&member_pda(venue, wallet)), r(wallet), r(&SYSTEM)])
}
pub fn revoke_member(issuer: &Address, venue: &Address, wallet: &Address) -> Instruction {
    ix(vec![7], vec![signer(issuer), r(venue), w(&member_pda(venue, wallet))])
}

/// Authority instructions on one symbol: accounts [authority (signer), venue, symbol (w)].
pub fn authority_ix(disc: u8, authority: &Address, venue: &Address, symbol: &Address, payload: &[u8]) -> Instruction {
    let mut d = vec![disc];
    d.extend_from_slice(payload);
    ix(d, vec![AccountMeta::new_readonly(*authority, true), r(venue), w(symbol)])
}

pub fn set_cap(auth: &Address, venue: &Address, symbol: &Address, cap_shares: u64, adv_shares: u64, num: u32, den: u32) -> Instruction {
    let mut p = cap_shares.to_le_bytes().to_vec();
    p.extend_from_slice(&adv_shares.to_le_bytes());
    p.extend_from_slice(&num.to_le_bytes());
    p.extend_from_slice(&den.to_le_bytes());
    authority_ix(16, auth, venue, symbol, &p)
}
pub fn set_halt(relay: &Address, venue: &Address, symbol: &Address, seq: u64, reason: &str, feed_ts: i64) -> Instruction {
    let mut p = seq.to_le_bytes().to_vec();
    p.extend_from_slice(&ticker(reason));
    p.extend_from_slice(&feed_ts.to_le_bytes());
    authority_ix(17, relay, venue, symbol, &p)
}
pub fn clear_halt(relay: &Address, venue: &Address, symbol: &Address, seq: u64) -> Instruction {
    authority_ix(18, relay, venue, symbol, &seq.to_le_bytes())
}
pub fn heartbeat(relay: &Address, venue: &Address, symbol: &Address, seq: u64) -> Instruction {
    authority_ix(19, relay, venue, symbol, &seq.to_le_bytes())
}
pub fn record_breach(auth: &Address, venue: &Address, symbol: &Address, breach_ts: i64) -> Instruction {
    authority_ix(20, auth, venue, symbol, &breach_ts.to_le_bytes())
}
pub fn record_issuer_notice(admin: &Address, venue: &Address, symbol: &Address, received_at: i64) -> Instruction {
    authority_ix(21, admin, venue, symbol, &received_at.to_le_bytes())
}
pub fn record_objection(admin: &Address, venue: &Address, symbol: &Address) -> Instruction {
    authority_ix(22, admin, venue, symbol, &[])
}
pub fn activate_pool(admin: &Address, venue: &Address, symbol: &Address) -> Instruction {
    authority_ix(23, admin, venue, symbol, &[])
}

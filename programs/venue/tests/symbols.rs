//! Requirement: registering a 76th Tier-1 or 251st Tier-2 symbol fails SymbolCapReached
//! (counted across the venue, i.e. the affiliate group, at registration — no grace).
mod common;

use {
    common::{assert_code, assert_ok, err, market::Market, token, venue as v},
    litesvm::types::TransactionResult,
    solana_signer::Signer,
};

const V_TIER1: usize = 4;
const V_TIER2: usize = 6;

fn register(m: &mut Market, tier: u8, n: usize) -> TransactionResult {
    let mint = token::raw_stock_mint(&mut m.svm, 6);
    let ix = v::register_symbol(&m.admin.pubkey(), &m.keys.venue, &mint, tier, true, &format!("S{n}"));
    m.as_admin(ix)
}

fn counts(m: &Market) -> (u16, u16) {
    let d = m.account_data(&m.keys.venue);
    (u16::from_le_bytes([d[V_TIER1], d[V_TIER1 + 1]]), u16::from_le_bytes([d[V_TIER2], d[V_TIER2 + 1]]))
}

#[test]
fn registering_a_76th_tier1_symbol_fails_symbol_cap_reached() {
    let mut m = Market::new(); // FWDI is already registered as Tier 2
    for n in 0..75 {
        assert_ok(&register(&mut m, 1, n));
    }
    assert_eq!(counts(&m), (75, 1));
    assert_code(&register(&mut m, 1, 75), err::SYMBOL_CAP_REACHED);
    assert_eq!(counts(&m), (75, 1));
    // Tier 2 has its own budget.
    assert_ok(&register(&mut m, 2, 76));
    assert_eq!(counts(&m), (75, 2));
}

#[test]
fn registering_a_251st_tier2_symbol_fails_symbol_cap_reached() {
    let mut m = Market::new();
    for n in 1..250 {
        assert_ok(&register(&mut m, 2, n));
    }
    assert_eq!(counts(&m), (0, 250));
    assert_code(&register(&mut m, 2, 250), err::SYMBOL_CAP_REACHED);
    assert_eq!(counts(&m), (0, 250));
    assert_ok(&register(&mut m, 1, 251));
}

#[test]
fn only_the_admin_registers_symbols_and_tiers_are_one_or_two() {
    let mut m = Market::new();
    let mint = token::raw_stock_mint(&mut m.svm, 6);
    let ix = v::register_symbol(&m.relay.pubkey(), &m.keys.venue, &mint, 1, true, "X");
    assert_code(&m.as_relay(ix), err::UNAUTHORIZED);
    let ix = v::register_symbol(&m.admin.pubkey(), &m.keys.venue, &mint, 3, true, "X");
    assert_code(&m.as_admin(ix), err::INVALID_ARGUMENT);
}

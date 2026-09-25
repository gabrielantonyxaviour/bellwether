//! Requirement: an admitted wallet's swap moves reserves per x·y=k net of the fee; a wallet
//! with no, expired, revoked or foreign-schema attestation fails with NotAdmitted.
mod common;

use {
    common::{
        assert_code, assert_ok, err,
        market::{Market, Opts, Trader, ONE},
        venue::{self as v, BUY, GATE_MEMBER, GATE_SAS, SELL},
        DAY, SAS_ID, SYSTEM,
    },
    solana_address::Address,
    solana_signer::Signer,
};

/// The venue's quote: fee (rounded up, kept in the pool) comes off the input first.
fn expected_out(amount_in: u64, r_in: u64, r_out: u64, fee_bps: u64) -> u64 {
    let fee = (amount_in as u128 * fee_bps as u128).div_ceil(10_000);
    let net = amount_in as u128 - fee;
    (net * r_out as u128 / (r_in as u128 + net)) as u64
}

/// A market seeded with 1,000 shares against 20,000 USDC ($20/share) by an admitted LP.
fn seeded(o: Opts) -> Market {
    let mut m = Market::with(o);
    let lp = m.trader(1_000 * ONE, 20_000 * ONE);
    assert_ok(&m.add(&lp, 1_000 * ONE, 20_000 * ONE, 1));
    m
}

#[test]
fn admitted_swap_moves_reserves_per_constant_product_net_of_fee() {
    let mut m = seeded(Opts::default());
    let t = m.trader(0, 5_000 * ONE);
    let (s0, u0) = m.reserves();

    let out = expected_out(1_000 * ONE, u0, s0, 30);
    assert_ok(&m.swap(&t, BUY, 1_000 * ONE, out));
    let (s1, u1) = m.reserves();
    assert_eq!((s1, u1), (s0 - out, u0 + 1_000 * ONE));
    assert_eq!(m.balance(&t.stock), out);
    assert_eq!(m.balance(&t.usdc), 4_000 * ONE);
    // Net of the fee the product holds; with the fee retained it grows.
    let net_in = 1_000 * ONE - 3 * ONE;
    assert!((u0 + net_in) as u128 * s1 as u128 >= u0 as u128 * s0 as u128);
    assert!(u1 as u128 * s1 as u128 > u0 as u128 * s0 as u128);

    let back = expected_out(out, s1, u1, 30);
    assert_ok(&m.swap(&t, SELL, out, back));
    assert_eq!(m.reserves(), (s1 + out, u1 - back));
    assert_eq!(m.balance(&t.usdc), 4_000 * ONE + back);
    assert!(back < 1_000 * ONE, "a round trip pays the fee twice");
}

#[test]
fn slippage_guard_refuses_a_worse_fill() {
    let mut m = seeded(Opts::default());
    let t = m.trader(0, 1_000 * ONE);
    let (s0, u0) = m.reserves();
    let out = expected_out(100 * ONE, u0, s0, 30);
    assert_code(&m.swap(&t, BUY, 100 * ONE, out + 1), err::SLIPPAGE_EXCEEDED);
    assert_eq!(m.reserves(), (s0, u0));
}

#[test]
fn wallet_with_no_attestation_is_not_admitted() {
    let mut m = seeded(Opts::default());
    let t = m.unadmitted(0, 1_000 * ONE);
    assert_code(&m.swap(&t, BUY, 10 * ONE, 1), err::NOT_ADMITTED);
}

#[test]
fn expired_attestation_is_not_admitted() {
    let mut m = seeded(Opts::default());
    let mut t = m.unadmitted(0, 1_000 * ONE);
    t.cred = m.admit_sas(&t.key(), m.now - 1);
    assert_code(&m.swap(&t, BUY, 10 * ONE, 1), err::NOT_ADMITTED);

    // Valid now, then time passes beyond its expiry.
    t.cred = m.admit_sas(&t.key(), m.now + DAY);
    assert_ok(&m.swap(&t, BUY, 10 * ONE, 1));
    m.warp(DAY + 1);
    assert_ok(&m.heartbeat());
    assert_code(&m.swap(&t, BUY, 10 * ONE, 1), err::NOT_ADMITTED);
}

#[test]
fn revoked_attestation_is_not_admitted() {
    let mut m = seeded(Opts::default());
    let t = m.trader(0, 1_000 * ONE);
    assert_ok(&m.swap(&t, BUY, 10 * ONE, 1));
    m.close_account(&t.cred);
    assert_code(&m.swap(&t, BUY, 10 * ONE, 1), err::NOT_ADMITTED);
}

#[test]
fn foreign_schema_or_credential_attestation_is_not_admitted() {
    let mut m = seeded(Opts::default());
    let mut t = m.unadmitted(0, 1_000 * ONE);
    let (cred, schema) = (m.params.sas_credential, m.params.sas_schema);
    let exp = m.now + DAY;
    t.cred = m.write_attestation(&t.key(), &cred, &Address::new_unique(), exp, SAS_ID);
    assert_code(&m.swap(&t, BUY, 10 * ONE, 1), err::NOT_ADMITTED);
    t.cred = m.write_attestation(&t.key(), &Address::new_unique(), &schema, exp, SAS_ID);
    assert_code(&m.swap(&t, BUY, 10 * ONE, 1), err::NOT_ADMITTED);
}

#[test]
fn another_wallets_or_forged_attestation_is_not_admitted() {
    let mut m = seeded(Opts::default());
    let holder = m.trader(0, 0);
    let mut t: Trader = m.unadmitted(0, 1_000 * ONE);
    t.cred = holder.cred; // valid attestation, but its nonce is another wallet
    assert_code(&m.swap(&t, BUY, 10 * ONE, 1), err::NOT_ADMITTED);

    // Correct bytes at the correct address, but not written by the SAS program.
    let (cred, schema, exp) = (m.params.sas_credential, m.params.sas_schema, m.now + DAY);
    t.cred = m.write_attestation(&t.key(), &cred, &schema, exp, SYSTEM);
    assert_code(&m.swap(&t, BUY, 10 * ONE, 1), err::NOT_ADMITTED);
}

#[test]
fn membership_fallback_admits_only_behind_its_flag() {
    // SAS-only venue: a membership PDA is not a credential.
    let mut m = seeded(Opts { gate: GATE_SAS, ..Opts::default() });
    let mut t = m.unadmitted(0, 1_000 * ONE);
    assert_ok(&m.admit_member(&t.key(), m.now + DAY));
    t.cred = v::member_pda(&m.keys.venue, &t.key());
    assert_code(&m.swap(&t, BUY, 10 * ONE, 1), err::NOT_ADMITTED);

    // Membership-only venue: the PDA admits until revoked or expired; SAS does not.
    let mut m = seeded(Opts { gate: GATE_MEMBER, ..Opts::default() });
    let mut t = m.unadmitted(0, 1_000 * ONE);
    let sas = m.admit_sas(&t.key(), m.now + DAY);
    t.cred = sas;
    assert_code(&m.swap(&t, BUY, 10 * ONE, 1), err::NOT_ADMITTED);
    assert_ok(&m.admit_member(&t.key(), m.now + DAY));
    t.cred = v::member_pda(&m.keys.venue, &t.key());
    assert_ok(&m.swap(&t, BUY, 10 * ONE, 1));

    let ix = v::revoke_member(&m.issuer.pubkey(), &m.keys.venue, &t.key());
    let issuer = m.issuer.insecure_clone();
    assert_ok(&common::send(&mut m.svm, &[ix], &[&issuer]));
    assert_code(&m.swap(&t, BUY, 10 * ONE, 1), err::NOT_ADMITTED);

    assert_ok(&m.admit_member(&t.key(), m.now + 60));
    assert_ok(&m.swap(&t, BUY, 10 * ONE, 1));
    m.warp(61);
    assert_ok(&m.heartbeat());
    assert_code(&m.swap(&t, BUY, 10 * ONE, 1), err::NOT_ADMITTED);
}

#[test]
fn only_the_credential_issuer_grants_membership() {
    let mut m = seeded(Opts { gate: GATE_MEMBER, ..Opts::default() });
    let t = m.unadmitted(0, 0);
    let impostor = common::funded(&mut m.svm);
    let ix = v::grant_member(&impostor.pubkey(), &m.keys.venue, &t.key(), m.now + DAY);
    assert_code(&common::send(&mut m.svm, &[ix], &[&impostor]), err::UNAUTHORIZED);
}

#[test]
fn proceeds_only_reach_the_admitted_traders_own_accounts() {
    let mut m = seeded(Opts::default());
    let t = m.trader(0, 1_000 * ONE);
    let outsider = m.unadmitted(0, 0);
    // An admitted wallet cannot route bought stock (or sale USDC) to someone else's account.
    let ix = v::swap(&m.keys, &t.key(), &outsider.stock, &t.usdc, &t.cred, BUY, 10 * ONE, 1);
    assert_code(&common::send(&mut m.svm, &[ix], &[&t.kp]), err::INVALID_ACCOUNT);
    let ix = v::swap(&m.keys, &t.key(), &t.stock, &outsider.usdc, &t.cred, BUY, 10 * ONE, 1);
    assert_code(&common::send(&mut m.svm, &[ix], &[&t.kp]), err::INVALID_ACCOUNT);
    assert_eq!(m.balance(&outsider.stock), 0);
}

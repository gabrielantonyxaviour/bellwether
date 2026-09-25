//! Requirement: a third-party-tokenized symbol cannot activate before 30 days after the
//! recorded issuer-notice receipt, or after an objection; an issuer-sponsored symbol
//! activates immediately.
mod common;

use {
    common::{
        assert_code, assert_ok, err,
        market::{Market, Opts, Trader, ONE},
        venue::{self as v, BUY},
        DAY,
    },
    litesvm::types::TransactionResult,
    solana_signer::Signer,
};

const S_ACTIVE: usize = 4;
const S_OBJECTED: usize = 6;
const S_NOTICE_AT: usize = 152;

/// An inactive market (seeded while inactive — deposits are allowed before listing).
fn inactive(sponsored: bool) -> (Market, Trader) {
    let mut m = Market::with(Opts { sponsored, activate: false, ..Opts::default() });
    let lp = m.trader(1_000 * ONE, 20_000 * ONE);
    assert_ok(&m.add(&lp, 1_000 * ONE, 20_000 * ONE, 1));
    let t = m.trader(0, 1_000 * ONE);
    (m, t)
}

fn activate(m: &mut Market) -> TransactionResult {
    let ix = v::activate_pool(&m.admin.pubkey(), &m.keys.venue, &m.keys.symbol);
    m.as_admin(ix)
}
fn notice(m: &mut Market, received_at: i64) -> TransactionResult {
    let ix = v::record_issuer_notice(&m.admin.pubkey(), &m.keys.venue, &m.keys.symbol, received_at);
    m.as_admin(ix)
}
fn objection(m: &mut Market) -> TransactionResult {
    let ix = v::record_objection(&m.admin.pubkey(), &m.keys.venue, &m.keys.symbol);
    m.as_admin(ix)
}
fn at(m: &mut Market, t: i64) {
    m.set_time(t);
    assert_ok(&m.heartbeat());
}

#[test]
fn third_party_symbol_cannot_activate_before_thirty_days_after_notice_receipt() {
    let (mut m, mut t) = inactive(false);
    assert_code(&m.swap(&t, BUY, 10 * ONE, 1), err::NOT_ACTIVE);
    assert_code(&activate(&mut m), err::NOTICE_WINDOW_OPEN); // no notice recorded yet

    let received = m.now;
    assert_ok(&notice(&mut m, received));
    let s = m.account_data(&m.keys.symbol);
    assert_eq!(i64::from_le_bytes(s[S_NOTICE_AT..S_NOTICE_AT + 8].try_into().unwrap()), received);
    assert_code(&activate(&mut m), err::NOTICE_WINDOW_OPEN);
    at(&mut m, received + 30 * DAY - 1);
    assert_code(&activate(&mut m), err::NOTICE_WINDOW_OPEN);

    at(&mut m, received + 30 * DAY);
    assert_ok(&activate(&mut m));
    assert_eq!(m.account_data(&m.keys.symbol)[S_ACTIVE], 1);
    t.cred = m.admit_sas(&t.key(), m.now + DAY);
    assert_ok(&m.swap(&t, BUY, 10 * ONE, 1));
}

#[test]
fn an_objection_blocks_activation() {
    let (mut m, _) = inactive(false);
    let received = m.now;
    assert_ok(&notice(&mut m, received));
    at(&mut m, received + 10 * DAY);
    assert_ok(&objection(&mut m));
    assert_eq!(m.account_data(&m.keys.symbol)[S_OBJECTED], 1);
    at(&mut m, received + 31 * DAY);
    assert_code(&activate(&mut m), err::OBJECTED);
    assert_eq!(m.account_data(&m.keys.symbol)[S_ACTIVE], 0);
}

#[test]
fn issuer_sponsored_symbol_activates_immediately() {
    let (mut m, t) = inactive(true);
    assert_code(&m.swap(&t, BUY, 10 * ONE, 1), err::NOT_ACTIVE);
    assert_ok(&activate(&mut m));
    assert_ok(&m.swap(&t, BUY, 10 * ONE, 1));
    // Issuer notice and objection concern third-party tokens only.
    let now = m.now;
    assert_code(&notice(&mut m, now), err::INVALID_ARGUMENT);
    assert_code(&objection(&mut m), err::INVALID_ARGUMENT);
}

#[test]
fn notice_records_are_the_admins_and_cannot_be_future_dated() {
    let (mut m, _) = inactive(false);
    let ix = v::record_issuer_notice(&m.relay.pubkey(), &m.keys.venue, &m.keys.symbol, m.now);
    assert_code(&m.as_relay(ix), err::UNAUTHORIZED);
    let ix = v::activate_pool(&m.data.pubkey(), &m.keys.venue, &m.keys.symbol);
    assert_code(&m.as_data(ix), err::UNAUTHORIZED);
    let now = m.now;
    assert_code(&notice(&mut m, now + 60), err::INVALID_ARGUMENT);
    assert_ok(&notice(&mut m, now));
    assert_code(&notice(&mut m, now - DAY), err::ALREADY_INITIALIZED);
}

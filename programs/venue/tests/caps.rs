//! Requirement: a swap that would push shares_traded_today past cap_shares fails CapReached;
//! the counter resets at the trade-date cutoff; the 1st recorded breach leaves trading on with
//! a warning, the 2nd pauses the symbol for 3 months and swaps fail Paused until then.
mod common;

use {
    common::{
        assert_code, assert_ok, err,
        market::{Market, Opts, Trader, ONE},
        ts,
        venue::{self as v, BUY, SELL},
        DAY,
    },
    solana_signer::Signer,
};

const S_BREACHES: usize = 7;
const S_TRADE_DATE: usize = 112;
const S_TRADED: usize = 120;
const S_PAUSED_UNTIL: usize = 128;
const PAUSE: i64 = 92 * DAY; // never shorter than three calendar months

/// A market with a 100-share daily budget and a trader holding 1,000 shares.
fn capped() -> (Market, Trader) {
    let mut m = Market::with(Opts { cap_shares: 100 * ONE, ..Opts::default() });
    let lp = m.trader(1_000 * ONE, 20_000 * ONE);
    assert_ok(&m.add(&lp, 1_000 * ONE, 20_000 * ONE, 1));
    let t = m.trader(1_000 * ONE, 100_000 * ONE);
    (m, t)
}

fn u64_at(d: &[u8], o: usize) -> u64 {
    u64::from_le_bytes(d[o..o + 8].try_into().unwrap())
}

fn at(m: &mut Market, t: i64) {
    m.set_time(t);
    assert_ok(&m.heartbeat());
}

#[test]
fn swap_past_the_daily_share_budget_fails_cap_reached() {
    let (mut m, t) = capped();
    assert_ok(&m.swap(&t, SELL, 60 * ONE, 1));
    assert_code(&m.swap(&t, SELL, 40 * ONE + 1, 1), err::CAP_REACHED);
    assert_ok(&m.swap(&t, SELL, 40 * ONE, 1));
    assert_eq!(u64_at(&m.account_data(&m.keys.symbol), S_TRADED), 100 * ONE);
    assert_code(&m.swap(&t, SELL, 1, 1), err::CAP_REACHED);
    // The stock leg of a buy counts too.
    assert_code(&m.swap(&t, BUY, 20 * ONE, 1), err::CAP_REACHED);
}

#[test]
fn a_buy_is_measured_by_the_shares_it_would_deliver() {
    let (mut m, t) = capped();
    // ~$20/share: 2,500 USDC would deliver well over 100 shares.
    assert_code(&m.swap(&t, BUY, 2_500 * ONE, 1), err::CAP_REACHED);
    assert_ok(&m.swap(&t, BUY, 1_500 * ONE, 1));
}

#[test]
fn counter_resets_at_the_trade_date_cutoff() {
    let (mut m, t) = capped();
    assert_ok(&m.swap(&t, SELL, 100 * ONE, 1));
    let day0 = u64_at(&m.account_data(&m.keys.symbol), S_TRADE_DATE);
    // 04:00 ET (08:00 UTC during EDT) starts Tuesday's trade date, not midnight.
    at(&mut m, ts(2026, 10, 20, 7, 59));
    assert_code(&m.swap(&t, SELL, ONE, 1), err::CAP_REACHED);
    at(&mut m, ts(2026, 10, 20, 8, 0));
    assert_ok(&m.swap(&t, SELL, 100 * ONE, 1));
    let s = m.account_data(&m.keys.symbol);
    assert_eq!(u64_at(&s, S_TRADE_DATE), day0 + 1);
    assert_eq!(u64_at(&s, S_TRADED), 100 * ONE);
}

#[test]
fn weekend_volume_belongs_to_fridays_trade_date() {
    let (mut m, t) = capped();
    at(&mut m, ts(2026, 10, 23, 15, 0)); // Friday
    assert_ok(&m.swap(&t, SELL, 100 * ONE, 1));
    at(&mut m, ts(2026, 10, 24, 12, 0)); // Saturday
    assert_code(&m.swap(&t, SELL, ONE, 1), err::CAP_REACHED);
    at(&mut m, ts(2026, 10, 26, 7, 59)); // Monday before the cutoff
    assert_code(&m.swap(&t, SELL, ONE, 1), err::CAP_REACHED);
    at(&mut m, ts(2026, 10, 26, 8, 0)); // Monday's trade date
    assert_ok(&m.swap(&t, SELL, ONE, 1));
}

#[test]
fn share_units_follow_the_data_authoritys_multiplier() {
    let (mut m, t) = capped();
    // One token = two shares: a 100-share budget admits 50 tokens.
    let ix = v::set_cap(&m.data.pubkey(), &m.keys.venue, &m.keys.symbol, 100 * ONE, 4_000 * ONE, 2, 1);
    assert_ok(&m.as_data(ix));
    assert_ok(&m.swap(&t, SELL, 50 * ONE, 1));
    assert_code(&m.swap(&t, SELL, 1, 1), err::CAP_REACHED);
}

#[test]
fn an_unset_budget_fails_closed() {
    let (mut m, t) = capped();
    assert_ok(&m.set_cap(0));
    assert_code(&m.swap(&t, SELL, 1, 1), err::CAP_REACHED);
}

#[test]
fn first_breach_warns_second_pauses_for_three_months() {
    let (mut m, mut t) = capped();
    let breach = |m: &mut Market, when: i64| {
        let ix = v::record_breach(&m.data.pubkey(), &m.keys.venue, &m.keys.symbol, when);
        m.as_data(ix)
    };
    let now = m.now;
    assert_ok(&breach(&mut m, now));
    let s = m.account_data(&m.keys.symbol);
    assert_eq!((s[S_BREACHES], u64_at(&s, S_PAUSED_UNTIL)), (1, 0), "first breach: warning only");
    assert_ok(&m.swap(&t, SELL, ONE, 1));

    let second = m.now;
    assert_ok(&breach(&mut m, second));
    let s = m.account_data(&m.keys.symbol);
    assert_eq!(s[S_BREACHES], 2);
    assert_eq!(u64_at(&s, S_PAUSED_UNTIL) as i64, second + PAUSE);
    assert_code(&m.swap(&t, SELL, ONE, 1), err::PAUSED);
    assert_code(&m.swap(&t, BUY, ONE, 1), err::PAUSED);

    at(&mut m, second + 91 * DAY);
    t.cred = m.admit_sas(&t.key(), m.now + 30 * DAY); // renew the 30-day credential
    assert_code(&m.swap(&t, SELL, ONE, 1), err::PAUSED);
    at(&mut m, second + PAUSE);
    assert_ok(&m.swap(&t, SELL, ONE, 1));
}

#[test]
fn breach_reporting_is_the_data_authoritys_and_cannot_be_future_dated() {
    let (mut m, _) = capped();
    let ix = v::record_breach(&m.admin.pubkey(), &m.keys.venue, &m.keys.symbol, m.now);
    assert_code(&m.as_admin(ix), err::UNAUTHORIZED);
    let ix = v::set_cap(&m.relay.pubkey(), &m.keys.venue, &m.keys.symbol, 1, 1, 1, 1);
    assert_code(&m.as_relay(ix), err::UNAUTHORIZED);
    let ix = v::record_breach(&m.data.pubkey(), &m.keys.venue, &m.keys.symbol, m.now + 60);
    assert_code(&m.as_data(ix), err::INVALID_ARGUMENT);
}

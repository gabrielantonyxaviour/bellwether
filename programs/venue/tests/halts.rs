//! Requirements: a halted symbol refuses swap and add_liquidity (TradingHalted) while
//! remove_liquidity succeeds, and clearing the halt with a fresh heartbeat restores trading;
//! a heartbeat older than heartbeat_max_age makes swaps fail HaltDataStale (fail closed).
mod common;

use {
    common::{
        assert_code, assert_ok, err,
        market::{Market, Trader, ONE},
        venue::{self as v, ticker, BUY, SELL},
    },
    litesvm::types::TransactionResult,
    solana_signer::Signer,
};

const S_HALTED: usize = 5;
const S_HALT_REASON: usize = 16;
const S_HEARTBEAT: usize = 136;
const S_SEQ: usize = 144;
const S_HALTED_AT: usize = 160;

fn open_market() -> (Market, Trader, Trader) {
    let mut m = Market::new();
    let lp = m.trader(1_000 * ONE, 20_000 * ONE);
    assert_ok(&m.add(&lp, 500 * ONE, 10_000 * ONE, 1));
    let t = m.trader(10 * ONE, 1_000 * ONE);
    (m, lp, t)
}

fn halt(m: &mut Market, reason: &str, feed_ts: i64) -> TransactionResult {
    m.seq += 1;
    let ix = v::set_halt(&m.relay.pubkey(), &m.keys.venue, &m.keys.symbol, m.seq, reason, feed_ts);
    m.as_relay(ix)
}

fn clear(m: &mut Market) -> TransactionResult {
    m.seq += 1;
    let ix = v::clear_halt(&m.relay.pubkey(), &m.keys.venue, &m.keys.symbol, m.seq);
    m.as_relay(ix)
}

fn symbol(m: &Market) -> Vec<u8> {
    m.account_data(&m.keys.symbol)
}

fn i64_at(d: &[u8], o: usize) -> i64 {
    i64::from_le_bytes(d[o..o + 8].try_into().unwrap())
}

#[test]
fn halted_symbol_refuses_swaps_and_deposits_but_allows_withdrawals() {
    let (mut m, lp, t) = open_market();
    assert_ok(&m.swap(&t, BUY, 10 * ONE, 1));

    let feed_ts = m.now - 42;
    assert_ok(&halt(&mut m, "T1", feed_ts));
    let s = symbol(&m);
    assert_eq!(s[S_HALTED], 1);
    assert_eq!(&s[S_HALT_REASON..S_HALT_REASON + 8], &ticker("T1"));
    assert_eq!(i64_at(&s, S_HALTED_AT), feed_ts);

    assert_code(&m.swap(&t, BUY, 10 * ONE, 1), err::TRADING_HALTED);
    assert_code(&m.swap(&t, SELL, ONE, 1), err::TRADING_HALTED);
    assert_code(&m.add(&lp, 10 * ONE, 200 * ONE, 1), err::TRADING_HALTED);
    let before = m.lp_shares(&lp.key());
    assert_ok(&m.remove(&lp, before / 10, 1, 1));
    assert_eq!(m.lp_shares(&lp.key()), before - before / 10);
}

#[test]
fn clearing_the_halt_with_a_fresh_heartbeat_restores_trading() {
    let (mut m, lp, t) = open_market();
    let now = m.now;
    assert_ok(&halt(&mut m, "LUDP", now));
    // The halt outlives the heartbeat window; the relay's clear is itself a fresh heartbeat.
    m.warp(600);
    assert_code(&m.swap(&t, BUY, 10 * ONE, 1), err::TRADING_HALTED);
    assert_ok(&clear(&mut m));
    let s = symbol(&m);
    assert_eq!(s[S_HALTED], 0);
    assert_eq!(i64_at(&s, S_HEARTBEAT), m.now);
    assert_ok(&m.swap(&t, BUY, 10 * ONE, 1));
    assert_ok(&m.add(&lp, 10 * ONE, 200 * ONE, 1));
}

#[test]
fn only_the_relay_authority_moves_halt_state() {
    let (mut m, _, t) = open_market();
    let ix = v::set_halt(&m.admin.pubkey(), &m.keys.venue, &m.keys.symbol, 99, "T1", m.now);
    assert_code(&m.as_admin(ix), err::UNAUTHORIZED);
    let ix = v::heartbeat(&m.data.pubkey(), &m.keys.venue, &m.keys.symbol, 99);
    assert_code(&m.as_data(ix), err::UNAUTHORIZED);
    assert_ok(&m.swap(&t, BUY, 10 * ONE, 1));
}

#[test]
fn relay_messages_cannot_replay_or_rewind() {
    let (mut m, _, t) = open_market();
    let now = m.now;
    assert_ok(&halt(&mut m, "T12", now));
    let newest = m.seq;
    // A delayed clear from before the halt (lower sequence) cannot lift it.
    let ix = v::clear_halt(&m.relay.pubkey(), &m.keys.venue, &m.keys.symbol, newest - 1);
    assert_code(&m.as_relay(ix), err::STALE_SEQUENCE);
    let ix = v::heartbeat(&m.relay.pubkey(), &m.keys.venue, &m.keys.symbol, newest);
    assert_code(&m.as_relay(ix), err::STALE_SEQUENCE);
    assert_eq!(u64::from_le_bytes(symbol(&m)[S_SEQ..S_SEQ + 8].try_into().unwrap()), newest);
    assert_code(&m.swap(&t, BUY, 10 * ONE, 1), err::TRADING_HALTED);
}

#[test]
fn stale_heartbeat_fails_closed_even_when_no_halt_is_set() {
    let (mut m, lp, t) = open_market();
    let max = m.params.heartbeat_max_age;
    m.warp(max); // exactly at the limit is still fresh
    assert_ok(&m.swap(&t, BUY, 10 * ONE, 1));
    m.warp(1); // one second past it is stale
    assert_eq!(symbol(&m)[S_HALTED], 0, "no halt is set");
    assert_code(&m.swap(&t, BUY, 10 * ONE, 1), err::HALT_DATA_STALE);
    assert_code(&m.swap(&t, SELL, ONE, 1), err::HALT_DATA_STALE);
    assert_code(&m.add(&lp, 10 * ONE, 200 * ONE, 1), err::HALT_DATA_STALE);
    assert_ok(&m.remove(&lp, 1_000, 0, 0));
    assert_ok(&m.heartbeat());
    assert_ok(&m.swap(&t, BUY, 10 * ONE, 1));
}

#[test]
fn stale_after_relay_silence_of_hours() {
    let (mut m, _, t) = open_market();
    m.warp(6 * 3600);
    assert_code(&m.swap(&t, BUY, 10 * ONE, 1), err::HALT_DATA_STALE);
}

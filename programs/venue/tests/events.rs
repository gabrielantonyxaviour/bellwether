//! Requirement: every successful swap emits exactly one tape event whose fields decode to
//! pair, price, size, time, direction, pool and program id.
mod common;

use {
    common::{
        assert_ok, err,
        market::{Market, DECIMALS, ONE},
        venue::{ticker, BUY, SELL},
        PROGRAM_ID,
    },
    litesvm::types::TransactionResult,
};

/// The documented tape event (sol_log_data, one slice, 228 bytes, little-endian).
pub const EVENT_LEN: usize = 228;

struct Trade {
    symbol: [u8; 8],
    stock_mint: [u8; 32],
    usdc_mint: [u8; 32],
    pool: [u8; 32],
    program: [u8; 32],
    direction: u8,
    stock_decimals: u8,
    usdc_decimals: u8,
    stock_amount: u64,
    usdc_amount: u64,
    price: u64,
    time: i64,
    size_shares: u64,
    reserve_stock: u64,
    reserve_usdc: u64,
    fee: u64,
}

fn b64(s: &str) -> Vec<u8> {
    let val = |c: u8| match c {
        b'A'..=b'Z' => c - b'A',
        b'a'..=b'z' => c - b'a' + 26,
        b'0'..=b'9' => c - b'0' + 52,
        b'+' => 62,
        b'/' => 63,
        _ => panic!("bad base64"),
    };
    let bytes: Vec<u8> = s.bytes().filter(|&c| c != b'=').map(val).collect();
    let mut out = Vec::new();
    for chunk in bytes.chunks(4) {
        let mut n = 0u32;
        for (i, &c) in chunk.iter().enumerate() {
            n |= (c as u32) << (18 - 6 * i);
        }
        out.extend_from_slice(&n.to_be_bytes()[1..chunk.len()]);
    }
    out
}

fn logs(res: &TransactionResult) -> &Vec<String> {
    match res {
        Ok(m) => &m.logs,
        Err(f) => &f.meta.logs,
    }
}

fn events(res: &TransactionResult) -> Vec<Vec<u8>> {
    logs(res).iter().filter_map(|l| l.strip_prefix("Program data: ")).map(|d| {
        let parts: Vec<Vec<u8>> = d.split(' ').map(b64).collect();
        assert_eq!(parts.len(), 1, "the event is one slice");
        parts.into_iter().next().unwrap()
    }).collect()
}

fn decode(e: &[u8]) -> Trade {
    assert_eq!(e.len(), EVENT_LEN);
    assert_eq!(&e[0..8], b"BWTRADE1");
    let k = |o: usize| -> [u8; 32] { e[o..o + 32].try_into().unwrap() };
    let u = |o: usize| u64::from_le_bytes(e[o..o + 8].try_into().unwrap());
    Trade {
        symbol: e[8..16].try_into().unwrap(),
        stock_mint: k(16),
        usdc_mint: k(48),
        pool: k(80),
        program: k(112),
        direction: e[144],
        stock_decimals: e[145],
        usdc_decimals: e[146],
        stock_amount: u(148),
        usdc_amount: u(156),
        price: u(164),
        time: u(172) as i64,
        size_shares: u(180),
        reserve_stock: u(204),
        reserve_usdc: u(212),
        fee: u(220),
    }
}

fn check_pair(m: &Market, t: &Trade) {
    assert_eq!(t.symbol, ticker("FWDI"));
    assert_eq!(&t.stock_mint, m.keys.stock_mint.as_ref());
    assert_eq!(&t.usdc_mint, m.keys.usdc_mint.as_ref());
    assert_eq!(&t.pool, m.keys.pool.as_ref());
    assert_eq!(&t.program, PROGRAM_ID.as_ref());
    assert_eq!((t.stock_decimals, t.usdc_decimals), (DECIMALS, DECIMALS));
}

#[test]
fn every_swap_emits_exactly_one_decodable_tape_event() {
    let mut m = Market::new();
    let lp = m.trader(1_000 * ONE, 20_000 * ONE);
    assert_ok(&m.add(&lp, 1_000 * ONE, 20_000 * ONE, 1));
    let t = m.trader(0, 2_000 * ONE);

    let at = common::ts(2026, 10, 19, 15, 45);
    m.set_time(at);
    assert_ok(&m.heartbeat());
    let res = m.swap(&t, BUY, 1_000 * ONE, 1);
    assert_ok(&res);
    let evs = events(&res);
    assert_eq!(evs.len(), 1, "exactly one event per swap");
    let buy = decode(&evs[0]);
    check_pair(&m, &buy);
    let got = m.balance(&t.stock);
    assert_eq!(buy.direction, BUY);
    assert_eq!((buy.stock_amount, buy.usdc_amount, buy.size_shares), (got, 1_000 * ONE, got));
    assert_eq!(buy.price, (1_000 * ONE as u128 * ONE as u128 / got as u128) as u64, "USDC units per whole share");
    assert!(buy.price > 20 * ONE && buy.price < 22 * ONE, "price {} near $21", buy.price);
    assert_eq!(buy.time, at);
    assert_eq!(buy.fee, 3 * ONE);
    assert_eq!((buy.reserve_stock, buy.reserve_usdc), m.reserves());

    m.warp(90);
    assert_ok(&m.heartbeat());
    let res = m.swap(&t, SELL, got / 2, 1);
    assert_ok(&res);
    let evs = events(&res);
    assert_eq!(evs.len(), 1);
    let sell = decode(&evs[0]);
    check_pair(&m, &sell);
    assert_eq!(sell.direction, SELL);
    assert_eq!(sell.stock_amount, got / 2);
    assert_eq!(sell.usdc_amount, m.balance(&t.usdc) - 1_000 * ONE);
    assert_eq!(sell.time, at + 90);
    assert_eq!((sell.reserve_stock, sell.reserve_usdc), m.reserves());
}

#[test]
fn rejected_swaps_and_liquidity_changes_emit_no_trade_event() {
    let mut m = Market::new();
    let lp = m.trader(1_000 * ONE, 20_000 * ONE);
    let res = m.add(&lp, 1_000 * ONE, 20_000 * ONE, 1);
    assert_ok(&res);
    assert!(events(&res).is_empty());

    let t = m.trader(0, 100 * ONE);
    let res = m.swap(&t, BUY, 100 * ONE, u64::MAX);
    common::assert_code(&res, err::SLIPPAGE_EXCEEDED);
    assert!(events(&res).is_empty());

    let res = m.remove(&lp, 1_000, 0, 0);
    assert_ok(&res);
    assert!(events(&res).is_empty());
}

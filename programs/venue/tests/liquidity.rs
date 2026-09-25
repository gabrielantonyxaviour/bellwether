//! Requirement: add and remove liquidity require admission; LP positions have no transfer
//! path; removing more than owned fails.
mod common;

use {
    common::{
        assert_code, assert_ok, err,
        market::{Market, Opts, ONE},
        send, venue as v, PROGRAM_ID,
    },
    solana_instruction::Instruction,
    solana_instruction_error::InstructionError,
    solana_transaction_error::TransactionError,
};

const MIN_LIQUIDITY: u64 = 1_000;

fn isqrt(n: u128) -> u128 {
    let mut x = (n as f64).sqrt() as u128;
    while x * x > n {
        x -= 1;
    }
    while (x + 1) * (x + 1) <= n {
        x += 1;
    }
    x
}

#[test]
fn admitted_wallets_add_and_remove_liquidity_pro_rata() {
    let mut m = Market::new();
    let a = m.trader(1_000 * ONE, 20_000 * ONE);
    assert_ok(&m.add(&a, 1_000 * ONE, 20_000 * ONE, 1));
    let total = isqrt(1_000 * ONE as u128 * 20_000 * ONE as u128) as u64;
    assert_eq!(m.lp_total(), total);
    assert_eq!(m.lp_shares(&a.key()), total - MIN_LIQUIDITY, "first deposit locks MIN_LIQUIDITY");
    assert_eq!(m.reserves(), (1_000 * ONE, 20_000 * ONE));

    // A second LP offers more USDC than the ratio needs; only the ratio is taken.
    let b = m.trader(100 * ONE, 5_000 * ONE);
    let lp = total / 10;
    let need_s = (lp as u128 * (1_000 * ONE) as u128).div_ceil(total as u128) as u64;
    let need_u = (lp as u128 * (20_000 * ONE) as u128).div_ceil(total as u128) as u64;
    assert_ok(&m.add(&b, 100 * ONE, 5_000 * ONE, lp));
    assert_eq!(m.lp_shares(&b.key()), lp);
    assert_eq!(m.balance(&b.stock), 100 * ONE - need_s);
    assert_eq!(m.balance(&b.usdc), 5_000 * ONE - need_u);

    let (rs, ru, t) = (m.reserves().0 as u128, m.reserves().1 as u128, m.lp_total() as u128);
    let (out_s, out_u) = ((lp as u128 * rs / t) as u64, (lp as u128 * ru / t) as u64);
    assert_ok(&m.remove(&b, lp, out_s, out_u));
    assert_eq!(m.lp_shares(&b.key()), 0);
    assert_eq!(m.lp_total(), total);
    assert_eq!(m.balance(&b.stock), 100 * ONE - need_s + out_s);
    assert_eq!(m.balance(&b.usdc), 5_000 * ONE - need_u + out_u);
}

#[test]
fn deposit_below_min_lp_is_refused() {
    let mut m = Market::new();
    let a = m.trader(1_000 * ONE, 20_000 * ONE);
    assert_code(&m.add(&a, 1_000 * ONE, 20_000 * ONE, u64::MAX), err::SLIPPAGE_EXCEEDED);
}

#[test]
fn unadmitted_wallet_cannot_add_liquidity() {
    let mut m = Market::new();
    let t = m.unadmitted(1_000 * ONE, 20_000 * ONE);
    assert_code(&m.add(&t, 1_000 * ONE, 20_000 * ONE, 1), err::NOT_ADMITTED);
}

#[test]
fn wallet_whose_credential_was_revoked_cannot_remove_liquidity() {
    let mut m = Market::new();
    let a = m.trader(1_000 * ONE, 20_000 * ONE);
    assert_ok(&m.add(&a, 1_000 * ONE, 20_000 * ONE, 1));
    m.close_account(&a.cred);
    assert_code(&m.remove(&a, 1_000, 0, 0), err::NOT_ADMITTED);
}

#[test]
fn removing_more_than_owned_fails() {
    let mut m = Market::new();
    let a = m.trader(1_000 * ONE, 20_000 * ONE);
    assert_ok(&m.add(&a, 1_000 * ONE, 20_000 * ONE, 1));
    let owned = m.lp_shares(&a.key());
    assert_code(&m.remove(&a, owned + 1, 0, 0), err::INSUFFICIENT_SHARES);
    assert_code(&m.remove(&a, 0, 0, 0), err::INVALID_AMOUNT);
    assert_ok(&m.remove(&a, owned, 0, 0));
    assert_code(&m.remove(&a, 1, 0, 0), err::INSUFFICIENT_SHARES);
}

#[test]
fn lp_position_has_no_transfer_path() {
    let mut m = Market::new();
    let a = m.trader(1_000 * ONE, 20_000 * ONE);
    assert_ok(&m.add(&a, 1_000 * ONE, 20_000 * ONE, 1));
    let pos_a = v::lp_pda(&m.keys.pool, &a.key());

    // The position is venue-program state, not a token: no token program can move it.
    let acct = m.svm.get_account(&pos_a).unwrap();
    assert_eq!(acct.owner, PROGRAM_ID);
    assert_eq!(&acct.data[40..72], a.key().as_ref(), "position records its owner");

    // Another admitted wallet cannot withdraw from, or deposit into, A's position.
    let b = m.trader(100 * ONE, 2_000 * ONE);
    let ix = v::remove_liquidity(&m.keys, &b.key(), &pos_a, &b.stock, &b.usdc, &b.cred, 1_000, 0, 0);
    assert_code(&send(&mut m.svm, &[ix], &[&b.kp]), err::INVALID_ACCOUNT);
    let mut ix = v::add_liquidity(&m.keys, &b.key(), &b.stock, &b.usdc, &b.cred, 10 * ONE, 200 * ONE, 1);
    ix.accounts[4].pubkey = pos_a;
    assert_code(&send(&mut m.svm, &[ix], &[&b.kp]), err::INVALID_ACCOUNT);
    assert_eq!(m.lp_shares(&b.key()), 0);

    // No instruction outside the documented set exists, so none can reassign a position.
    let documented: Vec<u8> = (0..=8).chain(16..=23).collect();
    let payer = m.payer.insecure_clone();
    for disc in 0..=255u8 {
        let probe = Instruction::new_with_bytes(PROGRAM_ID, &[disc], vec![]);
        let res = send(&mut m.svm, &[probe], &[&payer]);
        let recognized = match res {
            Err(f) => f.err != TransactionError::InstructionError(0, InstructionError::InvalidInstructionData),
            Ok(_) => true,
        };
        if recognized {
            assert!(documented.contains(&disc), "undocumented instruction {disc} exists");
        }
    }
}

#[test]
fn stock_vault_must_be_thawed_by_the_freeze_authority() {
    let mut m = Market::with(Opts { thaw_vault: false, ..Opts::default() });
    let a = m.trader(1_000 * ONE, 20_000 * ONE);
    assert_code(&m.add(&a, 1_000 * ONE, 20_000 * ONE, 1), err::TOKEN_ACCOUNT_FROZEN);
    let (payer, freeze) = (m.payer.insecure_clone(), m.stock_authority.insecure_clone());
    let (vault, mint) = (m.keys.stock_vault, m.keys.stock_mint);
    common::token::thaw(&mut m.svm, &payer, &vault, &mint, &freeze);
    assert_ok(&m.add(&a, 1_000 * ONE, 20_000 * ONE, 1));
    assert_eq!(m.reserves(), (1_000 * ONE, 20_000 * ONE));
}

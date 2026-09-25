//! Requirement: the instruction set contains no borrow, lend, margin or stock-issuance
//! instruction — checked three ways: the live dispatch table, the names it documents, and the
//! token instructions the program actually invokes across a full market lifecycle.
mod common;

use {
    common::{
        assert_ok,
        market::{Market, ONE},
        send,
        venue::{BUY, SELL},
        PROGRAM_ID,
    },
    litesvm::types::TransactionResult,
    solana_instruction::Instruction,
    solana_instruction_error::InstructionError,
    solana_transaction_error::TransactionError,
    std::path::Path,
};

/// The complete documented surface: discriminator → instruction.
const SURFACE: &[(u8, &str)] = &[
    (0, "init_venue"),
    (1, "register_symbol"),
    (2, "init_pool"),
    (3, "add_liquidity"),
    (4, "remove_liquidity"),
    (5, "swap"),
    (6, "grant_member"),
    (7, "revoke_member"),
    (8, "update_venue"),
    (16, "set_cap"),
    (17, "set_halt"),
    (18, "clear_halt"),
    (19, "heartbeat"),
    (20, "record_breach"),
    (21, "record_issuer_notice"),
    (22, "record_objection"),
    (23, "activate_pool"),
];

const CREDIT_OR_ISSUANCE: &[&str] = &[
    "borrow", "lend", "loan", "margin", "leverage", "credit", "collateral", "liquidate", "mint", "issue", "issuance",
];

#[test]
fn instruction_set_is_exactly_the_documented_venue_surface() {
    let mut m = Market::new();
    let payer = m.payer.insecure_clone();
    let mut recognized = Vec::new();
    for disc in 0..=255u8 {
        let probe = Instruction::new_with_bytes(PROGRAM_ID, &[disc], vec![]);
        let res = send(&mut m.svm, &[probe], &[&payer]);
        match res {
            Err(f) if f.err == TransactionError::InstructionError(0, InstructionError::InvalidInstructionData) => {}
            Err(f) => {
                assert_eq!(f.err, TransactionError::InstructionError(0, InstructionError::NotEnoughAccountKeys), "disc {disc}");
                recognized.push(disc);
            }
            Ok(_) => panic!("instruction {disc} succeeded with no accounts"),
        }
    }
    let documented: Vec<u8> = SURFACE.iter().map(|(d, _)| *d).collect();
    assert_eq!(recognized, documented);
}

#[test]
fn no_documented_instruction_is_credit_or_issuance() {
    for (_, name) in SURFACE {
        for word in name.split('_') {
            assert!(!CREDIT_OR_ISSUANCE.contains(&word), "{name} looks like credit or issuance");
        }
    }
}

fn token_instructions(res: &TransactionResult) -> Vec<String> {
    let logs = match res {
        Ok(m) => &m.logs,
        Err(f) => &f.meta.logs,
    };
    logs.iter().filter_map(|l| l.strip_prefix("Program log: Instruction: ")).map(str::to_string).collect()
}

#[test]
fn the_program_only_ever_moves_existing_tokens() {
    let mut m = Market::new();
    let lp = m.trader(1_000 * ONE, 20_000 * ONE);
    let t = m.trader(10 * ONE, 1_000 * ONE);
    let supply = |m: &Market| {
        let d = m.account_data(&m.keys.stock_mint);
        u64::from_le_bytes(d[36..44].try_into().unwrap())
    };
    let before = supply(&m);
    let mut invoked = Vec::new();
    for res in [
        m.add(&lp, 1_000 * ONE, 20_000 * ONE, 1),
        m.swap(&t, BUY, 100 * ONE, 1),
        m.swap(&t, SELL, 5 * ONE, 1),
        m.remove(&lp, 10_000, 0, 0),
    ] {
        assert_ok(&res);
        invoked.extend(token_instructions(&res));
    }
    assert!(!invoked.is_empty());
    assert!(invoked.iter().all(|i| i == "TransferChecked"), "token CPIs: {invoked:?}");
    assert_eq!(supply(&m), before, "stock supply never changes through the venue");
}

#[test]
fn program_source_has_no_mint_approve_or_lending_path() {
    let src = Path::new(env!("CARGO_MANIFEST_DIR")).join("src");
    let mut files = vec![src.clone()];
    let mut code = String::new();
    while let Some(p) = files.pop() {
        if p.is_dir() {
            files.extend(std::fs::read_dir(&p).unwrap().map(|e| e.unwrap().path()));
        } else if p.extension().is_some_and(|e| e == "rs") {
            for line in std::fs::read_to_string(&p).unwrap().lines() {
                if !line.trim_start().starts_with("//") {
                    code.push_str(&line.to_lowercase());
                    code.push('\n');
                }
            }
        }
    }
    for needle in ["mintto", "mint_to", "initializemint", "approve", "setauthority", "loan", "lend", "margin", "leverage", "collateral"] {
        assert!(!code.contains(needle), "program source mentions `{needle}`");
    }
}

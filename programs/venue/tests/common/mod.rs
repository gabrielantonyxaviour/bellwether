//! Black-box harness for the venue program: builds the release .so, loads it into LiteSVM
//! and speaks only the documented byte layouts, so these tests double as the client contract.
#![allow(dead_code)]

pub mod market;
pub mod token;
pub mod venue;

use {
    litesvm::{types::TransactionResult, LiteSVM},
    solana_address::Address,
    solana_clock::Clock,
    solana_instruction::Instruction,
    solana_instruction_error::InstructionError,
    solana_keypair::Keypair,
    solana_signer::Signer,
    solana_transaction::Transaction,
    solana_transaction_error::TransactionError,
    std::{path::PathBuf, process::Command, sync::OnceLock},
};

/// Test placeholder only. The deploy block generates the real program keypair; the program
/// never hard-codes its own id, so any id works here.
pub const PROGRAM_ID: Address = Address::from_str_const("BwM5QM4Ve5rpw34nMxAfso3nCiJvdnFuGQ4tuBP4Uc3P");
pub const SAS_ID: Address = Address::from_str_const("22zoJMtdu4tQc2PzL74ZUT7FrwgB1Udec8DdW4yw4BdG");
pub const TOKEN_2022: Address = Address::from_str_const("TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb");
pub const SPL_TOKEN: Address = Address::from_str_const("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA");
pub const SYSTEM: Address = Address::from_str_const("11111111111111111111111111111111");

/// Custom error codes, as documented for every client.
pub mod err {
    pub const NOT_ADMITTED: u32 = 6000;
    pub const TRADING_HALTED: u32 = 6001;
    pub const HALT_DATA_STALE: u32 = 6002;
    pub const NOT_ACTIVE: u32 = 6003;
    pub const PAUSED: u32 = 6004;
    pub const CAP_REACHED: u32 = 6005;
    pub const SLIPPAGE_EXCEEDED: u32 = 6006;
    pub const SYMBOL_CAP_REACHED: u32 = 6007;
    pub const NOTICE_WINDOW_OPEN: u32 = 6008;
    pub const OBJECTED: u32 = 6009;
    pub const UNAUTHORIZED: u32 = 6010;
    pub const INVALID_ACCOUNT: u32 = 6011;
    pub const INSUFFICIENT_SHARES: u32 = 6012;
    pub const STALE_SEQUENCE: u32 = 6013;
    pub const INVALID_AMOUNT: u32 = 6014;
    pub const ALREADY_INITIALIZED: u32 = 6015;
    pub const INVALID_ARGUMENT: u32 = 6016;
    /// Token program error code for a frozen account (SPL Token and Token-2022 alike).
    pub const TOKEN_ACCOUNT_FROZEN: u32 = 17;
}

pub const DAY: i64 = 86_400;

/// Unix seconds for a UTC civil date-time (Howard Hinnant's days_from_civil).
pub fn ts(y: i64, m: i64, d: i64, hh: i64, mm: i64) -> i64 {
    let y = if m <= 2 { y - 1 } else { y };
    let era = if y >= 0 { y } else { y - 399 } / 400;
    let yoe = y - era * 400;
    let doy = (153 * ((m + 9) % 12) + 2) / 5 + d - 1;
    let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
    (era * 146_097 + doe - 719_468) * DAY + hh * 3600 + mm * 60
}

/// Monday 2026-10-19 14:30 UTC: a business day, inside regular US hours.
pub fn base_time() -> i64 {
    ts(2026, 10, 19, 14, 30)
}

fn build_sbf_bin() -> PathBuf {
    let on_path = std::env::var_os("PATH")
        .into_iter()
        .flat_map(|p| std::env::split_paths(&p).collect::<Vec<_>>())
        .map(|d| d.join("cargo-build-sbf"))
        .find(|p| p.is_file());
    on_path.unwrap_or_else(|| {
        PathBuf::from(std::env::var("HOME").unwrap_or_default())
            .join(".local/share/solana/install/active_release/bin/cargo-build-sbf")
    })
}

/// Builds the release .so once per test process (incremental, so cheap when fresh) and
/// returns its bytes. Accept commands therefore never run against a stale binary.
pub fn program_bytes() -> &'static [u8] {
    static SO: OnceLock<Vec<u8>> = OnceLock::new();
    SO.get_or_init(|| {
        let dir = PathBuf::from(env!("CARGO_MANIFEST_DIR"));
        let mut cmd = Command::new(build_sbf_bin());
        cmd.arg("--manifest-path").arg(dir.join("Cargo.toml"));
        for var in [
            "RUSTUP_TOOLCHAIN", "RUSTC", "RUSTC_WRAPPER", "RUSTDOC", "RUSTFLAGS", "CARGO_TARGET_DIR",
            "CARGO_BUILD_TARGET", "CARGO_ENCODED_RUSTFLAGS", "CARGO_MAKEFLAGS", "MAKEFLAGS", "MFLAGS",
        ] {
            cmd.env_remove(var);
        }
        let out = cmd.output().expect("run cargo-build-sbf");
        assert!(
            out.status.success(),
            "cargo build-sbf failed:\n{}\n{}",
            String::from_utf8_lossy(&out.stdout),
            String::from_utf8_lossy(&out.stderr)
        );
        std::fs::read(dir.join("target/deploy/bellwether_venue.so")).expect("read .so")
    })
}

pub fn new_svm() -> LiteSVM {
    let mut svm = LiteSVM::new();
    svm.add_program(PROGRAM_ID, program_bytes()).expect("load program");
    svm
}

pub fn set_time(svm: &mut LiteSVM, unix: i64) {
    let mut clock: Clock = svm.get_sysvar();
    clock.unix_timestamp = unix;
    clock.slot += 1;
    svm.set_sysvar(&clock);
}

pub fn funded(svm: &mut LiteSVM) -> Keypair {
    let kp = Keypair::new();
    svm.airdrop(&kp.pubkey(), 100_000_000_000).expect("airdrop");
    kp
}

/// Sends `ixs` paid by the first signer, then expires the blockhash so an identical
/// follow-up transaction is not rejected as already processed.
pub fn send(svm: &mut LiteSVM, ixs: &[Instruction], signers: &[&Keypair]) -> TransactionResult {
    let tx = Transaction::new_signed_with_payer(ixs, Some(&signers[0].pubkey()), signers, svm.latest_blockhash());
    let res = svm.send_transaction(tx);
    svm.expire_blockhash();
    res
}

/// The custom error code a failed transaction carries, if any.
pub fn custom_code(res: &TransactionResult) -> Option<u32> {
    match res {
        Err(f) => match &f.err {
            TransactionError::InstructionError(_, InstructionError::Custom(c)) => Some(*c),
            _ => None,
        },
        Ok(_) => None,
    }
}

#[track_caller]
pub fn assert_ok(res: &TransactionResult) {
    if let Err(f) = res {
        panic!("expected success, got {:?}\n{}", f.err, f.meta.logs.join("\n"));
    }
}

#[track_caller]
pub fn assert_code(res: &TransactionResult, code: u32) {
    match res {
        Ok(m) => panic!("expected custom error {code}, but it succeeded\n{}", m.logs.join("\n")),
        Err(f) => assert_eq!(custom_code(res), Some(code), "wrong error {:?}\n{}", f.err, f.meta.logs.join("\n")),
    }
}

#[track_caller]
pub fn assert_instruction_error(res: &TransactionResult, expected: InstructionError) {
    match res {
        Ok(_) => panic!("expected {expected:?}, but it succeeded"),
        Err(f) => assert_eq!(f.err, TransactionError::InstructionError(0, expected), "{}", f.meta.logs.join("\n")),
    }
}

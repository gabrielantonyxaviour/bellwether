//! Token fixtures built from raw SPL Token / Token-2022 instructions, so the real bundled
//! token programs (not mocks) execute every transfer the venue makes.
#![allow(dead_code)]

use {
    super::{assert_ok, send, SPL_TOKEN, TOKEN_2022},
    litesvm::LiteSVM,
    solana_account::Account,
    solana_address::Address,
    solana_instruction::{AccountMeta, Instruction},
    solana_keypair::Keypair,
    solana_signer::Signer,
    solana_system_interface::instruction::create_account,
};

/// Base mint (82) padded to 165 + account-type byte + DefaultAccountState TLV (2+2+1).
pub const MINT_2022_FROZEN_LEN: usize = 171;
pub const MINT_LEN: usize = 82;
pub const ACCOUNT_LEN: usize = 165;

fn create(svm: &mut LiteSVM, payer: &Keypair, new: &Keypair, space: usize, owner: &Address, rest: Vec<Instruction>) {
    let lamports = svm.minimum_balance_for_rent_exemption(space);
    let mut ixs = vec![create_account(&payer.pubkey(), &new.pubkey(), lamports, space as u64, owner)];
    ixs.extend(rest);
    assert_ok(&send(svm, &ixs, &[payer, new]));
}

fn initialize_mint2(program: &Address, mint: &Address, decimals: u8, authority: &Address, freeze: &Address) -> Instruction {
    let mut data = vec![20, decimals];
    data.extend_from_slice(authority.as_ref());
    data.push(1);
    data.extend_from_slice(freeze.as_ref());
    Instruction::new_with_bytes(*program, &data, vec![AccountMeta::new(*mint, false)])
}

/// A Token-2022 stock mint that, like FWDI, creates every token account frozen
/// (DefaultAccountState = Frozen). `authority` is both mint and freeze authority.
pub fn stock_mint(svm: &mut LiteSVM, payer: &Keypair, authority: &Address, decimals: u8) -> Address {
    let mint = Keypair::new();
    let default_frozen = Instruction::new_with_bytes(TOKEN_2022, &[28, 0, 2], vec![AccountMeta::new(mint.pubkey(), false)]);
    let init = initialize_mint2(&TOKEN_2022, &mint.pubkey(), decimals, authority, authority);
    create(svm, payer, &mint, MINT_2022_FROZEN_LEN, &TOKEN_2022, vec![default_frozen, init]);
    mint.pubkey()
}

/// A classic SPL Token mint standing in for USDC.
pub fn usdc_mint(svm: &mut LiteSVM, payer: &Keypair, authority: &Address, decimals: u8) -> Address {
    let mint = Keypair::new();
    let init = initialize_mint2(&SPL_TOKEN, &mint.pubkey(), decimals, authority, authority);
    create(svm, payer, &mint, MINT_LEN, &SPL_TOKEN, vec![init]);
    mint.pubkey()
}

/// Writes an initialized, bare Token-2022 mint directly (for bulk symbol registration).
pub fn raw_stock_mint(svm: &mut LiteSVM, decimals: u8) -> Address {
    let mint = Address::new_unique();
    let mut data = vec![0u8; MINT_LEN];
    data[44] = decimals;
    data[45] = 1;
    let lamports = svm.minimum_balance_for_rent_exemption(MINT_LEN);
    svm.set_account(mint, Account { lamports, data, owner: TOKEN_2022, executable: false, rent_epoch: 0 })
        .expect("set mint");
    mint
}

pub fn token_account(svm: &mut LiteSVM, payer: &Keypair, mint: &Address, owner: &Address, program: &Address) -> Address {
    let acct = Keypair::new();
    let mut data = vec![18];
    data.extend_from_slice(owner.as_ref());
    let init = Instruction::new_with_bytes(
        *program,
        &data,
        vec![AccountMeta::new(acct.pubkey(), false), AccountMeta::new_readonly(*mint, false)],
    );
    create(svm, payer, &acct, ACCOUNT_LEN, program, vec![init]);
    acct.pubkey()
}

fn authority_ix(program: &Address, tag: u8, account: &Address, mint: &Address, authority: &Address) -> Instruction {
    Instruction::new_with_bytes(
        *program,
        &[tag],
        vec![AccountMeta::new(*account, false), AccountMeta::new_readonly(*mint, false), AccountMeta::new_readonly(*authority, true)],
    )
}

/// The stock's freeze authority thaws a token account (the issuer's allowlist step).
pub fn thaw(svm: &mut LiteSVM, payer: &Keypair, account: &Address, mint: &Address, freeze: &Keypair) {
    let ix = authority_ix(&TOKEN_2022, 11, account, mint, &freeze.pubkey());
    assert_ok(&send(svm, &[ix], &[payer, freeze]));
}

pub fn freeze(svm: &mut LiteSVM, payer: &Keypair, account: &Address, mint: &Address, freeze: &Keypair) {
    let ix = authority_ix(&TOKEN_2022, 10, account, mint, &freeze.pubkey());
    assert_ok(&send(svm, &[ix], &[payer, freeze]));
}

pub fn mint_to(svm: &mut LiteSVM, payer: &Keypair, program: &Address, mint: &Address, dest: &Address, authority: &Keypair, amount: u64) {
    let mut data = vec![7];
    data.extend_from_slice(&amount.to_le_bytes());
    let ix = Instruction::new_with_bytes(
        *program,
        &data,
        vec![AccountMeta::new(*mint, false), AccountMeta::new(*dest, false), AccountMeta::new_readonly(authority.pubkey(), true)],
    );
    assert_ok(&send(svm, &[ix], &[payer, authority]));
}

pub fn balance(svm: &LiteSVM, account: &Address) -> u64 {
    let data = svm.get_account(account).expect("token account").data;
    u64::from_le_bytes(data[64..72].try_into().unwrap())
}

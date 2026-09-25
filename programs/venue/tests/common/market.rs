//! A ready venue: one Token-2022 stock (frozen by default, like FWDI) against a classic SPL
//! USDC, with a registered symbol, an initialised pool, a fresh heartbeat and a daily cap.
#![allow(dead_code)]

use {
    super::{
        assert_ok, base_time, funded, new_svm, send, set_time, token, venue as v, venue::PoolKeys, venue::VenueParams,
        SAS_ID, SPL_TOKEN, TOKEN_2022,
    },
    litesvm::{types::TransactionResult, LiteSVM},
    solana_account::Account,
    solana_address::Address,
    solana_instruction::Instruction,
    solana_keypair::Keypair,
    solana_signer::Signer,
};

pub const DECIMALS: u8 = 6;
pub const ONE: u64 = 1_000_000; // one whole token (stock share or USDC) in base units

pub struct Opts {
    pub gate: u8,
    pub sponsored: bool,
    pub fee_bps: u16,
    pub cap_shares: u64,
    pub thaw_vault: bool,
    pub activate: bool,
    pub heartbeat_max_age: i64,
}

impl Default for Opts {
    fn default() -> Self {
        Opts {
            gate: v::GATE_SAS | v::GATE_MEMBER,
            sponsored: true,
            fee_bps: 30,
            cap_shares: 1_000_000_000 * ONE,
            thaw_vault: true,
            activate: true,
            heartbeat_max_age: 180,
        }
    }
}

pub struct Trader {
    pub kp: Keypair,
    pub stock: Address,
    pub usdc: Address,
    pub cred: Address,
}

impl Trader {
    pub fn key(&self) -> Address {
        self.kp.pubkey()
    }
}

pub struct Market {
    pub svm: LiteSVM,
    pub payer: Keypair,
    pub admin: Keypair,
    pub relay: Keypair,
    pub data: Keypair,
    pub issuer: Keypair,
    pub stock_authority: Keypair,
    pub usdc_authority: Keypair,
    pub params: VenueParams,
    pub keys: PoolKeys,
    pub seq: u64,
    pub now: i64,
}

impl Market {
    pub fn new() -> Self {
        Self::with(Opts::default())
    }

    pub fn with(o: Opts) -> Self {
        let mut svm = new_svm();
        let now = base_time();
        set_time(&mut svm, now);
        let (payer, admin, issuer) = (funded(&mut svm), funded(&mut svm), funded(&mut svm));
        let (relay, data, stock_authority, usdc_authority) = (Keypair::new(), Keypair::new(), Keypair::new(), Keypair::new());
        let params = VenueParams {
            gate: o.gate,
            heartbeat_max_age: o.heartbeat_max_age,
            trade_date_cutoff: 8 * 3600,
            relay: relay.pubkey(),
            data_authority: data.pubkey(),
            credential_issuer: issuer.pubkey(),
            sas_credential: Address::new_unique(),
            sas_schema: Address::new_unique(),
            affiliate_group: Address::new_unique(),
        };
        assert_ok(&send(&mut svm, &[v::init_venue(&admin.pubkey(), &params)], &[&admin]));
        let venue = v::venue_pda(&admin.pubkey());
        let stock_mint = token::stock_mint(&mut svm, &payer, &stock_authority.pubkey(), DECIMALS);
        let usdc_mint = token::usdc_mint(&mut svm, &payer, &usdc_authority.pubkey(), DECIMALS);
        let reg = v::register_symbol(&admin.pubkey(), &venue, &stock_mint, 2, o.sponsored, "FWDI");
        assert_ok(&send(&mut svm, &[reg], &[&admin]));
        let symbol = v::symbol_pda(&venue, &stock_mint);
        let pool = v::pool_pda(&symbol);
        let stock_vault = token::token_account(&mut svm, &payer, &stock_mint, &pool, &TOKEN_2022);
        let usdc_vault = token::token_account(&mut svm, &payer, &usdc_mint, &pool, &SPL_TOKEN);
        if o.thaw_vault {
            token::thaw(&mut svm, &payer, &stock_vault, &stock_mint, &stock_authority);
        }
        let keys = PoolKeys { venue, symbol, pool, stock_mint, usdc_mint, stock_vault, usdc_vault };
        assert_ok(&send(&mut svm, &[v::init_pool(&admin.pubkey(), &keys, o.fee_bps)], &[&admin]));
        let mut m = Market { svm, payer, admin, relay, data, issuer, stock_authority, usdc_authority, params, keys, seq: 0, now };
        assert_ok(&m.heartbeat());
        assert_ok(&m.set_cap(o.cap_shares));
        if o.activate {
            let ix = v::activate_pool(&m.admin.pubkey(), &venue, &symbol);
            assert_ok(&m.as_admin(ix));
        }
        m
    }

    pub fn warp(&mut self, secs: i64) {
        self.set_time(self.now + secs);
    }
    pub fn set_time(&mut self, t: i64) {
        self.now = t;
        set_time(&mut self.svm, t);
    }

    pub fn as_admin(&mut self, ix: Instruction) -> TransactionResult {
        let payer = self.payer.insecure_clone();
        send(&mut self.svm, &[ix], &[&payer, &self.admin])
    }
    pub fn as_relay(&mut self, ix: Instruction) -> TransactionResult {
        let payer = self.payer.insecure_clone();
        send(&mut self.svm, &[ix], &[&payer, &self.relay])
    }
    pub fn as_data(&mut self, ix: Instruction) -> TransactionResult {
        let payer = self.payer.insecure_clone();
        send(&mut self.svm, &[ix], &[&payer, &self.data])
    }

    pub fn heartbeat(&mut self) -> TransactionResult {
        self.seq += 1;
        let ix = v::heartbeat(&self.relay.pubkey(), &self.keys.venue, &self.keys.symbol, self.seq);
        self.as_relay(ix)
    }
    pub fn set_cap(&mut self, cap_shares: u64) -> TransactionResult {
        let ix = v::set_cap(&self.data.pubkey(), &self.keys.venue, &self.keys.symbol, cap_shares, cap_shares * 40, 1, 1);
        self.as_data(ix)
    }

    /// A funded wallet with thawed stock and USDC accounts, admitted through the venue's gate
    /// (a SAS attestation when SAS is enabled, else a membership PDA).
    pub fn trader(&mut self, stock: u64, usdc: u64) -> Trader {
        let mut t = self.unadmitted(stock, usdc);
        let expiry = self.now + 30 * super::DAY;
        t.cred = if self.params.gate & v::GATE_SAS != 0 {
            self.admit_sas(&t.key(), expiry)
        } else {
            assert_ok(&self.admit_member(&t.key(), expiry));
            v::member_pda(&self.keys.venue, &t.key())
        };
        t
    }

    /// Same as `trader`, but `cred` points at an attestation address that does not exist.
    pub fn unadmitted(&mut self, stock: u64, usdc: u64) -> Trader {
        let kp = funded(&mut self.svm);
        let owner = kp.pubkey();
        let s = token::token_account(&mut self.svm, &self.payer, &self.keys.stock_mint, &owner, &TOKEN_2022);
        let u = token::token_account(&mut self.svm, &self.payer, &self.keys.usdc_mint, &owner, &SPL_TOKEN);
        token::thaw(&mut self.svm, &self.payer, &s, &self.keys.stock_mint, &self.stock_authority);
        if stock > 0 {
            token::mint_to(&mut self.svm, &self.payer, &TOKEN_2022, &self.keys.stock_mint, &s, &self.stock_authority, stock);
        }
        if usdc > 0 {
            token::mint_to(&mut self.svm, &self.payer, &SPL_TOKEN, &self.keys.usdc_mint, &u, &self.usdc_authority, usdc);
        }
        let cred = v::attestation_pda(&self.params.sas_credential, &self.params.sas_schema, &owner);
        Trader { kp, stock: s, usdc: u, cred }
    }

    pub fn admit_sas(&mut self, wallet: &Address, expiry: i64) -> Address {
        let (c, s) = (self.params.sas_credential, self.params.sas_schema);
        self.write_attestation(wallet, &c, &s, expiry, SAS_ID)
    }

    /// Writes SAS attestation bytes (TECH-NOTES §2 layout, one-byte schema data) at the
    /// attestation PDA for (credential, schema, wallet), owned by `owner`.
    pub fn write_attestation(&mut self, wallet: &Address, credential: &Address, schema: &Address, expiry: i64, owner: Address) -> Address {
        let mut d = vec![2u8];
        d.extend_from_slice(wallet.as_ref());
        d.extend_from_slice(credential.as_ref());
        d.extend_from_slice(schema.as_ref());
        d.extend_from_slice(&1u32.to_le_bytes());
        d.push(1); // schema data: admission tier
        d.extend_from_slice(self.issuer.pubkey().as_ref());
        d.extend_from_slice(&expiry.to_le_bytes());
        d.extend_from_slice(&[0u8; 32]);
        assert_eq!(d.len(), 174);
        let addr = v::attestation_pda(credential, schema, wallet);
        let lamports = self.svm.minimum_balance_for_rent_exemption(d.len());
        self.svm.set_account(addr, Account { lamports, data: d, owner, executable: false, rent_epoch: 0 }).unwrap();
        addr
    }

    /// Revocation in SAS closes the attestation account.
    pub fn close_account(&mut self, addr: &Address) {
        let empty = Account { lamports: 0, data: vec![], owner: super::SYSTEM, executable: false, rent_epoch: 0 };
        self.svm.set_account(*addr, empty).unwrap();
    }

    pub fn admit_member(&mut self, wallet: &Address, expires_at: i64) -> TransactionResult {
        let ix = v::grant_member(&self.issuer.pubkey(), &self.keys.venue, wallet, expires_at);
        let issuer = self.issuer.insecure_clone();
        send(&mut self.svm, &[ix], &[&issuer])
    }

    pub fn swap(&mut self, t: &Trader, dir: u8, amount_in: u64, min_out: u64) -> TransactionResult {
        let ix = v::swap(&self.keys, &t.key(), &t.stock, &t.usdc, &t.cred, dir, amount_in, min_out);
        send(&mut self.svm, &[ix], &[&t.kp])
    }
    pub fn add(&mut self, t: &Trader, stock_max: u64, usdc_max: u64, min_lp: u64) -> TransactionResult {
        let ix = v::add_liquidity(&self.keys, &t.key(), &t.stock, &t.usdc, &t.cred, stock_max, usdc_max, min_lp);
        send(&mut self.svm, &[ix], &[&t.kp])
    }
    pub fn remove(&mut self, t: &Trader, lp: u64, min_stock: u64, min_usdc: u64) -> TransactionResult {
        let pos = v::lp_pda(&self.keys.pool, &t.key());
        let ix = v::remove_liquidity(&self.keys, &t.key(), &pos, &t.stock, &t.usdc, &t.cred, lp, min_stock, min_usdc);
        send(&mut self.svm, &[ix], &[&t.kp])
    }

    pub fn balance(&self, account: &Address) -> u64 {
        token::balance(&self.svm, account)
    }
    pub fn reserves(&self) -> (u64, u64) {
        (self.balance(&self.keys.stock_vault), self.balance(&self.keys.usdc_vault))
    }
    pub fn account_data(&self, addr: &Address) -> Vec<u8> {
        self.svm.get_account(addr).map(|a| a.data).unwrap_or_default()
    }
    pub fn lp_shares(&self, owner: &Address) -> u64 {
        let d = self.account_data(&v::lp_pda(&self.keys.pool, owner));
        if d.len() < 80 { 0 } else { u64::from_le_bytes(d[72..80].try_into().unwrap()) }
    }
    pub fn lp_total(&self) -> u64 {
        let d = self.account_data(&self.keys.pool);
        u64::from_le_bytes(d[184..192].try_into().unwrap())
    }
}

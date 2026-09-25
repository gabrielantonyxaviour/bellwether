# Venue program contract (bellwether_venue)

Source of truth: `programs/venue/src/**`. Written from the program builder's report, 2026-09-25.
Release .so: 31,128 bytes. Program id is chosen at deploy (tests use a throwaway placeholder).

## Accounts (byte 0 discriminator, byte 1 bump, little-endian)
- **VenueConfig** 248 B, seeds `["venue", admin]`: 2 gate flags (1 SAS, 2 membership) · 4 u16 tier-1 count · 6 u16 tier-2 count · 8 i64 heartbeat_max_age · 16 i64 trade-date cutoff (seconds after 00:00 UTC) · 24 admin · 56 relay · 88 data authority · 120 credential issuer · 152 SAS credential · 184 SAS schema · 216 affiliate group.
- **SymbolRecord** 168 B, seeds `["symbol", venue, stock_mint]`: 2–7 tier, issuer_sponsored, active, halted, objected, breach_count · 8 ticker[8] · 16 halt reason[8] · 24 venue · 56 mint · 88 adv_shares · 96 cap_shares · 104 u32 multiplier num · 108 u32 den · 112 trade_date · 120 shares_traded_today · 128 paused_until · 136 last_heartbeat · 144 relay seq · 152 notice_received_at · 160 halted_at.
- **Pool** 192 B, seeds `["pool", symbol]`: 2/3 decimals · 4 u16 fee_bps · 8 symbol · 40/72 mints · 104/136 vaults · 168/176 reserves · 184 lp_total.
- **LpPosition** 80 B, seeds `["lp", pool, owner]`: 8 pool · 40 owner · 72 shares.
- **Member** 80 B, seeds `["member", venue, wallet]`: 8 venue · 40 wallet · 72 expires_at.

## Instructions (first byte = discriminator)
- 0 init_venue: gate u8, heartbeat_max_age i64, cutoff i64, relay, data authority, issuer, SAS credential, SAS schema, affiliate group (32 B each). Accounts: admin (s,w), venue (w), system.
- 8 update_venue: same payload. Accounts: admin (s), venue (w).
- 1 register_symbol: tier, sponsored, ticker[8]. Accounts: admin (s,w), venue (w), symbol (w), stock_mint, system.
- 2 init_pool: fee_bps u16. Accounts: admin (s,w), venue, symbol, pool (w), stock_mint, usdc_mint, stock_vault, usdc_vault, system. Vaults: token accounts owned by the pool PDA, no delegate/close authority; the stock vault must be thawed by the stock's freeze authority.
- 3 add_liquidity: stock_max, usdc_max, min_lp. Accounts: owner (s,w), venue, symbol, pool (w), lp (w), stock_mint, usdc_mint, stock_vault (w), usdc_vault (w), owner_stock (w), owner_usdc (w), credential, Token-2022, SPL Token, system.
- 4 remove_liquidity: lp, min_stock, min_usdc. Same accounts minus system (allowed while halted).
- 5 swap: direction (0 buy with USDC, 1 sell stock), amount_in, min_out. Accounts: trader (s), venue, symbol (w), pool (w), stock_mint, usdc_mint, stock_vault (w), usdc_vault (w), trader_stock (w), trader_usdc (w), credential, Token-2022, SPL Token. Check order: credential → halt + heartbeat freshness → activation/pause → share budget → x·y=k + min_out → transfers → counters → event.
- 6 grant_member: expires_at. Accounts: issuer (s,w), venue, member (w), wallet, system. 7 revoke_member closes it.
- 16–23 (accounts: authority (s), venue, symbol (w)): 16 set_cap (data authority: cap u64, adv u64, num u32, den u32) · 17 set_halt (relay: seq, reason[8], feed_ts) · 18 clear_halt (relay: seq; counts as heartbeat) · 19 heartbeat (relay: seq) · 20 record_breach (data authority: breach_ts, 0 = now) · 21 record_issuer_notice (admin: received_at) · 22 record_objection (admin) · 23 activate_pool (admin).

## Tape event (one `Program data:` slice, 228 B per swap)
0 "BWTRADE1" · 8 ticker · 16 stock mint · 48 USDC mint · 80 pool · 112 program id · 144 direction · 145 stock decimals · 146 USDC decimals · 148 stock amount · 156 USDC amount · 164 price (USDC base units per whole share) · 172 unix time · 180 size in shares · 188 trade date · 196 shares traded today (after) · 204/212 reserves after · 220 fee.

## Errors (6000–6016)
NotAdmitted, TradingHalted, HaltDataStale, NotActive, Paused, CapReached, SlippageExceeded, SymbolCapReached, NoticeWindowOpen, Objected, Unauthorized, InvalidAccount, InsufficientShares, StaleSequence, InvalidAmount, AlreadyInitialized, InvalidArgument.

## Notes for consumers
- Credential issuer: SAS attestation PDA `["attestation", credential, schema, wallet]`; non-zero expiry later than now (0 = "never" is refused); revoke = close the attestation.
- Relay: per-symbol strictly increasing sequence shared by set_halt, clear_halt and heartbeat; with a 180 s max age, heartbeat about every 60 s.
- Caps job: cap_shares is in shares × 10^decimals scaled by the multiplier; trade date starts at the cutoff; weekend trades count toward Friday; holidays not modelled; a second breach pauses the symbol for 92 days.
- Local tests: run with `AR=/usr/bin/ar` if `ar` resolves elsewhere.

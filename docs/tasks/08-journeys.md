# Circuit journey validation — 2026-09-25

Product `prod_081357ef-1e52-421c-ad10-8a03a624f889`, version `1.0.0`. Public devnet venue: [bellwether.larinova.com](https://bellwether.larinova.com/); API: [bellwether-api.larinova.com](https://bellwether-api.larinova.com/health). The statuses below describe observed checks, not Gabriel's Circuit acceptance. The Abel scenario harness has not issued a passing journey verdict for any row.

| Journey | Verdict | Observed scope | Still required |
| --- | --- | --- | --- |
| `sc_participant_trade` | **Partial** | Fresh wallet signed challenge, admitted and funded; on-chain buy changed pool reserves and daily share counter; exact signature appeared on the public tape. A separate never-admitted wallet produced a finalized failed swap with `NotAdmitted` (`6000`) on devnet. Mapping revision 2 routes to `/explorer` and `mappingCurrent=true`. | Participant screen flow, SDN fixture refusal, and Abel scenario harness run. |
| `sc_liquidity` | **Partial** | A separate fresh wallet bought BWRS, deposited into its own non-transferable LP account, and withdrew all shares. In a short relay halt window, a second deposit was rejected `TradingHalted` and withdrawal succeeded while halted. | Participant liquidity screen states, over-withdrawal refusal, and Abel scenario harness run. |
| `sc_public_verify` | **Partial** | Live `/`, `/explorer`, `/about` inspected. Devnet program account is executable; a new swap signature is finalized and on the explorer tape. Gabriel chose devnet as the required starting state; versioned spec and mapping revision 3 use devnet Solscan links, `mappingCurrent=true`. | Devnet UI scenario harness run; mainnet remains optional later. |
| `sc_halt_sync` | **Partial** | Shipped relay `setHaltInstruction` set a synthetic `LUDP` halt on devnet BWRS; direct swap preflight returned `TradingHalted`; shipped `clearHaltInstruction` resumed. The live home returned to “No open halt.” On an isolated fork, a 200-second clock advance caused `HaltDataStale` (`6002`) until a fresh heartbeat. | A real Nasdaq feed halt/resume, participant and operator screen/latency evidence, and Abel harness run. The devnet halt was an instruction-path rehearsal, not an observed Nasdaq halt. |
| `sc_volume_cap` | **Partial** | Isolated fork chain proof: tiny budget refused a swap with `CapReached` (`6005`); two breach transactions made `breachCount=2` and set a 92-day pause; swap failed `Paused` (`6004`) before expiry and confirmed after time travel to `pausedUntil+1`. No cap mutation or breach performed on shared devnet BWRS. | Operator gauge, participant screen states and Abel harness proof. **Never breach BWRS on devnet.** |
| `sc_operator_launch` | **Pending** | Operator screen journey deferred. | Operator screens and full scenario proof. |

## Devnet transaction evidence

All wallets are isolated integration keys outside the repository. Amounts are devnet test assets. The two normal flows each used 0.05 test USDC for the preparatory buy.

| Check | Wallet or detail | Confirmed signature |
| --- | --- | --- |
| Trade admission | `AkjkTGLqB5yAGTGJ1Ki2zz7uzTc1fE5VCdWvHSnR3FGX` | `2WCHayAQhYLHcDT7Hi1vQMNpjJCJQs57VrA6ySw2HByrFkYhV3MGb4vJR1ca917v69dL95zVz6rZXw7cd9L8SvLB` |
| Trade wallet funding | 0.01 SOL and test USDC | `5HCRk2HwNtS7dgqDDTRNZyFd1vopNmQcJGYg3U2ZUbY25qop9zQNi1EqtW9DcMzpPnSpizXWYPJU6YsrzPWStgXX` |
| Trade buy and [tape print](https://bellwether.larinova.com/explorer?date=2026-09-25) | Pool reserves `356909` stock / `3020000` USDC → `351114` / `3070000`; shares today `2372` → `8167` | `3Za2zZ3Rv58UjtGqKoSoU3brYpSTCcN2BvtgR7DFU2FvvKVhvtzcLhPffMcGfG576NsgPKYrP6s8XDX7xSurxbFi` |
| LP admission | `4412EKjuLBuLQvWdtqJiHtYxWLi64e4RNXgLRg8LJDpw` | `5mBqrR9m3ddwXfLstoaPHmqUyyfuumxr3oXFigC1hgBDyRMk8d6MYYK97822UGrmX8n55wd5qNiFrpk9LWGepk1t` |
| LP wallet funding | 0.01 SOL and test USDC | `2zZr6zyakfpfhk949TVcTPeT26GZ4HZjkxJwtkcXevLLN4mNG6YTDusLBMozAYu72Zgv4iLrgappSZHRiNpgsyHc` |
| LP preparatory buy | `5610` raw BWRS received; exact print indexed | `2MuZrDYPyUaYoS52GyUarGdoscNRL8QPsBqkWjSJLq9iT6te3usomEMUjMT3aFKbPCqANdcywvJ25hux4iwgQtwJ` |
| LP deposit | Position `C165aaikUVcAkSGsjiuVvQRe9BSZUUp6Zfm9tCAVWBzj`, `3004` shares | `UbFdggDQQsyVwFTm34yGjwNmpWKPiQv4g2wCZS1otZuQrZHDnshRYKjVDWNxqcxWiT7GsFcEmtYqaPnyWVoxM9j` |
| LP full withdrawal | Position shares returned to zero | `2vJX6R5M6vWombucEwCbTWw5fRq3nsNfdg2uq97FcYwMxxAU1RAkDJ5nt9DM9nPtXcodis7DCD5jickoFJW6reik` |

The trade program account `88chqe41hw9uhqrUK6KfytQ7aZgEGJzcqszXGKJFWfuB` returned `executable: true` from devnet RPC. The trade buy signature above returned `finalized`, `err: null`, slot `504047688`. The public tape row includes BWRS/USDC, size `0.005795`, UTC time `2026-09-25T15:14:00Z`, buy direction, pool and program.

### On-chain `NotAdmitted` refusal

Fresh wallet `617Qs9Fhw5h4mq4fPR6ZvuaQfkavxaQGtCC1VoUGcA6p` never called the admission API. Its credential endpoint returned `not_admitted` before and after the check. An integration wallet funded only the fee SOL (`4svgxpZpUTorznBhYKL1DLiP4aLKq2Rmt37gP2ZorLht57MpQn18wqNe7JKMw7oVp7J46eSEbBXKGhLbieWaeViG`) and created the wallet's BWRS and USDC token accounts (`3c9TxExYqZEDMxBXkuXRnBqk5WoNTF6TvKhwJQDn34uP4k6E2BHi75JqvyoATYiDsknF8QNQNNwfy5cbo61hnwS4`). The direct `swapIx` used `skipPreflight` and [failed on chain](https://solscan.io/tx/5AP2nnrJxSo1Wedwb9hUqTsDAjFqXzVESmnLAyKjwmkAXwheXEnCPYMm5qbogxBrvT4xPLpCTMnuK1ZnRc3dPNsA?cluster=devnet), signature `5AP2nnrJxSo1Wedwb9hUqTsDAjFqXzVESmnLAyKjwmkAXwheXEnCPYMm5qbogxBrvT4xPLpCTMnuK1ZnRc3dPNsA`, slot `504055428`. Devnet RPC returned `finalized`, `InstructionError[0].Custom=6000`; transaction logs report `custom program error: 0x1770`, which maps to `NotAdmitted=6000` in `programs/venue/src/error.rs`. No pool, cap or halt mutation occurred.

## Reversible halt window

bw-participant acknowledged a pause in devnet runs. The window lasted approximately 15:16–15:17 UTC; the initial start notification had an incorrect clock time, which was corrected in the end notification. A synthetic `LUDP` reason was sent through the product's relay instruction path, not a direct account edit or claimed Nasdaq feed event. No volume cap was changed.

| Check | Result | Confirmed signature |
| --- | --- | --- |
| Deposit before halt | Position held `3004` shares | `32sxQ3w7wVeMb5ufw75x6mFsXYR5VRhApy9HjeAzjLhv6XrE9TGw6EgAf9Xw3E5NFyRn2s9X8it3zjF4FVLJYAXx` |
| Set halt | On-chain `halted=true`, reason `LUDP`, relay sequence `107` | `4PFH9YfPBptuH1jpKRdhhXgYtNkifxadBpsUiUn5LAdpxVD4CdUuq5GNgys1yEd79MpzemusddAnvUUy66sp2Gu7` |
| Add and swap while halted | Both transaction simulations rejected with program `TradingHalted` (`6001`); no transaction signatures | — |
| Withdraw while halted | All `3004` LP shares withdrawn; remaining shares `0` | `541LWQzx8KkQfATJ7LRyH5CRzSoKZA2xPtPhLhEsffzyvV9MnYia8iPAv1MK1E9F8sQ7tCyBagvwMhDBp79G2jJv` |
| Clear halt | On-chain `halted=false`, empty reason, relay sequence `108` | `4UhUH5B7mcCAokG5Dz6PHVZnYN9zd5P44HqQ5qaNTrpvdvACsQwQ5rLX8W5iFoXYdzx2L6i12qADNR6m3sGeCzK4` |

After the clear, public `GET /halts` returned `halts: []` and the live home page's venue status visibly read “No open halt.” bw-participant received the resume notice.

## Isolated fork chain proof

`npx tsx checks/journey-rulebook.ts` started and stopped its own Surfpool at `127.0.0.1:8984`. The fork program was `5TFj8r8N5fYiERNZuh5wSyBVh3DKDS8d5GSrKst8RNqT`; these signatures are **fork-local and cannot resolve on public Solscan**. The script used the shipped program instructions and `surfnet_timeTravel`; it did not mutate devnet BWRS.

| Check | Observed result | Fork-local signature |
| --- | --- | --- |
| Set tiny share cap | Cap set to `1` raw share unit | `5uC5Se4SygEDmknfCXDV8ABpLFp88EEsHhLssVReeUfXJH4SYK7xdem67rKEkfZiho2f7GmkYSUbgPc4DsVc4BJU` |
| Next swap | `CapReached` `6005` in preflight | No confirmed transaction |
| Restore generous cap | Allows later pause test | `3XYgnCfwGi7eXgF3npMr3a6rTL9Dw9kwrYaWXAdrpYVXW1UcNgsDAPJWY9Hkox9Z9L2qBuh1jnFgrEcPaAes9mWA` |
| Advance fork clock past 180-second heartbeat limit | Swap rejected `HaltDataStale` `6002` | No confirmed transaction |
| Fresh heartbeat | Recovery from stale data | `yG41Z26XLMWQ5ZTwazBKXiJfyWbHFQkXdEwktitMA5Hx2XnDBZ9qDo8RfeVQkh8DE8BPSFZtv1YKgxSCFkQEcSY` |
| First breach | On-chain count `1` | `45a51cGaYkxK4h67h3oqmsL5VDmQ5fiYAV25Am2wG1LAHuSGpApMWQ7cGzp8wEWQ4TxLvG6DMtzXT7kU6yhEpHvY` |
| Second breach | On-chain count `2`, `pausedUntil=1800887114` (92 days after the breach) | `W4z81z4GL4rLWab1sXityZnLxYrPLmfyhPBMjxjZtLMMoFqomZ34dp2iRAPBWaw6uKKdxqrusVBMxShHtvC6LXs` |
| Before expiry | Swap rejected `Paused` `6004` | No confirmed transaction |
| Time travel to `pausedUntil+1`, fresh heartbeat | Pause expired | `5fjBJpp4j3bkq3ZXuwcAvN9VNhUUZB7UG4DZmFHD4f2ejruKmRiDRSwVWpey9gZ2QQLEtpuPDXuU5HYBVacSZmEw` |
| After expiry | Swap confirmed | `4ttJm5GJf2sZY5PufjZ8AspoSByFmy3iCmYHkXJYBnoP7LAcYNQY1w36qeWsDo9Yu9GqijCmr9caiLgYbEdY7PZN` |

## Verification state

- `bash .abel/graph check-project`: wiring valid.
- `npx tsc --noEmit -p tsconfig.json`: passed after the transaction runners were added.
- The two devnet runners completed with exit code `0`; their assertions read on-chain accounts and public API responses after each transaction. The halted rejection checks read the actual `TradingHalted` program code from Solana preflight.
- The isolated fork rulebook runner completed with exit code `0`, checking `CapReached`, `HaltDataStale`, `Paused`, breach count and a confirmed post-expiry swap.
- `sc_public_verify` generated Playwright spec passed against the live `/`, `/explorer` and `/about` pages and devnet RPC (1 test passed, 15.4 seconds). Abel was briefly unavailable; on recovery its scenario-evidence read confirmed `mappingCurrent=true` but listed Home, Explorer and About as not `Completed` or `Shipped`. Therefore **no Abel scenario pass is recorded**. The participant and liquidity specs have real step bodies but have not run against the fixed participant UI or a newly coordinated halt window. Gabriel has made devnet the required public-verification scope; the canonical scenario spec and mapping were revised without reopening unrelated screens or blocks.

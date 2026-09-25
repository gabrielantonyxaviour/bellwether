# Task 01 — blk_fork_env + the go-live script (worker: bw-fork)

Owns: scripts/fork/**, checks/fork-scenario.ts, scripts/deploy/** (the go-live script; do NOT run it against mainnet).
Ports: dev fork 8899/8900; the accept check uses 8960/8961.

## (A) blk_fork_env
`scripts/fork/start.ts`: start a Surfpool MAINNET fork (mainnet datasource, not offline) on 127.0.0.1:8899, deploy the
program as an upgradeable program, and run the go-live steps against it (B, `--cluster fork`).
Accept command `npx tsx checks/fork-scenario.ts` (ports 8960/8961) must assert on a fresh fork:
1. A swap on the REAL FWDI mint 7GzQgf6DPo6ZANjnbhe9tNCpkGTv3zqHbsDx74jyQf9 passes all gates. Register FWDI as issuer-
   sponsored, create + thaw its pool vault and the demo wallets' FWDI accounts via surfnet_setTokenAccount (state
   initialized) — label this in code and logs as standing in for Superstate's allowlist thaw — and fund FWDI by cheatcode.
2. A third-party demo symbol activates only after a 30-day time travel (NoticeWindowOpen 6008 before).
3. A second recorded breach pauses the symbol (Paused 6004); trading resumes only after a ~92-day time travel.
Write signatures to scripts/fork/out/fork-scenario.json (small JSON; the proof page reads it). Kill processes by PID.
surfnet_timeTravel takes milliseconds.

## (B) scripts/deploy/go-live.ts — idempotent, resumable
`npx tsx scripts/deploy/go-live.ts --cluster fork|devnet|mainnet` writes scripts/deploy/deployments/<cluster>.json after
each step and skips done steps on re-run.
1. Preflight: detect cluster by genesis hash. For mainnet require `--confirm-mainnet`, print a full plan (every account,
   exact lamports), and stop unless `--execute` is also passed. Check deployer balance ≥ plan.
2. Deploy the program (upgradeable, --max-len = .so size) with the deployer (default ~/.config/solana/bellwether-deployer.json).
   Generate venue admin / relay / data-authority / credential-issuer / freeze-authority keypairs under
   ~/.config/solana/bellwether/<cluster>/ (0600) if absent. Never print or commit secrets.
3. Create the BWRS rehearsal mint (scripts/assets).  4. init_venue (gate SAS, heartbeat 180 s, cutoff 08:00 UTC).
5. SAS credential + schema (services/credential helpers).  6. register_symbol BWRS (Tier 2, issuer-sponsored), init_pool
   (fee 30 bps), thaw vaults.  7. Initial cap via services/caps (BWRS follows FWDI).
8. Seed liquidity from an admitted LP wallet: `--seed-usdc` (default 3 on mainnet; cheatcode on fork) + matching BWRS
   minted to the LP at ≈ FWDI last close (Nasdaq API).
9. Write a web runtime config JSON for the cluster (for web's /config.json override) and services/.env.<cluster>
   (gitignored) with every variable the services' env contracts need.  10. Print the service start commands.
Dress rehearsal: run it with `--cluster fork` on a fresh mainnet fork (8899), start relay/caps/indexer+api/credential with
the generated env, admit a wallet through the credential HTTP API, swap, confirm the print on GET /tape.
Write scripts/deploy/README.md: the exact mainnet runbook (plan → execute → start services → smoke), measured fork
timings per step, and the exact mainnet lamport total (program rent 0.159842 SOL measured).

Verify: blk_fork_env. (blk_mainnet_deploy is verified later, on mainnet, after Gabriel funds it.)

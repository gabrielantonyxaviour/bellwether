# Bellwether web

The web app: public tape and proof, participant trading, and the operator workbench. It is its
own pnpm project, separate from the root package (services, scripts, checks).

Stack: Vite 8, React 19, TypeScript 5.9, Tailwind v4, shadcn/ui (`base-nova` style, neutral theme,
ReUI registry as `@reui`), react-router 8, TanStack Query 5, sonner, zod 4, `@solana/kit` 7.1.1.

```bash
pnpm -C web install
pnpm -C web dev        # http://localhost:5190
pnpm -C web build      # typecheck + production build into web/dist
pnpm -C web test       # vitest: decoders, encoders, error map, cluster config, units
```

Add components with `pnpm -C web dlx shadcn@4.21.0 add <name>` (stock shadcn) or
`add @reui/<name>` (ReUI). Keep the neutral theme: the product look arrives later through
`/abel:apply-look`, not in screen code.

## Config

Three layers resolve once at boot (`src/lib/cluster.ts`); later wins:

1. per-cluster defaults
2. build-time `VITE_*` env (`web/.env.local`, see `.env.example`)
3. runtime `/config.json` (served from `web/public/config.json`, `{}` by default)

| Env var | `/config.json` key | Default |
|---|---|---|
| `VITE_CLUSTER` | `cluster` | `devnet` (`fork` \| `devnet` \| `mainnet`) |
| `VITE_RPC_URL` | `rpcUrl` | fork `http://127.0.0.1:8899`, devnet/mainnet public RPC |
| `VITE_WS_URL` | `wsUrl` | derived from the RPC (fork: port + 1) |
| `VITE_PROGRAM_ID` | `programId` | none, set after deploy |
| `VITE_VENUE` | `venue` | none: the VenueConfig PDA `["venue", admin]` |
| `VITE_USDC_MINT` | `usdcMint` | mainnet USDC on fork and mainnet; none on devnet |
| `VITE_BWRS_MINT` | `bwrsMint` | none: the rehearsal stock mint |
| `VITE_DEFAULT_SYMBOL` | `defaultSymbol` | `FWDI` on fork, `BWRS` elsewhere |
| `VITE_API_BASE_URL` | `apiBaseUrl` | `http://localhost:8787` (services/api) |
| `VITE_CREDENTIAL_API_URL` | `credentialApiUrl` | `http://localhost:8790` (services/credential) |

If `/config.json` sets a different `cluster` from the build's `VITE_CLUSTER`, the build's other
`VITE_*` values are ignored, because they describe the other cluster. Only the defaults and
`/config.json` then apply.

### Pointing a build at a cluster

- **Fork (local Surfpool, never public):** `VITE_CLUSTER=fork VITE_PROGRAM_ID=… VITE_VENUE=… pnpm -C web dev`.
  Explorer links use Solscan's custom RPC (`?cluster=custom&customUrl=http://127.0.0.1:8899`), so they
  only resolve on the machine that runs the fork.
- **Devnet:** `VITE_CLUSTER=devnet VITE_USDC_MINT=<test USDC> VITE_BWRS_MINT=… VITE_PROGRAM_ID=… pnpm -C web build`.
  Explorer links add `?cluster=devnet`.
- **Mainnet without rebuilding:** deploy the same `dist/` and replace `dist/config.json` with
  `{ "cluster": "mainnet", "programId": "…", "venue": "…", "bwrsMint": "…", "apiBaseUrl": "https://…", "credentialApiUrl": "https://…" }`.
  `config.json` is fetched with `cache: no-store`, so a replaced file takes effect on the next page load.

Wallets sign against `solana:devnet` on devnet and `solana:mainnet` on mainnet. On the fork, the wallet
only signs (`solana:signTransaction`) and the app sends through the fork RPC. A wallet's own RPC
would broadcast to real mainnet.

## Wallet and kit versions

`src/lib/wallet.tsx` is a thin provider on Wallet Standard (`@wallet-standard/app` 1.1.1,
`@wallet-standard/features` 1.1.1, `@solana/wallet-standard-features` 1.5.0). Screens use only the
`BellwetherWallet` interface via `useWallet()`: `wallets`, `status`, `publicKey`, `signer` (a kit
`TransactionSendingSigner`), `connect`, `disconnect`, `signAndSendTransaction`.

`@solana/kit` is pinned to **7.1.1** in `web/`, while the root package uses kit 8 for services.
Wallet UI (`@wallet-ui/react` 4.x, peer `@solana/kit ^6.1 || ^7`) and ConnectorKit
(`@solana/connector` 0.2.x, depends on kit ^7) both need kit 7. To adopt either one, write a
provider that maps its hooks onto `BellwetherWallet` and render it through
`WalletContextProvider`. No screen changes.

## Layout for screen builders

| Folder | Block | Named exports (fixed; `src/app/routes.tsx` imports them) |
|---|---|---|
| `src/routes/public/index.tsx` | blk_ui_public | `HomePage`, `TapePage`, `ProofPage` |
| `src/routes/app/index.tsx` | blk_ui_participant | `OnboardPage`, `TradePage`, `LiquidityPage` |
| `src/routes/operator/index.tsx` | blk_ui_operator | `OperatorOverviewPage`, `OperatorSymbolsPage`, `OperatorHaltsPage`, `OperatorParticipantsPage`, `OperatorPublicNoticePage`, `OperatorRehearsalPage` |

Shared modules:

- `@/app/paths`: route builders (`paths.trade(symbol)`, `paths.operator.halts`, …)
- `@/lib/cluster`: `clusterConfig()`, `explorerUrl(kind, id)`, token program ids
- `@/lib/api`: `api.*` fetchers, `useTape` / `useSymbols` / `useVenue` / `useHalts` / `useCredential` /
  `useAdmit` / `useNoticeDraft` / `useRehearsalReport`, `ApiError`, and the response types
- `@/lib/program`: account decoders, `swapInstruction` / `addLiquidityInstruction` /
  `removeLiquidityInstruction`, PDAs, `quoteSwap`, `withSlippage`, `toVenueError` / `describeError`
- `@/lib/tx`: `useTransaction(label)` → `review()`, `submit(instructions, signer)`, `state.phase`
- `@/lib/wallet`: `useWallet()`, `shortAddress()`
- `@/lib/format`: `formatUnits`, `parseUnits`, `formatUsd`

The notice (`/notice/draft`) and rehearsal (`/rehearsal/fwdi`) fetchers are placeholders. Those
services have no HTTP route yet, so the paths are proposed targets.

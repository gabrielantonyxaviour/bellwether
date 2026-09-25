# Live QA — bellwether.larinova.com

Checked 2026-09-25 in Chromium at 375, 768, and 1440. Routes: `/`, `/explorer`, `/about`, `/app/onboard`, `/app/trade/BWRS`, `/app/liquidity/BWRS`.

No console errors. No horizontal page overflow. `/`, `/explorer`, `/about`, and `/app/onboard` reach a finished state. Devnet Solscan links are `https://solscan.io/…?cluster=devnet` with no `cluster=custom` and no `127.0.0.1`. A normal fetch of the fresh-wallet swap renders its Solscan transaction page, and devnet RPC has that signature (slot 504029429) and the program account. A headless browser is stopped by Solscan's Cloudflare check (HTTP 403); that is the checker, not a dead link. `cdn-cgi/rum` aborts when the next route loads. That is Cloudflare's beacon, not an app request.

Public pages needed no code change. The live About page already shows fork signatures as copyable text. The exact label from `f862048` ("local mainnet fork (Surfpool), not publicly resolvable") is not what the live page says yet; it still says "Local recording…". That ships with the next redeploy.

## Findings

| Route | Width | What's wrong | Owner |
|---|---|---|---|
| `/app/trade/BWRS` | 375, 768, 1440 | Venue status leaves Credential on "Checking…" for at least 15s with no wallet connected. It never becomes "Not admitted" or an error. | bw-participant |
| `/app/trade/BWRS` | 375, 768, 1440 | Chart markers reading "buy 0.0" sit on the last candles and the right price axis. | bw-participant |
| `/app/trade/BWRS` | 375 | The trades table clips. Headers show "Sh" and "0.(" and the signature column is cut off. At 768 and 1440 the same table shows Time, Side, Price, Shares, and the signature. | bw-participant |
| `/app/trade/BWRS` | 375, 768, 1440 | The pay field reads "Balance Connect wallet" with no separation when the wallet is disconnected. | bw-participant |
| `/app/liquidity/BWRS` | 375, 768, 1440 | Under each amount field the line reads "Balance Connect wallet BWRS" or "Balance Connect wallet USDC" with no separation. | bw-participant |

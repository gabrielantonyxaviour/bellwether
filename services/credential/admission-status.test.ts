import assert from "node:assert/strict"
import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { test } from "node:test"
import { generateKeyPairSigner, type Instruction, type Signature } from "@solana/kit"
import { TOKEN_2022_PROGRAM_ADDRESS } from "@solana-program/token-2022"
import { associatedStockAccount, thawInstruction } from "../../scripts/assets/thaw.js"
import type { Chain, Rpc } from "../../scripts/assets/tx.js"
import { createAdmissions } from "./admission.js"
import { createApp } from "./app.js"
import type { CredentialBackend } from "./backend.js"
import { ScreeningLog } from "./screening-log.js"

test("credential status preserves the signed issue-and-thaw transaction across a repeat admission", async () => {
  const [payer, freezeAuthority, wallet, mint, attestation, sasProgram] = await Promise.all(
    Array.from({ length: 6 }, () => generateKeyPairSigner()),
  )
  const log = new ScreeningLog(join(mkdtempSync(join(tmpdir(), "admission-status-")), "log.jsonl"))
  const stockAddress = await associatedStockAccount(wallet.address, mint.address)
  const clock = new Uint8Array(40)
  new DataView(clock.buffer).setBigInt64(32, 1_790_000_000n, true)
  const stock = new Uint8Array(165)
  stock[108] = 1 // initialized and thawed
  let issued = false
  const batches: Instruction[][] = []
  const signature = "signed-issue-and-thaw" as Signature
  const rpc = {
    getAccountInfo: (key: string) => ({ send: async () => ({ value:
      key === "SysvarC1ock11111111111111111111111111111111"
        ? { owner: sasProgram.address, lamports: 1, data: [Buffer.from(clock).toString("base64"), "base64"] }
        : key === stockAddress && issued
          ? { owner: TOKEN_2022_PROGRAM_ADDRESS, lamports: 1, data: [Buffer.from(stock).toString("base64"), "base64"] }
          : null,
    }) }),
  } as unknown as Rpc
  const chain = {
    rpc, rpcUrl: "http://127.0.0.1:8970",
    send: async (instructions: Instruction[]) => { batches.push(instructions); issued = true; return signature },
    fundSol: async () => {},
  } as Chain
  const issue: Instruction = { programAddress: sasProgram.address, accounts: [], data: new Uint8Array([1]) }
  const backend: CredentialBackend = {
    kind: "sas", describe: () => ({}), ensureReady: async () => {},
    read: async () => ({ kind: "sas", address: attestation.address, exists: issued, expiresAt: issued ? 1_790_086_400n : null }),
    issueInstructions: async () => [issue], revokeInstructions: async () => [],
  }
  const admissions = createAdmissions({
    cluster: "devnet", chain, payer, freezeAuthority, stockMint: mint.address, backend,
    screening: { screen: async () => ({ match: null, list: {} as never }), info: () => null },
    log, ttlSeconds: 86_400n, dailyCap: null,
  })

  const first = await admissions.admit(wallet.address)
  assert.equal(first.signature, signature)
  assert.equal(batches.length, 1)
  assert.equal(batches[0].length, 3)
  assert.equal(batches[0][0].programAddress, sasProgram.address)
  assert.equal(batches[0][2].programAddress, TOKEN_2022_PROGRAM_ADDRESS)
  assert.deepEqual(batches[0][2].data, thawInstruction(stockAddress, mint.address, freezeAuthority).data)

  const second = await admissions.admit(wallet.address)
  assert.equal(second.signature, null)
  assert.equal(batches.length, 1, "an idempotent admission does not send another transaction")
  const response = await createApp(admissions, { operatorToken: null, corsOrigin: "*" }).request(`/credential/${wallet.address}`)
  assert.equal(response.status, 200)
  assert.equal((await response.json()).admissionSignature, signature)
  assert.equal(log.lastFor(wallet.address)?.signature, null)

  issued = false
  log.append({ wallet: wallet.address, event: "revoked", signature: "revocation-signature" })
  const revoked = await admissions.status(wallet.address)
  assert.equal(revoked.status, "revoked")
  assert.equal(revoked.admissionSignature, null)
})

test("an admitted credential without an issuance log has no admission signature", async () => {
  const log = new ScreeningLog(join(mkdtempSync(join(tmpdir(), "admission-log-")), "log.jsonl"))
  log.append({ wallet: "wallet-A", event: "admitted", signature: null })
  assert.equal(log.lastAdmissionSignature("wallet-A"), null)
  log.append({ wallet: "wallet-B", event: "admitted", signature: "other-wallet-signature" })
  assert.equal(log.lastAdmissionSignature("wallet-A"), null)
})

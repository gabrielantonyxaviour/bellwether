/**
 * The Bellwether rehearsal stock: a Token-2022 mint that mirrors the real FWDI mint's design
 * (7GzQgf6DPo6ZANjnbhe9tNCpkGTv3zqHbsDx74jyQf9) while saying plainly that it is a rehearsal asset.
 *
 * FWDI                                   Rehearsal stock
 * DefaultAccountState = Frozen           same: every new account is frozen until thawed
 * freeze authority = transfer agent      freeze authority = the venue key (thaws admitted wallets and pool vaults)
 * permanent delegate = transfer agent    same key as the freeze authority, as on FWDI
 * mint / metadata / scaled-UI authority  one issuer key, as on FWDI
 * ScaledUiAmount multiplier 1            same
 * MetadataPointer → the mint itself      same, with TokenMetadata naming it a rehearsal asset
 * 6 decimals                             same
 */
import { isSome, some, type Address, type Instruction, type TransactionSigner } from "@solana/kit"
import { getCreateAccountInstruction } from "@solana-program/system"
import {
  AccountState, TOKEN_2022_PROGRAM_ADDRESS, extension, fetchMint, getInitializeMintInstruction, getMintSize,
  getPostInitializeInstructionsForMintExtensions, getPreInitializeInstructionsForMintExtensions,
  getUpdateTokenMetadataFieldInstruction, tokenMetadataField, type ExtensionArgs,
} from "@solana-program/token-2022"
import type { Chain, Rpc } from "./tx.js"

export const FWDI_MINT = "7GzQgf6DPo6ZANjnbhe9tNCpkGTv3zqHbsDx74jyQf9"

export const REHEARSAL = {
  name: "Bellwether Rehearsal Stock",
  symbol: "BWRS",
  uri: "",
  decimals: 6,
  multiplier: 1,
  additionalMetadata: {
    notice: "Rehearsal asset for Bellwether venue testing. Not a security, not FWDI, no claim on any issuer.",
    mirrors: `FWDI Token-2022 design (${FWDI_MINT})`,
  },
} as const

export interface RehearsalMintInput {
  payer: TransactionSigner
  /** The new mint account's keypair. */
  mint: TransactionSigner
  /** Issuer key: mint authority, metadata + metadata-pointer authority, scaled-UI authority. */
  mintAuthority: TransactionSigner
  /** Venue key: freeze authority (thaws admitted wallets and pool vaults) and permanent delegate. */
  freezeAuthority: Address
  uri?: string
}

export function rehearsalExtensions(input: RehearsalMintInput): ExtensionArgs[] {
  return [
    extension("DefaultAccountState", { state: AccountState.Frozen }),
    extension("PermanentDelegate", { delegate: input.freezeAuthority }),
    extension("MetadataPointer", { authority: some(input.mintAuthority.address), metadataAddress: some(input.mint.address) }),
    extension("ScaledUiAmountConfig", {
      authority: input.mintAuthority.address, multiplier: REHEARSAL.multiplier,
      newMultiplierEffectiveTimestamp: 0n, newMultiplier: REHEARSAL.multiplier,
    }),
    extension("TokenMetadata", {
      updateAuthority: some(input.mintAuthority.address), mint: input.mint.address,
      name: REHEARSAL.name, symbol: REHEARSAL.symbol, uri: input.uri ?? REHEARSAL.uri,
      additionalMetadata: new Map(Object.entries(REHEARSAL.additionalMetadata)),
    }),
  ]
}

/** Account space before TokenMetadata (which reallocs on init) and the full rent-bearing size. */
export function rehearsalMintSizes(input: RehearsalMintInput): { space: number; rentSpace: number } {
  const all = rehearsalExtensions(input)
  return { space: getMintSize(all.filter((e) => e.__kind !== "TokenMetadata")), rentSpace: getMintSize(all) }
}

export function buildRehearsalMintInstructions(input: RehearsalMintInput, lamports: bigint): Instruction[] {
  const extensions = rehearsalExtensions(input)
  const { space } = rehearsalMintSizes(input)
  return [
    getCreateAccountInstruction({
      payer: input.payer, newAccount: input.mint, lamports, space, programAddress: TOKEN_2022_PROGRAM_ADDRESS,
    }),
    ...getPreInitializeInstructionsForMintExtensions(input.mint.address, extensions),
    getInitializeMintInstruction({
      mint: input.mint.address, decimals: REHEARSAL.decimals,
      mintAuthority: input.mintAuthority.address, freezeAuthority: input.freezeAuthority,
    }),
    ...getPostInitializeInstructionsForMintExtensions(input.mint.address, input.mintAuthority, extensions),
    ...Object.entries(REHEARSAL.additionalMetadata).map(([key, value]) =>
      getUpdateTokenMetadataFieldInstruction({
        metadata: input.mint.address, updateAuthority: input.mintAuthority, field: tokenMetadataField("Key", [key]), value,
      })),
  ]
}

export interface CreatedRehearsalMint {
  mint: Address
  signature: string
  space: number
  rentSpace: number
  lamports: bigint
}

export async function createRehearsalMint(chain: Chain, input: RehearsalMintInput): Promise<CreatedRehearsalMint> {
  const { space, rentSpace } = rehearsalMintSizes(input)
  const lamports = await chain.rpc.getMinimumBalanceForRentExemption(BigInt(rentSpace)).send()
  const signature = await chain.send(buildRehearsalMintInstructions(input, lamports), input.payer)
  return { mint: input.mint.address, signature, space, rentSpace, lamports }
}

export type AccountStateName = "uninitialized" | "initialized" | "frozen"
const STATE_NAMES: Record<AccountState, AccountStateName> = {
  [AccountState.Uninitialized]: "uninitialized",
  [AccountState.Initialized]: "initialized",
  [AccountState.Frozen]: "frozen",
}

export interface RehearsalMintState {
  address: Address
  tokenProgram: Address
  decimals: number
  supply: bigint
  mintAuthority: Address | null
  freezeAuthority: Address | null
  extensionKinds: string[]
  defaultAccountState: AccountStateName | null
  permanentDelegate: Address | null
  metadataPointer: { authority: Address | null; metadataAddress: Address | null } | null
  scaledUiAmount: { authority: Address; multiplier: number; newMultiplier: number; newMultiplierEffectiveTimestamp: bigint } | null
  metadata: {
    updateAuthority: Address | null; mint: Address; name: string; symbol: string; uri: string
    additionalMetadata: Record<string, string>
  } | null
}

const opt = <T>(value: { __option: "Some"; value: T } | { __option: "None" }): T | null => (isSome(value) ? value.value : null)

/** Decode any Token-2022 mint's authorities and extensions from chain (works for FWDI too). */
export async function readRehearsalMint(rpc: Rpc, mint: Address): Promise<RehearsalMintState> {
  const account = await fetchMint(rpc, mint)
  const extensions = isSome(account.data.extensions) ? account.data.extensions.value : []
  const state: RehearsalMintState = {
    address: mint,
    tokenProgram: account.programAddress,
    decimals: account.data.decimals,
    supply: account.data.supply,
    mintAuthority: opt(account.data.mintAuthority),
    freezeAuthority: opt(account.data.freezeAuthority),
    extensionKinds: extensions.map((e) => e.__kind),
    defaultAccountState: null, permanentDelegate: null, metadataPointer: null, scaledUiAmount: null, metadata: null,
  }
  for (const e of extensions) {
    if (e.__kind === "DefaultAccountState") state.defaultAccountState = STATE_NAMES[e.state]
    if (e.__kind === "PermanentDelegate") state.permanentDelegate = e.delegate
    if (e.__kind === "MetadataPointer") state.metadataPointer = { authority: opt(e.authority), metadataAddress: opt(e.metadataAddress) }
    if (e.__kind === "ScaledUiAmountConfig") {
      state.scaledUiAmount = {
        authority: e.authority, multiplier: e.multiplier, newMultiplier: e.newMultiplier,
        newMultiplierEffectiveTimestamp: e.newMultiplierEffectiveTimestamp,
      }
    }
    if (e.__kind === "TokenMetadata") {
      state.metadata = {
        updateAuthority: opt(e.updateAuthority), mint: e.mint, name: e.name, symbol: e.symbol, uri: e.uri,
        additionalMetadata: Object.fromEntries(e.additionalMetadata),
      }
    }
  }
  return state
}

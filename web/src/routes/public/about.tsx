import type { ReactNode } from "react"
import { ChainLink, LocalRecording } from "@/components/public/chain-link"
import { formatShares } from "@/components/public/format"
import { useNoticeChain, type NoticeChain } from "@/components/public/notice"
import { devnetRecord, forkRecord, mainnetRecord, orderedSignatures, solscanUrl, type DevnetRecord, type ForkRecord } from "@/components/public/records"
import { ErrorBlock, EmptyBlock, LoadingBlock, Panel } from "@/components/public/states"
import { swapChecks } from "@/components/public/swap-checks"
import { useHalts, useSymbols } from "@/lib/api"
import { formatUnits } from "@/lib/format"

const ORDER = "https://www.sec.gov/files/rules/exorders/2026/34-106402.pdf"

function AccountRow({ label, id }: { label: string; id: string }) {
  return (
    <div className="flex flex-wrap items-baseline justify-between gap-2">
      <span className="text-muted-foreground">{label}</span>
      <ChainLink href={solscanUrl("devnet", "account", id)} id={id} kind="account" />
    </div>
  )
}

function SignatureList({ map }: { map: Record<string, string> }) {
  return (
    <div className="grid gap-1">
      {orderedSignatures(map).map(([key, signature]) => (
        <div key={key} className="flex flex-wrap items-baseline justify-between gap-2">
          <span className="text-muted-foreground">{key}</span>
          <ChainLink href={solscanUrl("devnet", "tx", signature)} id={signature} kind="tx" />
        </div>
      ))}
    </div>
  )
}

function LocalRow({ label, id }: { label: string; id: string }) {
  return (
    <div className="flex flex-wrap items-baseline justify-between gap-2">
      <span className="text-muted-foreground">{label}</span>
      <LocalRecording id={id} name={label} />
    </div>
  )
}

function DevnetCard({ record }: { record: DevnetRecord }) {
  const accounts: [string, string][] = [
    ["Venue", record.venue],
    ["Symbol", record.symbol],
    ["Pool", record.pool],
    ["Stock mint", record.stockMint],
    ["USDC mint", record.usdcMint],
    ["Stock vault", record.stockVault],
    ["USDC vault", record.usdcVault],
    ["SAS credential", record.sasCredential],
  ]
  return (
    <Panel title="Devnet · end to end" action={<span className="text-xs text-muted-foreground">Recorded {record.updatedAt.slice(0, 10)}</span>}>
      <div className="grid gap-4 p-3 text-sm">
        <AccountRow label="Program" id={record.programId} />
        <div className="grid gap-1">{accounts.map(([label, id]) => <AccountRow key={label} label={label} id={id} />)}</div>
        <div>
          <h3 className="mb-1 text-xs font-medium text-muted-foreground">Signatures</h3>
          <SignatureList map={record.signatures} />
        </div>
      </div>
    </Panel>
  )
}

function ForkCard({ record }: { record: ForkRecord }) {
  return (
    <Panel title="Fork · local recording" action={<span className="text-xs text-muted-foreground">Checked {record.checkedAt.slice(0, 16)}Z</span>}>
      <div className="grid gap-4 p-3 text-sm">
        <p className="text-xs text-muted-foreground">
          local mainnet fork (Surfpool), not publicly resolvable. Copy the signatures below.
          The committed record is <code className="break-all">scripts/fork/out/fork-scenario.json</code>.
          Transfer-agent approval in this recording: {record.transferAgentApproval}.
        </p>
        <LocalRow label="Program" id={record.programId} />
        <LocalRow label="Venue" id={record.venue} />
        <div className="flex flex-wrap items-baseline justify-between gap-2">
          <span className="text-muted-foreground">FWDI mint · public</span>
          <ChainLink href={solscanUrl("mainnet", "token", record.fwdiMint)} id={record.fwdiMint} kind="token" />
        </div>
        <div>
          <h3 className="mb-1 text-xs font-medium text-muted-foreground">Signatures · local mainnet fork (Surfpool), not publicly resolvable</h3>
          <div className="grid gap-1">
            {orderedSignatures(record.signatures).map(([key, signature]) => <LocalRow key={key} label={key} id={signature} />)}
          </div>
        </div>
      </div>
    </Panel>
  )
}

function Powers({ notice }: { notice: NoticeChain }) {
  const program = notice.chain.program
  const venue = notice.chain.venue
  const symbol = notice.chain.symbols[0]
  const token = symbol?.token
  if (!program || !venue) {
    return <EmptyBlock title="Notice draft has no chain facts" detail={(notice.chain.errors ?? []).join(" ") || "The draft was generated without a program or venue account."} />
  }
  const cap = token && /^\d+$/.test(symbol.capShares) ? formatShares(formatUnits(BigInt(symbol.capShares), token.decimals)) : symbol?.capShares
  const rows: [string, ReactNode][] = [
    ["Upgrade the program", <>{program.upgradeAuthority ? <ChainLink href={solscanUrl("devnet", "account", program.upgradeAuthority)} id={program.upgradeAuthority} kind="account" /> : "none — the program is immutable"} can replace the code, move this authority, or close it. ProgramData {program.programData ? <ChainLink href={solscanUrl("devnet", "account", program.programData)} id={program.programData} kind="account" /> : "was not read"}.</>],
    ["Post or clear a halt", <><ChainLink href={solscanUrl("devnet", "account", venue.relay)} id={venue.relay} kind="account" /> records halts, resumptions and heartbeats. Heartbeat limit {venue.heartbeatMaxAgeS}s. It cannot move balances.</>],
    ["Set the share budget or record a breach", <><ChainLink href={solscanUrl("devnet", "account", venue.dataAuthority)} id={venue.dataAuthority} kind="account" /> sets the daily budget{cap ? ` (now ${cap} shares on ${symbol?.ticker})` : ""} and records volume-threshold breaches. A second breach pauses the symbol.</>],
    ["Register, notice, activate", <><ChainLink href={solscanUrl("devnet", "account", venue.admin)} id={venue.admin} kind="account" /> registers symbols, records issuer notices and objections, and activates pools.</>],
    ["Issue or revoke admission", <><ChainLink href={solscanUrl("devnet", "account", venue.credentialIssuer)} id={venue.credentialIssuer} kind="account" /> grants and revokes credentials.</>],
    ["Freeze a holder's tokens", token?.freezeAuthority ? <><ChainLink href={solscanUrl("devnet", "account", token.freezeAuthority)} id={token.freezeAuthority} kind="account" /> is {symbol?.ticker}&apos;s freeze authority and can freeze or thaw any account, including pool vaults.</> : "The notice draft did not read a freeze authority."],
    ["Move tokens without a swap", token?.permanentDelegate ? <>The venue program has no instruction that overrides a swap. The {symbol?.ticker} permanent delegate <ChainLink href={solscanUrl("devnet", "account", token.permanentDelegate)} id={token.permanentDelegate} kind="account" /> can transfer or burn tokens, including from pool vaults. On devnet that mint is a rehearsal stand-in.</> : "The venue program has no instruction that overrides a swap or moves a participant's tokens."],
  ]
  return (
    <div className="grid gap-3 p-3 text-sm">
      <p className="text-xs text-muted-foreground">From GET /notice/draft chain facts at {notice.generatedAt}. {notice.orderCite ?? ""}</p>
      {rows.map(([label, body]) => (
        <div key={label} className="grid gap-1 border-t pt-3 first:border-0 first:pt-0 sm:grid-cols-[16rem_1fr]">
          <span className="font-medium">{label}</span>
          <span>{body}</span>
        </div>
      ))}
    </div>
  )
}

function StandIn() {
  const halts = useHalts()
  const symbols = useSymbols()
  const fee = symbols.data?.symbols[0]?.fee_bps
  const rows: [string, string, string, string][] = [
    ["Stock token on devnet", `${symbols.data?.symbols[0]?.symbol ?? "Rehearsal mint"} ${devnetRecord.stockMint}`, "FWDI on the fork recording", "Stand-in"],
    ["Stock token on the fork", forkRecord.fwdiMint, "Forward Industries FWDI", "Real mint, fork only"],
    ["Fork thaw", forkRecord.transferAgentApproval, "Issuer transfer-agent approval", "Stand-in"],
    ["Admission", "30-day test credential after an OFAC screen", "Broker KYC and suitability", "Stand-in"],
    ["Sanctions list", "OFAC SDN digital-currency addresses", "The same list", "Real"],
    ["Halt data", halts.isPending ? "Loading the halt ledger" : halts.isError ? "Halt ledger did not load" : (halts.data?.source ?? "Source not named"), "Listing-exchange halt feed", halts.isPending ? "Loading" : halts.isError ? "Unavailable" : "Real"],
    ["Share budget", "Enforced in the program by the data authority", "The order's volume comparison", "Rule is real"],
    ["Pool fee", symbols.isPending ? "Loading" : fee === undefined || fee === null ? "Not loaded" : `${(fee / 100).toFixed(2)}% from the venue API`, "A venue-operated pool", symbols.isPending ? "Loading" : symbols.isError ? "Unavailable" : "Real"],
    ["Program", `Devnet ${devnetRecord.programId}`, "Mainnet deployment", mainnetRecord ? "Real" : "Devnet only"],
  ]
  return (
    <>
    <ul className="grid lg:hidden">
      {rows.map((row) => (
        <li key={row[0]} className="grid gap-1 border-b p-3 text-sm">
          <span className="font-medium">{row[0]} <span className="font-normal text-muted-foreground">· {row[3]}</span></span>
          <span className="break-all">{row[1]}</span>
          <span className="text-muted-foreground">{row[2]}</span>
        </li>
      ))}
    </ul>
    <div className="hidden overflow-x-auto lg:block">
      <table className="w-full text-left text-sm">
        <thead className="text-xs text-muted-foreground">
          <tr>
            <th className="px-3 py-2 font-medium">Part</th>
            <th className="px-3 py-2 font-medium">In this build</th>
            <th className="px-3 py-2 font-medium">Counterpart</th>
            <th className="px-3 py-2 font-medium">Status</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => (
            <tr key={row[0]} className="border-t align-top">
              {row.map((cell, index) => <td key={index} className="px-3 py-2">{cell}</td>)}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
    </>
  )
}

export function ProofPage() {
  const notice = useNoticeChain()
  const checks = swapChecks(null)
  return (
    <div className="grid min-w-0 gap-6 px-4 py-6 sm:px-6">
      <div className="grid max-w-3xl gap-2">
        <h1 className="text-xl font-semibold tracking-tight">About</h1>
        <p className="text-sm text-muted-foreground">
          Bellwether is a Solana venue program and operator workbench for the SEC Tokenized Securities Venue Innovation Exemption,{" "}
          <a className="underline" href={ORDER} target="_blank" rel="noreferrer">Release 34-106402</a>.
          Devnet is running end to end. Mainnet is the pitch target and is not deployed.
        </p>
      </div>
      <section className="grid max-w-3xl gap-2 text-sm">
        <h2 className="font-medium">What it enforces</h2>
        <p>
          The order puts duties on a US venue operator: who may trade, when trading must stop, how much of a stock may trade, a public tape, and advance notice.
          This program enforces the swap-path checks. It does not, by itself, make the operator a qualifying venue or replace counsel.
        </p>
        <ol className="list-decimal space-y-1 pl-5">
          {checks.map((check) => <li key={check.id}><span className="font-medium">{check.title}. </span>{check.summary}</li>)}
        </ol>
      </section>
      <section className="grid gap-3">
        <h2 className="font-medium">Where it runs</h2>
        <div className="grid items-start gap-3 lg:grid-cols-3">
          <DevnetCard record={devnetRecord} />
          <ForkCard record={forkRecord} />
          <Panel title="Mainnet · pitch">
            <EmptyBlock title="Mainnet is not deployed" detail="No mainnet deployment file is recorded. This page will not invent a program id or a signature. It is the target after devnet is green end to end." />
          </Panel>
        </div>
      </section>
      <Panel title="Real vs stand-in">
        <StandIn />
      </Panel>
      <Panel title="Who can pause, upgrade or override">
        {notice.isPending ? <div className="p-3"><LoadingBlock label="Loading notice draft" /></div>
          : notice.isError ? <div className="p-3"><ErrorBlock title="The notice draft is unavailable" error={notice.error} onRetry={() => void notice.refetch()} /></div>
          : <Powers notice={notice.data} />}
      </Panel>
    </div>
  )
}

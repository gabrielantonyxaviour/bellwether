/**
 * Recorded feed fixtures for deterministic relay checks.
 *
 * - recorded:  the live Nasdaq Trader trade-halt RSS, saved verbatim 2026-09-25 09:11 UTC (17 items).
 * - halt:      the recorded feed plus a SYNTHETIC LUDP pause for FWDI (the symbol BWRS follows),
 *              09/25/2026 10:14:07.312 ET, no resumption yet.
 * - resume:    the same pause with its resumption (quote 10:19:07, trade 10:19:12 ET).
 * - challenge: SYNTHETIC — the shape of the Incapsula bot challenge served instead of RSS.
 * - nyse:      NYSE's public current trade-halts JSON, saved verbatim 2026-09-25 09:11 UTC.
 */
import { readFileSync } from "node:fs"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"

const DIR = dirname(fileURLToPath(import.meta.url))

export const FIXTURE = {
  recorded: "nasdaq-tradehalts-2026-09-25T0911Z.xml",
  halt: "fwdi-ludp-halt.xml",
  resume: "fwdi-ludp-resume.xml",
  challenge: "incapsula-challenge.html",
  nyse: "nyse-current-2026-09-25T0911Z.json",
} as const

export type FixtureName = (typeof FIXTURE)[keyof typeof FIXTURE]

/** The synthetic pause, as the relay should read it (UTC). */
export const SYNTHETIC_LUDP = {
  nasdaq: "FWDI",
  reasonCode: "LUDP",
  haltAt: Date.parse("2026-09-25T14:14:07.312Z"),
  resumedAt: Date.parse("2026-09-25T14:19:12.000Z"),
} as const

export function readFixture(name: FixtureName): string {
  return readFileSync(join(DIR, name), "utf8")
}

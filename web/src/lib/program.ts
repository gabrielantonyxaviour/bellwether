/**
 * The venue program in the browser: account decoders, participant instruction builders, PDAs,
 * the swap quote, and error codes 6000–6016 as plain states. Contract: docs/program-contract.md.
 *
 *   import { decodePool, swapInstruction, toVenueError } from "@/lib/program"
 */
export * from "@/lib/venue/accounts"
export * from "@/lib/venue/instructions"
export * from "@/lib/venue/errors"

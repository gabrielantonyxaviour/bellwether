/** Solana Kit can surface a transport failure without the RPC's simulation payload. */
export function transactionFailureMessage(message: string | null): string {
  if (!message) return "Transaction failed. Check the chain and retry."
  if (/Cannot destructure property 'err' of 'data'/.test(message)) {
    return "The network did not confirm submission. Check your balance or position, then retry."
  }
  return message
}

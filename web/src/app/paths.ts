/** Every route in the app. Link with these builders instead of string literals. */
export const paths = {
  home: "/",
  explorer: "/explorer",
  about: "/about",
  /** Previous names. Same destinations, so in-flight links keep resolving. */
  tape: "/explorer",
  proof: "/about",
  onboard: "/app/onboard",
  trade: (symbol: string) => `/app/trade/${encodeURIComponent(symbol)}`,
  liquidity: (symbol: string) => `/app/liquidity/${encodeURIComponent(symbol)}`,
  operator: {
    overview: "/operator",
    symbols: "/operator/symbols",
    halts: "/operator/halts",
    participants: "/operator/participants",
    publicNotice: "/operator/public-notice",
    rehearsal: "/operator/rehearsal/fwdi",
  },
} as const

/** Surface ids from spec.json, keyed by route pattern. */
export const SURFACES = {
  "/": "pg_home",
  "/explorer": "pg_tape",
  "/about": "pg_proof",
  "/app/onboard": "pg_onboard",
  "/app/trade/:symbol": "pg_trade",
  "/app/liquidity/:symbol": "pg_liquidity",
  "/operator": "pg_op_overview",
  "/operator/symbols": "pg_op_symbols",
  "/operator/halts": "pg_op_halts",
  "/operator/participants": "pg_op_participants",
  "/operator/public-notice": "pg_op_notice",
  "/operator/rehearsal/fwdi": "pg_op_rehearsal",
} as const

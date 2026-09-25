/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_CLUSTER?: "fork" | "devnet" | "mainnet"
  readonly VITE_RPC_URL?: string
  readonly VITE_WS_URL?: string
  readonly VITE_PROGRAM_ID?: string
  readonly VITE_VENUE?: string
  readonly VITE_USDC_MINT?: string
  readonly VITE_BWRS_MINT?: string
  readonly VITE_DEFAULT_SYMBOL?: string
  readonly VITE_API_BASE_URL?: string
  readonly VITE_CREDENTIAL_API_URL?: string
}

interface ImportMeta {
  readonly env: ImportMetaEnv
}

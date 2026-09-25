/** Every response, log line and on-chain name says what this is — and what it is not. */
export const LABEL = "test admission, not KYC" as const

export const SAS_NAMES = {
  credential: "bellwether-test-admission",
  schema: "bellwether-admission",
  schemaVersion: 1,
  schemaDescription:
    "Bellwether test admission, not KYC: the wallet was screened against the OFAC SDN digital-currency address list only.",
  /** One u8 field (SAS compact layout 0 = u8). */
  layout: [0],
  fieldNames: ["tier"],
  /** Attestation data: tier 1 = test admission. */
  data: [1],
} as const

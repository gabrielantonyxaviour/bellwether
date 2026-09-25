/** ABEL SCENARIO — generated. Fill in selectors and assertions; do not rename step ids.
 *  scenario:   sc_halt_sync
 *  mapping:    1
 *  definition: 238495074877483b58969e3a7c0f9ebcbd330862afb13175c55ce49cf0895312
 *
 *  Regenerate with: npm run graph -- scenario-spec --product <id>
 *  Your code between the `>>> abel:<id>` markers is preserved across regeneration.
 */
import { scenario, step } from "./_abel"

scenario("sc_halt_sync", "participant", () => {
  step("halted", "Trade while halted", async ({ page }) => {
    // action:   Relay sets a halt from the Nasdaq feed; participant attempts a swap
    // expected: Swap fails TradingHalted; page shows 'Halted by Nasdaq', reason code and measured latency
    // >>> abel:halted
    throw new Error("TODO: implement step halted")
    // <<< abel:halted
  })
  step("resume", "Trade after resumption", async ({ page }) => {
    // action:   Relay clears the halt on resumption; participant swaps
    // expected: Swap confirms
    // >>> abel:resume
    throw new Error("TODO: implement step resume")
    // <<< abel:resume
  })
})

scenario("sc_halt_sync", "operator", () => {
  step("ledger", "Read the latency ledger", async ({ page }) => {
    // action:   Open /operator/halts
    // expected: Halt row with feed time, detection time and confirmed-enforcement time; relay healthy
    // >>> abel:ledger
    throw new Error("TODO: implement step ledger")
    // <<< abel:ledger
  })
})

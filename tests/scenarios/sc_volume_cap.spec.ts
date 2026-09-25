/** ABEL SCENARIO — generated. Fill in selectors and assertions; do not rename step ids.
 *  scenario:   sc_volume_cap
 *  mapping:    1
 *  definition: 315f875717614f91521f794756fb9c0a956a4be1d3a10069b810262d4cbf9bee
 *
 *  Regenerate with: npm run graph -- scenario-spec --product <id>
 *  Your code between the `>>> abel:<id>` markers is preserved across regeneration.
 */
import { scenario, step } from "./_abel"

scenario("sc_volume_cap", "participant", () => {
  step("capped", "Hit the daily share budget", async ({ page }) => {
    // action:   Swap until the next swap would exceed the budget
    // expected: Swap fails CapReached; page shows 'Daily cap reached'
    // >>> abel:capped
    throw new Error("TODO: implement step capped")
    // <<< abel:capped
  })
  step("paused", "3-month pause after second breach", async ({ page }) => {
    // action:   On the fork, record two breaches, attempt a swap, time-travel three months, swap again
    // expected: Swap fails Paused until the time-travelled date, then confirms
    // >>> abel:paused
    throw new Error("TODO: implement step paused")
    // <<< abel:paused
  })
})

scenario("sc_volume_cap", "operator", () => {
  step("gauge", "Read cap usage", async ({ page }) => {
    // action:   Open /operator
    // expected: Cap gauge shows shares used vs budget with the data source
    // >>> abel:gauge
    throw new Error("TODO: implement step gauge")
    // <<< abel:gauge
  })
})

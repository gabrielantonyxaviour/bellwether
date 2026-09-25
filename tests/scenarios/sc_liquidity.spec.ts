/** ABEL SCENARIO — generated. Fill in selectors and assertions; do not rename step ids.
 *  scenario:   sc_liquidity
 *  mapping:    1
 *  definition: 9ded51b7e1c9e267c4123f92d56bb097d6001bd099451054b26da96bb86a5a48
 *
 *  Regenerate with: npm run graph -- scenario-spec --product <id>
 *  Your code between the `>>> abel:<id>` markers is preserved across regeneration.
 */
import { scenario, step } from "./_abel"

scenario("sc_liquidity", "covered_firm", () => {
  step("add", "Add liquidity", async ({ page }) => {
    // action:   Open /app/liquidity/<symbol> and deposit
    // expected: Position recorded as non-transferable
    // >>> abel:add
    throw new Error("TODO: implement step add")
    // <<< abel:add
  })
  step("withdraw_halted", "Withdraw while halted", async ({ page }) => {
    // action:   Symbol halted; attempt add, then withdraw
    // expected: Add fails TradingHalted; withdraw succeeds; page reads 'Halted: withdraw only'
    // >>> abel:withdraw_halted
    throw new Error("TODO: implement step withdraw_halted")
    // <<< abel:withdraw_halted
  })
})

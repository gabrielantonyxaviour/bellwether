/** ABEL SCENARIO — generated. Fill in selectors and assertions; do not rename step ids.
 *  scenario:   sc_participant_trade
 *  mapping:    1
 *  definition: 61737d4df6e1dddc0b77d9612f6ebf858526c1b8322c885669a8e877560d5bca
 *
 *  Regenerate with: npm run graph -- scenario-spec --product <id>
 *  Your code between the `>>> abel:<id>` markers is preserved across regeneration.
 */
import { scenario, step } from "./_abel"

scenario("sc_participant_trade", "participant", () => {
  step("connect", "Connect wallet", async ({ page }) => {
    // action:   Open /app/onboard and connect the wallet
    // expected: Wallet address shown; admission not yet granted
    // >>> abel:connect
    throw new Error("TODO: implement step connect")
    // <<< abel:connect
  })
  step("admit", "Get admitted", async ({ page }) => {
    // action:   Request admission
    // expected: OFAC screening passes, a test-admission attestation is issued and the rehearsal-stock account is thawed
    // >>> abel:admit
    throw new Error("TODO: implement step admit")
    // <<< abel:admit
  })
  step("swap", "Swap USDC for rehearsal stock", async ({ page }) => {
    // action:   Open /app/trade/<symbol>, enter an amount, confirm
    // expected: Swap confirms; reserves move per x·y=k net of fee; today's share count increases
    // >>> abel:swap
    throw new Error("TODO: implement step swap")
    // <<< abel:swap
  })
  step("tape", "See the print", async ({ page }) => {
    // action:   Open /tape
    // expected: The trade appears with symbols, price, size, UTC time, direction, pool and program
    // >>> abel:tape
    throw new Error("TODO: implement step tape")
    // <<< abel:tape
  })
})

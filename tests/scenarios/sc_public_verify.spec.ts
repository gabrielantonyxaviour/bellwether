/** ABEL SCENARIO — generated. Fill in selectors and assertions; do not rename step ids.
 *  scenario:   sc_public_verify
 *  mapping:    1
 *  definition: 3b38e653be64753f341e38fcb1ca6452e25055e24f6f73310db3611cf970830d
 *
 *  Regenerate with: npm run graph -- scenario-spec --product <id>
 *  Your code between the `>>> abel:<id>` markers is preserved across regeneration.
 */
import { scenario, step } from "./_abel"

scenario("sc_public_verify", "public", () => {
  step("home", "Open home", async ({ page }) => {
    // action:   Open /
    // expected: Explains Bellwether and links to trade, tape and proof
    // >>> abel:home
    throw new Error("TODO: implement step home")
    // <<< abel:home
  })
  step("tape", "Read the tape", async ({ page }) => {
    // action:   Open /tape
    // expected: Prints listed with required fields
    // >>> abel:tape
    throw new Error("TODO: implement step tape")
    // <<< abel:tape
  })
  step("proof", "Verify on-chain", async ({ page }) => {
    // action:   Open /proof and follow explorer links
    // expected: Program id executable; signatures resolve
    // >>> abel:proof
    throw new Error("TODO: implement step proof")
    // <<< abel:proof
  })
})

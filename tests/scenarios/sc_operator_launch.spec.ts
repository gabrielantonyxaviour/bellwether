/** ABEL SCENARIO — generated. Fill in selectors and assertions; do not rename step ids.
 *  scenario:   sc_operator_launch
 *  mapping:    1
 *  definition: e41a2765c0bb72d956638ef9e061de4e32fcec4b2e581a29eb3a27578dfdf51a
 *
 *  Regenerate with: npm run graph -- scenario-spec --product <id>
 *  Your code between the `>>> abel:<id>` markers is preserved across regeneration.
 */
import { scenario, step } from "./_abel"

scenario("sc_operator_launch", "operator", () => {
  step("overview", "Open the overview", async ({ page }) => {
    // action:   Open /operator
    // expected: Symbols, tiers, gauges, heartbeat age and activation states render
    // >>> abel:overview
    throw new Error("TODO: implement step overview")
    // <<< abel:overview
  })
  step("register", "Register a third-party symbol", async ({ page }) => {
    // action:   On /operator/symbols register a demo symbol and record the issuer notice receipt
    // expected: Notice clock shows 30 days
    // >>> abel:register
    throw new Error("TODO: implement step register")
    // <<< abel:register
  })
  step("activate_early", "Activate too early", async ({ page }) => {
    // action:   Try to activate its pool
    // expected: Refused: notice window not over
    // >>> abel:activate_early
    throw new Error("TODO: implement step activate_early")
    // <<< abel:activate_early
  })
  step("activate", "Activate after 30 days", async ({ page }) => {
    // action:   On the fork, time-travel 30 days and activate
    // expected: Pool becomes active
    // >>> abel:activate
    throw new Error("TODO: implement step activate")
    // <<< abel:activate
  })
  step("credentials", "Issue and revoke a credential", async ({ page }) => {
    // action:   On /operator/participants issue then revoke
    // expected: Revoked wallet can no longer swap
    // >>> abel:credentials
    throw new Error("TODO: implement step credentials")
    // <<< abel:credentials
  })
  step("notice", "Review the public notice", async ({ page }) => {
    // action:   Open /operator/public-notice
    // expected: Chain-read items equal the program's upgrade authority and keys; others flagged operator input
    // >>> abel:notice
    throw new Error("TODO: implement step notice")
    // <<< abel:notice
  })
  step("rehearsal", "Run the FWDI rehearsal", async ({ page }) => {
    // action:   Open /operator/rehearsal/fwdi
    // expected: Real FWDI authorities, its frozen Manifest market and the Tier-2 share budget (inferred) render
    // >>> abel:rehearsal
    throw new Error("TODO: implement step rehearsal")
    // <<< abel:rehearsal
  })
})

/** Local Playwright adapter for Abel's step-id reporting convention. */
import { test, type Page } from "@playwright/test"

type Registered = { id: string; title: string; run: (args: { page: Page }) => Promise<void> }
let collecting: Registered[] | null = null

export function scenario(id: string, role: string, body: () => void): void {
  test.describe(id, () => {
    const steps: Registered[] = []
    const prior = collecting
    collecting = steps
    try { body() } finally { collecting = prior }
    if (steps.length === 0) throw new Error(`Scenario ${id}/${role} has no steps`)
    test(role, async ({ page }) => {
      for (const item of steps) await test.step(`${item.id} — ${item.title}`, () => item.run({ page }))
    })
  })
}

export function step(id: string, title: string, run: Registered["run"]): void {
  if (!collecting) throw new Error(`Step ${id} is outside a scenario`)
  collecting.push({ id, title, run })
}

export { expect, test } from "@playwright/test"

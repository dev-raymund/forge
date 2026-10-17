import path from "node:path";
import type { Page } from "@playwright/test";

/**
 * axe-core (M8-2: "axe checks on templates"), run in the page against WCAG 2.1 A and AA. Returns each violation as
 * `rule: the elements`, so a failure says what to fix; an empty list passes.
 */
export async function axeViolations(page: Page): Promise<string[]> {
  await page.addScriptTag({ path: path.join(process.cwd(), "node_modules/axe-core/axe.min.js") });
  const violations = await page.evaluate(async () => {
    const axe = (window as unknown as { axe: { run: (context: Document, options: unknown) => Promise<{ violations: { id: string; nodes: { target: string[] }[] }[] }> } }).axe;
    const result = await axe.run(document, { runOnly: { type: "tag", values: ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"] } });
    return result.violations.map((violation) => `${violation.id}: ${violation.nodes.map((node) => node.target.join(" ")).join(", ")}`);
  });
  return violations;
}

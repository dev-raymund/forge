import { expect, test, type Page } from "@playwright/test";

/**
 * Spike S3 (M0-5, ADR 0003) in a real browser: the behaviours the headless
 * tests can't cover (native drag and drop, real keyboard, real clipboard, the
 * browser's HTML parser). Runs against /dev/editor, which production never serves.
 */

const editor = (page: Page) => page.getByTestId("editor");
const topLevel = (page: Page) => editor(page).locator(":scope > *");

async function topLevelTexts(page: Page, n = 3) {
  return (await topLevel(page).allInnerTexts()).slice(0, n).map((t) => t.trim().split("\n")[0]);
}

async function storedIds(page: Page): Promise<string[]> {
  const json = JSON.parse((await page.getByTestId("json").textContent()) ?? "{}");
  const out: string[] = [];
  const walk = (n: { attrs?: { id?: string }; content?: unknown[] }) => {
    if (n.attrs?.id) out.push(n.attrs.id);
    (n.content as (typeof n)[] | undefined)?.forEach(walk);
  };
  walk(json.doc ?? {});
  return out;
}

test.beforeEach(async ({ page }) => {
  page.on("dialog", (d) => {
    throw new Error(`unexpected dialog: ${d.message()}`);
  });
  await page.goto("/dev/editor");
  await expect(editor(page)).toBeVisible();
  await expect(topLevel(page).first()).toHaveText("What we do");
});

test("renders all blocks and autosaves typing", async ({ page }) => {
  await expect(page.getByTestId("preview").locator("h2")).toHaveText("What we do");
  await topLevel(page).first().click();
  await page.keyboard.press("End");
  await page.keyboard.type(" today");
  await expect(page.getByTestId("preview").locator("h2")).toHaveText("What we do today");
  await expect(page.getByTestId("autosave-status")).toHaveText(/^Saved · v2/, { timeout: 5_000 });
});

test("Alt+↓ / Alt+↑ reorder top-level blocks; undo restores the order", async ({ page }) => {
  await topLevel(page).first().click();
  await page.keyboard.press("Alt+ArrowDown");
  await expect.poll(() => topLevelTexts(page, 2)).toEqual([expect.stringMatching(/^We build/), "What we do"]);
  await page.keyboard.press("Alt+ArrowUp");
  await expect.poll(() => topLevelTexts(page, 2)).toEqual(["What we do", expect.stringMatching(/^We build/)]);
  await page.keyboard.press("Alt+ArrowDown");
  await page.keyboard.press("ControlOrMeta+z");
  await expect.poll(() => topLevelTexts(page, 2)).toEqual(["What we do", expect.stringMatching(/^We build/)]);
});

test("the drag handle moves a top-level block, keeps ids, and undo restores it", async ({ page }) => {
  const idsBefore = new Set(await storedIds(page));
  const heading = topLevel(page).first();
  await heading.hover();
  const handle = page.getByTestId("drag-handle");
  await expect(handle).toBeVisible();
  // The handle is positioned asynchronously next to the hovered block: wait for it.
  await expect
    .poll(async () => {
      const [h, b] = [await handle.boundingBox(), await heading.boundingBox()];
      return !!h && !!b && Math.abs(h.y + h.height / 2 - (b.y + b.height / 2)) < b.height / 2 + 4;
    })
    .toBe(true);

  // Drop at the end of the paragraph's line: a heading can't go inside a
  // paragraph, and ProseMirror picks before/after by *document* position (end of
  // text → after), not by the visual half. Dropping onto a quote, list or column
  // puts the block inside that container. See ADR 0003.
  const target = topLevel(page).nth(1);
  const handleBox = (await handle.boundingBox())!;
  const targetBox = (await target.boundingBox())!;
  await page.mouse.move(handleBox.x + handleBox.width / 2, handleBox.y + handleBox.height / 2);
  await page.mouse.down();
  await page.mouse.move(targetBox.x + targetBox.width - 4, targetBox.y + targetBox.height / 2, { steps: 12 });
  await page.mouse.up();

  await expect.poll(() => topLevelTexts(page, 3)).toEqual([
    expect.stringMatching(/^We build/),
    "What we do",
    expect.stringMatching(/^Great work/),
  ]);
  await expect.poll(async () => new Set(await storedIds(page))).toEqual(idsBefore); // moved, not copied

  await editor(page).click();
  await page.keyboard.press("ControlOrMeta+z");
  await expect.poll(() => topLevelTexts(page, 1)).toEqual(["What we do"]);
});

test("copy/paste inside the editor re-ids the copies", async ({ page }) => {
  // ProseMirror's real copy serializer and paste parser, fed through a
  // DataTransfer instead of the OS clipboard (shared between parallel workers).
  const before = await storedIds(page);
  await topLevel(page).first().click();
  await page.keyboard.press("ControlOrMeta+a");
  await expect.poll(() => page.evaluate(() => document.getSelection()?.toString().length ?? 0)).toBeGreaterThan(100);
  await page.evaluate(() => {
    const clipboardData = new DataTransfer();
    document
      .querySelector('[data-testid="editor"]')!
      .dispatchEvent(new ClipboardEvent("copy", { clipboardData, bubbles: true, cancelable: true }));
    (window as unknown as { __copied: string }).__copied = clipboardData.getData("text/html");
  });
  expect(await page.evaluate(() => (window as unknown as { __copied: string }).__copied)).toContain("data-pm-slice");
  await page.keyboard.press("ArrowRight"); // collapse to the end of the document
  await expect.poll(() => page.evaluate(() => document.getSelection()?.isCollapsed)).toBe(true);
  await page.evaluate(() => {
    const clipboardData = new DataTransfer();
    clipboardData.setData("text/html", (window as unknown as { __copied: string }).__copied);
    document
      .querySelector('[data-testid="editor"]')!
      .dispatchEvent(new ClipboardEvent("paste", { clipboardData, bubbles: true, cancelable: true }));
  });
  await expect.poll(async () => (await storedIds(page)).length).toBeGreaterThan(before.length);
  const after = await storedIds(page);
  expect(new Set(after).size).toBe(after.length); // copies got new ids
  expect(after.slice(0, before.length)).toEqual(before); // originals kept theirs
});

test("pasted hostile HTML is normalized: nothing executes, nothing unsafe is rendered", async ({ page }) => {
  await page.evaluate(() => ((window as unknown as { __xss: number }).__xss = 0));
  await topLevel(page).last().click();
  await page.evaluate(() => {
    const clipboardData = new DataTransfer();
    clipboardData.setData(
      "text/html",
      `<p>Hi<img src=x onerror="window.__xss++"><a href="javascript:window.__xss++">bad</a>
       <svg onload="window.__xss++"></svg><iframe srcdoc="<script>parent.__xss++</script>"></iframe></p>
       <div data-forge-node="button" data-label="&quot;Pay&quot;" data-href="&quot;javascript:window.__xss++&quot;"></div>`,
    );
    document
      .querySelector('[data-testid="editor"]')!
      .dispatchEvent(new ClipboardEvent("paste", { clipboardData, bubbles: true, cancelable: true }));
  });
  await expect(editor(page)).toContainText("Hibad");
  await page.waitForTimeout(500);
  expect(await page.evaluate(() => (window as unknown as { __xss: number }).__xss)).toBe(0);
  const preview = await page.getByTestId("preview").innerHTML();
  expect(preview).not.toMatch(/javascript:|onerror|onload|srcdoc|<script|<svg/i);
  expect(await page.getByTestId("json").textContent()).not.toMatch(/javascript:|"Pay"/);
});

test("a save from another tab produces a conflict instead of an overwrite", async ({ page }) => {
  await page.getByRole("button", { name: "Simulate a save from another tab" }).click();
  await topLevel(page).first().click();
  await page.keyboard.type("!");
  await expect(page.getByTestId("autosave-status")).toHaveText("Conflict: someone saved v2", { timeout: 5_000 });
  await page.getByRole("button", { name: "Reload latest" }).click();
  await expect(topLevel(page).first()).toHaveText("What we do");
  await topLevel(page).first().click();
  await page.keyboard.type("?");
  await expect(page.getByTestId("autosave-status")).toHaveText(/^Saved · v3/, { timeout: 5_000 });
});

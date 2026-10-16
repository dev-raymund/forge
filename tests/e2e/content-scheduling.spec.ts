import { randomBytes } from "node:crypto";
import { expect, test, type APIRequestContext, type Page } from "@playwright/test";
import { uuidv7 } from "uuidv7";
import { asUniqueVisitor } from "./helpers/auth";
import { E2E_CRON_SECRET } from "./helpers/env";
import { markEmailVerified, seedOrganization, sitesIn } from "./helpers/orgs";
import { createSite, expectSiteCreated, memberOf } from "./helpers/site-ui";
import { addMember, inTenant, seedUser } from "./helpers/sites";

/**
 * M7-2 end to end against the production build: scheduling from the editor in the site's time zone, the queue's job run
 * by the real cron route (with its secret) once the time has come, what visitors then see, cancelling, and a schedule
 * that cannot be published (the editor and the overview say why).
 *
 * The time "comes" by moving the schedule's instant, its job's `run_at` and its payload into the past together, in the
 * database: the job checks they agree, so this is the schedule a person would have made for a minute ago.
 */

test.describe.configure({ timeout: 120_000 });

const tail = () => randomBytes(3).toString("hex");
const editor = (page: Page) => page.getByTestId("editor");
const saved = (page: Page) => expect(page.getByTestId("autosave-status")).toHaveText(/^Saved at/, { timeout: 15_000 });
const ZONE = "Asia/Manila";

async function withLiveSite(page: Page) {
  const org = await seedOrganization("sched");
  await addMember(org.id, (await seedUser("Olive Owner")).email, "owner");
  const member = await memberOf(page, "owner", org);
  await markEmailVerified(member.email);
  const address = `sched-${tail()}`;
  await page.goto(`/${org.slug}/sites/new`);
  await createSite(page, { name: "Harbour Bakery", address, timezone: ZONE });
  await expectSiteCreated(page, org.slug, address);
  const [site] = await sitesIn(org.id);
  const base = `/${org.slug}/sites/${site!.slug}`;
  await page.goto(base);
  await page.getByRole("button", { name: "Publish site…" }).click();
  await page.getByRole("dialog").getByRole("button", { name: "Publish site" }).click();
  await expect(page.getByTestId("site-status").filter({ visible: true })).toHaveText("Live", { timeout: 15_000 });
  return { org, site: site!, base, address, member };
}

async function seedPost(orgId: string, siteId: string, title: string, slug: string) {
  const id = uuidv7();
  const content = { v: 1, doc: { type: "doc", content: [{ type: "paragraph", attrs: { id: uuidv7() }, content: [{ type: "text", text: "Scheduled words." }] }] } };
  await inTenant(orgId, async (c) => {
    await c.query("insert into entries (id, organization_id, site_id, type, locale, title, slug, path) values ($1, $2, $3, 'post', 'en', $4, $5, $6)", [id, orgId, siteId, title, slug, `/blog/${slug}`]);
    await c.query("insert into entry_drafts (entry_id, organization_id, site_id, title, slug, content) values ($1, $2, $3, $4, $5, $6)", [id, orgId, siteId, title, slug, JSON.stringify(content)]);
  });
  return id;
}

/** The schedule's time comes: its instant, its job's time and its payload, a minute ago, together. */
async function timeComes(orgId: string, entryId: string) {
  await inTenant(orgId, async (c) => {
    const past = new Date(Date.now() - 60_000).toISOString();
    await c.query("update entries set scheduled_at = $1 where id = $2 and status = 'scheduled'", [past, entryId]);
    await c.query(
      "update jobs set run_at = $1::timestamptz, payload = jsonb_set(payload, '{runAt}', to_jsonb($4::text)) where dedupe_key = $2 and status = 'queued' and organization_id = $3",
      [past, `entry:${entryId}`, orgId, past],
    );
  });
}
const runCron = async (request: APIRequestContext) => {
  const res = await request.get("/api/internal/cron", { headers: { authorization: `Bearer ${E2E_CRON_SECRET}` } });
  expect(res.status()).toBe(200);
  return res.json();
};
const statusOf = async (orgId: string, id: string) =>
  (await inTenant(orgId, (c) => c.query<{ status: string; scheduled_at: Date | null }>("select status, scheduled_at from entries where id = $1", [id]))).rows[0]!;

test.beforeEach(async ({ page }) => {
  await asUniqueVisitor(page);
});

test("schedule a post in the site's time zone; edits after it are not published; the cron route publishes it when its time has come; visitors see it", async ({ page, browser, request }) => {
  const { org, site, base, address } = await withLiveSite(page);
  const id = await seedPost(org.id, site.id, "Rye season", "rye-season");
  await page.goto(`${base}/posts/${id}`);
  await expect(editor(page)).toBeVisible({ timeout: 15_000 });

  await page.getByRole("button", { name: "Schedule…" }).click();
  const dialog = page.getByTestId("schedule-dialog");
  const field = dialog.getByLabel(/^Date and time in Asia\/Manila \(UTC\+08:00\)$/);
  await expect(field).toHaveValue(/^\d{4}-\d{2}-\d{2}T09:00$/); // tomorrow, 9:00 where the site is
  const tomorrow = (await field.inputValue()).slice(0, 10);
  // A time in the past is refused by the field itself (its `min` is a couple of minutes from now, where the site is);
  // the server refuses it too (integration tests).
  await field.fill("2020-01-01T09:00");
  await dialog.getByRole("button", { name: "Schedule", exact: true }).click();
  expect(await field.evaluate((input) => (input as HTMLInputElement).validity.rangeUnderflow)).toBe(true);
  await expect(dialog).toBeVisible();
  expect((await statusOf(org.id, id)).status).toBe("draft");
  await field.fill(`${tomorrow}T09:30`);
  await dialog.getByRole("button", { name: "Schedule", exact: true }).click();
  await expect(dialog).toBeHidden();
  await expect(page.getByTestId("entry-status")).toHaveText("Scheduled");
  await expect(page.getByTestId("scheduled-for")).toContainText("09:30 (Asia/Manila, UTC+08:00)");
  await expect(page.getByRole("button", { name: "Publish", exact: true })).toHaveCount(0);
  const stored = await statusOf(org.id, id);
  expect(stored.status).toBe("scheduled");
  expect(new Date(stored.scheduled_at!).toISOString().slice(11, 16)).toBe("01:30"); // 09:30 in Manila is 01:30 UTC

  // Typed after scheduling: kept in the draft, not in the scheduled version.
  await expect(page.getByTestId("scheduled-note")).toBeVisible();
  await editor(page).click();
  await page.keyboard.press("End");
  await page.keyboard.type(" Typed later.");
  await saved(page);

  // On the overview, in the site's zone.
  await page.goto(base);
  await expect(page.getByTestId("scheduled-item")).toContainText("Rye season");
  await expect(page.getByTestId("scheduled-item")).toContainText("publishes");
  await expect(page.getByTestId("scheduled-item")).toContainText("(Asia/Manila, UTC+08:00)");

  // Not public before its time.
  const visitor = await (await browser.newContext()).newPage();
  expect((await visitor.goto(`/s/${address}/blog/rye-season`))?.status()).toBe(404);

  await timeComes(org.id, id);
  await runCron(request);
  expect((await statusOf(org.id, id)).status).toBe("published");
  await visitor.reload();
  await expect(visitor.getByRole("heading", { level: 1 })).toHaveText("Rye season");
  await expect(visitor.getByRole("main")).toContainText("Scheduled words.");
  await expect(visitor.getByRole("main")).not.toContainText("Typed later.");
  await visitor.goto(`/s/${address}/blog`);
  await expect(visitor.getByRole("link", { name: "Rye season" })).toBeVisible();

  // The editor: published, with the later changes unpublished; the activity names the system.
  await page.goto(`${base}/posts/${id}`);
  await expect(page.getByTestId("entry-status")).toHaveText("Published, with unpublished changes", { timeout: 15_000 });
  await page.goto(base);
  await expect(page.getByTestId("site-activity")).toContainText("Forge (scheduled publishing) published the post Rye season at /blog/rye-season, as scheduled.");
  await visitor.context().close();
});

test("change the time, then cancel the schedule: a draft again, and nothing is published when the old time comes", async ({ page, request }) => {
  const { org, site, base } = await withLiveSite(page);
  const id = await seedPost(org.id, site.id, "Maybe later", "maybe-later");
  await page.goto(`${base}/posts/${id}`);
  await expect(editor(page)).toBeVisible({ timeout: 15_000 });
  await page.getByRole("button", { name: "Schedule…" }).click();
  await page.getByTestId("schedule-dialog").getByRole("button", { name: "Schedule", exact: true }).click();
  await expect(page.getByTestId("entry-status")).toHaveText("Scheduled");
  await expect(page.getByTestId("scheduled-for")).toContainText("09:00");

  await page.getByRole("button", { name: "Change time…" }).click();
  const dialog = page.getByTestId("schedule-dialog");
  const value = await dialog.getByLabel(/^Date and time in Asia\/Manila/).inputValue();
  await dialog.getByLabel(/^Date and time in Asia\/Manila/).fill(`${value.slice(0, 10)}T17:45`);
  await dialog.getByRole("button", { name: "Change time" }).click();
  await expect(page.getByTestId("scheduled-for")).toContainText("17:45 (Asia/Manila, UTC+08:00)");

  await page.getByRole("button", { name: "Cancel schedule" }).click();
  await expect(page.getByTestId("entry-status")).toHaveText("Draft");
  await expect(page.getByText("The schedule is canceled: it is a draft.")).toBeVisible();
  await expect(page.getByRole("button", { name: "Publish", exact: true })).toBeVisible();
  await timeComes(org.id, id);
  await runCron(request);
  expect((await statusOf(org.id, id)).status).toBe("draft");
});

test("a schedule that cannot be published: a draft again, the editor and the overview say why", async ({ page, request }) => {
  const { org, site, base, member } = await withLiveSite(page);
  const id = await seedPost(org.id, site.id, "Not to be", "not-to-be");
  await page.goto(`${base}/posts/${id}`);
  await expect(editor(page)).toBeVisible({ timeout: 15_000 });
  await page.getByRole("button", { name: "Schedule…" }).click();
  await page.getByTestId("schedule-dialog").getByRole("button", { name: "Schedule", exact: true }).click();
  await expect(page.getByTestId("entry-status")).toHaveText("Scheduled");

  // The person who scheduled it may no longer publish when its time comes.
  await addMember(org.id, member.email, "viewer");
  await timeComes(org.id, id);
  await runCron(request);
  expect((await statusOf(org.id, id)).status).toBe("draft");
  await addMember(org.id, member.email, "owner");

  await page.goto(`${base}/posts/${id}`);
  await expect(page.getByTestId("schedule-failure")).toContainText("It was not published as scheduled");
  await expect(page.getByTestId("schedule-failure")).toContainText("The person who scheduled it can no longer publish it.");
  await expect(page.getByTestId("entry-status")).toHaveText("Draft");
  await page.goto(base);
  await expect(page.getByTestId("scheduled-item").and(page.locator('[data-state="failed"]'))).toContainText("Not published as scheduled: The person who scheduled it can no longer publish it.");
});

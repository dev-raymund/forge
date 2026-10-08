import { randomBytes } from "node:crypto";
import { expect, test, type Browser, type Locator, type Page } from "@playwright/test";
import { asUniqueVisitor, landing, newEmail, signUp } from "./helpers/auth";
import { firstLink, waitForEmail } from "./helpers/mailbox";
import { auditOf, markEmailVerified, organizationsOf, rolesIn, seedActivity, seedOrganization, type SeededOrganization } from "./helpers/orgs";
import { addMember, seedUser } from "./helpers/sites";

/**
 * M3-5 end to end against the production build: what is done in an
 * organization appears in its activity log, as sentences, for the members who
 * may read it, and for nobody outside it.
 *
 * Each event is written by the service that made the change, in the same
 * transaction (tests/integration/audit.test.ts proves that part). Here: that
 * the real screens produce the lines, and what the page shows and does not.
 */

const tail = () => randomBytes(3).toString("hex");
// After a client-side navigation Next keeps the page it left in the document, hidden: look at what is on screen only.
const shown = (scope: Page | Locator, testId: string) => scope.getByTestId(testId).filter({ visible: true });
const orgNav = (page: Page) => page.getByRole("navigation", { name: "Organization" });
const events = (page: Page) => shown(page, "event");
/** The sentences on the page, newest first, without their timestamps. */
const lines = async (page: Page) => (await events(page).locator("p:first-child").allInnerTexts()).map((text) => text.trim());
/** Waits for the page to show exactly these sentences: after a click the list arrives a moment later. */
const expectLines = (page: Page, expected: string[]) => expect.poll(() => lines(page)).toEqual(expected);
const filters = (page: Page) => page.getByRole("form", { name: "Filter activity" });
const sidewaysScroll = (page: Page) => page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);

async function openActivity(page: Page, organization: { slug: string }) {
  await page.goto(`/${organization.slug}/activity`);
  await expect(page.getByRole("heading", { level: 1, name: "Activity" })).toBeVisible();
}

/** A signed-in, verified user who is a member of the organization. Returns their email and the address their requests come from. */
async function memberOf(page: Page, organization: SeededOrganization, role: Parameters<typeof addMember>[2], name: string) {
  const ip = await asUniqueVisitor(page);
  const email = newEmail();
  await signUp(page, email, { name });
  await markEmailVerified(email);
  await addMember(organization.id, email, role);
  return { email, ip };
}

async function anotherPerson(browser: Browser) {
  const context = await browser.newContext();
  const page = await context.newPage();
  await asUniqueVisitor(page);
  return { context, page };
}

test.beforeEach(async ({ page }) => {
  await asUniqueVisitor(page);
});

test("a new organization's log starts with its creation; renaming it and changing its URL are added to it", async ({ page, baseURL }) => {
  const ip = await asUniqueVisitor(page);
  const email = newEmail();
  await signUp(page, email, { name: "Olive Owner" });
  await page.goto("/");
  await expect(landing(page)).toBeVisible();
  const id = tail();
  await page.getByLabel("Organization name").fill(`Logged ${id}`);
  await page.getByRole("button", { name: "Create organization" }).click();
  await expect(page).toHaveURL(`${baseURL}/logged-${id}/sites`);

  // The Owner has the link, and the log has one line: the organization's creation, by her.
  await orgNav(page).getByRole("link", { name: "Activity" }).click();
  await expect(page).toHaveURL(`${baseURL}/logged-${id}/activity`);
  await expect(orgNav(page).getByRole("link", { name: "Activity" })).toHaveAttribute("aria-current", "page");
  await expectLines(page, [`Olive Owner created the organization Logged ${id}.`]);
  await expect(events(page).locator("time")).toHaveCount(1);

  // Rename it, and move it.
  await page.goto(`/logged-${id}/settings`);
  await page.getByRole("form", { name: "Organization name" }).getByLabel("Name").fill(`Renamed ${id}`);
  await page.getByRole("button", { name: "Save name" }).click();
  await expect(page.locator('[data-form-alert][role="status"]').filter({ visible: true })).toHaveText("The organization's name has been updated.");
  await page.getByRole("form", { name: "Organization URL" }).getByLabel("URL", { exact: true }).fill(`moved-${id}`);
  await page.getByRole("button", { name: "Change URL" }).click();
  await expect(page).toHaveURL(`${baseURL}/moved-${id}/settings?changed=url`);

  // The log moved with the organization, and tells both, newest first.
  await orgNav(page).getByRole("link", { name: "Activity" }).click();
  await expect(page).toHaveURL(`${baseURL}/moved-${id}/activity`);
  await expectLines(page, [
    `Olive Owner changed the organization’s URL from /logged-${id} to /moved-${id}.`,
    `Olive Owner renamed the organization from “Logged ${id}” to “Renamed ${id}”.`,
    `Olive Owner created the organization Logged ${id}.`,
  ]);
  // Saving the same name again is not an event.
  await page.goto(`/moved-${id}/settings`);
  const name = page.getByRole("form", { name: "Organization name" }).getByLabel("Name");
  await name.fill(`Renamed ${id}`);
  await name.press("Enter");
  await expect(page.locator('[data-form-alert][role="status"]').filter({ visible: true })).toHaveText("The organization's name has been updated.");
  await openActivity(page, { slug: `moved-${id}` });
  await expect(events(page)).toHaveCount(3);

  // What is stored and what is shown are not the same thing: the request's address and id are kept, and are not on the page.
  const [organization] = await organizationsOf(email);
  const stored = await auditOf(organization!.id);
  expect(stored.map((row) => row.action)).toEqual(["organization.created", "organization.updated", "organization.updated"]);
  for (const row of stored) {
    expect(row.actor_label).toBe(email);
    expect(row.ip).toBe(ip);
    expect(row.request_id).not.toBe("");
  }
  const content = await page.content();
  for (const hidden of [ip, ...stored.map((row) => row.request_id), organization!.id]) expect(content.includes(hidden), `the page contains ${hidden}`).toBe(false);
  // Her own logins and sign-up are not this organization's business: none of them is a line here.
  expect((await lines(page)).filter((line) => /auth\.|logged in|signed up|password/i.test(line))).toEqual([]);
  expect(stored.filter((row) => row.action.startsWith("auth."))).toEqual([]);
});

test("the team's changes, each as a line: invited, accepted, role changed, removed; and the filters narrow them", async ({ page, browser, baseURL }) => {
  const organization = await seedOrganization("logteam");
  await memberOf(page, organization, "owner", "Olive Owner");
  const bob = await anotherPerson(browser);
  const bobEmail = newEmail();
  await signUp(bob.page, bobEmail, { name: "Bob Builder" });

  // Invite → accept.
  await page.goto(`/${organization.slug}/members`);
  await page.getByRole("button", { name: "Invite member" }).click();
  const dialog = page.getByRole("dialog", { name: "Invite a member" });
  await dialog.getByLabel("Email").fill(bobEmail);
  await dialog.getByRole("radio", { name: /^Author\b/ }).check();
  await dialog.getByRole("button", { name: "Send invitation" }).click();
  await expect(dialog.locator('[data-form-alert][role="status"]')).toHaveText(`Invitation sent to ${bobEmail}.`);
  await dialog.getByRole("button", { name: "Done" }).click();
  const link = firstLink(await waitForEmail(bobEmail, { subject: `Olive Owner invited you to ${organization.name} on Forge` }));
  await bob.page.goto(link);
  await bob.page.getByRole("button", { name: "Accept invitation" }).click();
  await expect(bob.page).toHaveURL(`${baseURL}/${organization.slug}/sites`);

  // Role change → remove.
  await page.reload();
  await page.getByRole("button", { name: "Actions for Bob Builder" }).click();
  await page.getByRole("menuitem", { name: "Change role…" }).click();
  const roleDialog = page.getByRole("dialog", { name: "Change the role of Bob Builder" });
  await roleDialog.getByRole("radio", { name: /^Editor\b/ }).check();
  await roleDialog.getByRole("button", { name: "Save role" }).click();
  await expect(roleDialog).toHaveCount(0);
  await page.getByRole("button", { name: "Actions for Bob Builder" }).click();
  await page.getByRole("menuitem", { name: "Remove from organization…" }).click();
  await page.getByRole("dialog").getByRole("button", { name: "Remove member" }).click();
  await expect(page.getByRole("row").filter({ hasText: bobEmail })).toHaveCount(0);

  // The log: all four, newest first, in words. The accepted line is Bob's own act.
  await orgNav(page).getByRole("link", { name: "Activity" }).click();
  await expectLines(page, [
    "Olive Owner removed Bob Builder from the organization.",
    "Olive Owner changed Bob Builder’s role from Author to Editor.",
    "Bob Builder accepted an invitation and joined as an Author.",
    `Olive Owner invited ${bobEmail} as an Author.`,
  ]);
  // Never the link he was sent, or anything of it.
  const token = new URL(link).pathname.split("/").pop()!;
  expect(await page.content()).not.toContain(token);
  expect(JSON.stringify(await auditOf(organization.id))).not.toContain(token);
  expect(JSON.stringify(await auditOf(organization.id))).not.toMatch(/token|hash|\/invite\//i);

  // Filter by event: the URL says what is shown, and the form shows what the URL says.
  await filters(page).getByLabel("Event").selectOption({ label: "Member invited" });
  await filters(page).getByRole("button", { name: "Apply filters" }).click();
  await expect(page).toHaveURL(/\/activity\?action=member\.invited/);
  await expectLines(page, [`Olive Owner invited ${bobEmail} as an Author.`]);
  await expect(filters(page).getByLabel("Event")).toHaveValue("member.invited");

  // By who did it: the Owner is offered (a member); her three lines, and not Bob's.
  await page.getByRole("link", { name: "Clear filters" }).click();
  await expect(page).toHaveURL(`${baseURL}/${organization.slug}/activity`);
  await filters(page).getByLabel("Done by").selectOption({ label: "Olive Owner" });
  await filters(page).getByRole("button", { name: "Apply filters" }).click();
  await expect(events(page)).toHaveCount(3);
  expect((await lines(page)).every((line) => line.startsWith("Olive Owner "))).toBe(true);

  // By day: today has all of it; a day long ago has nothing, and says so.
  const today = new Date().toISOString().slice(0, 10);
  await page.goto(`/${organization.slug}/activity?from=${today}&to=${today}`);
  await expect(events(page)).toHaveCount(4);
  await page.goto(`/${organization.slug}/activity?from=2020-01-01&to=2020-01-31`);
  await expect(shown(page, "no-activity")).toHaveText("No activity matches these filters.");
  // A filter value that is not one is ignored, not an error.
  await page.goto(`/${organization.slug}/activity?action=drop%20table&member=not-an-id&from=tomorrow&before=garbage`);
  await expect(events(page)).toHaveCount(4);
  await bob.context.close();
});

test("ownership transfer is recorded; and who may read the log is the catalog's answer, checked by the page", async ({ page, browser, baseURL }) => {
  const organization = await seedOrganization("logowner");
  const owner = await memberOf(page, organization, "owner", "Olive Owner");
  const nia = await anotherPerson(browser);
  const niaEmail = newEmail();
  await signUp(nia.page, niaEmail, { name: "Nia Next" });
  await addMember(organization.id, niaEmail, "editor");

  // An Editor has no link to the log, and the page itself says no.
  await nia.page.goto(`/${organization.slug}`);
  await expect(orgNav(nia.page).getByRole("link", { name: "Sites" })).toBeVisible();
  await expect(orgNav(nia.page).getByRole("link", { name: "Activity" })).toHaveCount(0);
  await nia.page.goto(`/${organization.slug}/activity`);
  await expect(shown(nia.page, "no-access")).toBeVisible();
  await expect(nia.page.getByText(`The activity log is for Owners and Admins of ${organization.name}.`)).toBeVisible();
  await expect(events(nia.page)).toHaveCount(0);
  await expect(filters(nia.page)).toHaveCount(0);
  for (const role of ["author", "viewer"] as const) {
    await addMember(organization.id, niaEmail, role);
    await nia.page.goto(`/${organization.slug}/activity?action=organization.created`);
    await expect(shown(nia.page, "no-access"), role).toBeVisible();
  }
  await addMember(organization.id, niaEmail, "editor");

  // The Owner hands the organization to her.
  await page.goto(`/${organization.slug}/settings`);
  await page.getByRole("button", { name: "Transfer ownership…" }).click();
  const dialog = page.getByRole("dialog", { name: `Transfer ownership of ${organization.name}` });
  await dialog.getByLabel("New Owner").selectOption({ label: `Nia Next (${niaEmail}), Editor` });
  await dialog.getByLabel(`Type ${organization.slug} to confirm`).fill(organization.slug);
  await dialog.getByRole("button", { name: "Transfer ownership", exact: true }).click();
  await expect(page).toHaveURL(`${baseURL}/${organization.slug}/settings?changed=owner`);
  expect(await rolesIn(organization.id)).toEqual({ [owner.email]: "admin", [niaEmail]: "owner" });

  // One line for it. The former Owner, now an Admin, may still read the log.
  await orgNav(page).getByRole("link", { name: "Activity" }).click();
  await expectLines(page, ["Olive Owner transferred ownership to Nia Next."]);
  // And the new Owner, on her next request, has the link and the same line.
  await nia.page.goto(`/${organization.slug}`);
  await orgNav(nia.page).getByRole("link", { name: "Activity" }).click();
  await expectLines(nia.page, ["Olive Owner transferred ownership to Nia Next."]);
  await nia.context.close();
});

test("another organization's activity is not there: not on the page, not through its URL, not through a filter", async ({ page, request }) => {
  const mine = await seedOrganization("logmine");
  const theirs = await seedOrganization("logtheirs");
  const me = await memberOf(page, mine, "owner", "Olive Owner");
  const theirOwner = await seedUser("Theo Theirs");
  await addMember(theirs.id, theirOwner.email, "owner");
  await seedActivity(mine.id, me.email, 2);
  await seedActivity(theirs.id, theirOwner.email, 3);

  await openActivity(page, mine);
  await expect(events(page)).toHaveCount(2);
  const content = await page.content();
  for (const foreign of ["Theo Theirs", theirOwner.email, theirs.name, theirs.id]) expect(content).not.toContain(foreign);
  // The filter of people offers this organization's members only.
  await expect(filters(page).getByLabel("Done by").locator("option")).toHaveText(["Anyone", "Olive Owner"]);

  // Their log's URL is the 404 that a made-up organization gets.
  const answers: string[] = [];
  for (const path of [`/${theirs.slug}/activity`, `/no-such-org-${theirs.slug}/activity`]) {
    await page.goto(path);
    await expect(shown(page, "not-found")).toBeVisible();
    expect(await page.content(), path).not.toContain("Theo Theirs");
    answers.push((await shown(page, "not-found").innerText()).trim());
  }
  expect(answers[0]).toBe(answers[1]);

  // Naming their organization, or one of their members, in my log's query string shows nothing of theirs.
  const theirMember = (await organizationsOf(theirOwner.email))[0]!.id;
  for (const query of [`org=${theirs.slug}`, `organizationId=${theirs.id}`, `member=${theirMember}`, `site=${theirs.id}`]) {
    await page.goto(`/${mine.slug}/activity?${query}`);
    await expect(page.getByRole("heading", { level: 1, name: "Activity" })).toBeVisible();
    expect(await page.content(), query).not.toContain("Theo Theirs");
    for (const line of await lines(page)) expect(line.startsWith("Olive Owner ")).toBe(true);
  }
  expect(await auditOf(theirs.id)).toHaveLength(3);

  // Signed out, the log's URL says nothing: the login page.
  const anonymous = await request.get(`/${theirs.slug}/activity`, { maxRedirects: 0 });
  expect(anonymous.status()).toBe(307);
  expect(anonymous.headers()["location"]).toBe(`/login?next=${encodeURIComponent(`/${theirs.slug}/activity`)}`);
});

test("a long log is read a page at a time: 25 events, then older ones, each event once", async ({ page, baseURL }) => {
  const organization = await seedOrganization("logpages");
  const me = await memberOf(page, organization, "admin", "Adam Admin"); // an Admin may read the log
  await seedActivity(organization.id, me.email, 60);

  await openActivity(page, organization);
  const seen: string[] = [];
  await expect(events(page)).toHaveCount(25);
  seen.push(...(await lines(page)));
  expect(seen[0]).toBe("Adam Admin changed Seeded 001’s role from Viewer to Author."); // the newest
  await expect(page.getByRole("link", { name: "Back to the newest" })).toHaveCount(0);

  await page.getByRole("link", { name: "Older activity" }).click();
  await expect(page).toHaveURL(/\/activity\?before=\d+_[0-9a-f-]{36}$/);
  await expect(events(page)).toHaveCount(25);
  seen.push(...(await lines(page)));

  await page.getByRole("link", { name: "Older activity" }).click();
  await expect(events(page)).toHaveCount(10);
  seen.push(...(await lines(page)));
  await expect(page.getByRole("link", { name: "Older activity" })).toHaveCount(0);

  // Sixty events, sixty lines, in order, none twice.
  expect(seen).toEqual(Array.from({ length: 60 }, (_, i) => `Adam Admin changed Seeded ${String(i + 1).padStart(3, "0")}’s role from Viewer to Author.`));
  // The page in the browser never held more than its share.
  expect(await page.locator('[data-testid="event"]').filter({ visible: true }).count()).toBeLessThanOrEqual(25);

  await page.getByRole("link", { name: "Back to the newest" }).click();
  await expect(page).toHaveURL(`${baseURL}/${organization.slug}/activity`);
  await expect(events(page).first()).toContainText("Seeded 001");

  // A filter and a page together: the filter stays on the way to older events.
  await page.goto(`/${organization.slug}/activity?action=member.role_changed`);
  await page.getByRole("link", { name: "Older activity" }).click();
  await expect(page).toHaveURL(/\/activity\?action=member\.role_changed&before=/);
  await expect(filters(page).getByLabel("Event")).toHaveValue("member.role_changed");
});

test.describe("on a phone", () => {
  test.use({ viewport: { width: 360, height: 740 } });

  test("the activity page, its filters and its pages fit the screen", async ({ page }) => {
    const organization = await seedOrganization("logsmall");
    const me = await memberOf(page, organization, "owner", "An Owner With A Rather Long Name Indeed");
    await seedActivity(organization.id, me.email, 30);
    await openActivity(page, organization);
    await expect(events(page)).toHaveCount(25);
    expect(await sidewaysScroll(page), "activity").toBeLessThanOrEqual(0);
    await filters(page).getByLabel("Event").selectOption({ label: "Role changed" });
    await filters(page).getByLabel("From").fill("2020-01-01");
    await filters(page).getByRole("button", { name: "Apply filters" }).click();
    await expect(page).toHaveURL(/action=member\.role_changed/);
    expect(await sidewaysScroll(page), "filtered").toBeLessThanOrEqual(0);
    const older = page.getByRole("link", { name: "Older activity" });
    await older.scrollIntoViewIfNeeded();
    const box = (await older.boundingBox())!;
    expect(box.height).toBeGreaterThanOrEqual(16);
    await older.click();
    await expect(events(page)).toHaveCount(5);
    expect(await sidewaysScroll(page), "second page").toBeLessThanOrEqual(0);
  });
});

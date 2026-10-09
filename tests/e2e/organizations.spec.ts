import { randomBytes } from "node:crypto";
import { expect, test, type Page } from "@playwright/test";
import { accountMenu, asUniqueVisitor, landing, logOut, newEmail, signUp, submitLogin } from "./helpers/auth";
import { firstLink, waitForEmail } from "./helpers/mailbox";
import { organizationRow, organizationsOf, removeMember, rolesIn, seedOrganization, setOrganizationStatus, subscriptionOf } from "./helpers/orgs";
import { addMember, seedUser } from "./helpers/sites";

/**
 * M3-3 end to end against the production build: onboarding, the `/` redirect,
 * the organization switcher, organization settings and ownership transfer.
 *
 * The organization is always the one in the URL (D-08). What a member may do
 * there comes from their membership, on the server, on every request (ADR
 * 0009): several tests change a membership behind the page's back to show it.
 */

const tail = () => randomBytes(3).toString("hex");

// After a client-side navigation Next keeps the page it left in the document, hidden, so that going
// back is instant. Locators that are not by role would also find that hidden copy: these look at
// what is on screen only.
const shown = (page: Page, testId: string) => page.getByTestId(testId).filter({ visible: true });
const switcher = (page: Page) => page.getByRole("button", { name: /^Switch organization/ });
const orgNav = (page: Page) => page.getByRole("navigation", { name: "Organization" });
const orgName = (page: Page) => shown(page, "organization-name");
const memberRole = (page: Page) => shown(page, "member-role");
const formAlert = (page: Page) => page.locator('[data-form-alert][role="alert"]').filter({ visible: true });
const formStatus = (page: Page) => page.locator('[data-form-alert][role="status"]').filter({ visible: true });
const nameForm = (page: Page) => page.getByRole("form", { name: "Organization name" });
const urlForm = (page: Page) => page.getByRole("form", { name: "Organization URL" });
/** Anything in the page's content that could be used to change something. */
const controls = (page: Page) => page.locator("main").locator("form, input, select, button").filter({ visible: true });
const sidewaysScroll = (page: Page) => page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);

test.beforeEach(async ({ page }) => {
  await asUniqueVisitor(page);
});

test("a new user: sign up → verify → log in → onboarding → create organization → its home, as Owner", async ({ page, baseURL }) => {
  const email = newEmail();
  await signUp(page, email);
  await page.goto(firstLink(await waitForEmail(email, { subject: "Verify your email for Forge" })));
  await expect(page).toHaveURL(`${baseURL}/verify-email?status=verified`);
  await logOut(page);

  // Signed in, with no organization: `/` is onboarding, and there is nothing to switch to.
  await submitLogin(page, email);
  await expect(page).toHaveURL(`${baseURL}/onboarding`);
  await expect(landing(page)).toBeVisible();
  await expect(switcher(page)).toHaveCount(0);
  expect(await organizationsOf(email)).toEqual([]);

  const name = page.getByLabel("Organization name");
  const url = page.getByLabel("URL", { exact: true });
  const create = page.getByRole("button", { name: "Create organization" });
  const id = tail();

  // The URL is suggested from the name…
  await name.fill(`Acme Studio & Sons ${id}`);
  await expect(url).toHaveValue(`acme-studio-and-sons-${id}`);

  // …and held to the slug rules before anything is sent: a word the app uses itself is refused, in words, at the field.
  await url.fill("login");
  await create.click();
  await expect(page.getByText("That URL is reserved. Choose another.")).toBeVisible();
  await expect(url).toBeFocused();
  await expect(url).toHaveAttribute("aria-invalid", "true");
  await url.fill("Not A Slug!");
  await create.click();
  await expect(page.getByText("Use lowercase letters, numbers and single hyphens, e.g. acme-studio.")).toBeVisible();

  // Whether a URL is free is the server's answer.
  const taken = await seedOrganization("taken");
  await url.fill(taken.slug.toUpperCase());
  await create.click();
  await expect(page.getByText("That URL is already taken.")).toBeVisible();
  await expect(name).toHaveValue(`Acme Studio & Sons ${id}`); // nothing typed is lost
  expect(await organizationsOf(email)).toEqual([]);

  // Once the user has typed a URL, the name no longer overwrites it. Enter submits.
  const slug = `acme-${id}`;
  await url.fill(slug);
  await name.fill("Acme Studio");
  await expect(url).toHaveValue(slug);
  await url.press("Enter");

  // On to onboarding's step 2, the first site (M4-2); the organization's home is at its own URL, with the creator as its Owner.
  await expect(page).toHaveURL(`${baseURL}/onboarding/${slug}`);
  await expect(shown(page, "onboarding-step")).toHaveText("Step 2 of 3");
  await page.goto(`/${slug}/sites`);
  await expect(page).toHaveURL(`${baseURL}/${slug}/sites`);
  await expect(orgName(page)).toHaveText("Acme Studio");
  await expect(memberRole(page)).toHaveText("Owner");
  await expect(switcher(page)).toContainText("Acme Studio");
  await expect(accountMenu(page)).toBeVisible();

  // In the database: the organization, its one Owner, and the 14-day trial.
  const organizations = await organizationsOf(email);
  expect(organizations).toEqual([{ id: expect.any(String), slug, name: "Acme Studio", status: "active", role: "owner" }]);
  expect(await rolesIn(organizations[0]!.id)).toEqual({ [email]: "owner" });
  const subscription = (await subscriptionOf(organizations[0]!.id))!;
  expect(subscription).toMatchObject({ plan_key: "pro", status: "trialing" });
  expect(Number(subscription.trial_days)).toBeGreaterThan(13.9);
  expect(Number(subscription.trial_days)).toBeLessThanOrEqual(14);

  // From now on `/` is that organization, onboarding is behind them, and logging in lands there.
  await page.goto("/");
  await expect(page).toHaveURL(`${baseURL}/${slug}/sites`);
  // Onboarding resumes where it was left (M4-2): the organization has no site yet.
  await page.goto("/onboarding");
  await expect(page).toHaveURL(`${baseURL}/onboarding/${slug}`);
  await logOut(page);
  await submitLogin(page, email);
  await expect(page).toHaveURL(`${baseURL}/${slug}/sites`);
  await expect(orgName(page)).toHaveText("Acme Studio");
});

test("an existing member lands in their organization, switches between their own, and never sees anyone else's", async ({ page, context, baseURL }) => {
  const [alpha, beta, gamma] = [await seedOrganization("alpha"), await seedOrganization("beta"), await seedOrganization("gamma")];
  const email = newEmail();
  await signUp(page, email);
  await addMember(alpha.id, email, "owner");
  await addMember(beta.id, email, "viewer"); // joined last
  await addMember(gamma.id, (await seedUser()).email, "owner"); // somebody else's

  // `/`: the organization joined last. Worked out from the memberships, not remembered. A real redirect,
  // and one that is this user's own answer: not for any cache to keep.
  const root = await page.request.get("/", { maxRedirects: 0 });
  expect(root.status()).toBe(307);
  expect(root.headers()["location"]).toBe(`/${beta.slug}/sites`);
  expect(root.headers()["cache-control"]).toBe("private, no-store");
  await page.goto("/");
  await expect(page).toHaveURL(`${baseURL}/${beta.slug}/sites`);
  await expect(orgName(page)).toHaveText(beta.name);
  await expect(memberRole(page)).toHaveText("Viewer");
  await expect(switcher(page)).toContainText(beta.name);

  // The switcher: exactly the user's organizations, the open one marked.
  await switcher(page).click();
  await expect(page.getByRole("menuitem")).toHaveText([alpha.name, beta.name]);
  await expect(page.getByRole("menuitem", { name: beta.name })).toHaveAttribute("aria-current", "true");
  await expect(page.getByRole("menuitem", { name: alpha.name })).not.toHaveAttribute("aria-current", "true");
  expect(await page.content()).not.toContain(gamma.name);
  expect(await page.content()).not.toContain(gamma.slug);

  // Choosing one goes to its URL, and the page is that organization's, with the role held there.
  await page.getByRole("menuitem", { name: alpha.name }).click();
  await expect(page).toHaveURL(`${baseURL}/${alpha.slug}/sites`);
  await expect(orgName(page)).toHaveText(alpha.name);
  await expect(memberRole(page)).toHaveText("Owner");
  await expect(switcher(page)).toContainText(alpha.name);

  // With the keyboard: open, arrow to the other one, Enter.
  await switcher(page).focus();
  await page.keyboard.press("Enter");
  await expect(page.getByRole("menuitem", { name: alpha.name })).toBeFocused();
  await page.keyboard.press("ArrowDown");
  await expect(page.getByRole("menuitem", { name: beta.name })).toBeFocused();
  await page.keyboard.press("Enter");
  await expect(page).toHaveURL(`${baseURL}/${beta.slug}/sites`);

  // Two tabs on two organizations: each is where its URL says, whatever the other one does (D-08).
  const second = await context.newPage();
  await second.goto(`/${alpha.slug}`);
  await expect(orgName(second)).toHaveText(alpha.name);
  await page.reload();
  await expect(orgName(page)).toHaveText(beta.name);
  await second.reload();
  await expect(orgName(second)).toHaveText(alpha.name);
  await second.close();

  // Nothing stored which organization was open: no cookie names one, and `/` is still the rule's answer.
  for (const cookie of await context.cookies()) {
    expect(cookie.name).not.toMatch(/org|tenant|active|current/i);
    for (const organization of [alpha, beta]) expect(decodeURIComponent(cookie.value)).not.toContain(organization.slug);
  }
  await page.goto(`/${alpha.slug}`);
  await page.goto("/");
  await expect(page).toHaveURL(`${baseURL}/${beta.slug}/sites`);

  // On the account page the switcher is the way back, and the wordmark leads home.
  await page.goto("/account");
  await expect(switcher(page)).toContainText("Organizations");
  await switcher(page).click();
  await page.getByRole("menuitem", { name: alpha.name }).click();
  await expect(page).toHaveURL(`${baseURL}/${alpha.slug}/sites`);
  await page.goto("/account");
  await page.getByRole("link", { name: "Forge", exact: true }).click();
  await expect(page).toHaveURL(`${baseURL}/${beta.slug}/sites`);
});

test("organization settings: an Owner changes things, an Admin can look, everyone else is told it is not theirs", async ({ page, baseURL }) => {
  const organization = await seedOrganization("roles");
  const email = newEmail();
  await signUp(page, email);
  const settings = `/${organization.slug}/settings`;

  // Owner: the page is in the organization's links, and has the forms.
  await addMember(organization.id, email, "owner");
  await page.goto(`/${organization.slug}`);
  await orgNav(page).getByRole("link", { name: "Settings" }).click();
  await expect(page).toHaveURL(`${baseURL}${settings}`);
  await expect(page.getByRole("heading", { level: 1, name: "Organization settings" })).toBeVisible();
  await expect(orgNav(page).getByRole("link", { name: "Settings" })).toHaveAttribute("aria-current", "page");
  await expect(nameForm(page).getByLabel("Name")).toHaveValue(organization.name);
  await expect(urlForm(page).getByLabel("URL", { exact: true })).toHaveValue(organization.slug);
  // Alone in the organization: there is nobody to hand it to, and so no button to do it with.
  await expect(shown(page, "no-transfer-candidates")).toBeVisible();
  await expect(page.getByRole("button", { name: /Transfer ownership/ })).toHaveCount(0);

  // Admin: may open the page; sees the same facts and nothing to change them with.
  await addMember(organization.id, email, "admin");
  await page.goto(`/${organization.slug}`);
  await expect(memberRole(page)).toHaveText("Admin");
  await orgNav(page).getByRole("link", { name: "Settings" }).click();
  await expect(shown(page, "organization-details")).toContainText(organization.name);
  await expect(shown(page, "organization-details")).toContainText(`/${organization.slug}`);
  await expect(page.getByText("Only an Owner can change the name or the URL of this organization.")).toBeVisible();
  await expect(page.getByText("Only an Owner can transfer this organization to another member.")).toBeVisible();
  await expect(controls(page)).toHaveCount(0);

  // Editor, Author, Viewer: no link to it, and the page itself says no, with nothing of the settings on it.
  for (const [role, label] of [["editor", "Editor"], ["author", "Author"], ["viewer", "Viewer"]] as const) {
    await addMember(organization.id, email, role);
    await page.goto(`/${organization.slug}`);
    await expect(memberRole(page), role).toHaveText(label);
    await expect(orgNav(page).getByRole("link", { name: "Sites" })).toBeVisible();
    await expect(orgNav(page).getByRole("link", { name: "Settings" }), role).toHaveCount(0);
    await expect(page.getByRole("link", { name: "Organization settings" }), role).toHaveCount(0);

    await page.goto(settings);
    await expect(shown(page, "no-access"), role).toBeVisible();
    await expect(page.getByRole("heading", { level: 1 })).toHaveText("You don’t have access to this page");
    await expect(shown(page, "organization-details")).toHaveCount(0);
    await expect(controls(page), role).toHaveCount(0);
  }
});

test("an Owner renames the organization and changes its URL; the old URL stops working", async ({ page, baseURL }) => {
  const organization = await seedOrganization("rename");
  const taken = await seedOrganization("occupied");
  const email = newEmail();
  await signUp(page, email);
  await addMember(organization.id, email, "owner");
  await page.goto(`/${organization.slug}/settings`);

  // The name: validated, saved, and shown at once wherever the organization is named.
  const name = nameForm(page).getByLabel("Name");
  await name.fill("   ");
  await nameForm(page).getByRole("button", { name: "Save name" }).click();
  await expect(nameForm(page).getByText("Enter a name for the organization.")).toBeVisible();
  expect((await organizationRow(organization.id))!.name).toBe(organization.name);

  const renamed = `Renamed ${tail()}`;
  await name.fill(`  ${renamed} `);
  await name.press("Enter");
  await expect(nameForm(page).locator('[data-form-alert][role="status"]')).toHaveText("The organization's name has been updated.");
  await expect(name).toHaveValue(renamed);
  await expect(switcher(page)).toContainText(renamed);
  expect((await organizationRow(organization.id))!.name).toBe(renamed);
  await page.goto(`/${organization.slug}`);
  await expect(orgName(page)).toHaveText(renamed);

  // The URL: the same rules as when it was created.
  await page.goto(`/${organization.slug}/settings`);
  const url = urlForm(page).getByLabel("URL", { exact: true });
  const change = urlForm(page).getByRole("button", { name: "Change URL" });
  await url.fill("settings");
  await change.click();
  await expect(urlForm(page).getByText("That URL is reserved. Choose another.")).toBeVisible();
  await url.fill(taken.slug);
  await change.click();
  await expect(urlForm(page).getByText("That URL is already taken.")).toBeVisible();
  expect((await organizationRow(organization.id))!.slug).toBe(organization.slug);
  expect((await organizationRow(taken.id))!.slug).toBe(taken.slug);

  // One spelling: trimmed and lowercased. On success the browser is at the new URL, told so by the server.
  const moved = `moved-${tail()}`;
  await url.fill(`  ${moved.toUpperCase()} `);
  await change.click();
  await expect(page).toHaveURL(`${baseURL}/${moved}/settings?changed=url`);
  await expect(formStatus(page)).toHaveText(`The organization’s URL is now /${moved}.`);
  await expect(urlForm(page).getByLabel("URL", { exact: true })).toHaveValue(moved);
  expect(await organizationRow(organization.id)).toMatchObject({ slug: moved, name: renamed });

  // The old URL is nobody's now: a 404, not a way in. `/` and the switcher know the new one.
  await page.goto(`/${organization.slug}/settings`);
  await expect(shown(page, "not-found")).toBeVisible();
  await page.goto("/");
  await expect(page).toHaveURL(`${baseURL}/${moved}/sites`);
  await switcher(page).click();
  await page.getByRole("menuitem", { name: renamed }).click();
  await expect(page).toHaveURL(`${baseURL}/${moved}/sites`);
});

test("the screen is not the gate: a member demoted or removed while the page is open is refused by the server", async ({ page }) => {
  const organization = await seedOrganization("stale");
  const email = newEmail();
  await signUp(page, email);
  await addMember(organization.id, email, "owner");
  await addMember(organization.id, (await seedUser()).email, "owner"); // so the first can be demoted
  await page.goto(`/${organization.slug}/settings`);
  await expect(nameForm(page)).toBeVisible();

  // Demoted to Admin behind the page's back: the forms are still on screen, and no longer work.
  await addMember(organization.id, email, "admin");
  await nameForm(page).getByLabel("Name").fill("Taken Over");
  await nameForm(page).getByRole("button", { name: "Save name" }).click();
  await expect(formAlert(page)).toHaveText("You don't have permission to do that.");
  await urlForm(page).getByLabel("URL", { exact: true }).fill(`taken-over-${tail()}`);
  await urlForm(page).getByRole("button", { name: "Change URL" }).click();
  await expect(urlForm(page).locator('[data-form-alert][role="alert"]')).toHaveText("You don't have permission to do that.");
  expect(await organizationRow(organization.id)).toMatchObject({ name: organization.name, slug: organization.slug });

  // Removed altogether: the organization no longer exists for them, in the form's answer and on the next page load.
  await removeMember(organization.id, email);
  await nameForm(page).getByLabel("Name").fill("Still Here?");
  await nameForm(page).getByRole("button", { name: "Save name" }).click();
  await expect(nameForm(page).locator('[data-form-alert][role="alert"]')).toHaveText("Not found.");
  expect(await organizationRow(organization.id)).toMatchObject({ name: organization.name, slug: organization.slug });
  await page.reload();
  await expect(shown(page, "not-found")).toBeVisible();
});

test("ownership transfer: A hands the organization to B on purpose, and is an Owner no more", async ({ page, browser, baseURL }) => {
  const organization = await seedOrganization("handover");
  const settings = `/${organization.slug}/settings`;
  const [alice, bob] = [newEmail(), newEmail()];
  await signUp(page, alice, { name: "Alice Owner" });
  await addMember(organization.id, alice, "owner");

  const bobContext = await browser.newContext();
  const bobPage = await bobContext.newPage();
  await asUniqueVisitor(bobPage);
  await signUp(bobPage, bob, { name: "Bob Member" });
  await addMember(organization.id, bob, "editor");
  await bobPage.goto(settings);
  await expect(shown(bobPage, "no-access")).toBeVisible(); // an Editor: not his to open, let alone to take

  // A opens the dialog. It says what will happen, and nothing has happened yet.
  await page.goto(settings);
  await page.getByRole("button", { name: "Transfer ownership…" }).click();
  const dialog = page.getByRole("dialog", { name: `Transfer ownership of ${organization.name}` });
  const submit = dialog.getByRole("button", { name: "Transfer ownership", exact: true });
  const confirm = dialog.getByLabel(`Type ${organization.slug} to confirm`);
  await expect(dialog).toContainText("You will no longer be an Owner of this organization");
  await expect(dialog).toContainText("you become an Admin");

  // Not one click: with nobody chosen and nothing typed, the button does nothing but say what is missing.
  await submit.click();
  await expect(dialog.getByText("Choose who will become the Owner.")).toBeVisible();
  await expect(dialog.getByText(`Type ${organization.slug} to confirm.`)).toBeVisible();
  expect(await rolesIn(organization.id)).toEqual({ [alice]: "owner", [bob]: "editor" });

  // Only the other members are offered, and the wrong word is not a confirmation.
  await expect(dialog.getByLabel("New Owner").locator("option:not([disabled])")).toHaveText([`Bob Member (${bob}), Editor`]);
  await dialog.getByLabel("New Owner").selectOption({ label: `Bob Member (${bob}), Editor` });
  await confirm.fill("yes");
  await submit.click();
  await expect(dialog.getByText(`Type ${organization.slug} to confirm.`)).toBeVisible();
  expect(await rolesIn(organization.id)).toEqual({ [alice]: "owner", [bob]: "editor" });

  // Cancelling (or Escape) leaves everything as it was, and nothing typed behind.
  await dialog.getByRole("button", { name: "Cancel" }).click();
  await expect(dialog).toHaveCount(0);
  await page.getByRole("button", { name: "Transfer ownership…" }).click();
  await expect(confirm).toHaveValue("");
  await page.keyboard.press("Escape");
  await expect(dialog).toHaveCount(0);
  expect(await rolesIn(organization.id)).toEqual({ [alice]: "owner", [bob]: "editor" });

  // Chosen, typed, submitted.
  await page.getByRole("button", { name: "Transfer ownership…" }).click();
  await dialog.getByLabel("New Owner").selectOption({ label: `Bob Member (${bob}), Editor` });
  await confirm.fill(organization.slug);
  await submit.click();
  await expect(page).toHaveURL(`${baseURL}${settings}?changed=owner`);
  await expect(formStatus(page)).toHaveText(`Ownership has been transferred. You are now an Admin of ${organization.name}.`);
  expect(await rolesIn(organization.id)).toEqual({ [alice]: "admin", [bob]: "owner" });

  // A is an Admin: the settings are read-only for her, on this page and on any later one.
  await expect(shown(page, "organization-details")).toContainText(organization.name);
  await expect(controls(page)).toHaveCount(0);
  await page.goto(`/${organization.slug}`);
  await expect(memberRole(page)).toHaveText("Admin");
  await page.goto(settings);
  await expect(nameForm(page)).toHaveCount(0);
  await expect(page.getByRole("button", { name: /Transfer ownership/ })).toHaveCount(0);

  // B is the Owner from his next request: he can open the settings and change them.
  await bobPage.goto(`/${organization.slug}`);
  await expect(memberRole(bobPage)).toHaveText("Owner");
  await bobPage.goto(settings);
  await nameForm(bobPage).getByLabel("Name").fill("Bob's Now");
  await nameForm(bobPage).getByRole("button", { name: "Save name" }).click();
  await expect(formStatus(bobPage)).toHaveText("The organization's name has been updated.");
  expect((await organizationRow(organization.id))!.name).toBe("Bob's Now");
  // And he could hand it back: A is offered to him, as an Admin.
  await bobPage.getByRole("button", { name: "Transfer ownership…" }).click();
  await expect(bobPage.getByRole("dialog").getByLabel("New Owner").locator("option:not([disabled])")).toHaveText([`Alice Owner (${alice}), Admin`]);
  await bobContext.close();
});

test("another organization's URLs are a 404, exactly like an organization that does not exist", async ({ page, request, baseURL }) => {
  const mine = await seedOrganization("mine");
  const theirs = await seedOrganization("theirs");
  const email = newEmail();
  await signUp(page, email);
  await addMember(mine.id, email, "owner");
  await addMember(theirs.id, (await seedUser()).email, "owner");

  const missing = `no-such-org-${tail()}`;
  // `/{orgSlug}` itself is a redirect to its sites (M4-1) that looks nothing up: the same answer for both.
  for (const slug of [theirs.slug, missing]) {
    const redirect = await page.request.get(`/${slug}`, { maxRedirects: 0 });
    expect(redirect.status(), slug).toBe(307);
    expect(redirect.headers()["location"], slug).toBe(`/${slug}/sites`);
  }
  const seen: { status: number; text: string; title: string }[] = [];
  for (const path of [`/${theirs.slug}/sites`, `/${theirs.slug}/settings`, `/${missing}/sites`, `/${missing}/settings`]) {
    const response = (await page.goto(path))!;
    await expect(shown(page, "not-found"), path).toBeVisible();
    await expect(page, path).toHaveURL(`${baseURL}${path}`); // not sent to their own organization, or anywhere else
    const content = await page.content();
    for (const secret of [theirs.name, theirs.id]) expect(content, path).not.toContain(secret);
    await expect(switcher(page)).toHaveCount(0); // nothing of an organization's shell either
    seen.push({ status: response.status(), text: (await shown(page, "not-found").innerText()).trim(), title: await page.title() });
  }
  // Page for page, the organization that exists and the one that does not give the same answer: status, title, words.
  expect(seen[0]).toEqual(seen[2]);
  expect(seen[1]).toEqual(seen[3]);
  expect(new Set(seen.map((s) => `${s.status} ${s.text}`)).size).toBe(1);
  expect(seen[0]!.text).toContain("Page not found");
  // The status is 200 for a signed-in visitor: the admin shell has begun to stream before the membership
  // is known (Cache Components), so the 404 is in the page, with `noindex`. Signed out, it is a redirect (below).
  expect(seen[0]!.status).toBe(200);
  expect(await page.locator('meta[name="robots"][content*="noindex"]').count()).toBeGreaterThan(0);

  // The way out of the 404 page is `/`: the visitor's own organization.
  await page.getByRole("link", { name: "Go to your organization" }).click();
  await expect(page).toHaveURL(`${baseURL}/${mine.slug}/sites`);
  expect(await organizationRow(theirs.id)).toMatchObject({ name: theirs.name, slug: theirs.slug });

  // Signed out, an organization's URL says nothing at all: the login page, for a real slug and a made-up one alike.
  for (const path of [`/${theirs.slug}/settings`, `/${missing}/settings`]) {
    const anonymous = await request.get(path, { maxRedirects: 0 });
    expect(anonymous.status(), path).toBe(307);
    expect(anonymous.headers()["location"]).toBe(`/login?next=${encodeURIComponent(path)}`);
  }
});

test("a suspended organization: its members are told so, and nothing of it can be opened or changed", async ({ page, baseURL }) => {
  const frozen = await seedOrganization("frozen");
  const open = await seedOrganization("open");
  const email = newEmail();
  await signUp(page, email);
  await addMember(open.id, email, "viewer");
  await addMember(frozen.id, email, "owner"); // joined last, and the Owner of it

  // Loaded while it was still active, so there is a form on screen to try afterwards.
  await page.goto(`/${frozen.slug}/settings`);
  await expect(nameForm(page)).toBeVisible();
  await setOrganizationStatus(frozen.id, "suspended");

  // The form's action is refused, in the organization's own words.
  await nameForm(page).getByLabel("Name").fill("Thawed");
  await nameForm(page).getByRole("button", { name: "Save name" }).click();
  await expect(formAlert(page)).toHaveText("This organization has been suspended.");
  expect((await organizationRow(frozen.id))!.name).toBe(frozen.name);

  // Its pages: one notice, for its Owner too. No settings, no organization links.
  for (const path of [`/${frozen.slug}`, `/${frozen.slug}/settings`]) {
    await page.goto(path);
    await expect(shown(page, "organization-suspended"), path).toBeVisible();
    await expect(page.getByRole("heading", { level: 1 })).toHaveText("This organization is suspended");
    await expect(orgNav(page)).toHaveCount(0);
    await expect(controls(page), path).toHaveCount(0);
  }

  // The header still works: the switcher marks it, and leads to the member's other organizations.
  await switcher(page).click();
  await expect(page.getByRole("menuitem", { name: frozen.name })).toContainText("Suspended");
  await page.getByRole("menuitem", { name: open.name }).click();
  await expect(page).toHaveURL(`${baseURL}/${open.slug}/sites`);
  await expect(orgName(page)).toHaveText(open.name);
  // And `/` prefers an organization that can be used, though the suspended one was joined later.
  await page.goto("/");
  await expect(page).toHaveURL(`${baseURL}/${open.slug}/sites`);

  // Somebody who is not a member learns nothing, not even that it is suspended.
  await addMember(open.id, email, "owner");
  await removeMember(frozen.id, email);
  await page.goto(`/${frozen.slug}`);
  await expect(shown(page, "not-found")).toBeVisible();
  await expect(shown(page, "organization-suspended")).toHaveCount(0);
});

test.describe("on a phone", () => {
  test.use({ viewport: { width: 360, height: 740 } });

  test("onboarding, the organization's pages and its settings fit the screen and work", async ({ page, baseURL }) => {
    const email = newEmail();
    await signUp(page, email);
    await page.goto("/");
    await expect(landing(page)).toBeVisible();
    expect(await sidewaysScroll(page), "onboarding").toBeLessThanOrEqual(0);

    const id = tail();
    await page.getByLabel("Organization name").fill(`A Rather Long Organization Name For A Small Screen ${id}`);
    await page.getByRole("button", { name: "Create organization" }).click();
    await expect(page).toHaveURL(new RegExp(`^${baseURL}/onboarding/a-rather-long-organization-name-for-a-small-screen-${id}$`));
    expect(await sidewaysScroll(page), "onboarding, step 2").toBeLessThanOrEqual(0);
    await page.goto(`/a-rather-long-organization-name-for-a-small-screen-${id}/sites`);
    await expect(orgName(page)).toBeVisible();
    expect(await sidewaysScroll(page), "organization home").toBeLessThanOrEqual(0);

    // The header's controls are there and large enough to tap (WCAG 2.2 target size).
    for (const control of [switcher(page), accountMenu(page)]) {
      const box = (await control.boundingBox())!;
      expect(Math.min(box.width, box.height)).toBeGreaterThanOrEqual(24);
    }

    await orgNav(page).getByRole("link", { name: "Settings" }).click();
    await expect(nameForm(page)).toBeVisible();
    expect(await sidewaysScroll(page), "settings").toBeLessThanOrEqual(0);
    await switcher(page).click();
    await expect(page.getByRole("menuitem")).toHaveCount(1);
    expect(await sidewaysScroll(page), "switcher open").toBeLessThanOrEqual(0);
  });
});

import { expect, test } from "@playwright/test";
import { asUniqueVisitor, currentSession, newEmail, sessionCookie, signUp } from "./helpers/auth";
import { addMember, seedSite } from "./helpers/sites";

/**
 * M3-1 on the shared V1 origin (ADR 0006): which tenant a public page shows is
 * decided by the address in the URL and by nothing about the visitor. Being
 * signed in to the admin, or being the Owner of some organization, neither
 * changes what `/s/{address}` renders nor opens another organization's site.
 *
 * M3-2 (ADR 0009): a role and its permissions are worked out on the server for
 * each admin request. They are not in the session, not in a cookie, and not on
 * a public page. The organization screens that will act on them are M3-3 and
 * M3-4; what each role may do there is tested against the services
 * (tests/integration/permissions.test.ts).
 */

const ROLES = ["owner", "admin", "editor", "author", "viewer"] as const;

test.beforeEach(async ({ page }) => {
  await asUniqueVisitor(page);
});

test("the address decides the site: a signed-in Owner of one organization sees every site exactly as a stranger does", async ({ page, playwright, baseURL }) => {
  const [alpha, beta] = await Promise.all([seedSite("alpha", "Alpha tagline"), seedSite("beta", "Beta tagline")]);
  const stranger = await playwright.request.newContext({ baseURL });
  const asStranger = async (address: string) => {
    const html = await (await stranger.get(`/s/${address}`)).text();
    return { tagline: html.match(/data-testid="tagline"[^>]*>([^<]*)</)?.[1], name: html.match(/data-testid="site-name"[^>]*>\s*<a[^>]*>([^<]*)</)?.[1] };
  };

  // Sign in, and become the Owner of Beta's organization.
  const email = newEmail();
  await signUp(page, email);
  await addMember(beta.orgId, email, "owner");
  expect(await sessionCookie(page)).toBeDefined();

  for (const site of [alpha, beta]) {
    const response = (await page.goto(`/s/${site.address}`))!;
    expect(response.status()).toBe(200);
    expect(await response.headerValue("set-cookie")).toBeNull();
    const shown = { tagline: await page.getByTestId("tagline").textContent(), name: await page.getByTestId("site-name").textContent() };
    expect(shown).toEqual(await asStranger(site.address)); // identical to an anonymous visit
    expect(shown.tagline).toBe(site.address === alpha.address ? "Alpha tagline" : "Beta tagline");
    await expect(page.getByRole("button", { name: "Account menu" })).toHaveCount(0); // nothing of the admin on a public page
  }

  // Membership opens no other door: an unknown address is 404 for an Owner as for anyone,
  expect((await page.goto(`/s/${alpha.address}-missing`))!.status()).toBe(404);
  // and one organization's address never shows the other's content.
  await page.goto(`/s/${alpha.address}`);
  await expect(page.getByTestId("tagline")).not.toHaveText("Beta tagline");
  expect((await currentSession(page)).status).toBe(200); // still signed in to the admin throughout
  await stranger.dispose();
});

test("a public page is not a way into the admin: organization and site URLs still need the app's own checks", async ({ page, request }) => {
  const site = await seedSite("gate", "Public");
  // The public address is not an admin URL, and an organization's admin URL is not public.
  for (const path of [`/${site.address}`, `/${site.address}/sites`, `/org-${site.address}/sites/${site.address}`]) {
    const anonymous = await request.get(path, { maxRedirects: 0 });
    expect(anonymous.status(), path).toBe(307);
    expect(anonymous.headers()["location"], path).toContain("/login?next=");
  }
  // Server Actions never run on site pages, signed in or not.
  await signUp(page, newEmail());
  expect((await page.request.post(`/s/${site.address}`, { headers: { "next-action": "x" } })).status()).toBe(404);
  expect((await page.request.get(`/render/address~${site.address}`)).status()).toBe(404);
});

test("a role lives on the server: for a member of any role the public site is a stranger's view, and nothing about roles or permissions reaches the browser", async ({ page, playwright, baseURL }) => {
  const site = await seedSite("roles", "Same for everyone");
  const stranger = await playwright.request.newContext({ baseURL });
  const view = (html: string) => ({
    tagline: html.match(/data-testid="tagline"[^>]*>([^<]*)</)?.[1],
    name: html.match(/data-testid="site-name"[^>]*>\s*<a[^>]*>([^<]*)</)?.[1],
  });
  const asStranger = view(await (await stranger.get(`/s/${site.address}`)).text());
  expect(asStranger).toEqual({ tagline: "Same for everyone", name: site.name });

  const email = newEmail();
  await signUp(page, email);

  for (const role of ROLES) {
    await addMember(site.orgId, email, role);

    // The public page: identical, sets nothing, shows nothing of the admin.
    const response = (await page.goto(`/s/${site.address}`))!;
    expect(response.status(), role).toBe(200);
    expect(await response.headerValue("set-cookie"), role).toBeNull();
    expect({ tagline: await page.getByTestId("tagline").textContent(), name: await page.getByTestId("site-name").textContent() }, role).toEqual(asStranger);
    await expect(page.getByRole("button", { name: "Account menu" })).toHaveCount(0);
    expect(await page.content()).not.toMatch(/org\.manage|org\.members\.manage|"permissions"|"role":/);

    // The session: who the user is. Not where they belong, and not what they may do.
    const session = await currentSession(page);
    expect(session.status, role).toBe(200);
    expect(Object.keys(session.body).sort()).toEqual(["session", "user"]);
    const text = JSON.stringify(session.body);
    expect(text, role).not.toMatch(/"(role|roles|permissions?|organization\w*|orgId|orgSlug|membership\w*|activeOrganization\w*)"/i);
    expect(text).not.toContain(site.orgId);

    // Cookies: the session and nothing that names an organization, a role or a permission.
    for (const cookie of await page.context().cookies()) {
      expect(cookie.name, role).not.toMatch(/org|role|perm|tenant|member/i);
      expect(decodeURIComponent(cookie.value)).not.toContain(site.orgId);
    }
  }

  // A visitor who claims to be somebody gets the same page as one who claims nothing.
  const claims = { "x-role": "owner", "x-permissions": "org.manage,sites.delete", "x-organization-id": site.orgId, cookie: "role=owner; permissions=org.manage" };
  const loud = await stranger.get(`/s/${site.address}`, { headers: claims });
  expect(loud.status()).toBe(200);
  expect(loud.headers()["set-cookie"]).toBeUndefined();
  expect(view(await loud.text())).toEqual(asStranger);
  // And the same claims make nobody a user: the session route still wants a session.
  expect((await stranger.get("/api/app/session", { headers: claims })).status()).toBe(401);
  await stranger.dispose();
});

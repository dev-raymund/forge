import { expect, test } from "@playwright/test";
import { asUniqueVisitor, currentSession, newEmail, sessionCookie, signUp } from "./helpers/auth";
import { addMember, seedSite } from "./helpers/sites";

/**
 * M3-1 on the shared V1 origin (ADR 0006): which tenant a public page shows is
 * decided by the address in the URL and by nothing about the visitor. Being
 * signed in to the admin, or being the Owner of some organization, neither
 * changes what `/s/{address}` renders nor opens another organization's site.
 */

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

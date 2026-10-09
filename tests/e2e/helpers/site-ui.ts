import { expect, type Page } from "@playwright/test";
import { newEmail, signUp } from "./auth";
import { seedOrganization, type SeededOrganization } from "./orgs";
import { addMember } from "./sites";

/** Site screens in the browser (M4-1 onward): a signed-up member, and the create-site form. */

export type Role = "owner" | "admin" | "editor" | "author" | "viewer";

/** A signed-up user who is a member of a fresh organization (or the given one), with this role. */
export async function memberOf(page: Page, role: Role = "owner", organization?: SeededOrganization) {
  const org = organization ?? (await seedOrganization("sites"));
  const email = newEmail();
  await signUp(page, email);
  await addMember(org.id, email, role);
  return { org, email };
}

export const createForm = (page: Page) => page.getByRole("form", { name: "Create a site" });

/** Fills and submits the create-site form on the current page. */
export async function createSite(page: Page, site: { name: string; address: string; language?: string; timezone?: string }) {
  const form = createForm(page);
  await form.getByLabel("Site name").fill(site.name);
  await form.getByLabel("Site address").fill(site.address);
  if (site.language) await form.getByLabel("Language").selectOption({ label: site.language });
  if (site.timezone) await form.getByLabel("Time zone").selectOption(site.timezone);
  await form.getByRole("button", { name: "Create site" }).click();
}

/**
 * After a successful create, the browser moves to the new site's page once it
 * has re-fetched the links the action refreshed. With several browsers on one
 * local server that can take longer than the default 5 s (seen: about 5 s at a
 * load of 8 to 14, and in CI it does not), so this one wait is given longer.
 * What is checked is unchanged: the URL is exactly the new site's.
 */
export async function expectSiteCreated(page: Page, orgSlug: string, address: string) {
  await expect(page).toHaveURL(new RegExp(`/${orgSlug}/sites/${address}$`), { timeout: 15_000 });
}

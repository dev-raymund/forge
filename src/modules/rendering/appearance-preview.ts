import "server-only";
import { and, eq } from "drizzle-orm";
import { permissionsForRole } from "@/modules/tenancy/shared";
import { withTenant } from "@/platform/db";
import { domains, organizationMembers, roles } from "@/platform/db/schema";
import { previewSecret, verifyAppearanceToken } from "@/platform/routing/preview-token";
import type { SiteLocator } from "@/platform/routing/hosts";
import { kitSettingsSchema } from "@/themes/_kit/tokens";
import { publicPageFor, type PublicPage } from "./public-page";
import { loadPublicSite, type PublicSite } from "./queries";
import { isShowable } from "./render-state";

/**
 * The appearance editor's live preview (M8-1; ADR 0028): the site's home page, as it would look with settings that are
 * not saved yet. The token carries them (signed, 15 minutes, ADR 0027's route and headers); here they are checked
 * again against the kit's schema, and the person the token names must still be allowed to change the site's
 * appearance (`site.settings.manage`, from the catalog, asked of their role now). Coming soon does not stop it.
 *
 * Only the settings differ from the public page: the content is the published home, read through the public cached
 * reads, and the site's other settings (logo, social links, the theme's own options) are the saved ones. Nothing is
 * written or flushed, and the settings themselves are never cached: they live in the token.
 */

export type AppearancePreview = { kind: "appearance"; site: PublicSite; locator: SiteLocator; page: PublicPage };

export async function loadAppearancePreview(token: string, now: number = Date.now()): Promise<AppearancePreview | null> {
  const secret = previewSecret();
  const claims = secret ? verifyAppearanceToken(token, secret, now) : null;
  if (!claims) return null;
  const settings = kitSettingsSchema.safeParse(claims.settings);
  if (!settings.success) return null;
  const site = await loadPublicSite(claims.orgId, claims.siteId);
  if (!site || !isShowable(site)) return null;

  const address = await withTenant({ orgId: claims.orgId }, async (tx) => {
    const [member] = await tx
      .select({ role: roles.key })
      .from(organizationMembers)
      .innerJoin(roles, eq(roles.id, organizationMembers.roleId))
      .where(and(eq(organizationMembers.organizationId, claims.orgId), eq(organizationMembers.userId, claims.userId)));
    if (!member || !permissionsForRole(member.role).has("site.settings.manage")) return null;
    const [row] = await tx
      .select({ hostname: domains.hostname })
      .from(domains)
      .where(and(eq(domains.siteId, claims.siteId), eq(domains.kind, "subdomain"), eq(domains.status, "active")));
    return row?.hostname ?? null;
  });
  if (!address) return null;

  // The theme's own options stay the saved ones; only the kit-level settings are the token's.
  const options = (site.themeSettings as { options?: unknown } | null)?.options;
  const previewed: PublicSite = { ...site, themeSettings: { ...settings.data, ...(options && typeof options === "object" ? { options } : {}) } };
  const page = await publicPageFor(previewed, []);
  if (!page) return null;
  return { kind: "appearance", site: previewed, locator: { kind: "address", address }, page };
}

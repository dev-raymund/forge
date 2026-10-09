import { and, eq } from "drizzle-orm";
import { describe, expect, it, vi } from "vitest";
import { changeSiteAddress, chooseTheme, createSite, deleteSite } from "@/modules/sites";
import { resolveSiteContext } from "@/modules/tenancy";
import * as t from "@/platform/db/schema";
import { withTenant } from "@/platform/db/tenant";
import { themeFor } from "@/themes/render";
import { newSlug, newTenant } from "../fixtures/tenants";

// The renderer's data functions are `'use cache'`. Outside Next their cache calls have nothing to talk to: they are
// made to do nothing, and the queries behind them run as they do in production.
vi.mock("next/cache", async (original) => ({ ...(await original<typeof import("next/cache")>()), cacheLife: () => {}, cacheTag: () => {} }));
const { loadPublicSite, renderableSite, renderStateFor, resolveSite } = await import("@/modules/rendering");

/**
 * M4-3 against real Postgres, as forge_app through PgBouncer: from a public
 * address to the data a theme is handed. No session and no member anywhere:
 * the address is the only input.
 */

async function newSite(theme?: "journal") {
  const tenant = await newTenant();
  const address = newSlug("public");
  const { site } = await createSite(tenant.ctx, { name: "Public Site", address, language: "fil", timezone: "Asia/Manila" });
  if (theme) await chooseTheme(await resolveSiteContext(tenant.actor, tenant.org.slug, site.slug), { theme });
  return { tenant, site, address };
}
const at = (address: string) => resolveSite({ kind: "address", address });
const setStatus = (orgId: string, siteId: string, status: "coming_soon" | "live" | "suspended") =>
  withTenant({ orgId }, (tx) => tx.update(t.sites).set({ status }).where(and(eq(t.sites.organizationId, orgId), eq(t.sites.id, siteId))));

describe("an address → its site", () => {
  it("a known address resolves to its site and organization, the primary address; its public data follows", async () => {
    const { tenant, site, address } = await newSite();
    expect(await at(address)).toEqual({ siteId: site.id, orgId: tenant.org.id, isPrimary: true });
    expect(await loadPublicSite(tenant.org.id, site.id)).toEqual({
      id: site.id, name: "Public Site", tagline: "", status: "coming_soon", language: "fil", timezone: "Asia/Manila", themeKey: "studio", themeSettings: {},
      social: [], analytics: {},
    });
  });

  it("an unknown or malformed address resolves to nothing", async () => {
    for (const address of [newSlug("nobody"), "", "UPPER", "a--b", "x".repeat(70)]) expect(await at(address), address).toBeNull();
    expect(await resolveSite({ kind: "host", hostname: "nobody.example" })).toBeNull();
  });

  it("an address change counts once committed: the old address finds nothing, the new one the same site", async () => {
    const { tenant, site, address } = await newSite();
    const moved = newSlug("moved");
    await changeSiteAddress(await resolveSiteContext(tenant.actor, tenant.org.slug, site.slug), { address: moved });
    expect(await at(address)).toBeNull();
    expect(await at(moved)).toMatchObject({ siteId: site.id });
  });

  it("a deleted site resolves to nothing, by its address or by its id", async () => {
    const { tenant, site, address } = await newSite();
    await deleteSite(await resolveSiteContext(tenant.actor, tenant.org.slug, site.slug));
    expect(await at(address)).toBeNull();
    expect(await loadPublicSite(tenant.org.id, site.id)).toBeNull();
  });
});

describe("what is rendered", () => {
  it("each status, through the same lookups: coming soon, live, suspended", async () => {
    const { tenant, site, address } = await newSite();
    const stateAt = async (path: string[] = []) => {
      const resolved = await at(address);
      return renderStateFor(resolved ? await loadPublicSite(resolved.orgId, resolved.siteId) : null, path).kind;
    };
    expect([await stateAt(), await stateAt(["about"])]).toEqual(["coming-soon", "coming-soon"]);
    await setStatus(tenant.org.id, site.id, "live");
    expect([await stateAt(), await stateAt(["about"])]).toEqual(["home", "page-not-found"]);
    await setStatus(tenant.org.id, site.id, "suspended");
    expect([await stateAt(), await stateAt(["about"])]).toEqual(["site-unavailable", "site-unavailable"]);
    expect(renderStateFor(null).kind).toBe("site-not-found");
  });

  it("the theme a site chose, and its settings; damaged settings or a retired theme key fall back without failing", async () => {
    const { tenant, site, address } = await newSite("journal");
    const publicSite = (await loadPublicSite(tenant.org.id, site.id))!;
    expect(themeFor(renderableSite(publicSite, { kind: "address", address })).theme.key).toBe("journal");

    await withTenant({ orgId: tenant.org.id }, async (tx) => {
      await tx.update(t.siteSettings).set({ theme: { tokens: { colors: { primary: "url(javascript:alert(1))", accent: "#00ff00" } }, header: "nope" } }).where(eq(t.siteSettings.siteId, site.id));
      await tx.update(t.sites).set({ themeKey: "../../retired" }).where(eq(t.sites.id, site.id));
    });
    const damaged = (await loadPublicSite(tenant.org.id, site.id))!;
    const { theme, context } = themeFor(renderableSite(damaged, { kind: "address", address }));
    expect(theme.key).toBe("studio");
    expect(context.settings.tokens.colors).toMatchObject({ primary: "#1d4ed8", accent: "#00ff00" });
    expect(context.settings.header.variant).toBe("classic");
    expect(context.site).toEqual({ name: "Public Site", tagline: "", language: "fil", basePath: `/s/${address}`, social: [] });
  });
});

describe("only the resolved site's data, in its organization's context", () => {
  it("another organization's id with this site's id finds nothing: RLS, and the query names both", async () => {
    const a = await newSite();
    const b = await newSite();
    expect(await loadPublicSite(b.tenant.org.id, a.site.id)).toBeNull();
    expect(await loadPublicSite(a.tenant.org.id, b.site.id)).toBeNull();
    expect((await loadPublicSite(a.tenant.org.id, a.site.id))?.id).toBe(a.site.id);
  });

  it("what a page is handed holds no id of the organization, the site or anyone", async () => {
    const { tenant, site, address } = await newSite();
    const renderable = renderableSite((await loadPublicSite(tenant.org.id, site.id))!, { kind: "address", address });
    const text = JSON.stringify(renderable);
    for (const secret of [tenant.org.id, tenant.org.slug, site.id, tenant.user.id, tenant.user.email]) expect(text).not.toContain(secret);
  });

  it("no session or member is needed, or used: the lookups take an address and ids, and nothing else", () => {
    expect(resolveSite.length).toBe(1);
    expect(loadPublicSite.length).toBe(2);
  });
});

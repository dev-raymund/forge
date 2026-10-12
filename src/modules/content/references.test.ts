import { uuidv7 } from "uuidv7";
import { describe, expect, it, vi } from "vitest";
import type { SiteContext } from "@/modules/tenancy";
import type { TenantTx } from "@/platform/db";

vi.mock("@/platform/config/env", () => ({ env: () => ({ APP_ORIGIN: "https://cms.forgelinetechnologies.com" }) }));

import { assertNewReferences, assertOwnReferences, SELF_EMBED } from "./references";

/**
 * A generic embed never frames Forge's own host (M5-5): the server adds the
 * app's host to url-safety's blocked hosts. (The integration tests run on
 * localhost, which url-safety refuses anyway, so this is shown here.) The
 * image and link checks run against Postgres: tests/integration/content-blocks.test.ts.
 */

const ctx = { org: { id: uuidv7() }, site: { id: uuidv7() } } as unknown as SiteContext;
/** Nothing here reads the database: a document without images or entry links. */
const tx = new Proxy({}, { get: () => { throw new Error("no query expected"); } }) as TenantTx;
const embed = (url: string) => ({ v: 1, doc: { type: "doc", content: [{ type: "embed", attrs: { id: uuidv7(), v: 1, provider: "generic", url, aspect: "16:9" } }] } });

describe("embeds of Forge itself", () => {
  it.each(["https://cms.forgelinetechnologies.com/acme/bakery/settings", "https://CMS.forgelinetechnologies.com/", "https://x.cms.forgelinetechnologies.com/"])("refuses %s on save and on publish", async (url) => {
    await expect(assertNewReferences(tx, ctx, embed(url), null)).rejects.toMatchObject({ kind: "Validation", fieldErrors: { content: [SELF_EMBED] } });
    await expect(assertOwnReferences(tx, ctx, embed(url))).rejects.toMatchObject({ kind: "Validation", fieldErrors: { content: [SELF_EMBED] } });
  });

  it("accepts any other public page, and YouTube and Vimeo (their own hosts)", async () => {
    await expect(assertNewReferences(tx, ctx, embed("https://www.openstreetmap.org/export/embed.html"), null)).resolves.toBeUndefined();
    await expect(assertOwnReferences(tx, ctx, embed("https://forgelinetechnologies.com/"))).resolves.toBeUndefined();
  });
});

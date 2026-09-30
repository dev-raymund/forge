import { beforeEach, describe, expect, it, vi } from "vitest";

const calls: string[] = [];
vi.mock("next/cache", () => ({
  updateTag: (tag: string) => calls.push(`update ${tag}`),
  revalidateTag: (tag: string, profile: unknown) => calls.push(`revalidate ${tag} ${JSON.stringify(profile)}`),
}));

const { invalidate, tags, tagsFor, tagsForAll } = await import("./index");

const S = "0192f000-0000-7000-8000-00000000000a";
const E = "0192f000-0000-7000-8000-00000000000b";

beforeEach(() => void (calls.length = 0));

describe("tagsFor (the invalidation map)", () => {
  it.each([
    [{ type: "entry.published", siteId: S, entryId: E, contentType: "post" } as const,
      { immediate: [tags.entry(S, E), tags.routes(S)], stale: [tags.list(S, "post")] }],
    [{ type: "entry.unpublished", siteId: S, entryId: E, contentType: "page", pathChanged: true } as const,
      { immediate: [tags.entry(S, E), tags.routes(S), tags.config(S)], stale: [tags.list(S, "page")] }],
    [{ type: "site.configChanged", siteId: S } as const, { immediate: [`site:${S}:config`], stale: [] }],
    [{ type: "site.statusChanged", siteId: S } as const, { immediate: [`site:${S}`], stale: [] }],
    [{ type: "domain.changed", siteId: S, hostnames: ["old.com", "new.com"] } as const,
      { immediate: ["host:old.com", "host:new.com", `site:${S}`], stale: [] }],
    [{ type: "media.updated", mediaId: E } as const, { immediate: [], stale: [`media:${E}`] }],
  ])("%j", (event, expected) => expect(tagsFor(event)).toEqual(expected));

  it("merges events; immediate wins over stale", () => {
    const set = tagsForAll([
      { type: "entry.published", siteId: S, entryId: E, contentType: "post" },
      { type: "entry.published", siteId: S, entryId: E, contentType: "post" },
    ]);
    expect(set.immediate).toEqual([tags.entry(S, E), tags.routes(S)]);
    expect(set.stale).toEqual([tags.list(S, "post")]);
  });

  it("keeps tags within Next's 256-character limit", () => {
    const longHost = `${"a".repeat(63)}.${"b".repeat(63)}.${"c".repeat(63)}.${"d".repeat(61)}`;
    for (const tag of [tags.host(longHost), tags.entry(S, E), tags.list(S, "post")]) expect(tag.length).toBeLessThanOrEqual(256);
    expect(tags.host(longHost)).not.toBe(tags.host(`${longHost.slice(0, -1)}e`)); // still distinct
    expect(tags.host("client.com")).toBe("host:client.com");
  });
});

describe("invalidate", () => {
  const event = { type: "entry.published", siteId: S, entryId: E, contentType: "post" } as const;

  it("Server Actions: updateTag for immediate tags, SWR for the rest", () => {
    invalidate([event], "action");
    expect(calls).toEqual([
      `update ${tags.entry(S, E)}`,
      `update ${tags.routes(S)}`,
      `revalidate ${tags.list(S, "post")} "max"`,
    ]);
  });

  it("route handlers and jobs: revalidateTag with expire 0 for immediate tags", () => {
    invalidate([event], "background");
    expect(calls).toEqual([
      `revalidate ${tags.entry(S, E)} {"expire":0}`,
      `revalidate ${tags.routes(S)} {"expire":0}`,
      `revalidate ${tags.list(S, "post")} "max"`,
    ]);
  });
});

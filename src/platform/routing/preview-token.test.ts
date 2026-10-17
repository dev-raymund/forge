import { createHmac } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  DEVELOPMENT_PREVIEW_SECRET, PREVIEW_TOKEN_SHAPE, PREVIEW_TOKEN_TTL_SECONDS, previewSecret, signAppearanceToken, signPreviewToken, verifyAppearanceToken, verifyPreviewToken,
  type PreviewClaims,
} from "./preview-token";

/** Preview tokens (M7-4): signed, bound to what they show and who asked, 15 minutes, and nothing else accepted. */

const SECRET = "s".repeat(40);
const NOW = Date.UTC(2026, 9, 16, 10, 0, 0);
const claims = (over: Partial<PreviewClaims> = {}): PreviewClaims => ({
  orgId: "0192f000-0000-7000-8000-000000000001", siteId: "0192f000-0000-7000-8000-000000000002", entryId: "0192f000-0000-7000-8000-000000000003",
  userId: "0192f000-0000-7000-8000-000000000004", revisionId: null, expiresAt: NOW / 1000 + PREVIEW_TOKEN_TTL_SECONDS, ...over,
});

describe("preview tokens", () => {
  it("carry the organization, site, entry, user and (for a revision) the revision, and are accepted until they expire", () => {
    const token = signPreviewToken(claims(), SECRET);
    expect(verifyPreviewToken(token, SECRET, NOW)).toEqual(claims());
    expect(verifyPreviewToken(token, SECRET, NOW + PREVIEW_TOKEN_TTL_SECONDS * 1000 - 1)).toEqual(claims());
    expect(verifyPreviewToken(token, SECRET, NOW + PREVIEW_TOKEN_TTL_SECONDS * 1000)).toBeNull();
    const revision = claims({ revisionId: "0192f000-0000-7000-8000-000000000005" });
    expect(verifyPreviewToken(signPreviewToken(revision, SECRET), SECRET, NOW)).toEqual(revision);
    expect(PREVIEW_TOKEN_TTL_SECONDS).toBe(900);
  });

  it("refuses another secret, a changed payload or signature, a payload with a forged field, and anything not shaped like a token", () => {
    const token = signPreviewToken(claims(), SECRET);
    const [payload, signature] = token.split(".") as [string, string];
    expect(verifyPreviewToken(token, "t".repeat(40), NOW)).toBeNull();
    const body = JSON.parse(Buffer.from(payload, "base64url").toString()) as Record<string, unknown>;
    const forged = Buffer.from(JSON.stringify({ ...body, e: "0192f000-0000-7000-8000-000000000009" })).toString("base64url");
    expect(verifyPreviewToken(`${forged}.${signature}`, SECRET, NOW)).toBeNull();
    const flipped = `${signature.slice(0, -1)}${signature.endsWith("A") ? "B" : "A"}`;
    expect(verifyPreviewToken(`${payload}.${flipped}`, SECRET, NOW)).toBeNull();
    for (const bad of ["", "x", `${payload}`, `${payload}.${signature}.x`, `${payload}.${signature}=`, "a".repeat(30) + "." + "b".repeat(43)]) {
      expect(verifyPreviewToken(bad, SECRET, NOW), bad).toBeNull();
    }
  });

  it("refuses a correctly signed token whose fields are not what a token holds (the signer is the only writer, but nothing is assumed)", () => {
    // An arbitrary body signed with the same scheme, as a bug in the signer would make.
    const signedBody = (body: Record<string, unknown>) => {
      const payload = Buffer.from(JSON.stringify(body)).toString("base64url");
      return `${payload}.${createHmac("sha256", SECRET).update(`forge-preview:v1:${payload}`).digest("base64url")}`;
    };
    const ok = { v: 1, o: claims().orgId, s: claims().siteId, e: claims().entryId, u: claims().userId, x: claims().expiresAt };
    expect(verifyPreviewToken(signedBody(ok), SECRET, NOW)).toEqual(claims());
    for (const body of [{ ...ok, v: 2 }, { ...ok, o: "not-an-id" }, { ...ok, r: "x" }, { ...ok, x: "soon" }, { ...ok, x: 1.5 }]) {
      expect(verifyPreviewToken(signedBody(body), SECRET, NOW), JSON.stringify(body)).toBeNull();
    }
  });

  it("are signed with PREVIEW_TOKEN_SECRET, or on localhost only with the development secret; elsewhere previews are off", () => {
    expect(previewSecret({ PREVIEW_TOKEN_SECRET: SECRET })).toBe(SECRET);
    expect(previewSecret({ PREVIEW_TOKEN_SECRET: "short", APP_ORIGIN: "https://cms.example.com" })).toBeNull();
    expect(previewSecret({ APP_ORIGIN: "http://localhost:3000" })).toBe(DEVELOPMENT_PREVIEW_SECRET);
    // `.env` files write unset variables as empty ones.
    expect(previewSecret({ APP_ORIGIN: "http://localhost:3000", BETTER_AUTH_URL: "", PREVIEW_TOKEN_SECRET: "", VERCEL_ENV: "" })).toBe(DEVELOPMENT_PREVIEW_SECRET);
    expect(previewSecret({ APP_ORIGIN: "http://localhost:3000", VERCEL_ENV: "preview" })).toBeNull();
    expect(previewSecret({ APP_ORIGIN: "https://cms.forgelinetechnologies.com" })).toBeNull();
  });
});

describe("appearance preview tokens (M8-1)", () => {
  const appearance = { orgId: claims().orgId, siteId: claims().siteId, userId: claims().userId, settings: { layout: { width: "wide" } }, expiresAt: claims().expiresAt };

  it("carry the organization, site, user and the unsaved settings, and expire like the others", () => {
    const token = signAppearanceToken(appearance, SECRET);
    expect(verifyAppearanceToken(token, SECRET, NOW)).toEqual(appearance);
    expect(verifyAppearanceToken(token, SECRET, NOW + PREVIEW_TOKEN_TTL_SECONDS * 1000)).toBeNull();
    expect(verifyAppearanceToken(token, "t".repeat(40), NOW)).toBeNull();
  });

  it("are never read as an entry's preview token, nor the other way round: each is signed under its own label", () => {
    const appearanceToken = signAppearanceToken(appearance, SECRET);
    const entryToken = signPreviewToken(claims(), SECRET);
    expect(verifyPreviewToken(appearanceToken, SECRET, NOW)).toBeNull();
    expect(verifyAppearanceToken(entryToken, SECRET, NOW)).toBeNull();
  });

  it("fit the route even with the longest settings the kit allows", () => {
    const longest = { ...appearance, settings: { header: { cta: { label: "x".repeat(40), href: `/${"a".repeat(499)}` } }, footer: { copyright: "ü".repeat(200) }, tokens: { colors: { primary: "#000000" } } } };
    expect(PREVIEW_TOKEN_SHAPE.test(signAppearanceToken(longest, SECRET))).toBe(true);
  });
});

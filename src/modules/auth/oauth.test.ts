import { describe, expect, it } from "vitest";
import { safeNextPath, loginPath } from "@/platform/routing/admin-access";
import { ACCOUNT_LINKING, GOOGLE_AUTHORIZE_ORIGIN, isGoogleAuthorizeUrl, OAUTH_MESSAGES, oauthErrorMessage } from "./oauth";

describe("account-linking policy (plan §12)", () => {
  it("links only on a verified address: no provider is trusted on its name alone", () => {
    expect(ACCOUNT_LINKING.enabled).toBe(true);
    expect(ACCOUNT_LINKING.trustedProviders).toEqual([]);
    expect(ACCOUNT_LINKING.trustedProviders).not.toContain("google");
  });

  it("never links different addresses, and never rewrites the account from the provider's profile", () => {
    expect(ACCOUNT_LINKING.allowDifferentEmails).toBe(false);
    expect(ACCOUNT_LINKING.updateUserInfoOnLink).toBe(false);
  });

  it("keeps the local-address check Better Auth applies by default (it must not be switched off)", () => {
    // `requireLocalEmailVerified: false` would let a pre-registered, unverified
    // account capture the real owner's Google identity.
    expect(ACCOUNT_LINKING).not.toHaveProperty("requireLocalEmailVerified", false);
    expect(Object.keys(ACCOUNT_LINKING).sort()).toEqual(
      ["allowDifferentEmails", "disableImplicitLinking", "enabled", "trustedProviders", "updateUserInfoOnLink"].sort(),
    );
  });
});

describe("oauthErrorMessage", () => {
  it("says nothing when there is no error", () => {
    expect(oauthErrorMessage(undefined)).toBeUndefined();
    expect(oauthErrorMessage("")).toBeUndefined();
  });

  it.each([
    ["account_not_linked", OAUTH_MESSAGES.NOT_LINKED],
    ["unable_to_link_account", OAUTH_MESSAGES.NOT_LINKED],
    ["access_denied", OAUTH_MESSAGES.CANCELLED],
    ["email_not_found", OAUTH_MESSAGES.NO_EMAIL],
  ])("%s has its own wording", (code, message) => expect(oauthErrorMessage(code)).toBe(message));

  it.each(["state_mismatch", "state_not_found", "invalid_code", "no_code", "internal_server_error", "oauth_provider_not_found", "anything-else"])(
    "%s gets the generic message",
    (code) => expect(oauthErrorMessage(code)).toBe(OAUTH_MESSAGES.GENERIC),
  );

  it("never echoes the code: it comes from the URL, so anyone can put anything there", () => {
    for (const code of ["<script>alert(1)</script>", "Your account was suspended. Call 555-0100", "constructor", "__proto__", "toString"]) {
      const message = oauthErrorMessage(code)!;
      expect(message).toBe(OAUTH_MESSAGES.GENERIC);
      expect(message).not.toContain(code);
    }
  });

  it("the not-linked message tells the owner what to do without naming anyone", () => {
    expect(OAUTH_MESSAGES.NOT_LINKED).toMatch(/Log in with your password/);
    expect(OAUTH_MESSAGES.NOT_LINKED).not.toMatch(/@/);
  });
});

describe("isGoogleAuthorizeUrl", () => {
  it("accepts only Google's own authorization origin", () => {
    expect(GOOGLE_AUTHORIZE_ORIGIN).toBe("https://accounts.google.com");
    expect(isGoogleAuthorizeUrl("https://accounts.google.com/o/oauth2/v2/auth?client_id=x&state=y")).toBe(true);
  });

  it.each([
    ["http://accounts.google.com/o/oauth2/v2/auth"],
    ["https://accounts.google.com.evil.example/o/oauth2/v2/auth"],
    ["https://evil.example/?https://accounts.google.com"],
    ["https://accounts.google.com@evil.example/"],
    ["//accounts.google.com/o/oauth2/v2/auth"],
    ["javascript:alert(1)"],
    ["/login"],
    [""],
    [undefined],
    [null],
    [42],
  ])("rejects %s", (url) => expect(isGoogleAuthorizeUrl(url)).toBe(false));
});

describe("where a Google sign-in may return to (the same rules as the login form)", () => {
  it("only a page of this app is kept as the destination", () => {
    expect(safeNextPath("/acme-org/sites?tab=members")).toBe("/acme-org/sites?tab=members");
    for (const next of ["https://evil.example/", "//evil.example", "/\\evil.example", "/.//evil.example", "/s/tenant", "/api/auth/callback/google", ""]) {
      expect(safeNextPath(next), next).toBe("/");
    }
  });

  it("a failed sign-in returns to this app's login page, carrying only a safe destination", () => {
    expect(loginPath({ next: safeNextPath("/acme-org/sites") })).toBe("/login?next=%2Facme-org%2Fsites");
    expect(loginPath({ next: safeNextPath("https://evil.example/") })).toBe("/login");
  });
});

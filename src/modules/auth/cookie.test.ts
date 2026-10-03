import { describe, expect, it } from "vitest";
import { findSessionCookie, renewedSessionCookie, SECURE_SESSION_COOKIE, SESSION_COOKIE, SESSION_IDLE_SECONDS } from "./cookie";

describe("findSessionCookie", () => {
  it("finds the session cookie among others, value untouched", () => {
    expect(findSessionCookie(`theme=dark; ${SESSION_COOKIE}=abc.def%2Bghi%3D; other=1`)).toEqual({ name: SESSION_COOKIE, rawValue: "abc.def%2Bghi%3D" });
    expect(findSessionCookie(`${SESSION_COOKIE}=only`)).toEqual({ name: SESSION_COOKIE, rawValue: "only" });
  });

  it("prefers the __Secure- cookie (the one Better Auth uses on https)", () => {
    const header = `${SESSION_COOKIE}=plain; ${SECURE_SESSION_COOKIE}=secure`;
    expect(findSessionCookie(header)).toEqual({ name: SECURE_SESSION_COOKIE, rawValue: "secure" });
  });

  it.each([[null], [undefined], [""], ["theme=dark"], [`${SESSION_COOKIE}=`], [`x${SESSION_COOKIE}=abc`], [`${SESSION_COOKIE}x=abc`],
    ["better-auth.session_data=abc"], [SESSION_COOKIE],
  ])("finds nothing in %s", (header) => expect(findSessionCookie(header)).toBeNull());

  it("ignores values that are not plain cookie text", () => {
    expect(findSessionCookie(`${SESSION_COOKIE}=a b`)).toBeNull();
    expect(findSessionCookie(`${SESSION_COOKIE}="quoted"`)).toBeNull();
    expect(findSessionCookie(`${SESSION_COOKIE}=a,b`)).toBeNull();
    expect(findSessionCookie(`${SESSION_COOKIE}=a\r\nSet-Cookie: x=1`)).toBeNull();
  });
});

describe("renewedSessionCookie", () => {
  it("re-issues the same value for another 7 days with Better Auth's attributes", () => {
    expect(SESSION_IDLE_SECONDS).toBe(604_800);
    expect(renewedSessionCookie({ name: SESSION_COOKIE, rawValue: "abc.def%3D" })).toBe(
      `${SESSION_COOKIE}=abc.def%3D; Max-Age=604800; Path=/; HttpOnly; SameSite=Lax`,
    );
  });

  it("keeps Secure on the __Secure- cookie (the prefix requires it)", () => {
    expect(renewedSessionCookie({ name: SECURE_SESSION_COOKIE, rawValue: "abc" })).toBe(
      `${SECURE_SESSION_COOKIE}=abc; Max-Age=604800; Path=/; HttpOnly; Secure; SameSite=Lax`,
    );
  });

  it("never sets a Domain: the cookie stays host-only", () => {
    expect(renewedSessionCookie({ name: SESSION_COOKIE, rawValue: "abc" })).not.toMatch(/domain/i);
  });
});

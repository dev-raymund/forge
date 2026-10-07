import type { ErrorEvent } from "@sentry/nextjs";
import { describe, expect, it } from "vitest";
import { scrubEvent } from "./scrub";

describe("scrubEvent", () => {
  it("drops cookies, bodies, query strings, unsafe headers, user details and emails", () => {
    const event = scrubEvent({
      type: undefined,
      message: "Invite failed for alice@example.com",
      request: {
        url: "https://app.forge.test/acme/sites?token=secret",
        method: "POST",
        cookies: { session: "abc" },
        data: { password: "hunter2" },
        query_string: "token=secret",
        headers: { cookie: "s=1", authorization: "Bearer x", "user-agent": "UA", "x-request-id": "req-1" },
      },
      user: { id: "user-1", email: "alice@example.com", ip_address: "1.2.3.4" },
      exception: { values: [{ type: "Error", value: "no user bob@example.org" }] },
      breadcrumbs: [{ category: "fetch", data: { url: "https://x.test/a?key=1", method: "GET", status_code: 200, body: "secret" } }],
      tags: { orgId: "org-1" },
    } as ErrorEvent);

    expect(event.request).toEqual({
      url: "https://app.forge.test/acme/sites",
      method: "POST",
      headers: { "user-agent": "UA", "x-request-id": "req-1" },
    });
    expect(event.user).toEqual({ id: "user-1" });
    expect(event.message).toBe("Invite failed for [email]");
    expect(event.exception?.values?.[0]?.value).toBe("no user [email]");
    expect(event.breadcrumbs?.[0]?.data).toEqual({ url: "https://x.test/a", method: "GET", status_code: 200 });
    expect(event.tags).toEqual({ orgId: "org-1" });
    expect(JSON.stringify(event)).not.toMatch(/hunter2|secret|abc|1\.2\.3\.4|alice@|bob@|Bearer/);
  });

  it("keeps an invitation token out of everything, wherever the link appears", () => {
    const token = "Zk3rT0kenThatMustNeverLeave_abcdefghijklmnop-12";
    const event = scrubEvent({
      type: undefined,
      message: `GET /invite/${token} failed`,
      transaction: `/invite/${token}`,
      request: { url: `https://app.forge.test/invite/${token}?x=1`, method: "GET", headers: { referer: `https://app.forge.test/invite/${token}` } },
      exception: { values: [{ type: "Error", value: `redirect to /login?next=%2Finvite%2F${token}&email=a%40b.test` }] },
      breadcrumbs: [
        { category: "navigation", message: `to /invite/${token}`, data: { url: `https://app.forge.test/invite/${token}`, method: "GET", status_code: 200 } },
        { category: "fetch", data: { url: `https://app.forge.test/login?next=%2Finvite%2F${token}`, method: "GET", status_code: 200 } },
      ],
    } as ErrorEvent);

    expect(JSON.stringify(event)).not.toContain(token);
    expect(event.request?.url).toBe("https://app.forge.test/invite/[token]");
    expect(event.transaction).toBe("/invite/[token]");
    expect(event.message).toBe("GET /invite/[token] failed");
    expect(event.exception?.values?.[0]?.value).toBe("redirect to /login?next=%2Finvite%2F[token]&email=a%40b.test");
    expect(event.breadcrumbs?.[0]).toMatchObject({ message: "to /invite/[token]", data: { url: "https://app.forge.test/invite/[token]" } });
    // The route's own name stays readable.
    expect(scrubEvent({ type: undefined, transaction: "/invite/[token]" } as ErrorEvent).transaction).toBe("/invite/[token]");
  });
});

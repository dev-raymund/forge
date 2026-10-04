import { describe, expect, it } from "vitest";
import { renderEmail } from "./templates";

const url = "https://cms.example.com/api/auth/verify-email?token=tok_abc123";

describe("email templates", () => {
  it.each([
    ["verify-email", { name: "Ada", url }, "Verify your email for Forge"],
    ["reset-password", { name: "Ada", url, expiresInMinutes: 60 }, "Reset your Forge password"],
    [
      "password-changed",
      { name: "Ada", email: "ada@example.test", changedAt: new Date("2026-10-04T09:30:00Z"), url },
      "Your Forge password was changed",
    ],
    [
      "organization-invitation",
      { inviterName: "Grace", organizationName: "Acme", roleName: "Editor", url, expiresAt: new Date("2026-10-08T00:00:00Z") },
      "Grace invited you to Acme on Forge",
    ],
    ["trial-ending", { organizationName: "Acme", trialEndsAt: new Date("2026-10-15T00:00:00Z"), url }, "Your Forge trial for Acme ends October 15, 2026"],
    ["payment-failed", { organizationName: "Acme", url }, "Payment failed for Acme"],
  ] as const)("%s renders HTML, plain text and its subject, with the link", async (name, props, subject) => {
    const email = await renderEmail(name, props as never);
    expect(email.subject).toBe(subject);
    expect(email.html).toMatch(/^<!DOCTYPE html/);
    expect(email.html).toContain(`href="${url.replace(/&/g, "&amp;")}"`);
    expect(email.text).toContain(url);
    expect(email.text).not.toMatch(/<[a-z]/i);
  });

  it("escapes user-provided names and keeps subjects to one line", async () => {
    const email = await renderEmail("organization-invitation", {
      inviterName: "<img src=x onerror=alert(1)>",
      organizationName: "Acme\r\nBcc: victim@example.com",
      roleName: "<b>Admin</b>",
      url,
      expiresAt: new Date("2026-10-08T00:00:00Z"),
    });
    expect(email.html).not.toContain("<img src=x");
    expect(email.html).not.toContain("<b>Admin</b>");
    expect(email.html).toContain("&lt;img src=x onerror=alert(1)&gt;");
    expect(email.subject).not.toMatch(/[\r\n]/);
  });

  describe("password-changed", () => {
    const forgot = "https://cms.example.com/forgot-password";
    const render = (over: Partial<{ name: string; email: string }> = {}) =>
      renderEmail("password-changed", { name: "Ada", email: "ada@example.test", changedAt: new Date("2026-10-04T09:30:00Z"), url: forgot, ...over });

    it("says the password was changed, for which account, and when", async () => {
      const email = await render();
      expect(email.subject).toBe("Your Forge password was changed");
      expect(email.text).toContain("Hi Ada,");
      expect(email.text).toMatch(/The password for the Forge account ada@example\.test was changed on October 4, 2026 at 9:30\sAM UTC\./);
      expect(email.text).toContain("If you made this change, there is nothing more to do.");
    });

    it("tells someone who didn't make the change what to do, with a link to the app's own reset page", async () => {
      const email = await render();
      expect(email.text).toMatch(/If you didn.t, someone else may have access to your account\./);
      expect(email.html).toContain(`href="${forgot}"`);
      expect(email.text).toContain(forgot);
    });

    it("carries no token, no password and no other link", async () => {
      const email = await render();
      for (const part of [email.html, email.text]) {
        expect(part).not.toMatch(/token=/i);
        expect(part).not.toMatch(/reset-password\//);
        expect(part).not.toMatch(/your (new|old) password (is|was):/i);
      }
      const links = [...email.html.matchAll(/href="([^"]+)"/g)].map((m) => m[1]);
      expect(new Set(links)).toEqual(new Set([forgot]));
    });

    it("escapes the account's name and address", async () => {
      const email = await render({ name: "<script>alert(1)</script>", email: "a\"><img src=x>@example.test" });
      expect(email.html).not.toContain("<script>alert(1)</script>");
      expect(email.html).not.toContain("<img src=x>");
    });
  });

  it("uses a friendly greeting when the user has no name", async () => {
    expect((await renderEmail("verify-email", { name: "", url })).text).toContain("Hi there,");
    expect((await renderEmail("password-changed", { name: "", email: "a@example.test", changedAt: new Date(0), url })).text).toContain("Hi there,");
  });
});

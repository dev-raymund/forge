import { describe, expect, it } from "vitest";
import { renderEmail } from "./templates";

const url = "https://cms.example.com/api/auth/verify-email?token=tok_abc123";

describe("email templates", () => {
  it.each([
    ["verify-email", { name: "Ada", url }, "Verify your email for Forge"],
    ["reset-password", { name: "Ada", url, expiresInMinutes: 60 }, "Reset your Forge password"],
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

  it("uses a friendly greeting when the user has no name", async () => {
    expect((await renderEmail("verify-email", { name: "", url })).text).toContain("Hi there,");
  });
});

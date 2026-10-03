import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

// The forms import their Server Actions; rendering needs only their identity.
vi.mock("../actions", () => ({
  signInAction: vi.fn(), signUpAction: vi.fn(), signOutAction: vi.fn(), resendVerificationAction: vi.fn(),
  requestPasswordResetAction: vi.fn(), resetPasswordAction: vi.fn(),
}));

import { AuthCard } from "./auth-card";
import { ForgotPasswordForm } from "./forgot-password-form";
import { Field, FormAlert, PasswordField, SubmitButton } from "./form";
import { LoginForm } from "./login-form";
import { ResetLinkInvalid, ResetPasswordForm } from "./reset-password-form";
import { SignUpForm } from "./signup-form";
import { VerifyEmailBanner } from "./verify-email-banner";
import { VerifyEmailPanel } from "./verify-email-panel";

const html = (node: React.ReactNode) => renderToStaticMarkup(node);
/** The attributes of the first tag matching `pattern`, e.g. the input named "email". */
const tag = (markup: string, pattern: RegExp) => markup.match(pattern)?.[0] ?? "";
const attr = (element: string, name: string) => element.match(new RegExp(`\\b${name}="([^"]*)"`))?.[1];

describe("fields", () => {
  it("ties the label to the input and marks it required", () => {
    const out = html(<Field name="email" label="Email" type="email" required />);
    const input = tag(out, /<input[^>]*>/);
    const label = tag(out, /<label[^>]*>/);
    expect(attr(label, "for")).toBe(attr(input, "id"));
    expect(input).toContain('required=""');
    expect(attr(input, "aria-invalid")).toBeUndefined();
    expect(attr(input, "aria-describedby")).toBeUndefined();
  });

  it("an error is text with an icon, linked to the input and flagged invalid", () => {
    const out = html(<Field name="email" label="Email" errors={["Enter a valid email address."]} />);
    const input = tag(out, /<input[^>]*>/);
    const id = attr(input, "id")!;
    expect(attr(input, "aria-invalid")).toBe("true");
    expect(attr(input, "aria-describedby")).toBe(`${id}-error`);
    expect(out).toContain(`id="${id}-error"`);
    expect(out).toContain("Enter a valid email address.");
    expect(out).toMatch(/<svg[^>]*aria-hidden="true"/); // not colour alone
  });

  it("shows only the first message of a field", () => {
    const out = html(<Field name="x" label="X" errors={["First.", "Second."]} />);
    expect(out).toContain("First.");
    expect(out).not.toContain("Second.");
  });

  it("a hint (the password rule) is read with the field, after any error", () => {
    const plain = tag(html(<PasswordField name="password" label="Password" hint="At least 12 characters." />), /<input[^>]*>/);
    expect(attr(plain, "aria-describedby")).toBe(`${attr(plain, "id")}-hint`);
    const failed = tag(html(<PasswordField name="password" label="Password" hint="At least 12 characters." errors={["Use at least 12 characters."]} />), /<input[^>]*>/);
    expect(attr(failed, "aria-describedby")).toBe(`${attr(failed, "id")}-error ${attr(failed, "id")}-hint`);
  });

  it("a password field starts hidden, with a labelled show/hide toggle that is not a submit button", () => {
    const out = html(<PasswordField name="password" label="Password" autoComplete="current-password" />);
    const input = tag(out, /<input[^>]*>/);
    const toggle = tag(out, /<button[^>]*>/);
    expect(attr(input, "type")).toBe("password");
    expect(attr(input, "autoComplete") ?? attr(input, "autocomplete")).toBe("current-password");
    expect(attr(toggle, "type")).toBe("button");
    expect(attr(toggle, "aria-label")).toBe("Show password");
    expect(attr(toggle, "aria-pressed")).toBe("false");
    expect(attr(toggle, "aria-controls")).toBe(attr(input, "id"));
    expect(input).not.toContain("value="); // never rendered with a value
  });
});

describe("alerts and the submit button", () => {
  it("errors are announced at once; notices politely", () => {
    expect(attr(tag(html(<FormAlert tone="error">No.</FormAlert>), /<div[^>]*>/), "role")).toBe("alert");
    expect(attr(tag(html(<FormAlert tone="success">Yes.</FormAlert>), /<div[^>]*>/), "role")).toBe("status");
    expect(attr(tag(html(<FormAlert tone="info">FYI.</FormAlert>), /<div[^>]*>/), "role")).toBe("status");
    expect(attr(tag(html(<FormAlert tone="error">No.</FormAlert>), /<div[^>]*>/), "tabindex")).toBe("-1"); // can take focus
  });

  it("the button says what it is doing and stays focusable while it does", () => {
    const idle = html(<SubmitButton pending={false} pendingLabel="Logging in…">Log in</SubmitButton>);
    expect(idle).toContain("Log in");
    expect(attr(tag(idle, /<button[^>]*>/), "aria-disabled")).toBeUndefined();
    const busy = tag(html(<SubmitButton pending pendingLabel="Logging in…">Log in</SubmitButton>), /<button[^>]*>/);
    expect(attr(busy, "aria-disabled")).toBe("true");
    expect(attr(busy, "aria-busy")).toBe("true");
    expect(busy).not.toMatch(/\sdisabled(=|\s|>)/);
    expect(html(<SubmitButton pending pendingLabel="Logging in…">Log in</SubmitButton>)).toContain("Logging in…");
    const waiting = html(<SubmitButton pending={false} pendingLabel="Sending…" unavailable="You can resend in 42s">Resend email</SubmitButton>);
    expect(waiting).toContain("You can resend in 42s");
    expect(attr(tag(waiting, /<button[^>]*>/), "aria-disabled")).toBe("true");
    expect(attr(tag(waiting, /<button[^>]*>/), "aria-busy")).toBeUndefined();
  });
});

describe("login form", () => {
  it("has labelled email and password fields, the links, and carries the destination", () => {
    const out = html(<LoginForm next="/acme-org/sites" />);
    expect(out).toContain('name="email"');
    expect(attr(tag(out, /<input[^>]*name="email"[^>]*>/), "type")).toBe("email");
    expect(attr(tag(out, /<input[^>]*name="email"[^>]*>/), "autoComplete") ?? attr(tag(out, /<input[^>]*name="email"[^>]*>/), "autocomplete")).toBe("username");
    expect(attr(tag(out, /<input[^>]*name="password"[^>]*>/), "type")).toBe("password");
    expect(tag(out, /<input[^>]*name="next"[^>]*>/)).toContain('value="/acme-org/sites"');
    expect(out).toContain('href="/forgot-password"');
    expect(tag(out, /<form[^>]*>/)).toMatch(/novalidate/i); // our messages, not the browser's bubbles
    expect(out).not.toMatch(/12 characters/); // says nothing about the password rules
    expect(out).not.toContain("data-form-alert");
  });

  it.each([
    ["session", "status", "Your session has ended. Log in again to continue."],
    ["password-reset", "status", "Your password has been changed. Log in with your new password."],
    ["signed-out", "status", "You have been logged out."],
  ] as const)("explains why the user is here: %s", (reason, role, message) => {
    const out = html(<LoginForm next="/" reason={reason} />);
    expect(out).toContain(message);
    expect(attr(tag(out, /<div[^>]*data-form-alert[^>]*>/), "role")).toBe(role);
  });
});

describe("sign-up form", () => {
  it("asks for name, email and a new password, and states the rule up front", () => {
    const out = html(<SignUpForm />);
    for (const name of ["name", "email", "password"]) expect(out).toContain(`name="${name}"`);
    const password = tag(out, /<input[^>]*name="password"[^>]*>/);
    expect(attr(password, "autoComplete") ?? attr(password, "autocomplete")).toBe("new-password");
    expect(out).toContain("At least 12 characters.");
    expect(out).not.toContain('name="confirm'); // one field with show/hide, no second entry
  });

  it("shows the Turnstile challenge only when a site key is configured", () => {
    expect(html(<SignUpForm />)).not.toContain('data-testid="turnstile"');
    expect(html(<SignUpForm turnstileSiteKey="site-key" />)).toContain('data-testid="turnstile"');
  });
});

describe("password reset screens", () => {
  it("the request form asks only for an email", () => {
    const out = html(<ForgotPasswordForm resetMinutes={60} />);
    expect(out).toContain('name="email"');
    expect(out).not.toContain('type="password"');
    expect(out).toContain("Send reset link");
  });

  it("the new-password form posts the token in a hidden field and states the rule", () => {
    const out = html(<ResetPasswordForm token="tok-123" />);
    const token = tag(out, /<input[^>]*name="token"[^>]*>/);
    expect(attr(token, "type")).toBe("hidden");
    expect(attr(token, "value")).toBe("tok-123");
    expect(out).toContain("At least 12 characters.");
    expect(out).toContain("Change password");
  });

  it("a dead link says so and offers a new one", () => {
    const out = html(<ResetLinkInvalid />);
    expect(out).toContain("This link is invalid or has expired.");
    expect(out).toContain('role="alert"');
    expect(out).toContain('href="/forgot-password"');
    expect(out).not.toContain("<form");
  });
});

describe("verify-email screen", () => {
  const state = (out: string) => attr(tag(out, /<div[^>]*data-testid="verify-state"[^>]*>/), "data-state");

  it("pending: names the address, offers a resend, lets the user continue or log out", () => {
    const out = html(<VerifyEmailPanel view={{ kind: "pending", email: "ada@example.test" }} />);
    expect(state(out)).toBe("pending");
    expect(out).toContain("ada@example.test");
    expect(out).toContain("Resend email");
    expect(out).toContain("Continue to Forge");
    expect(out).toContain("Log out");
    expect(out).not.toContain("is verified");
  });

  it("verified: says so and continues", () => {
    const out = html(<VerifyEmailPanel view={{ kind: "verified" }} />);
    expect(state(out)).toBe("verified");
    expect(out).toContain("Your email address is verified.");
    expect(out).toContain('href="/"');
    expect(out).not.toContain("Resend");
  });

  it("confirmed without a session: thanks, and points to the login page", () => {
    const out = html(<VerifyEmailPanel view={{ kind: "confirmed" }} />);
    expect(state(out)).toBe("confirmed");
    expect(out).toContain('href="/login"');
    expect(out).not.toContain("Continue to Forge");
  });

  it("invalid link, signed in: one message and a way to get a new link", () => {
    const out = html(<VerifyEmailPanel view={{ kind: "invalid", email: "ada@example.test" }} />);
    expect(state(out)).toBe("invalid");
    expect(out).toContain("This link is invalid or has expired.");
    expect(out).toContain("Send a new link");
  });

  it("invalid link, not signed in: log in first; no address is shown", () => {
    const out = html(<VerifyEmailPanel view={{ kind: "invalid" }} />);
    expect(out).toContain("Log in to get a new link");
    expect(out).toContain("next=%2Fverify-email");
    expect(out).not.toContain("@");
    expect(out).not.toContain("<form");
  });

  it("anonymous: explains and points to the login page", () => {
    const out = html(<VerifyEmailPanel view={{ kind: "anonymous" }} />);
    expect(state(out)).toBe("anonymous");
    expect(out).toContain("next=%2Fverify-email");
  });
});

describe("markup", () => {
  it("no screen nests a form or a block element inside a paragraph (invalid HTML breaks hydration)", () => {
    const screens = [
      <LoginForm key="login" next="/" reason="session" />,
      <SignUpForm key="signup" turnstileSiteKey="k" />,
      <ForgotPasswordForm key="forgot" resetMinutes={60} />,
      <ResetPasswordForm key="reset" token="t" />,
      <ResetLinkInvalid key="invalid" />,
      <VerifyEmailBanner key="banner" />,
      ...(["pending", "verified", "confirmed", "invalid", "anonymous"] as const).map((kind) => (
        <VerifyEmailPanel key={kind} view={kind === "pending" ? { kind, email: "a@example.test" } : kind === "invalid" ? { kind, email: "a@example.test" } : { kind }} />
      )),
    ];
    for (const screen of screens) {
      const out = html(<AuthCard title="T" footer={<a href="/x">x</a>}>{screen}</AuthCard>);
      const paragraphs = [...out.matchAll(/<p(?:\s[^>]*)?>([\s\S]*?)<\/p>/g)].map((match) => match[1]!);
      expect(paragraphs.length).toBeGreaterThan(0);
      for (const inner of paragraphs) expect(inner).not.toMatch(/<(form|div|p|ul|h[1-6]|header|main)[\s>]/);
    }
  });
});

describe("shell pieces", () => {
  it("every account screen has exactly one h1 inside main", () => {
    const out = html(<AuthCard title="Log in to Forge" description="Welcome back." footer={<a href="/signup">Sign up</a>}>body</AuthCard>);
    expect(out.match(/<h1/g)).toHaveLength(1);
    expect(out).toMatch(/<main[^>]*>.*<h1[^>]*>Log in to Forge<\/h1>.*<\/main>/s);
  });

  it("the unverified banner is a polite status with a link to the verify screen", () => {
    const out = html(<VerifyEmailBanner />);
    expect(out).toContain('role="status"');
    expect(out).toContain('href="/verify-email"');
  });
});

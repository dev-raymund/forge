import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

// The forms import their Server Actions; rendering needs only their identity.
vi.mock("../actions", () => ({
  signInAction: vi.fn(), signUpAction: vi.fn(), signOutAction: vi.fn(), resendVerificationAction: vi.fn(), signInWithGoogleAction: vi.fn(),
  requestPasswordResetAction: vi.fn(), resetPasswordAction: vi.fn(), updateProfileAction: vi.fn(), changePasswordAction: vi.fn(),
  sendSetPasswordLinkAction: vi.fn(), revokeSessionAction: vi.fn(), revokeOtherSessionsAction: vi.fn(),
}));

import { ChangePasswordForm, ProfileForm, SessionList, SetPasswordPrompt, type SessionRow } from "./account-forms";
import { AccountSection, EmailStatus, SignInMethodList } from "./account-section";
import { AuthCard, AuthLink } from "./auth-card";
import { ForgotPasswordForm } from "./forgot-password-form";
import { Field, FormAlert, PasswordField, SubmitButton } from "./form";
import { GoogleButton } from "./google-button";
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

describe("Google sign-in button", () => {
  const googleForm = (out: string) => out.match(/<form[^>]*aria-label="(Continue|Sign up) with Google"[\s\S]*?<\/form>/)?.[0];

  it("is absent unless Google is configured: on the login page…", () => {
    for (const out of [html(<LoginForm next="/" />), html(<LoginForm next="/" googleEnabled={false} />)]) {
      expect(out).not.toMatch(/Google/);
      expect(out.match(/<form/g)).toHaveLength(1);
      expect(out).not.toContain('role="separator"');
    }
  });

  it("…and on the sign-up page", () => {
    const out = html(<SignUpForm />);
    expect(out).not.toMatch(/Google/);
    expect(out.match(/<form/g)).toHaveLength(1);
  });

  it("is shown when Google is configured, above the email form, as its own form", () => {
    const out = html(<LoginForm next="/acme-org/sites" googleEnabled />);
    const form = googleForm(out)!;
    expect(form).toContain("Continue with Google");
    expect(tag(form, /<input[^>]*name="next"[^>]*>/)).toContain('value="/acme-org/sites"'); // returns to the same page
    expect(attr(tag(form, /<button[^>]*>/), "type")).toBe("submit");
    expect(form).not.toContain('name="password"'); // the password never travels with it
    expect(out.indexOf("Continue with Google")).toBeLessThan(out.indexOf('name="email"'));
    expect(out).toContain('role="separator"');
    expect(out.match(/<form/g)).toHaveLength(2);
  });

  it("on the sign-up page it says so, and a new account lands on the home page", () => {
    const form = googleForm(html(<SignUpForm googleEnabled />))!;
    expect(form).toContain("Sign up with Google");
    expect(tag(form, /<input[^>]*name="next"[^>]*>/)).toContain('value="/"');
  });

  it("the logo is decorative; the button is named by its text", () => {
    const out = html(<GoogleButton next="/" />);
    expect(tag(out, /<svg[^>]*>/)).toContain('aria-hidden="true"');
    expect(out).toContain("Continue with Google");
  });

  it("a failed Google sign-in is explained on the login page, with or without the button", () => {
    const message = "Google sign-in was cancelled.";
    for (const out of [html(<LoginForm next="/" googleEnabled oauthError={message} />), html(<LoginForm next="/" oauthError={message} />)]) {
      const alert = tag(out, /<div[^>]*data-form-alert[^>]*>/);
      expect(attr(alert, "role")).toBe("alert");
      expect(out).toContain(message);
    }
    // It takes precedence over a notice about why the user is on this page: one message at a time.
    const both = html(<LoginForm next="/" reason="signed-out" oauthError={message} />);
    expect(both).toContain(message);
    expect(both).not.toContain("You have been logged out.");
    expect(both.match(/data-form-alert/g)).toHaveLength(1);
    // It is about the Google attempt, so it sits above the Google button.
    const placed = html(<LoginForm next="/" googleEnabled oauthError={message} />);
    expect(placed.indexOf(message)).toBeLessThan(placed.indexOf("Continue with Google"));
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

describe("account page (M2-4)", () => {
  const session = (over: Partial<SessionRow>): SessionRow => ({
    handle: "h".repeat(32), current: false, device: "Chrome on macOS", ipAddress: "203.0.113.7",
    signedInAt: "2026-10-01T23:30:00.000Z", lastActiveAt: "2026-10-04T00:10:00.000Z", ...over,
  });
  const three = [
    session({ handle: "a".repeat(32), current: true }),
    session({ handle: "b".repeat(32), device: "Safari on iOS", ipAddress: "203.0.113.20" }),
    session({ handle: "c".repeat(32), device: "Firefox on Windows", ipAddress: null }),
  ];
  const rows = (out: string) => out.match(/<li[^>]*data-testid="session"[\s\S]*?<\/li>/g) ?? [];

  it("the profile form edits the name only", () => {
    const out = html(<ProfileForm name="Ada Lovelace" />);
    expect(out.match(/<input/g)).toHaveLength(1);
    const input = tag(out, /<input[^>]*name="name"[^>]*>/);
    expect(attr(input, "value")).toBe("Ada Lovelace");
    expect(attr(input, "autoComplete") ?? attr(input, "autocomplete")).toBe("name");
    expect(out).not.toContain('name="email"');
    expect(out).not.toContain('type="file"');
  });

  it("the address is shown, not editable, with its verification state in words", () => {
    const unverified = html(<EmailStatus email="ada@example.test" verified={false} />);
    expect(unverified).not.toContain("<input");
    expect(unverified).toContain("ada@example.test");
    expect(unverified).toContain("Not verified");
    expect(unverified).toContain('href="/verify-email"');
    const verified = html(<EmailStatus email="ada@example.test" verified />);
    expect(verified).toContain("Verified");
    expect(verified).not.toContain("Not verified");
    expect(verified).not.toContain('href="/verify-email"');
  });

  it("sign-in methods are a read-only list", () => {
    const out = html(<SignInMethodList password google={false} />);
    expect(out).toMatch(/Password<\/span><span[^>]*>Set</);
    expect(out).toMatch(/Google<\/span><span[^>]*>Not connected</);
    expect(out).not.toMatch(/<button|<form|<a /);
    expect(html(<SignInMethodList password={false} google />)).toMatch(/Password<\/span><span[^>]*>Not set<[\s\S]*Google<\/span><span[^>]*>Connected</);
  });

  it("changing the password asks for the current one, states the rule, and says what else happens", () => {
    const out = html(<ChangePasswordForm email="ada@example.test" />);
    const current = tag(out, /<input[^>]*name="currentPassword"[^>]*>/);
    const next = tag(out, /<input[^>]*name="newPassword"[^>]*>/);
    expect(attr(current, "type")).toBe("password");
    expect(attr(current, "autoComplete") ?? attr(current, "autocomplete")).toBe("current-password");
    expect(attr(next, "autoComplete") ?? attr(next, "autocomplete")).toBe("new-password");
    expect(out).toContain("At least 12 characters.");
    expect(out).toContain("Changing your password logs out your other sessions.");
    // For password managers only: hidden, and never a password.
    const username = tag(out, /<input[^>]*name="username"[^>]*>/);
    expect(username).toContain("hidden");
    expect(attr(username, "value")).toBe("ada@example.test");
    expect(current).not.toContain("value=");
    expect(next).not.toContain("value=");
  });

  it("an account without a password is offered a link by email instead of a form it cannot use", () => {
    const out = html(<SetPasswordPrompt />);
    expect(out).toContain("has no password");
    expect(out).toContain("Email me a link");
    expect(out).not.toContain('type="password"');
  });

  it("lists each session with what a person needs to recognise it, and marks this device", () => {
    const out = html(<SessionList sessions={three} />);
    const items = rows(out);
    expect(items).toHaveLength(3);
    expect(items[0]).toContain("This device");
    expect(items[0]).toContain("Chrome on macOS");
    // The server renders the UTC day inside <time>; the browser replaces it with the viewer's own day.
    expect(items[0]).toMatch(/Signed in <time dateTime="2026-10-01T23:30:00.000Z">Oct 1, 2026<\/time>/i);
    expect(items[0]).toMatch(/Last active <time dateTime="2026-10-04T00:10:00.000Z">Oct 4, 2026<\/time>/i);
    expect(items[0]).toContain("IP address 203.0.113.7");
    expect(items[1]).not.toContain("This device");
    expect(items[2]).not.toContain("IP address"); // unknown: omitted, not invented
  });

  it("this device has no button; every other session has its own, named so they can be told apart", () => {
    const out = html(<SessionList sessions={three} />);
    const items = rows(out);
    expect(items[0]).not.toContain("<button");
    const second = tag(items[1]!, /<button[^>]*>/);
    expect(attr(second, "type")).toBe("submit");
    expect(attr(second, "name")).toBe("session");
    expect(attr(second, "value")).toBe("b".repeat(32));
    expect(attr(second, "aria-label")).toBe("Log out the session on Safari on iOS, signed in Oct 1, 2026");
    expect(attr(tag(items[2]!, /<button[^>]*>/), "value")).toBe("c".repeat(32));
    expect(out).toContain("Log out all other sessions");
  });

  it("with one session there is nothing to end", () => {
    const out = html(<SessionList sessions={[three[0]!]} />);
    expect(out).not.toContain("<button");
    expect(out).toContain("This is your only active session.");
  });

  it("carries only the opaque handle to the browser", () => {
    const out = html(<SessionList sessions={three} />);
    expect(out).not.toMatch(/[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-/); // no UUIDs: no session or user ids
    expect(out).not.toContain("Mozilla/");
  });

  it("each block of the page is a labelled region with an h2", () => {
    const out = html(<AccountSection title="Sessions" description="Where your account is logged in.">body</AccountSection>);
    const section = tag(out, /<section[^>]*>/);
    const heading = tag(out, /<h2[^>]*>/);
    expect(attr(section, "aria-labelledby")).toBe(attr(heading, "id"));
    expect(out).toContain(">Sessions</h2>");
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
      const out = html(<AuthCard title="T" footer={<AuthLink href="/x">x</AuthLink>}>{screen}</AuthCard>);
      const paragraphs = [...out.matchAll(/<p(?:\s[^>]*)?>([\s\S]*?)<\/p>/g)].map((match) => match[1]!);
      expect(paragraphs.length).toBeGreaterThan(0);
      for (const inner of paragraphs) expect(inner).not.toMatch(/<(form|div|p|ul|h[1-6]|header|main)[\s>]/);
    }
  });
});

describe("shell pieces", () => {
  it("every account screen has exactly one h1 inside main", () => {
    const out = html(<AuthCard title="Log in to Forge" description="Welcome back." footer={<AuthLink href="/signup">Sign up</AuthLink>}>body</AuthCard>);
    expect(out.match(/<h1/g)).toHaveLength(1);
    expect(out).toMatch(/<main[^>]*>.*<h1[^>]*>Log in to Forge<\/h1>.*<\/main>/s);
  });

  it("the unverified banner is a polite status with a link to the verify screen", () => {
    const out = html(<VerifyEmailBanner />);
    expect(out).toContain('role="status"');
    expect(out).toContain('href="/verify-email"');
  });
});

describe("signing up on the way to somewhere (an invitation)", () => {
  it("carries the destination through the form, the Google button and the 'already have an account' link, and starts with the address given", () => {
    const next = "/invite/abcDEF_123-token";
    const out = html(<SignUpForm googleEnabled next={next} email="ivy@example.test" />);
    expect(attr(tag(out, /<input[^>]*name="next"[^>]*>/), "value")).toBe(next);
    // In the sign-up form and in the Google button's form.
    expect([...out.matchAll(/<input[^>]*name="next"[^>]*>/g)].map((match) => attr(match[0], "value"))).toEqual([next, next]);
    expect(attr(tag(out, /<input[^>]*name="email"[^>]*>/), "value")).toBe("ivy@example.test");
    // The address is a starting value in an ordinary field: it can be changed, and nothing hidden repeats it.
    expect(tag(out, /<input[^>]*name="email"[^>]*>/)).not.toMatch(/\s(readOnly|disabled)=|type="hidden"/);
    expect(out.match(/ivy@example\.test/g)).toHaveLength(1);
  });

  it("without a destination behaves as before: home, and an empty address", () => {
    const out = html(<SignUpForm />);
    expect(attr(tag(out, /<input[^>]*name="next"[^>]*>/), "value")).toBe("/");
    expect(attr(tag(out, /<input[^>]*name="email"[^>]*>/), "value")).toBe("");
  });

  it("the login form starts with the address given, too", () => {
    const out = html(<LoginForm next="/invite/abc" email="ivy@example.test" />);
    expect(attr(tag(out, /<input[^>]*name="email"[^>]*>/), "value")).toBe("ivy@example.test");
    expect(attr(tag(out, /<input[^>]*name="next"[^>]*>/), "value")).toBe("/invite/abc");
  });
});

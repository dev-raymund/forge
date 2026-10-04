import { describe, expect, it } from "vitest";
import { fieldErrorsFrom } from "@/platform/errors";
import {
  changePasswordSchema, forgotPasswordSchema, MAX_PASSWORD_LENGTH, MIN_PASSWORD_LENGTH, profileSchema, resetPasswordSchema, signInSchema,
  signUpSchema, text,
} from "./validation";

const errors = (schema: { safeParse: (v: unknown) => { success: boolean; error?: unknown } }, value: unknown) => {
  const result = schema.safeParse(value);
  return result.success ? {} : fieldErrorsFrom(result.error as Parameters<typeof fieldErrorsFrom>[0]);
};
const good = { name: "Ada Lovelace", email: "ada@example.test", password: "correct horse battery staple" };

describe("signUpSchema", () => {
  it("accepts a name, an email and a password of at least 12 characters", () => {
    expect(signUpSchema.parse(good)).toEqual(good);
    expect(signUpSchema.safeParse({ ...good, password: "x".repeat(MIN_PASSWORD_LENGTH) }).success).toBe(true);
    expect(signUpSchema.safeParse({ ...good, password: "x".repeat(MAX_PASSWORD_LENGTH) }).success).toBe(true);
  });

  it("trims the name and the email, lowercases the email, and leaves the password exactly as typed", () => {
    expect(signUpSchema.parse({ name: "  Ada  ", email: "  Ada@Example.TEST ", password: "  spaces are part of it  " })).toEqual({
      name: "Ada", email: "ada@example.test", password: "  spaces are part of it  ",
    });
  });

  it("says what each empty field needs, one message per field", () => {
    expect(errors(signUpSchema, { name: "", email: "", password: "" })).toEqual({
      name: ["Enter your name."],
      email: ["Enter your email address."],
      password: ["Use at least 12 characters."],
    });
    expect(errors(signUpSchema, { name: "   ", email: "   ", password: good.password })).toEqual({
      name: ["Enter your name."],
      email: ["Enter your email address."],
    });
  });

  it.each([["not-an-email"], ["a@b"], ["@example.test"], ["ada@"], ["ada example@test.com"], [`${"a".repeat(250)}@example.test`]])(
    "rejects the email %s",
    (email) => expect(errors(signUpSchema, { ...good, email })).toEqual({ email: ["Enter a valid email address."] }),
  );

  it("enforces the password bounds", () => {
    expect(errors(signUpSchema, { ...good, password: "x".repeat(MIN_PASSWORD_LENGTH - 1) })).toEqual({ password: ["Use at least 12 characters."] });
    expect(errors(signUpSchema, { ...good, password: "x".repeat(MAX_PASSWORD_LENGTH + 1) })).toEqual({ password: ["Use at most 128 characters."] });
  });

  it("bounds the name", () => {
    expect(errors(signUpSchema, { ...good, name: "x".repeat(101) })).toEqual({ name: ["Use at most 100 characters."] });
  });

  it("rejects missing fields and non-strings", () => {
    expect(signUpSchema.safeParse({}).success).toBe(false);
    expect(signUpSchema.safeParse({ ...good, password: 123456789012 }).success).toBe(false);
  });
});

describe("signInSchema", () => {
  it("asks only that the fields are filled: it never reveals the password rules", () => {
    expect(signInSchema.parse({ email: " Ada@Example.test ", password: "short" })).toEqual({ email: "ada@example.test", password: "short" });
    expect(errors(signInSchema, { email: "", password: "" })).toEqual({
      email: ["Enter your email address."],
      password: ["Enter your password."],
    });
    expect(JSON.stringify(errors(signInSchema, { email: "ada@example.test", password: "" }))).not.toContain("12");
  });

  it("answers an absurdly long password like a wrong one", () => {
    expect(errors(signInSchema, { email: "ada@example.test", password: "x".repeat(MAX_PASSWORD_LENGTH + 1) })).toEqual({
      password: ["Email or password is incorrect."],
    });
  });
});

describe("forgotPasswordSchema and resetPasswordSchema", () => {
  it("forgot password needs a valid email", () => {
    expect(forgotPasswordSchema.parse({ email: "ADA@example.test" })).toEqual({ email: "ada@example.test" });
    expect(errors(forgotPasswordSchema, { email: "nope" })).toEqual({ email: ["Enter a valid email address."] });
  });

  it("reset needs the token and a password that meets the rules", () => {
    expect(resetPasswordSchema.parse({ token: "abc", password: good.password })).toEqual({ token: "abc", password: good.password });
    expect(errors(resetPasswordSchema, { token: "abc", password: "short" })).toEqual({ password: ["Use at least 12 characters."] });
    expect(errors(resetPasswordSchema, { token: "", password: good.password })).toEqual({
      token: ["This link is invalid or has expired. Request a new one."],
    });
    expect(errors(resetPasswordSchema, { token: "x".repeat(513), password: good.password })).toHaveProperty("token");
  });
});

describe("the account page: profileSchema and changePasswordSchema", () => {
  it("the name is trimmed, required and bounded; nothing else is a profile field", () => {
    expect(profileSchema.parse({ name: "  Ada Lovelace " })).toEqual({ name: "Ada Lovelace" });
    expect(errors(profileSchema, { name: "   " })).toEqual({ name: ["Enter your name."] });
    expect(errors(profileSchema, { name: "x".repeat(101) })).toEqual({ name: ["Use at most 100 characters."] });
    // Unknown fields are dropped, so a forged form cannot carry them to the service.
    expect(profileSchema.parse({ name: "Ada", email: "x@example.test", image: "https://x", emailVerified: true })).toEqual({ name: "Ada" });
  });

  it("changing the password needs the current one and a new one that meets the rules", () => {
    expect(changePasswordSchema.parse({ currentPassword: "old", newPassword: good.password })).toEqual({ currentPassword: "old", newPassword: good.password });
    expect(errors(changePasswordSchema, { currentPassword: "", newPassword: "" })).toEqual({
      currentPassword: ["Enter your current password."],
      newPassword: ["Use at least 12 characters."],
    });
    expect(errors(changePasswordSchema, { currentPassword: "old", newPassword: "x".repeat(MAX_PASSWORD_LENGTH + 1) })).toEqual({
      newPassword: ["Use at most 128 characters."],
    });
  });

  it("says nothing about the rules for the current password, and treats an absurdly long one as wrong", () => {
    expect(errors(changePasswordSchema, { currentPassword: "x", newPassword: good.password })).toEqual({});
    expect(errors(changePasswordSchema, { currentPassword: "x".repeat(MAX_PASSWORD_LENGTH + 1), newPassword: good.password })).toEqual({
      currentPassword: ["Your current password is incorrect."],
    });
  });
});

describe("text", () => {
  it("reads a form value as a string; files and missing values are empty", () => {
    expect(text("abc")).toBe("abc");
    expect(text(null)).toBe("");
    expect(text(new File(["x"], "x.txt"))).toBe("");
  });
});

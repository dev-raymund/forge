import { describe, expect, it } from "vitest";
import {
  ASSIGNABLE_ROLES, INVITATION_DAYS, invitationExpiry, invitationState, isAcceptable, isAssignableRole, isInvitedAccount, isOpenInvitation,
  normalizeEmail, type InvitationState,
} from "./invitation-rules";
import { hashInvitationToken, looksLikeInvitationToken, newInvitationToken } from "./invitation-token";
import { roleHolds } from "./permissions";
import { ROLE_KEYS } from "./schema";
import { changeMemberRoleSchema, inviteMemberSchema } from "./validation";

const now = new Date("2026-10-06T12:00:00Z");
const at = (offsetMs: number) => new Date(now.getTime() + offsetMs);
const DAY = 24 * 3600 * 1000;
const dates = (over: Partial<{ expiresAt: Date; acceptedAt: Date | null; revokedAt: Date | null }> = {}) => ({ expiresAt: at(DAY), acceptedAt: null, revokedAt: null, ...over });

describe("the life of an invitation", () => {
  it("lasts 7 days from when it is sent", () => {
    expect(INVITATION_DAYS).toBe(7);
    expect(invitationExpiry(now).toISOString()).toBe("2026-10-13T12:00:00.000Z");
    expect(invitationState({ expiresAt: invitationExpiry(now), acceptedAt: null, revokedAt: null }, at(7 * DAY - 1))).toBe("pending");
    expect(invitationState({ expiresAt: invitationExpiry(now), acceptedAt: null, revokedAt: null }, at(7 * DAY))).toBe("expired");
  });

  it("is pending until its time is up, and expired from that instant on", () => {
    expect(invitationState(dates({ expiresAt: at(1) }), now)).toBe("pending");
    expect(invitationState(dates({ expiresAt: now }), now)).toBe("expired");
    expect(invitationState(dates({ expiresAt: at(-1) }), now)).toBe("expired");
  });

  it("accepted and revoked are final: neither turns into expired, or into each other", () => {
    expect(invitationState(dates({ acceptedAt: at(-DAY) }), now)).toBe("accepted");
    expect(invitationState(dates({ acceptedAt: at(-DAY), expiresAt: at(-1) }), now)).toBe("accepted"); // accepted in time, long ago
    expect(invitationState(dates({ revokedAt: at(-DAY) }), now)).toBe("revoked");
    expect(invitationState(dates({ revokedAt: at(-DAY), expiresAt: at(-1) }), now)).toBe("revoked");
    // Both set cannot happen through the service; if it did, "accepted" is what happened to the membership.
    expect(invitationState(dates({ acceptedAt: at(-2), revokedAt: at(-1) }), now)).toBe("accepted");
  });

  it("only a pending invitation can be accepted; pending and expired ones can still be re-sent or revoked", () => {
    const table: Record<InvitationState, { acceptable: boolean; open: boolean }> = {
      pending: { acceptable: true, open: true },
      expired: { acceptable: false, open: true },
      accepted: { acceptable: false, open: false },
      revoked: { acceptable: false, open: false },
    };
    for (const [state, expected] of Object.entries(table) as [InvitationState, (typeof table)[InvitationState]][]) {
      expect({ acceptable: isAcceptable(state), open: isOpenInvitation(state) }, state).toEqual(expected);
    }
  });
});

describe("the roles an invitation, or the members page, can give", () => {
  it("are every role but Owner", () => {
    expect([...ASSIGNABLE_ROLES]).toEqual(ROLE_KEYS.filter((role) => role !== "owner"));
    expect(isAssignableRole("owner")).toBe(false);
    for (const role of ASSIGNABLE_ROLES) expect(isAssignableRole(role)).toBe(true);
    for (const junk of ["", "Owner", "OWNER", "superuser", "admin ", null, undefined, 1, {}, ["admin"]]) expect(isAssignableRole(junk), String(junk)).toBe(false);
  });

  it("none of them holds what only an Owner holds: no link and no drop-down can hand over the organization", () => {
    for (const role of ASSIGNABLE_ROLES) {
      for (const key of ["org.manage", "org.billing.manage", "sites.delete"] as const) expect(roleHolds(role, key), `${role}: ${key}`).toBe(false);
    }
  });

  it("the invite form: an address in one spelling, and one of those roles", () => {
    expect(inviteMemberSchema.parse({ email: "  Ada@Example.TEST ", role: "editor" })).toEqual({ email: "ada@example.test", role: "editor" });
    const errors = (input: unknown) => Object.fromEntries((inviteMemberSchema.safeParse(input).error?.issues ?? []).map((issue) => [issue.path.join("."), issue.message]));
    expect(errors({ email: "ada@example.test", role: "owner" })).toEqual({ role: "Choose a role." });
    expect(errors({ email: "ada@example.test" })).toEqual({ role: "Choose a role." });
    expect(errors({ email: "ada@example.test", role: "" })).toEqual({ role: "Choose a role." });
    expect(errors({ email: "", role: "viewer" })).toEqual({ email: "Enter an email address." });
    expect(errors({ email: "ada", role: "viewer" })).toEqual({ email: "Enter a valid email address." });
    expect(errors({ email: "a@b.test, c@d.test", role: "viewer" })).toEqual({ email: "Enter a valid email address." });
    expect(errors({ email: "ada@example.test\r\nbcc: x@evil.test", role: "viewer" })).toEqual({ email: "Enter a valid email address." });
    expect(errors({})).toEqual({ email: expect.any(String), role: "Choose a role." });
  });

  it("the role form: the same roles, and Owner is not one of them", () => {
    for (const role of ASSIGNABLE_ROLES) expect(changeMemberRoleSchema.parse({ role })).toEqual({ role });
    for (const role of ["owner", "", "superuser", undefined]) expect(changeMemberRoleSchema.safeParse({ role }).success, String(role)).toBe(false);
  });
});

describe("who an invitation is for", () => {
  it("the account whose own address is the invited one, in one spelling", () => {
    expect(isInvitedAccount("ada@example.test", "ada@example.test")).toBe(true);
    expect(isInvitedAccount("ada@example.test", "Ada@Example.TEST")).toBe(true);
    expect(isInvitedAccount("ada@example.test", "  ada@example.test ")).toBe(true);
    expect(normalizeEmail("  Ada@Example.TEST ")).toBe("ada@example.test");
  });

  it("and no other: a different address, a look-alike, or no address at all", () => {
    for (const other of ["bob@example.test", "ada@example.test.evil.test", "ada+x@example.test", "ada@exampIe.test", "", "   ", null, undefined]) {
      expect(isInvitedAccount("ada@example.test", other), String(other)).toBe(false);
    }
    // Two missing addresses are not a match.
    expect(isInvitedAccount("", "")).toBe(false);
    expect(isInvitedAccount("", null)).toBe(false);
  });
});

describe("invitation tokens", () => {
  it("are 32 random bytes in the URL-safe alphabet, different every time", () => {
    const tokens = Array.from({ length: 200 }, () => newInvitationToken().token);
    expect(new Set(tokens).size).toBe(200);
    for (const token of tokens) {
      expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/);
      expect(Buffer.from(token, "base64url")).toHaveLength(32);
      expect(looksLikeInvitationToken(token)).toBe(true);
    }
  });

  it("are stored as a SHA-256, which is not the token and does not lead back to it", () => {
    const { token, tokenHash } = newInvitationToken();
    expect(tokenHash).toMatch(/^[0-9a-f]{64}$/);
    expect(tokenHash).toBe(hashInvitationToken(token));
    expect(tokenHash).not.toContain(token);
    expect(hashInvitationToken(`${token}x`)).not.toBe(tokenHash);
    // A hash is not accepted where a token is expected: it has the wrong shape.
    expect(looksLikeInvitationToken(tokenHash)).toBe(false);
  });

  it("anything that is not shaped like a token is refused before a database is asked", () => {
    const junk = ["", "x", "a".repeat(42), "a".repeat(44), `${"a".repeat(42)}/`, `${"a".repeat(42)}%`, `${"a".repeat(42)} `, "../".repeat(14) + "a", "0199a000-0000-7000-8000-00000000000a", null, undefined, 43, {}, ["a".repeat(43)]];
    for (const value of junk) expect(looksLikeInvitationToken(value), String(value)).toBe(false);
  });
});

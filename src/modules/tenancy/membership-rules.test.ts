import { describe, expect, it } from "vitest";
import { decideRemoval, decideRoleChange, decideTransfer } from "./membership-rules";
import { roleHolds } from "./permissions";
import { ROLE_KEYS, type RoleKey } from "./schema";

const OK = { ok: true };
const FORBIDDEN = { ok: false, reason: "forbidden" };
const LAST_OWNER = { ok: false, reason: "last-owner" };
const others = ROLE_KEYS.filter((role) => role !== "owner");

describe("who manages what", () => {
  it("is the catalog's answer: members take org.members.manage, the organization itself org.manage", () => {
    const managers = ROLE_KEYS.filter((role) => roleHolds(role, "org.members.manage"));
    const organizers = ROLE_KEYS.filter((role) => roleHolds(role, "org.manage"));
    expect(managers).toEqual(["owner", "admin"]);
    expect(organizers).toEqual(["owner"]);
    // The decisions follow the catalog, role for role, rather than a list of their own.
    for (const role of ROLE_KEYS) {
      expect(decideRoleChange({ actorRole: role, self: false, currentRole: "viewer", newRole: "author", owners: 2 }).ok, role).toBe(managers.includes(role));
      expect(decideRemoval({ actorRole: role, self: false, targetRole: "viewer", owners: 2 }).ok, role).toBe(managers.includes(role));
      expect(decideTransfer({ actorRole: role, self: false }).ok, role).toBe(organizers.includes(role));
    }
  });
});

describe("decideRoleChange", () => {
  const change = (actorRole: RoleKey, currentRole: RoleKey, newRole: RoleKey, owners = 2, self = false) =>
    decideRoleChange({ actorRole, currentRole, newRole, owners, self });

  it("Editors, Authors and Viewers cannot change anyone's role, their own included", () => {
    for (const actor of ["editor", "author", "viewer"] as const) {
      for (const current of ROLE_KEYS) for (const next of ROLE_KEYS) {
        expect(change(actor, current, next), `${actor}: ${current} → ${next}`).toEqual(FORBIDDEN);
        expect(change(actor, current, next, 2, true), `${actor} on self`).toEqual(FORBIDDEN);
      }
    }
  });

  it("an Admin manages every role below Owner", () => {
    for (const current of others) for (const next of others) expect(change("admin", current, next)).toEqual(OK);
  });

  it("only an Owner can make an Owner: an Admin cannot promote anyone to it, themselves included", () => {
    for (const current of others) expect(change("admin", current, "owner")).toEqual(FORBIDDEN);
    expect(change("admin", "admin", "owner", 1, true)).toEqual(FORBIDDEN);
  });

  it("only an Owner can change an Owner", () => {
    for (const next of ROLE_KEYS) expect(change("admin", "owner", next)).toEqual(FORBIDDEN);
  });

  it("an Owner can do all of it while another Owner remains", () => {
    for (const current of ROLE_KEYS) for (const next of ROLE_KEYS) expect(change("owner", current, next, 2)).toEqual(OK);
  });

  it("the last Owner cannot be demoted, by anyone, themselves included", () => {
    for (const next of others) {
      expect(change("owner", "owner", next, 1, true)).toEqual(LAST_OWNER);
      expect(change("owner", "owner", next, 1, false)).toEqual(LAST_OWNER);
    }
    expect(change("owner", "owner", "owner", 1, true)).toEqual(OK); // nothing changes
    expect(change("owner", "admin", "owner", 1)).toEqual(OK); // a second Owner is how the first gets free
  });

  it("refuses on permission before it says anything about Owners", () => {
    expect(change("viewer", "owner", "viewer", 1)).toEqual(FORBIDDEN);
    expect(change("admin", "owner", "admin", 1)).toEqual(FORBIDDEN);
  });
});

describe("decideRemoval", () => {
  const remove = (actorRole: RoleKey, targetRole: RoleKey, owners = 2) => decideRemoval({ actorRole, targetRole, owners, self: false });
  const leave = (role: RoleKey, owners = 2) => decideRemoval({ actorRole: role, targetRole: role, owners, self: true });

  it("removing someone else takes an Owner or an Admin", () => {
    for (const actor of ["editor", "author", "viewer"] as const) for (const target of ROLE_KEYS) expect(remove(actor, target)).toEqual(FORBIDDEN);
    for (const target of others) expect(remove("admin", target)).toEqual(OK);
    for (const target of ROLE_KEYS) expect(remove("owner", target)).toEqual(OK);
  });

  it("an Admin cannot remove an Owner", () => {
    expect(remove("admin", "owner")).toEqual(FORBIDDEN);
  });

  it("the last Owner cannot be removed", () => {
    expect(remove("owner", "owner", 1)).toEqual(LAST_OWNER);
  });

  it("anyone can leave, except the last Owner", () => {
    for (const role of others) expect(leave(role, 1)).toEqual(OK);
    expect(leave("owner", 2)).toEqual(OK);
    expect(leave("owner", 1)).toEqual(LAST_OWNER);
  });
});

describe("decideTransfer", () => {
  it("only an Owner hands the organization over, and to someone else", () => {
    expect(decideTransfer({ actorRole: "owner", self: false })).toEqual(OK);
    expect(decideTransfer({ actorRole: "owner", self: true })).toEqual(FORBIDDEN);
    for (const role of others) expect(decideTransfer({ actorRole: role, self: false })).toEqual(FORBIDDEN);
  });
});

describe("the last-Owner rule, exhaustively", () => {
  it("no allowed decision takes the number of Owners from one to zero", () => {
    for (const actor of ROLE_KEYS) for (const target of ROLE_KEYS) for (const self of [true, false]) {
      for (const next of ROLE_KEYS) {
        const decision = decideRoleChange({ actorRole: actor, currentRole: target, newRole: next, owners: 1, self });
        if (decision.ok && target === "owner") expect(next, `${actor} demotes the only owner to ${next}`).toBe("owner");
      }
      const removal = decideRemoval({ actorRole: actor, targetRole: target, owners: 1, self });
      if (target === "owner") expect(removal.ok, `${actor} removes the only owner (self=${self})`).toBe(false);
    }
  });
});

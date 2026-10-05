import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { ENTRY_TYPES } from "@/platform/db/schema";
import {
  grantMatches, isPermission, NO_PERMISSIONS, PERMISSIONS, permissionsForRole, permits, ROLE_GRANTS, roleHolds,
  type OwnedResource, type Permission, type PermissionSet, type Subject,
} from "./permissions";
import { ROLE_KEYS, type RoleKey } from "./schema";

/**
 * The table of plan §13, written out one key per row, by hand, and NOT derived
 * from the code under test. Typed by the catalog: a key added to the catalog
 * without a row here does not compile, and neither does a row for a key that
 * is not in it.
 */
const ALL = ["owner", "admin", "editor", "author", "viewer"] as const;
const WRITERS = ["owner", "admin", "editor", "author"] as const;
const EDITORS = ["owner", "admin", "editor"] as const;
const ADMINS = ["owner", "admin"] as const;
const OWNERS = ["owner"] as const;

const PLAN: Record<Permission, readonly RoleKey[]> = {
  "org.manage": OWNERS,
  "org.billing.manage": OWNERS,
  "org.members.manage": ADMINS,
  "org.activity.read": ADMINS,
  "sites.create": ADMINS,
  "sites.delete": OWNERS,
  "site.settings.manage": ADMINS,
  "site.menus.manage": EDITORS,
  "site.seo.manage": EDITORS,
  "entries.page.read": ALL,
  "entries.page.create": EDITORS,
  "entries.page.update": EDITORS,
  "entries.page.publish": EDITORS,
  "entries.page.delete": EDITORS,
  "entries.post.read": ALL,
  "entries.post.create": WRITERS,
  "entries.post.update.own": WRITERS,
  "entries.post.update.any": EDITORS,
  "entries.post.publish.own": WRITERS,
  "entries.post.publish.any": EDITORS,
  "entries.post.delete.own": WRITERS,
  "entries.post.delete.any": EDITORS,
  "terms.manage": EDITORS,
  "terms.assign": WRITERS,
  "media.upload": WRITERS,
  "media.update.own": WRITERS,
  "media.update.any": EDITORS,
  "media.delete.own": WRITERS,
  "media.delete.any": EDITORS,
};

const ORG = "0199a000-0000-7000-8000-00000000000a";
const OTHER_ORG = "0199a000-0000-7000-8000-00000000000b";
const ME = "0199a000-0000-7000-8000-0000000000a1";
const SOMEONE = "0199a000-0000-7000-8000-0000000000a2";
const subject = (role: string, over: Partial<Subject> = {}): Subject => ({ permissions: permissionsForRole(role), userId: ME, organizationId: ORG, ...over });
const mine: OwnedResource = { organizationId: ORG, ownerId: ME };
const theirs: OwnedResource = { organizationId: ORG, ownerId: SOMEONE };

describe("the catalog", () => {
  it("is the V1 vocabulary of plan §13: 29 keys, each once", () => {
    expect([...PERMISSIONS].sort()).toEqual(Object.keys(PLAN).sort());
    expect(new Set(PERMISSIONS).size).toBe(PERMISSIONS.length);
    expect(PERMISSIONS).toHaveLength(29);
  });

  it("every key is lowercase `area.action`, two to four segments, with no wildcard in it", () => {
    for (const key of PERMISSIONS) expect(key, key).toMatch(/^[a-z]+(\.[a-z]+){1,3}$/);
  });

  it("entry keys are `entries.{type}.{action}` for exactly the content types that exist", () => {
    const types = new Set(PERMISSIONS.filter((key) => key.startsWith("entries.")).map((key) => key.split(".")[1]));
    expect([...types].sort()).toEqual([...ENTRY_TYPES].sort());
    for (const type of ENTRY_TYPES) expect(isPermission(`entries.${type}.read`), type).toBe(true);
  });

  it("every `.own` key has its `.any` twin, and the other way round", () => {
    const own = PERMISSIONS.filter((key) => key.endsWith(".own")).map((key) => key.slice(0, -4));
    const any = PERMISSIONS.filter((key) => key.endsWith(".any")).map((key) => key.slice(0, -4));
    expect(own.sort()).toEqual(any.sort());
    expect(own).toHaveLength(5);
  });

  it("has no platform-staff, plan or entitlement keys in it", () => {
    for (const key of PERMISSIONS) expect(key).not.toMatch(/^(platform|staff|admin|plan|billing|entitlement|feature)\b/);
  });

  it("knows a key from a non-key", () => {
    for (const key of PERMISSIONS) expect(isPermission(key)).toBe(true);
    for (const junk of ["", "org", "org.", "org.manage ", "ORG.MANAGE", "org.manage.any", "entries.*.read", "*", "toString", "__proto__", null, undefined, 7, {}, ["org.manage"]]) {
      expect(isPermission(junk), String(junk)).toBe(false);
    }
  });
});

describe.each(ROLE_KEYS)("the role matrix: %s", (role) => {
  it.each(PERMISSIONS)("%s", (permission) => {
    expect(permissionsForRole(role).has(permission)).toBe(PLAN[permission].includes(role));
    expect(roleHolds(role, permission)).toBe(PLAN[permission].includes(role));
  });
});

describe("the documented matrix (ADR 0009 §3)", () => {
  const adr = readFileSync(path.resolve(import.meta.dirname, "../../../docs/adr/0009-authorization.md"), "utf8");
  const table = adr.slice(adr.indexOf("<!-- matrix:start -->"), adr.indexOf("<!-- matrix:end -->")).split("\n").filter((line) => line.startsWith("|"));
  const cellsOf = (line: string) => line.split("|").slice(1, -1).map((cell) => cell.trim());

  it("has the roles as its columns, in order", () => {
    expect(cellsOf(table[0]!).map((cell) => cell.toLowerCase())).toEqual(["permission", ...ROLE_KEYS]);
  });

  it("is the code's, row for row and cell for cell", () => {
    const rows = table.slice(2).map(cellsOf);
    expect(rows.map((cells) => cells[0])).toEqual(PERMISSIONS.map((key) => `\`${key}\``));
    for (const [cell, ...marks] of rows) {
      const key = cell!.slice(1, -1) as Permission;
      expect(marks.every((mark) => mark === "✓" || mark === ""), key).toBe(true);
      expect(ROLE_KEYS.filter((_, column) => marks[column] === "✓"), key).toEqual(ROLE_KEYS.filter((role) => roleHolds(role, key)));
    }
  });

  it("states the size of each role's set", () => {
    const sizes = ROLE_KEYS.map((role) => `${role[0]!.toUpperCase()}${role.slice(1)} ${permissionsForRole(role).list.length}`).join(", ");
    expect(adr).toContain(`${sizes}.`);
  });
});

describe("role → permissions", () => {
  it("covers exactly the five roles", () => {
    expect(Object.keys(ROLE_GRANTS).sort()).toEqual([...ROLE_KEYS].sort());
  });

  it("gives each role exactly its column of the table, in catalog order", () => {
    for (const role of ROLE_KEYS) {
      expect(permissionsForRole(role).list, role).toEqual(PERMISSIONS.filter((key) => PLAN[key].includes(role)));
    }
    expect(ROLE_KEYS.map((role) => permissionsForRole(role).list.length)).toEqual([29, 26, 22, 10, 2]);
  });

  it("the Owner holds the whole catalog, and three keys belong to the Owner alone", () => {
    expect(permissionsForRole("owner").list).toEqual([...PERMISSIONS]);
    expect(PERMISSIONS.filter((key) => PLAN[key].length === 1)).toEqual(["org.manage", "org.billing.manage", "sites.delete"]);
  });

  it("no role holds something the role above it lacks", () => {
    for (let i = 1; i < ROLE_KEYS.length; i++) {
      const [above, below] = [permissionsForRole(ROLE_KEYS[i - 1]!), permissionsForRole(ROLE_KEYS[i]!)];
      for (const key of below.list) expect(above.has(key), `${ROLE_KEYS[i]} holds ${key}, ${ROLE_KEYS[i - 1]} does not`).toBe(true);
      expect(below.list.length).toBeLessThan(above.list.length);
    }
  });

  it("is the same answer every time", () => {
    for (const role of ROLE_KEYS) expect(permissionsForRole(role)).toBe(permissionsForRole(role));
  });

  it("an unknown role holds nothing", () => {
    const unknown = ["", "superuser", "root", "OWNER", "Owner", " owner", "owner ", "owner,admin", "*", "constructor", "__proto__", "toString", "hasOwnProperty", null, undefined, 0, {}, ["owner"]];
    for (const role of unknown) {
      const set = permissionsForRole(role as string);
      expect(set, String(role)).toBe(NO_PERMISSIONS);
      expect(set.list).toEqual([]);
      for (const key of PERMISSIONS) {
        expect(set.has(key)).toBe(false);
        expect(roleHolds(role as string, key)).toBe(false);
      }
    }
  });

  it("an unknown permission is held by nobody, the Owner included", () => {
    const unknown = ["", "org", "org.manage.any", "ORG.MANAGE", "org.manage ", "platform.admin", "entries.*.read", "entries.page.*", "*", "size", "has", "__proto__", null, undefined, 1, {}, ["org.manage"]];
    for (const role of ROLE_KEYS) for (const key of unknown) {
      expect(permissionsForRole(role).has(key as Permission), `${role}: ${String(key)}`).toBe(false);
      expect(permits(subject(role), key as Permission, mine)).toBe(false);
    }
  });

  it("a set cannot be added to: not through the object, not through its list", () => {
    const set = permissionsForRole("viewer") as { has: unknown; list: Permission[] } & PermissionSet;
    expect(Object.isFrozen(set)).toBe(true);
    expect(Object.isFrozen(set.list)).toBe(true);
    expect(() => set.list.push("org.manage")).toThrow(TypeError);
    expect(() => (set.has = () => true)).toThrow(TypeError);
    expect(() => ((set as unknown as { list: Permission[] }).list = ["org.manage"])).toThrow(TypeError);
    // Nothing on the object leads to the keys behind `has`.
    expect(Object.keys(set).sort()).toEqual(["has", "list"]);
    expect(permissionsForRole("viewer").has("org.manage")).toBe(false);
    // Changing the exported grants after the fact changes nothing either: the sets are already made.
    (ROLE_GRANTS.viewer as string[]).push("org.manage");
    try {
      expect(permissionsForRole("viewer").has("org.manage")).toBe(false);
    } finally {
      (ROLE_GRANTS.viewer as string[]).pop();
    }
  });
});

describe("grants and the one wildcard", () => {
  it("a grant covers its own key", () => {
    for (const key of PERMISSIONS) expect(grantMatches(key, key)).toBe(true);
    expect(grantMatches("org.manage", "org.members.manage")).toBe(false);
    expect(grantMatches("media.update.own", "media.update.any")).toBe(false);
  });

  it("`entries.*.{action}` covers that action on every entry type", () => {
    for (const type of ENTRY_TYPES) expect(grantMatches("entries.*.read", `entries.${type}.read`)).toBe(true);
    expect(grantMatches("entries.*.update.own", "entries.post.update.own")).toBe(true);
    expect(grantMatches("entries.*.read", "entries.page.create")).toBe(false);
  });

  it("the wildcard does not cross segments", () => {
    expect(grantMatches("entries.*.update", "entries.post.update.own")).toBe(false);
    expect(grantMatches("entries.*.update", "entries.post.update.any")).toBe(false);
    expect(grantMatches("entries.*.update.own", "entries.page.update")).toBe(false);
    expect(grantMatches("entries.*", "entries.page.read")).toBe(false);
    expect(grantMatches("entries.*.read", "entries.read")).toBe(false);
    expect(grantMatches("entries.*.read", "entries.a.b.read")).toBe(false);
  });

  it("is a wildcard in the entry type and nowhere else", () => {
    const elsewhere = ["*", "*.*", "*.manage", "org.*", "org.*.manage", "site.*.manage", "media.*", "media.*.own", "entries.page.*", "entries.*.*", "entries.post.update.*", "*.page.read", "terms.*"];
    for (const grant of elsewhere) for (const key of PERMISSIONS) expect(grantMatches(grant, key), `${grant} ~ ${key}`).toBe(false);
  });

  it("every grant a role is given names something in the catalog", () => {
    for (const role of ROLE_KEYS) for (const grant of ROLE_GRANTS[role]) {
      expect(PERMISSIONS.some((key) => grantMatches(grant, key)), `${role}: ${grant}`).toBe(true);
    }
    // The one wildcard in use is the plan's `entries.*.read`.
    expect([...new Set(ROLE_KEYS.flatMap((role) => ROLE_GRANTS[role]).filter((grant) => grant.includes("*")))]).toEqual(["entries.*.read"]);
  });
});

describe("permits: the decision behind can()", () => {
  it("without a resource, it is the matrix, except that `.own` keys need the thing itself", () => {
    for (const role of ROLE_KEYS) for (const key of PERMISSIONS) {
      const expected = key.endsWith(".own") ? false : PLAN[key].includes(role);
      expect(permits(subject(role), key), `${role}: ${key}`).toBe(expected);
      expect(permits(subject(role), key, null), `${role}: ${key} (null)`).toBe(expected);
    }
  });

  it("with the member's own resource, it is the matrix", () => {
    for (const role of ROLE_KEYS) for (const key of PERMISSIONS) {
      expect(permits(subject(role), key, mine), `${role}: ${key}`).toBe(PLAN[key].includes(role));
    }
  });

  it("`.own` is refused on somebody else's resource; `.any` is not", () => {
    for (const role of ROLE_KEYS) for (const key of PERMISSIONS) {
      const expected = key.endsWith(".own") ? false : PLAN[key].includes(role);
      expect(permits(subject(role), key, theirs), `${role}: ${key}`).toBe(expected);
    }
    // An Author edits their own post and not a colleague's; an Editor edits both.
    expect(permits(subject("author"), "entries.post.update.own", mine)).toBe(true);
    expect(permits(subject("author"), "entries.post.update.own", theirs)).toBe(false);
    expect(permits(subject("author"), "entries.post.update.any", theirs)).toBe(false);
    expect(permits(subject("editor"), "entries.post.update.any", theirs)).toBe(true);
  });

  it("a resource nobody is recorded as having made is nobody's own", () => {
    for (const ownerId of [null, undefined, "", 0, {}, [ME]]) {
      const orphan = { organizationId: ORG, ownerId } as unknown as OwnedResource;
      expect(permits(subject("owner"), "media.delete.own", orphan), String(ownerId)).toBe(false);
      expect(permits(subject("owner"), "media.delete.any", orphan)).toBe(true);
    }
    // Nor does a subject without an id own things that have no owner.
    expect(permits(subject("owner", { userId: "" }), "media.delete.own", { organizationId: ORG, ownerId: "" })).toBe(false);
    expect(permits(subject("owner", { userId: undefined as unknown as string }), "media.delete.own", { organizationId: ORG, ownerId: undefined as unknown as string })).toBe(false);
  });

  it("a resource of another organization is refused whatever the key and whoever made it", () => {
    const foreign: OwnedResource = { organizationId: OTHER_ORG, ownerId: ME };
    for (const role of ROLE_KEYS) for (const key of PERMISSIONS) expect(permits(subject(role), key, foreign), `${role}: ${key}`).toBe(false);
    for (const organizationId of ["", undefined, null, ORG.toUpperCase(), ` ${ORG}`]) {
      expect(permits(subject("owner"), "media.delete.any", { organizationId, ownerId: ME } as unknown as OwnedResource), String(organizationId)).toBe(false);
    }
    // A subject with no organization matches no resource, including one with no organization.
    const nowhere = subject("owner", { organizationId: undefined as unknown as string });
    expect(permits(nowhere, "media.delete.any", { organizationId: undefined, ownerId: ME } as unknown as OwnedResource)).toBe(false);
  });

  it("does not throw on anything it is handed", () => {
    for (const resource of ["x", 7, true, [], () => 1] as unknown as OwnedResource[]) {
      expect(permits(subject("owner"), "org.manage", resource)).toBe(false);
      expect(permits(subject("owner"), "media.delete.own", resource)).toBe(false);
    }
    expect(permits(subject("nobody"), "org.manage")).toBe(false);
  });
});

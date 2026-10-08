import { describe, expect, it } from "vitest";
import {
  AUDIT_ACTIONS, AUDIT_EVENTS, AuditEventError, describeEvent, eventLabel, isAuditAction, sanitizeMetadata, withoutSecrets, type AuditAction,
} from "./events";

/** One valid set of details per event: what a service would hand the writer. */
const SAMPLES: { [A in AuditAction]: Record<string, unknown> } = {
  "organization.created": { name: "Acme Studio", slug: "acme-studio" },
  "organization.updated": { previousName: "Acme", newName: "Acme Studio" },
  "organization.ownership_transferred": { newOwnerName: "Jane Doe" },
  "member.invited": { email: "john@example.com", role: "author" },
  "invitation.resent": { email: "john@example.com" },
  "invitation.revoked": { email: "john@example.com" },
  "invitation.accepted": { role: "editor" },
  "member.role_changed": { memberName: "Jane Doe", previousRole: "author", newRole: "editor" },
  "member.removed": { memberName: "Jane Doe", role: "viewer" },
  "member.left": { role: "admin" },
  "site.created": { name: "Acme Bakery", address: "acme" },
  "site.address_changed": { name: "Acme Bakery", previousAddress: "acme", newAddress: "acme-bakery" },
  "site.deleted": { name: "Acme Bakery", address: "acme-bakery" },
};

describe("the audit vocabulary", () => {
  it("is the ten events of M3 and the three of M4-1, each named `resource.verb` in the past tense", () => {
    expect([...AUDIT_ACTIONS].sort()).toEqual(
      [
        "organization.created", "organization.updated", "organization.ownership_transferred",
        "member.invited", "invitation.resent", "invitation.revoked", "invitation.accepted",
        "member.role_changed", "member.removed", "member.left",
        "site.created", "site.address_changed", "site.deleted",
      ].sort(),
    );
    for (const action of AUDIT_ACTIONS) expect(action, action).toMatch(/^[a-z]+\.[a-z_]+(ed|ent|eft)$/);
  });

  it("every event is about an organization, a membership, an invitation or a site, and has a name for the filter list", () => {
    for (const action of AUDIT_ACTIONS) {
      expect(["organization", "membership", "invitation", "site"], action).toContain(AUDIT_EVENTS[action].resourceType);
      expect(eventLabel(action), action).toMatch(/^[A-Z][a-z]+( [a-z]+)*$/);
    }
    expect(new Set(AUDIT_ACTIONS.map(eventLabel)).size).toBe(AUDIT_ACTIONS.length);
    expect(eventLabel("entry.published")).toBe("entry.published"); // an event from elsewhere keeps its own name
  });

  it("knows an event from something that is not one", () => {
    for (const action of AUDIT_ACTIONS) expect(isAuditAction(action)).toBe(true);
    for (const junk of ["", "member", "member.", "MEMBER.INVITED", "member.invited ", "entry.published", "toString", "__proto__", "constructor", null, undefined, 1, {}, ["member.invited"]]) {
      expect(isAuditAction(junk), String(junk)).toBe(false);
    }
  });
});

describe("what is stored with an event", () => {
  it.each(AUDIT_ACTIONS)("%s: the details it names, as given", (action) => {
    expect(sanitizeMetadata(action, SAMPLES[action])).toEqual(SAMPLES[action]);
  });

  it("nothing the event does not name: other keys are left out", () => {
    const stored = sanitizeMetadata("member.role_changed", { ...SAMPLES["member.role_changed"], organizationId: "x", userId: "y", note: "z", row: { everything: true } });
    expect(stored).toEqual(SAMPLES["member.role_changed"]);
  });

  it("never anything named like a secret, at any depth, whatever the event", () => {
    const secrets = {
      token: "t", invitationToken: "t", tokenHash: "h", token_hash: "h", password: "p", newPassword: "p", passwordHash: "h", secret: "s", clientSecret: "s",
      apiKey: "k", api_key: "k", "api-key": "k", authorization: "Bearer x", cookie: "c", sessionId: "s", session_token: "s", credential: "c", hash: "h",
    };
    for (const action of AUDIT_ACTIONS) {
      const stored = sanitizeMetadata(action, { ...SAMPLES[action], ...secrets, nested: { ...secrets, fine: 1 } });
      expect(stored, action).toEqual(SAMPLES[action]);
      expect(JSON.stringify(stored)).not.toMatch(/token|password|secret|hash|cookie|session|authorization|credential/i);
    }
    expect(withoutSecrets({ a: 1, token: "x", deep: { password: "y", ok: [{ secret: "z", kept: true }] } })).toEqual({ a: 1, deep: { ok: [{ kept: true }] } });
    expect(withoutSecrets(null)).toBeNull();
    expect(withoutSecrets("a string is not searched")).toBe("a string is not searched");
  });

  it("trims what it stores and leaves out what was optional and absent", () => {
    expect(sanitizeMetadata("organization.created", { name: "  Acme  ", slug: " acme " })).toEqual({ name: "Acme", slug: "acme" });
    expect(sanitizeMetadata("organization.updated", { previousSlug: "old", newSlug: "new", previousName: undefined })).toEqual({ previousSlug: "old", newSlug: "new" });
    expect(sanitizeMetadata("invitation.accepted", { role: "viewer", alreadyMember: true })).toEqual({ role: "viewer", alreadyMember: true });
    expect(Object.keys(sanitizeMetadata("invitation.accepted", { role: "viewer" }))).toEqual(["role"]);
  });

  it("refuses an event whose details are missing, malformed or too long", () => {
    const invalid: [AuditAction, unknown][] = [
      ["organization.created", { name: "Acme" }],
      ["organization.created", { name: "", slug: "acme" }],
      ["organization.created", { name: "x".repeat(201), slug: "acme" }],
      ["organization.updated", {}],
      ["organization.updated", { previousName: "only half" }],
      ["organization.updated", { newSlug: "only-half" }],
      ["member.invited", { email: "john@example.com" }],
      ["member.invited", { email: "john@example.com", role: "Not A Role" }],
      ["member.invited", { email: "x".repeat(255), role: "viewer" }],
      ["member.role_changed", { memberName: "Jane", previousRole: "editor" }],
      ["member.role_changed", { memberName: { first: "Jane" }, previousRole: "editor", newRole: "author" }],
      ["invitation.accepted", { role: "viewer", alreadyMember: false }],
      ["member.left", null],
      ["member.left", "viewer"],
      ["member.left", []],
    ];
    for (const [action, metadata] of invalid) expect(() => sanitizeMetadata(action, metadata), `${action} ${JSON.stringify(metadata)}`).toThrow(AuditEventError);
  });

  it("refuses an event that is not in the vocabulary, including names an object would answer to", () => {
    for (const action of ["member.promoted", "entry.published", "", "toString", "__proto__", "constructor", "hasOwnProperty", null, undefined, 7]) {
      expect(() => sanitizeMetadata(action, {}), String(action)).toThrow(/is not an audit event/);
    }
  });
});

describe("an event as a sentence", () => {
  const say = (action: string, metadata: unknown, actorName = "Raymund") => describeEvent({ action, actorName, metadata });

  it("says who did what, in words", () => {
    expect(say("organization.created", { name: "Acme Studio", slug: "acme-studio" })).toBe("Raymund created the organization Acme Studio.");
    expect(say("organization.updated", { previousName: "Acme", newName: "Acme Studio" })).toBe("Raymund renamed the organization from “Acme” to “Acme Studio”.");
    expect(say("organization.updated", { previousSlug: "acme", newSlug: "acme-studio" })).toBe("Raymund changed the organization’s URL from /acme to /acme-studio.");
    expect(say("organization.updated", { previousName: "Acme", newName: "Acme Studio", previousSlug: "acme", newSlug: "acme-studio" })).toBe(
      "Raymund renamed the organization from “Acme” to “Acme Studio” and changed the organization’s URL from /acme to /acme-studio.",
    );
    expect(say("organization.ownership_transferred", { newOwnerName: "Jane" })).toBe("Raymund transferred ownership to Jane.");
    expect(say("member.invited", { email: "john@example.com", role: "author" })).toBe("Raymund invited john@example.com as an Author.");
    expect(say("member.invited", { email: "john@example.com", role: "viewer" })).toBe("Raymund invited john@example.com as a Viewer.");
    expect(say("invitation.resent", { email: "john@example.com" })).toBe("Raymund sent the invitation to john@example.com again.");
    expect(say("invitation.revoked", { email: "john@example.com" })).toBe("Raymund revoked the invitation to john@example.com.");
    expect(say("invitation.accepted", { role: "editor" }, "John")).toBe("John accepted an invitation and joined as an Editor.");
    expect(say("invitation.accepted", { role: "viewer", alreadyMember: true }, "John")).toBe("John accepted an invitation, and was already a member.");
    expect(say("member.role_changed", { memberName: "Jane", previousRole: "author", newRole: "editor" })).toBe("Raymund changed Jane’s role from Author to Editor.");
    expect(say("member.removed", { memberName: "Jane", role: "viewer" })).toBe("Raymund removed Jane from the organization.");
    expect(say("member.left", { role: "admin" }, "Jane")).toBe("Jane left the organization.");
    expect(say("site.created", { name: "Acme Bakery", address: "acme" })).toBe("Raymund created the site Acme Bakery at /s/acme.");
    expect(say("site.address_changed", { name: "Acme Bakery", previousAddress: "acme", newAddress: "acme-bakery" })).toBe(
      "Raymund moved the site Acme Bakery from /s/acme to /s/acme-bakery.",
    );
    expect(say("site.deleted", { name: "Acme Bakery", address: "acme-bakery" })).toBe("Raymund deleted the site Acme Bakery, which was at /s/acme-bakery.");
  });

  it.each(AUDIT_ACTIONS)("%s: a sentence, with a subject and a full stop, for its sample", (action) => {
    const sentence = say(action, SAMPLES[action]);
    expect(sentence).toMatch(/^Raymund .+\.$/);
    expect(sentence).not.toMatch(/undefined|null|\[object|NaN/);
  });

  it("an event whose stored details cannot be read is still told, without them", () => {
    for (const action of AUDIT_ACTIONS) {
      for (const damaged of [{}, null, "text", { unexpected: true }, []]) {
        const sentence = say(action, action === "member.left" && damaged !== null && typeof damaged === "object" ? { role: 7 } : damaged);
        expect(sentence, `${action} ${JSON.stringify(damaged)}`).toMatch(/^Raymund [a-z].+\.$/);
        expect(sentence).not.toMatch(/undefined|null|\[object/);
      }
    }
    expect(say("member.role_changed", {})).toBe("Raymund changed a member’s role.");
    expect(say("member.invited", { email: 5 })).toBe("Raymund invited someone.");
  });

  it("an event this code does not know is named, not hidden; an actor with no name is 'Someone'", () => {
    expect(say("entry.published", { type: "post" })).toBe("Raymund did something Forge cannot describe yet (entry.published).");
    expect(say("member.left", { role: "viewer" }, "")).toBe("Someone left the organization.");
    expect(say("member.left", { role: "viewer" }, "   ")).toBe("Someone left the organization.");
  });

  it("puts nothing in a sentence that the event's own details do not name", () => {
    const loud = { memberName: "Jane", previousRole: "author", newRole: "editor", token: "tok_secret", ip: "203.0.113.9", requestId: "req-1", organizationId: "0199a000-0000-7000-8000-00000000000a" };
    const sentence = say("member.role_changed", loud);
    for (const hidden of ["tok_secret", "203.0.113.9", "req-1", "0199a000"]) expect(sentence).not.toContain(hidden);
  });
});

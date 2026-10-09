import { z } from "zod";

/**
 * The audit vocabulary (D-30, plan §13; ADR 0010): every event a tenant's
 * activity log can hold, what kind of thing it is about, and exactly which
 * details may be stored with it. Pure and client-safe.
 *
 * An event is named `resource.verb`, in the past tense. To add one, add it
 * here: the writer (./record.ts) accepts nothing that is not in this table,
 * and stores no detail that the event's own schema does not name.
 *
 * Metadata answers "what changed?" and is never a copy of a row. No secret
 * belongs in it. That is not left to care: besides the schemas, any key whose
 * name looks like a secret is dropped before anything is stored.
 */

const line = (max = 200) => z.string().trim().min(1).max(max);
/** A role, as its key (`editor`). The activity page turns it into a word. */
const role = z.string().regex(/^[a-z_]{3,30}$/);
const email = line(254);
const slug = line(63);
/** A site's public address: the label in `/s/{address}` (ADR 0006). */
const address = line(63);
/** A theme's key (`studio`). The activity page turns it into a word. */
const themeKey = z.string().regex(/^[a-z][a-z0-9-]{0,39}$/);

export const AUDIT_EVENTS = {
  "organization.created": {
    resourceType: "organization",
    label: "Organization created",
    metadata: z.object({ name: line(), slug }),
  },
  "organization.updated": {
    resourceType: "organization",
    label: "Organization updated",
    // Only what changed: a rename, a new URL, or both.
    metadata: z
      .object({ previousName: line().optional(), newName: line().optional(), previousSlug: slug.optional(), newSlug: slug.optional() })
      .refine((m) => (m.previousName !== undefined && m.newName !== undefined) || (m.previousSlug !== undefined && m.newSlug !== undefined), {
        message: "organization.updated needs a previous and a new name, or a previous and a new slug",
      }),
  },
  "organization.ownership_transferred": {
    resourceType: "organization",
    label: "Ownership transferred",
    metadata: z.object({ newOwnerName: line() }),
  },
  "member.invited": {
    resourceType: "invitation",
    label: "Member invited",
    metadata: z.object({ email, role }),
  },
  "invitation.resent": {
    resourceType: "invitation",
    label: "Invitation sent again",
    metadata: z.object({ email }),
  },
  "invitation.revoked": {
    resourceType: "invitation",
    label: "Invitation revoked",
    metadata: z.object({ email }),
  },
  "invitation.accepted": {
    resourceType: "invitation",
    label: "Invitation accepted",
    // `alreadyMember`: the invitation was used up by someone who had joined another way; their role did not change.
    metadata: z.object({ role, alreadyMember: z.literal(true).optional() }),
  },
  "member.role_changed": {
    resourceType: "membership",
    label: "Role changed",
    metadata: z.object({ memberName: line(), previousRole: role, newRole: role }),
  },
  "member.removed": {
    resourceType: "membership",
    label: "Member removed",
    metadata: z.object({ memberName: line(), role }),
  },
  "member.left": {
    resourceType: "membership",
    label: "Member left",
    metadata: z.object({ role }),
  },
  // Sites (M4-1, ADR 0011). The site's name is stored with each, so the line still reads after a rename or a deletion.
  "site.created": {
    resourceType: "site",
    label: "Site created",
    metadata: z.object({ name: line(), address }),
  },
  "site.address_changed": {
    resourceType: "site",
    label: "Site address changed",
    metadata: z.object({ name: line(), previousAddress: address, newAddress: address }),
  },
  "site.deleted": {
    resourceType: "site",
    label: "Site deleted",
    metadata: z.object({ name: line(), address }),
  },
  // M4-4 (ADR 0012).
  "site.theme_changed": {
    resourceType: "site",
    label: "Theme changed",
    metadata: z.object({ name: line(), previousTheme: themeKey, newTheme: themeKey }),
  },
} as const;

export type AuditAction = keyof typeof AUDIT_EVENTS;
export const AUDIT_ACTIONS = Object.keys(AUDIT_EVENTS) as AuditAction[];
export type AuditResourceType = (typeof AUDIT_EVENTS)[AuditAction]["resourceType"];
export type AuditMetadata<A extends AuditAction> = z.input<(typeof AUDIT_EVENTS)[A]["metadata"]>;

/** What a service hands the writer. Who did it, and in which organization, is not in here: see ./record.ts. */
export type AuditEntry = {
  [A in AuditAction]: {
    action: A;
    resourceType: (typeof AUDIT_EVENTS)[A]["resourceType"];
    /** The id of the organization, membership, invitation or site the event is about. */
    resourceId: string;
    /** The site the event belongs to, for the activity page's site filter. Only site-level events have one. */
    siteId?: string;
    metadata: AuditMetadata<A>;
  };
}[AuditAction];

export const isAuditAction = (value: unknown): value is AuditAction => typeof value === "string" && Object.hasOwn(AUDIT_EVENTS, value);

/** An entry the writer refuses. A fault in the calling code, never something a user caused. */
export class AuditEventError extends Error {
  override readonly name = "AuditEventError";
}

/** Names that have no business in an audit row, whatever the event. */
const SECRET_KEY = /pass(word)?|secret|token|hash|authori[sz]ation|cookie|api[-_]?key|session|credential/i;

/** Removes every key that is named like a secret, at any depth. */
export function withoutSecrets(value: unknown, depth = 0): unknown {
  if (depth > 5 || value === null || typeof value !== "object") return value;
  if (Array.isArray(value)) return value.slice(0, 50).map((item) => withoutSecrets(item, depth + 1));
  return Object.fromEntries(
    Object.entries(value)
      .filter(([key]) => !SECRET_KEY.test(key))
      .map(([key, inner]) => [key, withoutSecrets(inner, depth + 1)]),
  );
}

/**
 * What is stored for an event: the details its schema names, checked, and
 * nothing else. Unknown keys are left out; a missing or malformed detail, or an
 * unknown action, throws. The caller's transaction then rolls back: a change
 * is not committed with a broken record of it.
 */
export function sanitizeMetadata(action: unknown, metadata: unknown): Record<string, unknown> {
  if (!isAuditAction(action)) throw new AuditEventError(`"${String(action)}" is not an audit event (modules/audit/events.ts)`);
  const parsed = AUDIT_EVENTS[action].metadata.safeParse(withoutSecrets(metadata ?? {}));
  if (!parsed.success) {
    const where = parsed.error.issues.map((issue) => issue.path.join(".") || issue.message).join(", ");
    throw new AuditEventError(`Invalid metadata for audit event "${action}": ${where}`);
  }
  // Drop what was optional and absent, so a stored row has no `undefined` or empty noise in it.
  return Object.fromEntries(Object.entries(parsed.data).filter(([, value]) => value !== undefined));
}

// ── Reading: an event as a sentence ──────────────────────────────────────────

/** `editor` → `Editor`. Roles are stored as keys; this is all the activity page needs to show one. */
const word = (key: unknown) => (typeof key === "string" && key ? `${key[0]!.toUpperCase()}${key.slice(1).replaceAll("_", " ")}` : "another role");
const article = (label: string) => (/^[AEIOU]/.test(label) ? "an" : "a");

type Details<A extends AuditAction> = z.output<(typeof AUDIT_EVENTS)[A]["metadata"]>;
const SENTENCES: { [A in AuditAction]: (actor: string, m: Details<A>) => string } = {
  "organization.created": (actor, m) => `${actor} created the organization ${m.name}.`,
  "organization.updated": (actor, m) => {
    const renamed = m.previousName !== undefined && m.newName !== undefined ? `renamed the organization from “${m.previousName}” to “${m.newName}”` : null;
    const moved = m.previousSlug !== undefined && m.newSlug !== undefined ? `changed the organization’s URL from /${m.previousSlug} to /${m.newSlug}` : null;
    return `${actor} ${[renamed, moved].filter(Boolean).join(" and ")}.`;
  },
  "organization.ownership_transferred": (actor, m) => `${actor} transferred ownership to ${m.newOwnerName}.`,
  "member.invited": (actor, m) => `${actor} invited ${m.email} as ${article(word(m.role))} ${word(m.role)}.`,
  "invitation.resent": (actor, m) => `${actor} sent the invitation to ${m.email} again.`,
  "invitation.revoked": (actor, m) => `${actor} revoked the invitation to ${m.email}.`,
  "invitation.accepted": (actor, m) =>
    m.alreadyMember ? `${actor} accepted an invitation, and was already a member.` : `${actor} accepted an invitation and joined as ${article(word(m.role))} ${word(m.role)}.`,
  "member.role_changed": (actor, m) => `${actor} changed ${m.memberName}’s role from ${word(m.previousRole)} to ${word(m.newRole)}.`,
  "member.removed": (actor, m) => `${actor} removed ${m.memberName} from the organization.`,
  "member.left": (actor) => `${actor} left the organization.`,
  "site.created": (actor, m) => `${actor} created the site ${m.name} at /s/${m.address}.`,
  "site.address_changed": (actor, m) => `${actor} moved the site ${m.name} from /s/${m.previousAddress} to /s/${m.newAddress}.`,
  "site.deleted": (actor, m) => `${actor} deleted the site ${m.name}, which was at /s/${m.address}.`,
  "site.theme_changed": (actor, m) => `${actor} changed the theme of ${m.name} from ${word(m.previousTheme)} to ${word(m.newTheme)}.`,
};

/** For a row whose details cannot be read (written by other code, or damaged): what happened, without the details. */
const PLAIN: Record<AuditAction, string> = {
  "organization.created": "created the organization",
  "organization.updated": "changed the organization",
  "organization.ownership_transferred": "transferred ownership",
  "member.invited": "invited someone",
  "invitation.resent": "sent an invitation again",
  "invitation.revoked": "revoked an invitation",
  "invitation.accepted": "accepted an invitation",
  "member.role_changed": "changed a member’s role",
  "member.removed": "removed a member",
  "member.left": "left the organization",
  "site.created": "created a site",
  "site.address_changed": "changed a site’s address",
  "site.deleted": "deleted a site",
  "site.theme_changed": "changed a site’s theme",
};

/**
 * One line of the activity page. Built from the stored event and nothing else:
 * no id, no address of the request, nothing the event's schema does not name.
 * An event this code does not know is shown as its name, not hidden.
 */
export function describeEvent(event: { action: string; actorName: string; metadata: unknown }): string {
  const actor = event.actorName.trim() || "Someone";
  if (!isAuditAction(event.action)) return `${actor} did something Forge cannot describe yet (${event.action}).`;
  const parsed = AUDIT_EVENTS[event.action].metadata.safeParse(withoutSecrets(event.metadata ?? {}));
  if (!parsed.success) return `${actor} ${PLAIN[event.action]}.`;
  return (SENTENCES[event.action] as (actor: string, m: unknown) => string)(actor, parsed.data);
}

/** The name of an event for a list of filters. */
export const eventLabel = (action: string): string => (isAuditAction(action) ? AUDIT_EVENTS[action].label : action);

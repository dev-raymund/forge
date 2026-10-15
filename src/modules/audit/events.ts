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
/** An entry's type, and its path on its site (`/` or `/segment/…`: the `entries_path_format` rule). */
const entryType = z.enum(["page", "post"]);
const entryPath = z.string().max(2048).regex(/^(\/|(\/[a-z0-9]+(-[a-z0-9]+)*)+)$/);
/** A category or a tag, and its slug (the `terms_slug_format` rule). */
const taxonomy = z.enum(["category", "tag"]);
const termSlug = z.string().max(100).regex(/^[a-z0-9]+(-[a-z0-9]+)*$/);
/** A media item's kind (M6). */
const mediaKind = z.enum(["image", "document"]);

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
  // M4-2 (ADR 0014): which settings changed, by name. Never their values: the settings page shows those.
  "site.settings_changed": {
    resourceType: "site",
    label: "Site settings changed",
    metadata: z.object({ name: line(), group: z.enum(["general", "reading", "analytics", "images"]), fields: z.array(z.string().regex(/^[a-z][a-zA-Z0-9]{0,39}$/)).min(1).max(20) }),
  },
  // M4-5 (ADR 0015): publishing, and back to Coming soon.
  "site.status_changed": {
    resourceType: "site",
    label: "Site status changed",
    // Only the two statuses a member may move between: a suspended site is refused before anything is recorded.
    metadata: z.object({ name: line(), previousStatus: z.enum(["coming_soon", "live"]), newStatus: z.enum(["coming_soon", "live"]) }),
  },
  // M5-3 (ADR 0016): entries, and the site's home page.
  "entry.created": {
    resourceType: "entry",
    label: "Entry created",
    metadata: z.object({ type: entryType, title: line(), path: entryPath }),
  },
  "entry.published": {
    resourceType: "entry",
    label: "Entry published",
    metadata: z.object({ type: entryType, title: line(), path: entryPath, revision: z.int().min(1) }),
  },
  "site.homepage_changed": {
    resourceType: "site",
    label: "Home page changed",
    metadata: z.object({ name: line(), title: line(), previousTitle: line().optional() }),
  },
  // M5-7: the page tree and authorship.
  "entry.moved": {
    resourceType: "entry",
    label: "Page moved",
    // Under which page now (none: the top level), and the address it had and has (the same when only its parent changed, like the Home page's).
    metadata: z.object({ type: entryType, title: line(), parentTitle: line().optional(), from: entryPath, to: entryPath }),
  },
  "entry.reordered": {
    resourceType: "entry",
    label: "Page reordered",
    metadata: z.object({ type: entryType, title: line(), position: z.int().min(1), of: z.int().min(1) }),
  },
  "entry.author_changed": {
    resourceType: "entry",
    label: "Author changed",
    metadata: z.object({ type: entryType, title: line(), authorName: line(), previousAuthorName: line().optional() }),
  },
  // M7-1 (ADR 0024): the lifecycle. `below`: the pages that went (or came back, or were deleted) with it.
  "entry.unpublished": {
    resourceType: "entry",
    label: "Entry unpublished",
    metadata: z.object({ type: entryType, title: line(), path: entryPath }),
  },
  "entry.trashed": {
    resourceType: "entry",
    label: "Entry moved to the trash",
    metadata: z.object({ type: entryType, title: line(), path: entryPath, below: z.int().min(0).max(100_000) }),
  },
  "entry.restored": {
    resourceType: "entry",
    label: "Entry restored",
    metadata: z.object({ type: entryType, title: line(), path: entryPath, below: z.int().min(0).max(100_000) }),
  },
  "entry.deleted": {
    resourceType: "entry",
    label: "Entry deleted for good",
    metadata: z.object({ type: entryType, title: line(), path: entryPath, below: z.int().min(0).max(100_000) }),
  },
  // M5-8: categories and tags.
  "term.created": {
    resourceType: "term",
    label: "Category or tag created",
    metadata: z.object({ taxonomy, name: line(), slug: termSlug }),
  },
  "term.updated": {
    resourceType: "term",
    label: "Category or tag changed",
    // Which details changed, by name; the old name and slug when they changed (a renamed archive, M8-5's redirect).
    metadata: z.object({
      taxonomy, name: line(), slug: termSlug, fields: z.array(z.enum(["name", "slug", "description", "parent"])).min(1).max(4),
      previousName: line().optional(), previousSlug: termSlug.optional(),
    }),
  },
  "term.deleted": {
    resourceType: "term",
    label: "Category or tag deleted",
    // What it was on: published posts, and drafts it was taken out of.
    metadata: z.object({ taxonomy, name: line(), slug: termSlug, posts: z.int().min(0), drafts: z.int().min(0) }),
  },
  // M6-1: an upload accepted (its file checked). Requested uploads are reservations, not activity; refused ones leave nothing.
  "media.uploaded": {
    resourceType: "media",
    label: "File uploaded",
    metadata: z.object({ kind: mediaKind, filename: line(255), sizeBytes: z.int().min(1) }),
  },
  // M6-3: the library. A file's details, its folder, the trash; the folders themselves.
  "media.updated": {
    resourceType: "media",
    label: "File details changed",
    metadata: z.object({ kind: mediaKind, filename: line(255), fields: z.array(z.enum(["title", "alt", "caption"])).min(1).max(3) }),
  },
  "media.moved": {
    resourceType: "media",
    label: "File moved",
    // A folder's name; none for "All media" (no folder).
    metadata: z.object({ kind: mediaKind, filename: line(255), folderName: line(100).optional(), previousFolderName: line(100).optional() }),
  },
  "media.trashed": {
    resourceType: "media",
    label: "File trashed",
    metadata: z.object({ kind: mediaKind, filename: line(255) }),
  },
  "media.restored": {
    resourceType: "media",
    label: "File restored",
    metadata: z.object({ kind: mediaKind, filename: line(255) }),
  },
  "media.folder_created": {
    resourceType: "media_folder",
    label: "Folder created",
    metadata: z.object({ name: line(100) }),
  },
  "media.folder_renamed": {
    resourceType: "media_folder",
    label: "Folder renamed",
    metadata: z.object({ name: line(100), previousName: line(100) }),
  },
  "media.folder_deleted": {
    resourceType: "media_folder",
    label: "Folder deleted",
    metadata: z.object({ name: line(100) }),
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
/** A settings field's key as words: `postsPerPage` → `posts per page`, `ga4MeasurementId` → `GA4 measurement ID`. */
const FIELD_WORDS: Record<string, string> = {
  ga4MeasurementId: "GA4 measurement ID", plausibleDomain: "Plausible domain",
  // M6-4: the "images" group.
  logo: "logo", favicon: "favicon",
  facebook: "Facebook", instagram: "Instagram", x: "X", linkedin: "LinkedIn", youtube: "YouTube", tiktok: "TikTok",
};
const withBelow = (below: number) => (below ? `, with ${below} ${below === 1 ? "page" : "pages"} below it` : "");
const fieldWord = (key: string) => FIELD_WORDS[key] ?? key.replace(/([A-Z])/g, " $1").toLowerCase();

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
  "site.settings_changed": (actor, m) => `${actor} changed the ${m.group === "images" ? "image" : m.group} settings of ${m.name}: ${m.fields.map(fieldWord).join(", ")}.`,
  "site.status_changed": (actor, m) =>
    m.newStatus === "live" ? `${actor} published the site ${m.name}.` : `${actor} switched the site ${m.name} back to Coming soon.`,
  "entry.created": (actor, m) => `${actor} created the ${m.type} ${m.title} at ${m.path}.`,
  "entry.published": (actor, m) => `${actor} published the ${m.type} ${m.title} at ${m.path}.`,
  "site.homepage_changed": (actor, m) =>
    m.previousTitle ? `${actor} made ${m.title} the home page of ${m.name}, in place of ${m.previousTitle}.` : `${actor} made ${m.title} the home page of ${m.name}.`,
  "entry.moved": (actor, m) =>
    `${actor} moved the ${m.type} ${m.title} ${m.parentTitle ? `under ${m.parentTitle}` : "to the top level"}${m.from === m.to ? "" : `, from ${m.from} to ${m.to}`}.`,
  "entry.reordered": (actor, m) => `${actor} moved the ${m.type} ${m.title} to position ${m.position} of ${m.of}.`,
  "entry.author_changed": (actor, m) =>
    m.previousAuthorName ? `${actor} made ${m.authorName} the author of the ${m.type} ${m.title}, in place of ${m.previousAuthorName}.` : `${actor} made ${m.authorName} the author of the ${m.type} ${m.title}.`,
  "entry.unpublished": (actor, m) => `${actor} unpublished the ${m.type} ${m.title}, which was at ${m.path}.`,
  "entry.trashed": (actor, m) => `${actor} moved the ${m.type} ${m.title} to the trash${withBelow(m.below)}.`,
  "entry.restored": (actor, m) => `${actor} restored the ${m.type} ${m.title} from the trash, at ${m.path}${withBelow(m.below)}.`,
  "entry.deleted": (actor, m) => `${actor} deleted the ${m.type} ${m.title} for good${withBelow(m.below)}.`,
  "term.created": (actor, m) => `${actor} created the ${m.taxonomy} ${m.name}.`,
  "term.updated": (actor, m) =>
    m.previousName && m.previousName !== m.name
      ? `${actor} renamed the ${m.taxonomy} ${m.previousName} to ${m.name}${m.previousSlug ? `, with the slug ${m.slug} instead of ${m.previousSlug}` : ""}.`
      : `${actor} changed the ${m.taxonomy} ${m.name}: ${m.fields.join(", ")}.`,
  "term.deleted": (actor, m) => `${actor} deleted the ${m.taxonomy} ${m.name}, which was on ${m.posts} published ${m.posts === 1 ? "post" : "posts"} and ${m.drafts} ${m.drafts === 1 ? "draft" : "drafts"}.`,
  "media.uploaded": (actor, m) => `${actor} uploaded the ${m.kind === "image" ? "image" : "PDF"} ${m.filename}.`,
  "media.updated": (actor, m) => `${actor} changed the ${m.kind === "image" ? "image" : "PDF"} ${m.filename}: ${m.fields.map((f) => (f === "alt" ? "alternative text" : f)).join(", ")}.`,
  "media.moved": (actor, m) =>
    `${actor} moved the ${m.kind === "image" ? "image" : "PDF"} ${m.filename} ${m.folderName ? `to the folder ${m.folderName}` : "out of its folder"}${m.previousFolderName && m.folderName ? `, from ${m.previousFolderName}` : ""}.`,
  "media.trashed": (actor, m) => `${actor} moved the ${m.kind === "image" ? "image" : "PDF"} ${m.filename} to the trash.`,
  "media.restored": (actor, m) => `${actor} restored the ${m.kind === "image" ? "image" : "PDF"} ${m.filename} from the trash.`,
  "media.folder_created": (actor, m) => `${actor} created the media folder ${m.name}.`,
  "media.folder_renamed": (actor, m) => `${actor} renamed the media folder ${m.previousName} to ${m.name}.`,
  "media.folder_deleted": (actor, m) => `${actor} deleted the media folder ${m.name}.`,
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
  "site.settings_changed": "changed a site’s settings",
  "site.status_changed": "changed a site’s status",
  "entry.created": "created a page or post",
  "entry.published": "published a page or post",
  "site.homepage_changed": "changed a site’s home page",
  "entry.moved": "moved a page",
  "entry.reordered": "reordered a page",
  "entry.author_changed": "changed an author",
  "entry.unpublished": "unpublished a page or post",
  "entry.trashed": "moved a page or post to the trash",
  "entry.restored": "restored a page or post",
  "entry.deleted": "deleted a page or post for good",
  "term.created": "created a category or tag",
  "term.updated": "changed a category or tag",
  "term.deleted": "deleted a category or tag",
  "media.uploaded": "uploaded a file",
  "media.updated": "changed a file's details",
  "media.moved": "moved a file",
  "media.trashed": "trashed a file",
  "media.restored": "restored a file",
  "media.folder_created": "created a media folder",
  "media.folder_renamed": "renamed a media folder",
  "media.folder_deleted": "deleted a media folder",
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

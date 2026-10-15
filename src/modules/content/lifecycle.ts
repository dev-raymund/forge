/**
 * An entry's lifecycle (M7-1; plan §9; cms-architecture §16.1): its status (`draft`, `scheduled`, `published`) and,
 * orthogonal to it, the trash (`deleted_at`). Every action is a transition from one state to another, allowed or
 * refused with the reason a person is told, and each names the right it takes. Pure and client-safe: the services
 * ask it before they write, and the screens ask it which actions to offer.
 *
 *   from                 action            to                  right
 *   draft                publish           published           publish
 *   published            publish           published           publish     (publish changes)
 *   published            unpublish         draft               publish
 *   draft                schedule          scheduled           publish     (M7-2)
 *   scheduled            cancel_schedule   draft               publish     (M7-2)
 *   draft                trash             draft, trashed      delete
 *   trashed              restore           draft               delete      (never republished)
 *   trashed              purge             (gone)              delete_any  (by hand; the daily job purges after 30 days)
 *
 * Refused: trashing a published or scheduled entry (unpublish, or cancel the schedule, first: M7-1 keeps them apart),
 * anything but restore and purge in the trash, restore and purge outside it.
 */

export const LIFECYCLE_STATUSES = ["draft", "scheduled", "published"] as const;
export type LifecycleStatus = (typeof LIFECYCLE_STATUSES)[number];
export type LifecycleState = { status: LifecycleStatus; trashed: boolean };

export const LIFECYCLE_ACTIONS = ["publish", "unpublish", "schedule", "cancel_schedule", "trash", "restore", "purge"] as const;
export type LifecycleAction = (typeof LIFECYCLE_ACTIONS)[number];

/** The right an action takes: the type's publish right, its delete right (own or any), or its delete-any right. */
export type LifecycleRight = "publish" | "delete" | "delete_any";

export type Transition = { ok: true; to: LifecycleState | null; right: LifecycleRight } | { ok: false; reason: string };

const RIGHTS: Record<LifecycleAction, LifecycleRight> = {
  publish: "publish",
  unpublish: "publish",
  schedule: "publish",
  cancel_schedule: "publish",
  trash: "delete",
  restore: "delete",
  purge: "delete_any",
};

export const IN_TRASH = "It is in the trash. Restore it first.";
export const PUBLISHED_TO_TRASH = "It is published. Unpublish it first, then move it to the trash.";
export const SCHEDULED_TO_TRASH = "It is scheduled. Cancel the schedule first, then move it to the trash.";
export const NOT_PUBLISHED = "It is not published.";
export const NOT_IN_TRASH = "It is not in the trash.";

const draft: LifecycleState = { status: "draft", trashed: false };
const ok = (to: LifecycleState | null, action: LifecycleAction): Transition => ({ ok: true, to, right: RIGHTS[action] });
const no = (reason: string): Transition => ({ ok: false, reason });

export function transition(from: LifecycleState, action: LifecycleAction): Transition {
  if (from.trashed) {
    if (action === "restore") return ok(draft, action);
    if (action === "purge") return ok(null, action);
    return no(IN_TRASH);
  }
  switch (action) {
    case "publish":
      return from.status === "scheduled" ? no("It is scheduled. Cancel the schedule first.") : ok({ status: "published", trashed: false }, action);
    case "unpublish":
      return from.status === "published" ? ok(draft, action) : no(NOT_PUBLISHED);
    case "schedule":
      return from.status === "draft" ? ok({ status: "scheduled", trashed: false }, action) : no(from.status === "published" ? "It is published." : "It is already scheduled.");
    case "cancel_schedule":
      return from.status === "scheduled" ? ok(draft, action) : no("It is not scheduled.");
    case "trash":
      if (from.status === "published") return no(PUBLISHED_TO_TRASH);
      if (from.status === "scheduled") return no(SCHEDULED_TO_TRASH);
      return ok({ status: "draft", trashed: true }, action);
    case "restore":
    case "purge":
      return no(action === "restore" ? NOT_IN_TRASH : "Move it to the trash first.");
  }
}

/** The state of a stored entry: its status (a value the CHECK allows) and whether it is in the trash. */
export const stateOf = (entry: { status: string; deletedAt: Date | null }): LifecycleState => ({
  status: (LIFECYCLE_STATUSES as readonly string[]).includes(entry.status) ? (entry.status as LifecycleStatus) : "draft",
  trashed: entry.deletedAt !== null,
});

/** How long an entry stays in the trash before `trash.purge` deletes it, as media does (ADR 0022). */
export const ENTRY_TRASH_DAYS = 30;

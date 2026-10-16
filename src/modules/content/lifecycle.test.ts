import { describe, expect, it } from "vitest";
import { ENTRY_TRASH_DAYS, LIFECYCLE_ACTIONS, stateOf, transition, type LifecycleAction, type LifecycleState } from "./lifecycle";

/** The entry lifecycle's transition table (M7-1, ADR 0024): every state against every action. */

const draft: LifecycleState = { status: "draft", trashed: false };
const scheduled: LifecycleState = { status: "scheduled", trashed: false };
const published: LifecycleState = { status: "published", trashed: false };
const trashed: LifecycleState = { status: "draft", trashed: true };

type Row = [string, LifecycleState, LifecycleAction, LifecycleState | null | string, string?];
const TABLE: Row[] = [
  ["draft", draft, "publish", published, "publish"],
  ["draft", draft, "unpublish", "It is not published."],
  ["draft", draft, "schedule", scheduled, "publish"],
  ["draft", draft, "cancel_schedule", "It is not scheduled."],
  ["draft", draft, "trash", trashed, "delete"],
  ["draft", draft, "restore", "It is not in the trash."],
  ["draft", draft, "purge", "Move it to the trash first."],
  ["published", published, "publish", published, "publish"],
  ["published", published, "unpublish", draft, "publish"],
  ["published", published, "schedule", "It is published."],
  ["published", published, "cancel_schedule", "It is not scheduled."],
  ["published", published, "trash", "It is published. Unpublish it first, then move it to the trash."],
  ["published", published, "restore", "It is not in the trash."],
  ["published", published, "purge", "Move it to the trash first."],
  ["scheduled", scheduled, "publish", "It is scheduled. Cancel the schedule first."],
  ["scheduled", scheduled, "unpublish", "It is not published."],
  ["scheduled", scheduled, "schedule", "It is already scheduled."],
  ["scheduled", scheduled, "cancel_schedule", draft, "publish"],
  ["scheduled", scheduled, "reschedule", scheduled, "publish"],
  ["scheduled", scheduled, "publish_scheduled", published, "system"],
  ["draft", draft, "reschedule", "It is not scheduled."],
  ["draft", draft, "publish_scheduled", "It is not scheduled."],
  ["published", published, "reschedule", "It is not scheduled."],
  ["published", published, "publish_scheduled", "It is not scheduled."],
  ["scheduled", scheduled, "trash", "It is scheduled. Cancel the schedule first, then move it to the trash."],
  ["trashed", trashed, "restore", draft, "delete"],
  ["trashed", trashed, "purge", null, "delete_any"],
  ...(["publish", "unpublish", "schedule", "reschedule", "cancel_schedule", "publish_scheduled", "trash"] as const).map(
    (action): Row => ["trashed", trashed, action, "It is in the trash. Restore it first."],
  ),
];

describe("the transition table", () => {
  it.each(TABLE)("%s · %s", (_name, from, action, expected, right) => {
    const step = transition(from, action);
    if (typeof expected === "string") expect(step).toEqual({ ok: false, reason: expected });
    else expect(step).toEqual({ ok: true, to: expected, right });
  });

  it("covers every action from every state", () => {
    for (const from of [draft, scheduled, published, trashed]) {
      for (const action of LIFECYCLE_ACTIONS) {
        if (from === scheduled && (action === "restore" || action === "purge")) continue; // as for draft and published
        expect(TABLE.some(([, state, a]) => state === from && a === action), `${JSON.stringify(from)} ${action}`).toBe(true);
      }
    }
  });

  it("a trashed entry restored is a draft: never published again by restoring", () => {
    expect(transition({ status: "published", trashed: true }, "restore")).toMatchObject({ ok: true, to: { status: "draft", trashed: false } });
  });
});

describe("the state of a stored entry", () => {
  it("is its status and whether it is in the trash; an unknown status reads as a draft", () => {
    expect(stateOf({ status: "published", deletedAt: null })).toEqual(published);
    expect(stateOf({ status: "draft", deletedAt: new Date() })).toEqual(trashed);
    expect(stateOf({ status: "archived", deletedAt: null })).toEqual(draft);
  });

  it("stays in the trash for 30 days, as media does", () => {
    expect(ENTRY_TRASH_DAYS).toBe(30);
  });
});

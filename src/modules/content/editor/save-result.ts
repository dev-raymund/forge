import type { FormState } from "@/platform/forms";
import { DRAFT_CHANGED } from "../messages";
import type { SaveResult } from "./autosave";

/**
 * The save action's answer (a form state, M5-3) as the autosave controller
 * reads it. A success carries the new version; a version mismatch is the
 * service's `DRAFT_CHANGED` Conflict; field errors are content the server
 * refused; anything else (a lost connection, a server error) is thrown, so
 * the controller keeps the change and tries again.
 */
export function saveResultOf(state: FormState): SaveResult {
  if (state.status === "success") {
    const version = Number(state.values?.version);
    if (Number.isInteger(version) && version > 0) return { ok: true, version };
    throw new Error("The save answered without a version.");
  }
  if (state.message === DRAFT_CHANGED) return { ok: false, reason: "conflict" };
  if (state.fieldErrors && Object.keys(state.fieldErrors).length) {
    return { ok: false, reason: "invalid", issues: Object.values(state.fieldErrors).flat() };
  }
  throw new Error(state.message ?? "The draft could not be saved.");
}

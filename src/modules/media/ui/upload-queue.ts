import { checkFile, MAX_FILES_PER_REQUEST } from "../policy";

/**
 * The dropzone's queue (M6-3), without React: what each file is doing, and what a retry may do next. Pure, so every
 * outcome and every retry is tested without a browser (upload-queue.test.ts).
 *
 * A file goes: checked here (a warning only; the server decides) → requested (in a request of at most 20: all or
 * nothing) → sent to its storage target (progress) → completed (checked, and an image processed, on the server) →
 * ready. Only the server's completion makes it ready.
 *
 * What a retry may do, by where it stopped:
 *   request refused or failed      ask again for this file alone: nothing was reserved for it
 *   send failed, link still valid  send again to the same link (it creates the file once: a second copy is refused
 *                                  with 412, which means it is there) and complete
 *   send failed, link expired      ask again: a new upload (the server has no way to renew a link; the earlier one
 *                                  holds its reserved bytes until `uploads.cleanup`, 24 hours later)
 *   completion: not there yet, or  send again while the link is valid (412 = it is there), then complete; after
 *   still being finished           the link expired, complete once more, then ask again
 *   completion unavailable         complete again (still pending on the server)
 *   completion refused (the file   nothing: the server deleted it; the message says why
 *   or the storage limit)
 */

export type Target = { method: "PUT"; url: string; headers: Record<string, string>; expiresAt: string };

export type UploadStep = "check" | "request" | "send" | "complete";
export type UploadStatus = "waiting" | "requesting" | "sending" | "finishing" | "ready" | "failed" | "refused";

export type QueueItem = {
  key: string;
  name: string;
  size: number;
  type: string;
  kind: "image" | "document" | null;
  status: UploadStatus;
  /** 0–1 while sending. */
  progress: number;
  message?: string;
  mediaId?: string;
  target?: Target;
  /** What a retry does now, or nothing (refused, or ready). */
  retry?: "request" | "send" | "complete";
};

export type ActionAnswer<T> = { ok: true; data: T } | { ok: false; error: string; code: string; fieldErrors?: Record<string, string[]> };

/** Ending a link's use this long before it expires: a send started later could not finish in time. */
export const LINK_MARGIN_MS = 30_000;
export const linkValid = (target: Target | undefined, now = Date.now()) => !!target && new Date(target.expiresAt).getTime() - LINK_MARGIN_MS > now;

/** A new item for a chosen file, checked here first (the same rules the server applies; it decides anyway). */
export function itemOf(file: { name: string; size: number; type: string }, key: string): QueueItem {
  const checked = checkFile(file);
  if (!checked.ok) return { key, name: file.name, size: file.size, type: file.type, kind: null, status: "refused", progress: 0, message: checked.message };
  return { key, name: checked.file.name, size: file.size, type: checked.file.mimeType, kind: checked.file.type.kind, status: "waiting", progress: 0 };
}

/** The requests a set of waiting files is sent in: at most 20 each, each its own all-or-nothing request. */
export function batchesOf<T>(items: readonly T[], size = MAX_FILES_PER_REQUEST): T[][] {
  const batches: T[][] = [];
  for (let i = 0; i < items.length; i += size) batches.push(items.slice(i, i + size));
  return batches;
}

/** What the person is told for a refusal or a failure, by its kind. The server's own message when it gives one. */
export function messageFor(step: "request" | "complete", answer: { error: string; code: string }): string {
  switch (answer.code) {
    case "Validation":
    case "LimitExceeded":
      return answer.error;
    case "Unavailable":
      return "Storage is not answering right now. Try again in a moment.";
    case "Conflict":
      return step === "complete" ? "The file is not finished on the server yet. Try again." : answer.error;
    case "Forbidden":
      return "You can't upload to this site.";
    case "NotFound":
      return step === "complete" ? "This upload no longer exists. Upload the file again." : "This site could not be found.";
    case "Unauthenticated":
      return "Your session ended. Log in again, then upload the file.";
    default:
      return "Something went wrong, and the file was not uploaded.";
  }
}

/** The state after a request: each file gets its target, or the whole request's refusal (all or nothing). */
export function afterRequest(batch: QueueItem[], answer: ActionAnswer<{ uploads: { mediaId: string; upload: Target }[] }>): QueueItem[] {
  if (answer.ok) {
    return batch.map((item, i) => ({ ...item, status: "sending", progress: 0, message: undefined, retry: undefined, mediaId: answer.data.uploads[i]!.mediaId, target: answer.data.uploads[i]!.upload }));
  }
  const own = (i: number) => answer.fieldErrors?.[`files.${i}`]?.[0];
  const refusedHere = batch.some((_, i) => own(i));
  return batch.map((item, i) => {
    const reason = own(i);
    // The file the server refused: no retry (its own message). The others of the same request were not sent with it.
    if (reason) return { ...item, status: "refused", message: reason, retry: undefined };
    const message = refusedHere ? "Not sent: another file in the same group was refused. Try again to send this one alone." : messageFor("request", answer);
    return { ...item, status: "failed", message, retry: answer.code === "Forbidden" ? undefined : "request" };
  });
}

/** The state after a send: on to completion, or what a retry does. `status` is the storage's answer (0: no answer). */
export function afterSend(item: QueueItem, status: number, now = Date.now()): QueueItem {
  // 2xx: sent. 412: the file was already created through this link (a retry): it is there.
  if ((status >= 200 && status < 300) || status === 412) return { ...item, status: "finishing", progress: 1, message: undefined, retry: undefined };
  if (linkValid(item.target, now) && (status === 0 || status >= 500 || status === 408 || status === 429)) {
    return { ...item, status: "failed", message: "The file did not reach storage. Try again.", retry: "send" };
  }
  return { ...item, status: "failed", message: "The upload link expired or was refused. Try again to upload the file anew.", retry: "request", target: undefined };
}

/** The state after a completion. */
export function afterComplete(item: QueueItem, answer: ActionAnswer<unknown>, now = Date.now()): QueueItem {
  if (answer.ok) return { ...item, status: "ready", progress: 1, message: undefined, retry: undefined };
  switch (answer.code) {
    case "Validation":
    case "LimitExceeded":
      // Refused on the server, which deleted it. Nothing to retry; the reason says why.
      return { ...item, status: "refused", message: answer.error, retry: undefined };
    case "Conflict":
      return { ...item, status: "failed", message: messageFor("complete", answer), retry: linkValid(item.target, now) ? "send" : "complete" };
    case "Unavailable":
    case "Internal":
      return { ...item, status: "failed", message: messageFor("complete", answer), retry: "complete" };
    case "NotFound":
      return { ...item, status: "failed", message: messageFor("complete", answer), retry: "request", target: undefined, mediaId: undefined };
    default:
      return { ...item, status: "failed", message: messageFor("complete", answer), retry: undefined };
  }
}

/** A completion retried after the link expired, that is still "not there": the only way left is a new upload. */
export function afterLateConflict(item: QueueItem): QueueItem {
  return { ...item, status: "failed", message: "The file never reached storage, and its link has expired. Try again to upload it anew.", retry: "request", target: undefined, mediaId: undefined };
}

/** A short summary of the queue, for the live region: never "done" while anything is still going or failed. */
export function summaryOf(items: readonly QueueItem[]): string {
  const count = (status: UploadStatus) => items.filter((item) => item.status === status).length;
  const going = count("waiting") + count("requesting") + count("sending") + count("finishing");
  const parts = [
    going ? `${going} uploading` : null,
    count("ready") ? `${count("ready")} ready` : null,
    count("failed") ? `${count("failed")} failed` : null,
    count("refused") ? `${count("refused")} refused` : null,
  ].filter(Boolean);
  return parts.join(", ");
}

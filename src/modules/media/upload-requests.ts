import "server-only";
import type { Actor } from "@/modules/auth";
import { resolveSiteContext, type RequestMeta } from "@/modules/tenancy";
import { actionOk, asAppError, limitExceeded, toActionResult, unauthenticated, validationError, type ActionResult } from "@/platform/errors";
import { reportError } from "@/platform/observability";
import { completeAvatarUpload, requestAvatarUpload, type IssuedAvatarUpload } from "./avatar.service";
import { completeUpload, requestUploads, type IssuedUpload, type UploadedMedia } from "./upload.service";

/**
 * What the upload Server Actions do (M6-1): everything except reading the session, which ./actions.ts adds.
 *
 * Who is asking comes from the session; the organization and the site from the page's own URL (bound by it).
 * They name things and grant nothing: the resolver checks the user's membership of the organization and the site's
 * place in it on every call, and the services ask for `media.upload`. The browser's file list and media id are
 * input to check, never proof of anything.
 */

const MODULE = "media";

function failure(error: unknown, meta: RequestMeta): ActionResult<never> {
  if (!asAppError(error)) reportError(error, { module: MODULE, requestId: meta.requestId });
  return toActionResult(error, meta.requestId);
}

export async function submitRequestUploads(actor: Actor, orgSlug: string, siteSlug: string, files: unknown, meta: RequestMeta = {}): Promise<ActionResult<{ uploads: IssuedUpload[] }>> {
  try {
    const ctx = await resolveSiteContext(actor, orgSlug, siteSlug, meta);
    return actionOk(await requestUploads(ctx, files));
  } catch (error) {
    return failure(error, meta);
  }
}

/** A refused file is a failure to the browser, with its reason, never a success. */
export async function submitCompleteUpload(actor: Actor, orgSlug: string, siteSlug: string, mediaId: unknown, meta: RequestMeta = {}): Promise<ActionResult<UploadedMedia>> {
  try {
    const ctx = await resolveSiteContext(actor, orgSlug, siteSlug, meta);
    const outcome = await completeUpload(ctx, mediaId);
    if (outcome.status === "failed") {
      return toActionResult(outcome.code === "LimitExceeded" ? limitExceeded("storage", outcome.message) : validationError({ file: [outcome.message] }, outcome.message));
    }
    return actionOk(outcome.media);
  } catch (error) {
    return failure(error, meta);
  }
}

// The account avatar (M6-2): the signed-in user's own, whoever they are; no organization, no site.

const userIdOf = (actor: Actor): string => {
  if (actor.kind !== "user") throw unauthenticated();
  return actor.userId;
};

export async function submitRequestAvatarUpload(actor: Actor, file: unknown, meta: RequestMeta = {}): Promise<ActionResult<IssuedAvatarUpload>> {
  try {
    return actionOk(await requestAvatarUpload(userIdOf(actor), file));
  } catch (error) {
    return failure(error, meta);
  }
}

export async function submitCompleteAvatarUpload(actor: Actor, avatarId: unknown, meta: RequestMeta = {}): Promise<ActionResult<{ url: string }>> {
  try {
    return actionOk(await completeAvatarUpload(userIdOf(actor), avatarId));
  } catch (error) {
    return failure(error, meta);
  }
}

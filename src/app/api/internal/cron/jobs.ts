import { trashPurge } from "@/modules/content";
import { avatarsCollect, uploadsCleanup } from "@/modules/media";
import { emailSend } from "@/platform/email";
import { createJobRegistry, jobsCleanup } from "@/platform/jobs";

/**
 * The composition root for background jobs: every job type the runner can
 * execute. Modules export their definitions from their public entry point and
 * are added here as their issues land (M6-1 uploads, M6-2 avatars, M6-3
 * the trash, which M7-1 moved to the content module (entries, then media),
 * M7 scheduling, M11 billing notices, …).
 */
export const jobRegistry = createJobRegistry([jobsCleanup, emailSend, uploadsCleanup, avatarsCollect, trashPurge]);

/** Enqueued once a day by /api/internal/cron/daily. */
export const DAILY_JOBS = [jobsCleanup, uploadsCleanup, trashPurge] as const;

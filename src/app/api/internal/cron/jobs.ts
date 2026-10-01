import { emailSend } from "@/platform/email";
import { createJobRegistry, jobsCleanup } from "@/platform/jobs";

/**
 * The composition root for background jobs: every job type the runner can
 * execute. Modules export their definitions from their public entry point and
 * are added here as their issues land (M7 scheduling, M11 billing notices, …).
 */
export const jobRegistry = createJobRegistry([jobsCleanup, emailSend]);

/** Enqueued once a day by /api/internal/cron/daily. */
export const DAILY_JOBS = [jobsCleanup] as const;

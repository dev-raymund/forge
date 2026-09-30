import { createJobRegistry, jobsCleanup } from "@/platform/jobs";

/**
 * The composition root for background jobs: every job type the runner can
 * execute. Modules export their definitions from their public entry point and
 * are added here as their issues land (email.send in M1-4, domain.check in M9, …).
 */
export const jobRegistry = createJobRegistry([jobsCleanup]);

/** Enqueued once a day by /api/internal/cron/daily. */
export const DAILY_JOBS = [jobsCleanup] as const;

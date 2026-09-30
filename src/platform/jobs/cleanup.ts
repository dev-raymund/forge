import "server-only";
import { sql } from "drizzle-orm";
import { z } from "zod";
import { withPlatform } from "@/platform/db/tenant";
import { defineJob } from "./definition";

const BATCH = 5_000;

/**
 * Daily retention for the jobs table (long-term §6.9): finished jobs are kept
 * 14 days, `dead` and `failed` jobs 30 days (they are what staff investigate).
 * Idempotent: running it twice deletes nothing more.
 */
export const jobsCleanup = defineJob({
  type: "jobs.cleanup",
  scope: "platform",
  payload: z.object({}),
  run: async (_payload, ctx) => {
    let deleted = 0;
    for (;;) {
      const { rows } = await withPlatform((tx) =>
        tx.execute<{ id: string }>(sql`
          delete from jobs where id in (
            select id from jobs
            where (status in ('succeeded', 'canceled') and finished_at < now() - interval '14 days')
               or (status in ('dead', 'failed') and finished_at < now() - interval '30 days')
            limit ${BATCH})
          returning id`),
      );
      deleted += rows.length;
      if (rows.length < BATCH) break;
    }
    ctx.log.info("jobs.cleanup finished", { deleted });
  },
});

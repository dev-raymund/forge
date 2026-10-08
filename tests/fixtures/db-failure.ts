import pg from "pg";
import { uuidv7 } from "uuidv7";

/**
 * Making the database fail on cue, for the tests that prove a change and its
 * audit record commit together or not at all (M3-5, ADR 0010; sites in M4-1).
 * As the schema owner, on a direct connection to this worker's database.
 */

export async function asOwner<T>(work: (client: pg.Client) => Promise<T>): Promise<T> {
  const client = new pg.Client({ connectionString: process.env.TEST_WORKER_OWNER_URL });
  await client.connect();
  try {
    return await work(client);
  } finally {
    await client.end();
  }
}

/** While `work` runs, a trigger makes the database refuse `event` on `table`: at once, or (deferred) when the transaction tries to commit. */
export async function whileFailing<T>(table: string, event: "insert" | "delete" | "update", work: () => Promise<T>, options: { atCommit?: boolean } = {}): Promise<T> {
  const name = `test_fail_${uuidv7().slice(-12)}`;
  await asOwner(async (owner) => {
    await owner.query(`create function ${name}() returns trigger language plpgsql as $$ begin raise exception 'forced failure on ${table}'; end $$`);
    await owner.query(
      options.atCommit
        ? `create constraint trigger ${name} after ${event} on ${table} deferrable initially deferred for each row execute function ${name}()`
        : `create trigger ${name} before ${event} on ${table} for each row execute function ${name}()`,
    );
  });
  try {
    return await work();
  } finally {
    await asOwner(async (owner) => {
      await owner.query(`drop trigger ${name} on ${table}`);
      await owner.query(`drop function ${name}()`);
    });
  }
}

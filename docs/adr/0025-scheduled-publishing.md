# ADR 0025: Scheduled publishing and the system actor

| | |
|---|---|
| **Status** | Accepted for V1 |
| **Date** | 2026-10-16 |
| **Issue** | M7-2 (v1-github-issues.md) |
| **Decisions touched** | Plan §9 (Schedule, Cancel schedule, Scheduled run), §16 (jobs); cms-architecture §16.2 (D-16: scheduling freezes a revision), D-30 (audit); builds on ADR 0005 (the job queue), ADR 0006 (crons on Hobby), ADR 0010 (the audit writer), ADR 0016 (publishing), ADR 0024 (the lifecycle) |

## Context

M7-2's criteria:
- **`scheduleEntry(entryId, runAt, expectedVersion)`:**
  - validates as for publish;
  - creates a `scheduled` revision;
  - enqueues `entry.publish_scheduled` (`dedupe_key = entry:{id}`);
  - sets the status to `scheduled`.
- **`cancelSchedule`, and the job:** the job publishes the frozen revision through the same function, and invalidates with `revalidateTag(…, { expire: 0 })`.
- **The screens:**
  - a schedule dialog in the site's time zone;
  - the scheduled list on the site overview;
  - a failed job: an email to whoever scheduled it, and a banner.
- **Testing:** "a draft edited after scheduling does not leak into the scheduled publish"; E2E through the cron route.

Hand-offs from earlier milestones:
- **M3-5:** `record()` writes only with a user in the transaction; add a system actor "as an explicit, typed caller (`actor_type = 'system'`), not as a free parameter".
- **M7-1:** `trash.purge` was not recorded for want of one.

M7-2's brief added two requirements:
- automated publishing and the automatic purge must be recorded;
- a permanent failure must not be retried forever.

## Decision

### 1. The lifecycle

`content/lifecycle.ts` gains two transitions:
- **`reschedule`:** scheduled → scheduled, with the publish right.
- **`publish_scheduled`:** scheduled → published, with a right no member holds (`system`); `canTransition` says no to every member.

A scheduled entry:
- cannot be published by hand ("Cancel the schedule first"), unpublished or trashed;
- has a draft that stays editable (§3).

### 2. Times: the site's time zone, stored in UTC

**The zone:**
- Every site already has a time zone (`sites.timezone`, an IANA name, set in its settings since M4-2).
- The dialog's field is a wall-clock time there, labelled "Date and time in Asia/Manila (UTC+08:00)".
- The server reads the site's zone itself; nothing from the browser decides it.

**Conversion** (`content/zoned-time.ts`, pure, `Intl` only):
- The instant is stored as `timestamptz` (UTC).
- A wall-clock time the clocks skip (a DST gap) or pass twice (a DST overlap) is refused, never guessed.

**Shown back** in the zone, with its name and offset: the editor, the overview, the posts list, and the failure email. The activity log keeps UTC, since it is the organization's and spans sites.

**Accepted range:** at least one minute ahead ("To publish now, use Publish"), and at most two years. A past time is refused, never published at once.

### 3. Scheduling (`content/scheduling.ts`)

**One transaction, under the entry's and the draft's locks:**
1. **The draft version:** the one the editor saved (a newer save is a Conflict).
2. **Checks:** the same as Publish (`prepareForPublish`): document, references, slug, fields, the parent chain, reserved paths, terms. The address it will take must be free.
3. **The frozen revision:** a `scheduled` revision, created by the scheduler.
4. **The entry:** `status = 'scheduled'`, `scheduled_at` set.
5. **The job:** `entry.publish_scheduled` queued with `run_at = scheduled_at`, `dedupe_key = entry:{id}`, payload `{ entryId, revisionId, runAt }`.
6. **The record:** `entry.scheduled` (by the person).

Nothing public changes, so nothing is flushed.

**Change the time (`rescheduleEntry`):**
- The same revision, another instant.
- The queued job is moved (`moveQueuedJob`: new `run_at` and payload).
- Recorded as `entry.scheduled` with `previousRunAt`.
- To publish newer changes, cancel and schedule again: the dialog says so.

**Cancel (`cancelSchedule`):**
- Back to a draft; the queued job is `canceled` (`cancelQueuedJob`).
- Recorded as `entry.schedule_canceled`.
- The frozen revision stays in the history (M7-3).

**Who:** the publish right (pages Owner–Editor; posts `.any`, or `.own` for an Author's own posts). An Author never sees pages or another's post (not found); a Viewer is refused.

**The job queue is the timer (plan §4.1: no `scheduled_actions` table).**
- `jobs` has no RLS, so the two new helpers scope themselves to the transaction's own organization (`app_current_org_id()`), never a parameter.
- A job being run at that very moment cannot be moved; the request is refused with "It is being published right now."

### 4. The job: publishing at the time

The runner claims the job once `run_at` has passed (its clock). In the job's organization's tenant transaction (no user in it), `publishDue`:
1. **Locks the entry.**
2. **Checks it is still this schedule:** `scheduled`, the same instant as the payload, the same revision. Otherwise nothing is done:
   - canceled, or moved to another time (whose own job will run);
   - replaced;
   - published already: the cache is flushed again, for a run that published and then failed before flushing.
3. **Checks who scheduled it may still publish it.** Their role as it is now (`roleMayPublish`, the catalog's `permissionsForRole`), never rights of the job's own; nobody is impersonated.
4. **Checks the frozen revision again** as it would be published now (`prepareForPublish`): the site may have changed.
   - A term deleted since is left out, as a term's deletion takes it off live posts; the remaining ones must be this site's.
5. **Makes it live** through the same projection as Publish (`makeLive`):
   - the revision becomes `published_revision_id`;
   - the pages below follow a path change;
   - the published terms are replaced;
   - `published_at` = the scheduled instant (the date its author chose, kept on later publishes), and `first_published_at` = when it really went live.
6. **Records** `entry.published` with `scheduled: true`, by the system.
7. **Flushes the cache** (the job, after the commit): `invalidate(events, "background")`, which is `revalidateTag(tag, { expire: 0 })` for the entry, the routes and the moved pages, and the lists (§8).

**Exactly once:**
- The runner never runs one job twice at once (claim with `SKIP LOCKED`, `attempts` as a fencing token).
- A second delivery, or a duplicate run, waits for the entry's lock, then finds it published.
- Tested: two runs at once in rounds, one publishes and one finds it done; one revision, one `entry.published`.

**What is published** is the frozen revision, never the draft as it is at the time. The test edits after scheduling and checks the public page. After the job, the editor shows "Published, with unpublished changes" when the draft has moved on.

### 5. When it cannot be published

**Permanent:** the job's checks refuse it with a `Validation`, `Conflict`, `Forbidden` or `NotFound` error. Examples: the scheduler may no longer publish it; an Author's post was credited to someone else; the address is taken; the parent chain is broken; a reserved path; the revision is no longer valid.
- **Not retried.** In a new transaction (`failDue`), only if it is still this schedule:
  - the entry becomes a draft again, with `schedule_failure` (the reason, in the editor's words, never content) and `schedule_failed_at`;
  - `entry.schedule_failed` is recorded by the system;
  - an email (`scheduled-publish-failed`) is queued to whoever scheduled it, while they are a member, with a link to the editor and the time in the site's zone.
- **Shown:**
  - the editor shows a banner with the reason until the entry is scheduled or published again;
  - the overview's "Scheduled" list shows it for 14 days.
- **No cache event:** nothing went live.
- **The job itself succeeds:** the schedule is settled.

**Transient** (anything else: the database refusing a write, a timeout):
- The transaction rolls back whole, and the job is retried with the queue's backoff (5 attempts, 30 s doubling).
- On the last attempt, the same failure is recorded with a technical reason, if the database lets it, and the job is still marked `dead`, for whoever watches the queue.
- Nothing is half published: the publish, its record and its terms are one transaction.

**Schema:** migration 0014 adds the two columns (nullable, a CHECK keeps them together) as explicit state for the banner, rather than reading it back from the log.

### 6. The system actor (`audit/record.ts`: `recordSystem`)

- **A fixed, typed list:**
  - `"entry.publish_scheduled"` → "Forge (scheduled publishing)";
  - `"trash.purge"` → "Forge (trash cleanup)".

  A caller cannot invent an actor or a label.
- **The row:** `actor_type = 'system'`, `actor_id` null, `actor_label` that name, `request_id = job:{actor}`.
- **The organization** comes from the transaction's own context (`app_current_org_id()`), as for `record`, never a parameter. Another organization's site is refused.
- **No user in the transaction:** a person's change is never written as the system's, nor the other way round.
- **The same events and checks** as `record`, in the same transaction as the change: a record that cannot be written leaves no change.
- **Display:** the activity page shows the label as the actor ("Forge (scheduled publishing) published the post Rye season at /blog/rye-season, as scheduled."). Filtering by member never matches it.
- **The writer** was only extended; the event-ordering issue stays M12-1's.

**New events:**
- `entry.scheduled`, with `runAt` and, when the time changed, `previousRunAt`;
- `entry.schedule_canceled`;
- `entry.schedule_failed` (by the system);
- `entry.published` with `scheduled: true`;
- `entry.deleted` with `afterDays`.

### 7. `trash.purge`, recorded

- **Each batch** records, in its own transaction, one `entry.deleted` by "Forge (trash cleanup)" for each entry deleted whose parent was not deleted with it, with `below` (the pages that went with it) and `afterDays`.
- **A record that cannot be written deletes nothing.** The job reports the failure, still runs the media half, and the next run purges and records (tested).
- **The lines outlive the rows:** `audit_logs` has no foreign keys and is append-only.
- **Media purges are still not recorded** (ADR 0022; not in M7-2's brief).
- **Unchanged:** the 30 days, the batches, the site's tree lock, the retry.

### 8. The cache

A scheduled publish returns the same events as Publish:
- `entry.published`: the entry and the routes at once, the lists stale;
- `entry.moved` for live pages below it.

The job flushes them with `revalidateTag(tag, { expire: 0 })` for the immediate ones.

The integration test:
- records the tags the public reads apply (the blog, the archive, the path) while the post is scheduled;
- checks the job's flushes cover the entry and the routes with `{ expire: 0 }`, and the post list;
- checks no request's `updateTag` is used;
- checks a failed or retried run flushes nothing.

### 9. When the job runs

The job runs when the runner is called after its `run_at`. On V1's free hosting (ADR 0006, runbook §6):

| Where | Who calls the runner | When a scheduled entry is published |
|---|---|---|
| Vercel Hobby, as configured (`vercel.json`) | The daily cron (03:00 UTC, ±59 min) | **Up to a day late** |
| Vercel Hobby plus a free external scheduler (runbook §6: `GET /api/internal/cron`, `Authorization: Bearer $CRON_SECRET`, every 1–5 min) | That scheduler | Within its interval (1–5 min), when it calls on time |
| Vercel Pro (post-V1) | A per-minute Vercel cron | About a minute |
| Local, tests, E2E | `runJobs({ now })` (integration, fake clock), or the cron route with the secret (E2E) | When called |

- **Nothing here is measured on a deployment.** A green CI run shows the job's behaviour, not that the platform calls it on time.
- **The external scheduler** is configuration, not code, and is not set up by this milestone (no paid infrastructure; nothing deployed).
- **The route:** without the secret it answers 404 (existing tests).
- **`kickJobs` after a request** does not help: a schedule is at least a minute ahead.

## Not in M7-2

- **M7-3:**
  - revision history, which will list `scheduled` revisions among the others;
  - restoring a revision;
  - the conflict dialog's overwrite.
- **Later (cms-architecture §16.1):**
  - scheduling changes to a published entry ("schedule changes");
  - scheduling an unpublish.
- **Not done:** recording media purges; a dashboard for dead jobs.
- **M12-1:** the audit ordering follow-up, unchanged.

## Why, and what it costs

| Decision | Reason | Tradeoff | Reconsider when |
|---|---|---|---|
| The scheduled revision itself becomes the published one | "Publishes the frozen revision through the same function": no second copy | History shows a `scheduled` revision as the live one | M7-3's history wants every live version as `publish` |
| `published_at` = the scheduled instant | The date the author chose; a late runner does not move it | On Hobby without a scheduler, the date can be up to a day before it was really visible | Readers complain about dates |
| The scheduler's right is checked again at the time | A background job must not publish what no one may | A schedule fails when its author is demoted; someone reschedules it | — |
| A permanent failure returns it to draft | No unbounded retries; the person is told and can act | A transient problem misread as permanent would need a reschedule | — |
| Deleted terms are left out, not a failure | Matches what a term's deletion does to live posts | The post goes live without that tag | Authors want to be asked |
| Times in the site's zone, not the browser's | One meaning for everyone editing the site; the plan says "site timezone" | Someone abroad thinks in site time | Per-user zones are wanted |
| Refuse DST gaps and overlaps | No silent hour shifts | A person picks another minute twice a year | — |
| Moving a running job is refused | It cannot be moved under its runner, and the window is a moment | "Try again in a moment" | — |
| Two columns for the failure | Explicit state for the banner; the log is history | Two nullable columns on `entries` | A notifications feature replaces it |

## Evidence

- **`tests/integration/content-scheduling.test.ts`** (19, real Postgres through PgBouncer; the real runner on a fake clock):
  - **scheduling:** freezes the revision, queues the job at the instant in the site's zone, is recorded, shows nothing; the same wall-clock time in two zones;
  - **refusals:** past, within a minute, beyond two years, malformed, a DST gap and overlap, published, a newer save;
  - **who may:** an Author's own posts only, no pages, a Viewer refused; the form's field error;
  - **the job:**
    - publishes the frozen revision (not later edits), at its time and not before;
    - recorded by the system, with the public reads' tags flushed with `{ expire: 0 }`, and a second delivery a no-op;
    - two runs at once, in rounds: once;
    - canceled and moved: the old time publishes nothing, the new one does;
    - a cancel racing the job, in rounds;
    - refused actions while scheduled, and the draft still editable;
    - a page under a draft parent; a post with a deleted term;
  - **permanent failure:** the scheduler demoted, or an Author's post credited to someone else: a draft again with the reason, recorded by the system, an email queued, not retried, nothing flushed, then scheduled again and published;
  - **transient failure:** rolled back, retried, then published; on the last attempt, a draft again and the job dead;
  - **the system actor:** refused inside a user's transaction, with an unknown actor, and invisible to another organization;
  - **`trash.purge`:** recorded per root with `below` and `afterDays`, the lines surviving the rows; a failed record deletes nothing and the next run does it.
- **Other suites:**
  - `isolation.test.ts`: schedule, change time and cancel, as services and forms, with B's entry and slugs;
  - `audit.test.ts`: the three new events written by real changes;
  - `content-paths.test.ts`: the migration 0005 test compares the columns it knows (0014 adds two).
- **Unit tests:**
  - `zoned-time.test.ts`: zones, DST gaps and overlaps, malformed input, display;
  - `lifecycle.test.ts`: the transitions;
  - audit vocabulary and sentences; the email template, escaped.
- **`tests/e2e/content-scheduling.spec.ts`** (3, the production build, the cron route with its secret):
  - schedule in Asia/Manila (a past time refused; 09:30 there stored as 01:30 UTC), edit after, the overview's list, not public before, published by the cron route, the later edit not public, the activity naming the system;
  - change the time, then cancel: nothing published;
  - a schedule whose author was demoted: a draft again, with the editor's banner and the overview's line.

  Repeated 5 times: 15 of 15 passed.
- **Mutation check:** without the job's entry lock, two runs at once both publish, and the test fails every time.
- **CI on the first push (`74c00e9`) found two problems, fixed in the next commit:**
  - **A regression:** after the refactor, `makeLive` read the clock twice, so a first publish by hand could get a `first_published_at` one millisecond after its `published_at` (`content-entries.test.ts` expects them equal). It now reads the clock once.
  - **Test isolation:** a lifecycle test deliberately leaves a trashed page with a live child; when it shared a database with the purge-record test (as CI's fewer workers make it), the job rightly reported that page as kept back. The lifecycle test now puts its broken tree right afterwards. The purge-record test checks its own entries with `purgeTrashedEntries`, as the job's entry half does.
  - Both were checked again with the integration suite on two workers and with the two files sharing one database.

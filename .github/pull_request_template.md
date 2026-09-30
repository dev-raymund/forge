## What and why

<!-- Link the issue (e.g. M5-3) and any decision (D-xx / ADR) this touches. -->

## Checklist (v1-build-plan §40 non-negotiables)

- [ ] No repository call without tenant context (`withTenant`); no tenant id read from input
- [ ] No business logic or DB access in `app/`; modules imported only via `index.ts` / `shared.ts`
- [ ] No stored HTML; no new `dangerouslySetInnerHTML`
- [ ] Must-happen side effects go through jobs, enqueued inside the transaction
- [ ] Mutations check permissions in the service and write an audit row in the same transaction
- [ ] Tests: unit for pure logic; integration for anything touching the database

## Migration review (only if `drizzle/` changed)

- [ ] Generated with `npm run db:generate` (or `db:generate:custom` for hand-written SQL) and read line by line
- [ ] Every new tenant table: `organization_id`, composite FK to `sites` if site-scoped, tenant policy, `FORCE ROW LEVEL SECURITY`, classified in `src/platform/db/table-classes.ts`
- [ ] Grants reviewed (append-only tables revoke UPDATE/DELETE from `forge_app`)
- [ ] Lock impact on large tables considered; indexes on big tables `CONCURRENTLY`
- [ ] NOT NULL additions split into add → backfill → constrain
- [ ] Backward compatible with the currently deployed code (expand → migrate → contract)
- [ ] Rollback path is a forward fix (documented if non-obvious)

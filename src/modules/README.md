# modules/

Business logic, one folder per bounded context (v1-build-plan §18).

Each module exposes exactly two entry points:

- `index.ts`: the server-only public API (services, queries, types)
- `shared.ts`: client-safe exports (types, Zod schemas, constants)

Everything else in the module is private. ESLint enforces this: code outside a module may import only `@/modules/<m>` or `@/modules/<m>/shared`.

| File | Role |
|---|---|
| `schema.ts` | Drizzle tables owned by the module |
| `*.service.ts` | Use cases: authorize → validate → load → decide → persist → audit → return events. Audit is `record(tx, …)` from `@/modules/audit`, in the same transaction (ADR 0010) |
| `*.repository.ts` | Drizzle queries that take a tenant transaction (`tx`) |
| `queries.ts` | Read models for Server Components |
| `actions.ts` | `"use server"` adapters: parse → context → service → invalidate |
| `validation.ts` | Zod schemas shared by client and server |
| `policies.ts` | Permission checks: `can(ctx, permission, resource?)` from `@/modules/tenancy` (ADR 0009). Never compare roles |

# modules/

Business logic, one folder per bounded context (v1-build-plan §18).

Each module exposes these entry points:

- `index.ts`: the server-only public API (services, queries, types, and the module's screens)
- `shared.ts`: client-safe exports (types, Zod schemas, constants)
- `public.ts`, where the public site needs it: server-only and UI-free (M8-2, ADR 0029), because a barrel's screens are shipped to every page that imports it

Everything else in the module is private. ESLint enforces this: code outside a module may import only `@/modules/<m>`, `@/modules/<m>/shared` or `@/modules/<m>/public`. The public site (`rendering`, `app/(sites)`) never imports another module's barrel (`rendering/public-bundle.test.ts`).

| File | Role |
|---|---|
| `schema.ts` | Drizzle tables owned by the module |
| `*.service.ts` | Use cases: authorize → validate → load → decide → persist → audit → return events. Audit is `record(tx, …)` from `@/modules/audit`, in the same transaction (ADR 0010) |
| `*.repository.ts` | Drizzle queries that take a tenant transaction (`tx`) |
| `queries.ts` | Read models for Server Components |
| `actions.ts` | `"use server"` adapters: parse → context → service → invalidate |
| `validation.ts` | Zod schemas shared by client and server |
| `policies.ts` | Permission checks: `can(ctx, permission, resource?)` from `@/modules/tenancy` (ADR 0009). Never compare roles |

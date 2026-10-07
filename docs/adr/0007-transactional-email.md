# ADR 0007: Transactional email through `email.send`, behind a provider interface

| | |
|---|---|
| **Status** | Accepted for V1 |
| **Date** | 2026-10-01 |
| **Issue** | M1-4 (v1-github-issues.md) |
| **Decisions touched** | D-22 (jobs), D-07 (Better Auth emails); builds on ADR 0005 and 0006 |

## Decision

```text
service ─(same transaction)→ jobs: email.send ─(runner, after() kick / cron)→ render template → EmailProvider.send → Resend | Mailpit | console | capture
```

1. **Provider interface.** `EmailProvider.send(message, { idempotencyKey })` in `src/platform/email/provider.ts`.
   - A message has `to`, `subject`, `html`, `text` and `tags`, and **no `from`**: the sender is the configured platform identity (`EMAIL_FROM`).
   - Adapters live in `src/platform/email/providers/`, and they are the only code that knows a vendor.
2. **Adapters.**

   | Provider | Used for | Sends real email |
   |---|---|---|
   | `ResendEmailProvider` | Production (`EMAIL_PROVIDER=resend`, the default on Vercel production) | Yes |
   | `MailpitEmailProvider` | Local development and E2E. HTTP to the Mailpit container; inbox at `localhost:8025` | No |
   | `ConsoleEmailProvider` | The default anywhere else (previews, CI unit runs). Logs subject and tags only | No |
   | `CaptureEmailProvider` | Tests (in-process; honours idempotency keys like Resend; scriptable failures) | No |

   The Resend adapter uses its HTTP API directly (`POST /emails`, one request, no SDK).
3. **Configuration** is lazy and validated (`env("email")`). Importing the email module never fails.
   - A missing or invalid setting surfaces when an email is about to be sent, as an `EmailConfigError` that names the variables (never values).
   - The job keeps retrying it and reports it to Sentry, so the email still goes out once fixed.
   - Readiness reports the `email` group. On Vercel production, Resend is the default and needs `RESEND_API_KEY` and `EMAIL_FROM`.
4. **One job type, `email.send`.** The payload is a Zod discriminated union of the V1 templates:
   - verify email, reset password, organization invitation, trial ending, payment failed.
   - No marketing or campaign email.
   - It is queued with `queueEmail(tx, payload)` inside the business transaction, or `sendEmailSoon(payload)` outside one (Better Auth hooks), followed by a kick.
   - **Delivery can never roll back or fail the business operation.** A queued invitation or reset token stays valid while the job retries.
5. **Recipients are never caller-supplied.** The job resolves them when it runs:
   - verify and reset → the user (`userId`);
   - invitation → the invitation's address, read **under the enqueuing organization's RLS context** (another tenant's invitation is invisible → permanent failure, no email);
   - billing notices → the organization's owners.

   Every link must be on `APP_ORIGIN`; the check runs at enqueue and again at send.
6. **Tenant scope `inherit`** (added to the queue, ADR 0005). `email.send` takes the enqueuing transaction's organization when there is one. Sign-up emails have none; invitation and billing emails need one.
7. **Idempotency = job id.**
   - The key is the job id, plus `:{userId}` when a job has several recipients. It is Resend's `Idempotency-Key` (24 h window).
   - A retry after a lost response (sent, but the job didn't record it) delivers nothing twice (tested with the capture provider).
   - No database transaction is open during `send`: the runner holds none, and recipients are read in short transactions first.
8. **Retries.** 8 attempts with backoff from 60 s up to 1 h, about 2 h in total, well inside the idempotency window.
   - Transient: network errors, timeouts, 429, 5xx.
   - Permanent (job `failed`, reported): 400/422 rejections, a missing user or invitation, a link off the app origin.
   - Configuration (logged and reported with an explanation, then retried): 401/403 from Resend, missing variables.
   - A user who verified meanwhile, or an invitation no longer open, is a no-op.
9. **Secrets.**
   - Links carry one-time tokens, so the stored payload's `url` is replaced by `"[redacted]"` when the job finishes (`redactOnFinish`, added to the queue).
   - Logs never include bodies, links or addresses (the console provider logs subject and recipient domain only; the logger also masks emails).
   - The Resend key never appears in errors.
10. **Templates** are React Email components (`src/platform/email/templates/`) with typed props, rendered to HTML and plain text.
    - React escapes all values.
    - Subjects are stripped of line breaks.
    - Templates format data and contain no logic.
11. **Better Auth** (M0-6 spike; production in M2-1) keeps owning tokens and links. Its hooks only queue `email.send`:
    - `sendVerificationEmail` → `sendEmailSoon({ template: "verify-email", userId, url })`
    - `sendResetPassword` → `sendEmailSoon({ template: "reset-password", userId, url })`

    Tested end to end: sign-up → delivered link verifies; reset → delivered token resets the password; an unknown address gets the same response and no email.

## Evidence

- `src/platform/email/providers.test.ts` and `templates.test.tsx` (24 unit tests):
  - the Resend request (endpoint, auth header, idempotency key, body with the platform sender);
  - HTTP status → retry, permanent or configuration;
  - Mailpit request, the capture provider's idempotency, the console provider logging no body;
  - configuration resolution and errors;
  - template rendering and escaping.
- `tests/integration/email.test.ts` (15 tests, Postgres through PgBouncer):
  - delivery;
  - invalid payloads and off-origin links rejected;
  - transient retry, permanent failure, configuration retry;
  - **exactly-once despite a retry**;
  - an invitation surviving a delivery failure;
  - cross-tenant invitation refused;
  - owners-only billing notices;
  - tokens absent from logs and redacted from the payload;
  - Better Auth sign-up and reset through the queue.
- `tests/integration/jobs.test.ts`: `inherit` scope and redaction, including on `dead`.
- `tests/e2e/email.spec.ts`: production build → `email.send` → `after()` kick → Mailpit inbox, read by the M1-6 helper `tests/e2e/helpers/mailbox.ts`.

Mutation checks: random idempotency keys fail the exactly-once test, and removing the redaction fails the secrets test.

## Configuration

| | Variables |
|---|---|
| Required locally | none (defaults to the console provider) |
| Optional locally | `EMAIL_PROVIDER=mailpit` (inbox at `localhost:8025`), `MAILPIT_URL`, `EMAIL_FROM` |
| Required for Resend (production) | `RESEND_API_KEY`, `EMAIL_FROM` (on a domain verified in Resend, e.g. `Forge <no-reply@cms.forgelinetechnologies.com>`); `EMAIL_PROVIDER=resend` is implied on Vercel production |

---

## Addendum (M3-4, 2026-10-07): invitation emails are in use

The `organization-invitation` template and its handling in `email.send` were built in M1-4. M3-4 is their first caller, and nothing in the job changed:

- The email is queued by `inviteMember` / `resendInvitation` **inside the transaction** that writes the invitation, so there is an invitation exactly when its email is on its way.
- **The recipient is the invitation's address, read by the job** under the organization's RLS context. The caller passes an invitation id and a link, never an address.
- **The link is the only copy of the token.** The job checks that it points at the app's origin, sends it, and replaces it with `[redacted]` in the stored payload.
- An invitation that was revoked, accepted or has expired by the time the job runs sends nothing.
- The Server Action calls `kickEmail()` after the commit; the cron runner is the guarantee.

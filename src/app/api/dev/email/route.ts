import { connection } from "next/server";
import { uuidv7 } from "uuidv7";
import { z } from "zod";
import { env } from "@/platform/config/env";
import { sendEmailSoon } from "@/platform/email";
import { notFound, problemResponse } from "@/platform/errors";
import { requestIdFrom } from "@/platform/observability";
import { hasBearerSecret } from "@/platform/security/bearer";

/**
 * Dev/E2E only (M1-4): queues a verification email for an existing user, the
 * way Better Auth's hook will (M2-1), and kicks the runner after the response.
 * With EMAIL_PROVIDER=mailpit it lands in the local Mailpit inbox. The link
 * carries a dummy token. Local: open. Preview: needs the cron secret.
 * Production: never.
 */
const input = z.object({ userId: z.uuid() });

export async function POST(request: Request) {
  await connection();
  const requestId = requestIdFrom(request.headers);
  const vercelEnv = process.env.VERCEL_ENV;
  const allowed =
    vercelEnv !== "production" && (!vercelEnv || hasBearerSecret(request.headers, process.env.CRON_SECRET ?? ""));
  if (!allowed) return problemResponse(notFound(), requestId);

  const parsed = input.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return problemResponse(parsed.error, requestId);
  const url = `${env("core").APP_ORIGIN}/verify-email?token=dev-${uuidv7()}`;
  const { id } = await sendEmailSoon({ template: "verify-email", userId: parsed.data.userId, url });
  return Response.json({ ok: true, jobId: id });
}

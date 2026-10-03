import { requireAuth } from "@/modules/auth";
import { problemResponse } from "@/platform/errors";
import { requestIdFrom } from "@/platform/observability";

/**
 * The signed-in user, for the admin UI (`/api/app/*`: session-authenticated
 * JSON). 401 without a valid session. Identity only: no organization here.
 */
export async function GET(request: Request) {
  try {
    const { user, session } = await requireAuth();
    return Response.json({ user, session: { id: session.id, expiresAt: session.expiresAt } }, { headers: { "cache-control": "no-store" } });
  } catch (err) {
    return problemResponse(err, requestIdFrom(request.headers));
  }
}

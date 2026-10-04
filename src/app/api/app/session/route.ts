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
    // No session id: nothing that identifies a session inside Forge leaves the server (M2-4).
    return Response.json({ user, session: { expiresAt: session.expiresAt } }, { headers: { "cache-control": "no-store" } });
  } catch (err) {
    return problemResponse(err, requestIdFrom(request.headers));
  }
}

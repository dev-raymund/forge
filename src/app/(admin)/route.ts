import { requireAuthOrLogin, toActor } from "@/modules/auth";
import { homeOrganization, homePath } from "@/modules/tenancy";

/**
 * `/` is not a page (plan §19): it sends a signed-in user to their
 * organization, or to onboarding when they have none, and anyone else to the
 * login page. A route handler, so each of those is a real HTTP redirect.
 *
 * Which organization is worked out from the user's memberships on every
 * request (modules/tenancy/home.ts). Nothing remembers a "current" one: the
 * URL the user lands on is what says where they are (D-08).
 */
export async function GET() {
  const auth = await requireAuthOrLogin("/");
  const destination = homePath(await homeOrganization(toActor(auth)));
  // The answer is this user's own: never to be stored by a browser or a shared cache and replayed.
  return new Response(null, { status: 307, headers: { location: destination, "cache-control": "private, no-store" } });
}

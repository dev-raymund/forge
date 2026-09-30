import type { Event } from "@sentry/nextjs";

type InitOptions = NonNullable<Parameters<typeof import("@sentry/nextjs").init>[0]>;

/**
 * PII scrubbing for Sentry events, shared by the server and the admin client.
 * Keeps: stack traces, tags (IDs only), the route. Drops: cookies, bodies,
 * query strings, headers other than a small allow-list, user details beyond
 * an id, IPs, and email addresses anywhere in messages.
 */

const SAFE_HEADER_LIST = ["user-agent", "x-request-id", "x-vercel-id", "content-type", "accept"];
const SAFE_HEADERS = new Set(SAFE_HEADER_LIST);

/**
 * What the SDK may collect in the first place (Sentry 11 replaced
 * `sendDefaultPii` with this). `scrubEvent` below is the second layer.
 */
export const SENTRY_DATA_COLLECTION: InitOptions["dataCollection"] = {
  userInfo: false,
  cookies: false,
  httpHeaders: { request: { allow: SAFE_HEADER_LIST }, response: false },
  httpBodies: [],
  urlQueryParams: false,
};
const EMAIL = /[^\s@"'<>]+@[^\s@"'<>]+\.[a-z]{2,}/gi;

const scrubText = (s: string | undefined) => s?.replace(EMAIL, "[email]");

export function scrubEvent<E extends Event>(event: E): E {
  if (event.request) {
    const { url, method, headers } = event.request;
    event.request = {
      url: url?.split("?")[0],
      method,
      headers: Object.fromEntries(Object.entries(headers ?? {}).filter(([k]) => SAFE_HEADERS.has(k.toLowerCase()))),
    };
  }
  if (event.user) event.user = event.user.id ? { id: event.user.id } : undefined;
  event.message = scrubText(event.message);
  for (const ex of event.exception?.values ?? []) ex.value = scrubText(ex.value);
  if (event.breadcrumbs) {
    event.breadcrumbs = event.breadcrumbs.map((b) => ({
      ...b,
      message: scrubText(b.message),
      // fetch/xhr breadcrumbs carry full URLs and sometimes bodies
      data: b.data?.url ? { url: String(b.data.url).split("?")[0], method: b.data.method, status_code: b.data.status_code } : undefined,
    }));
  }
  return event;
}

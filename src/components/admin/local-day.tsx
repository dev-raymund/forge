"use client";

import { useSyncExternalStore } from "react";

const formatDay = (iso: string, timeZone?: string) => new Intl.DateTimeFormat("en", { dateStyle: "medium", timeZone }).format(new Date(iso));
const noSubscription = () => () => {};

/**
 * A day, in the viewer's time zone. The server does not know that zone, so it
 * renders the UTC day and the browser corrects it after hydration (a login at
 * 01:00 in Manila is still "yesterday" in UTC).
 */
export function useLocalDay(iso: string): string {
  return useSyncExternalStore(noSubscription, () => formatDay(iso), () => formatDay(iso, "UTC"));
}

export function Day({ iso }: { iso: string }) {
  return <time dateTime={iso}>{useLocalDay(iso)}</time>;
}

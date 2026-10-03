/** A page's `searchParams` prop. Request-time data: await it inside <Suspense>. */
export type SearchParams = Promise<Record<string, string | string[] | undefined>>;

/** The first value of a query parameter (a repeated parameter is an array). */
export const first = (value: string | string[] | undefined): string | undefined => (Array.isArray(value) ? value[0] : value);

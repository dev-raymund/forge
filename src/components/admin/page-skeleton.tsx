/** What a page shows while its request-time content is on the way. */
export function PageSkeleton({ narrow = false }: { narrow?: boolean }) {
  return (
    <div aria-hidden="true" className={`mx-auto w-full flex-1 animate-pulse px-4 py-10 motion-reduce:animate-none sm:px-6 ${narrow ? "max-w-3xl" : "max-w-5xl"}`}>
      <div className="h-7 w-56 rounded bg-muted" />
      <div className="mt-3 h-4 w-80 max-w-full rounded bg-muted" />
      <div className="mt-10 h-24 rounded-lg bg-muted" />
    </div>
  );
}

/** The header and, for organization pages, the row of links under it. */
export function ShellSkeleton({ nav = false }: { nav?: boolean }) {
  return (
    <div aria-hidden="true">
      <div className="h-14 border-b" />
      {nav ? <div className="h-11 border-b" /> : null}
    </div>
  );
}

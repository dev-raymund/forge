import Link from "next/link";
import { cn } from "@/lib/utils";

/**
 * The frame of every account screen: wordmark, one heading, the content, and
 * an optional line of links underneath. A server component: no client code.
 */
export function AuthCard({ title, description, children, footer }: { title: string; description?: React.ReactNode; children: React.ReactNode; footer?: React.ReactNode }) {
  return (
    <div className="flex min-h-dvh flex-col items-center justify-center px-4 py-10 sm:px-6">
      <div className="w-full max-w-sm">
        <p className="mb-8 text-center">
          <Link href="/" className="rounded-sm text-xl font-semibold tracking-tight outline-none focus-visible:ring-3 focus-visible:ring-foreground/25">
            Forge
          </Link>
        </p>
        <main className="rounded-xl border bg-card p-6 text-card-foreground shadow-xs sm:p-8">
          <header className="mb-6 grid gap-1.5">
            <h1 className="text-xl font-semibold tracking-tight text-balance">{title}</h1>
            {description ? <p className="text-sm text-muted-foreground">{description}</p> : null}
          </header>
          {children}
        </main>
        {footer ? <p className="mt-6 text-center text-sm text-muted-foreground">{footer}</p> : null}
      </div>
    </div>
  );
}

/** An inline link inside the account screens: underlined, so it doesn't rely on colour. */
export function AuthLink({ href, children, className }: { href: string; children: React.ReactNode; className?: string }) {
  return (
    <Link
      href={href}
      className={cn("rounded-sm font-medium text-foreground underline underline-offset-4 outline-none hover:no-underline focus-visible:ring-3 focus-visible:ring-foreground/25", className)}
    >
      {children}
    </Link>
  );
}

/** Placeholder while the request-time part of a screen (session, query string) streams in. */
export function FormSkeleton({ fields = 2 }: { fields?: number }) {
  return (
    <div aria-hidden="true" className="grid animate-pulse gap-4 motion-reduce:animate-none">
      {Array.from({ length: fields }, (_, i) => (
        <div key={i} className="grid gap-2">
          <div className="h-3.5 w-20 rounded bg-muted" />
          <div className="h-10 rounded-lg bg-muted" />
        </div>
      ))}
      <div className="h-10 rounded-lg bg-muted" />
    </div>
  );
}

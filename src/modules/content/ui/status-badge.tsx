import { cn } from "@/lib/utils";

/** An entry's status as the lists and the editor say it: a draft, live, or live with changes saved since. */
export function StatusBadge({ status, changed }: { status: string; changed?: boolean }) {
  const live = status === "published";
  const label = live ? (changed ? "Published, with changes" : "Published") : status === "scheduled" ? "Scheduled" : "Draft";
  return (
    <span
      data-testid="entry-status-badge"
      className={cn(
        "inline-flex h-6 shrink-0 items-center rounded-full border px-2.5 text-xs font-medium",
        live ? "border-emerald-700/30 bg-emerald-50 text-emerald-900" : "border-amber-700/30 bg-amber-50 text-amber-900",
      )}
    >
      {label}
    </span>
  );
}

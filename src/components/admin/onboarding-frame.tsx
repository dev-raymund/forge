import { Check } from "lucide-react";
import { cn } from "@/lib/utils";

/**
 * The frame of each onboarding step (M3-3, M4-2; plan §3: organization → site
 * → theme): where the person is among the three steps, a heading, and the
 * step's form.
 */
export function OnboardingFrame({ steps, current, title, description, children }: {
  steps: readonly string[];
  /** 1-based. */
  current: number;
  title: string;
  description: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <main className="mx-auto w-full max-w-xl flex-1 px-4 py-10 sm:px-6 sm:py-14">
      <nav aria-label="Setup steps" className="mb-8">
        <p className="mb-3 text-sm text-muted-foreground" data-testid="onboarding-step">
          Step {current} of {steps.length}
        </p>
        <ol className="flex flex-wrap gap-x-5 gap-y-2 text-sm">
          {steps.map((label, index) => {
            const number = index + 1;
            const state = number < current ? "done" : number === current ? "current" : "next";
            return (
              <li key={label} className={cn("flex items-center gap-2", state === "next" ? "text-muted-foreground" : "font-medium")} aria-current={state === "current" ? "step" : undefined}>
                <span
                  aria-hidden="true"
                  className={cn(
                    "flex size-6 items-center justify-center rounded-full border text-xs",
                    state === "done" && "border-foreground bg-foreground text-background",
                    state === "current" && "border-foreground",
                  )}
                >
                  {state === "done" ? <Check className="size-3.5" /> : number}
                </span>
                {label}
              </li>
            );
          })}
        </ol>
      </nav>
      <header className="mb-8 grid gap-2">
        <h1 className="text-2xl font-semibold tracking-tight text-balance">{title}</h1>
        <div className="text-muted-foreground">{description}</div>
      </header>
      {children}
    </main>
  );
}

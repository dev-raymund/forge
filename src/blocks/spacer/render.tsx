import type { ReactNode } from "react";
import { spacer } from "./schema";

/** Vertical space on the public site, one of the theme's spacing steps. */
export function renderSpacer(attrs: unknown): ReactNode {
  const parsed = spacer.attrs.safeParse(attrs);
  return parsed.success ? <div className={`forge-spacer forge-spacer--${parsed.data.size}`} aria-hidden="true" /> : null;
}

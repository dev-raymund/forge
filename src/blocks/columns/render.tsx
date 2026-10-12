import type { CSSProperties, ReactNode } from "react";
import { columns } from "./schema";

/**
 * Columns on the public site. `children` is each column's already-rendered
 * content: one entry per column, and they must agree with `count` or nothing
 * is drawn. Columns never hold columns (the caller leaves them out, as the
 * schema does). The widths travel as the `--forge-columns` custom property,
 * built from the validated ratio only, so the theme's styles can stack the
 * columns on a phone (`--stack`).
 */
export function renderColumns(attrs: unknown, children: readonly ReactNode[]): ReactNode {
  const parsed = columns.attrs.safeParse(attrs);
  if (!parsed.success || children.length !== parsed.data.count) return null;
  const { ratio, stackOnMobile } = parsed.data;
  return (
    <div
      className={`forge-columns${stackOnMobile ? " forge-columns--stack" : ""}`}
      style={{ "--forge-columns": ratio.split(":").map((part) => `${Number(part)}fr`).join(" ") } as CSSProperties}
    >
      {children.map((content, index) => (
        <div key={index} className="forge-column">
          {content}
        </div>
      ))}
    </div>
  );
}

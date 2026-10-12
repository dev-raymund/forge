import type { ReactNode } from "react";
import { columns } from "./schema";

/**
 * Columns on the public site. `children` is each column's already-rendered
 * content: one entry per column, and they must agree with `count` or nothing
 * is drawn. Columns never hold columns (the caller leaves them out, as the
 * schema does).
 */
export function renderColumns(attrs: unknown, children: readonly ReactNode[]): ReactNode {
  const parsed = columns.attrs.safeParse(attrs);
  if (!parsed.success || children.length !== parsed.data.count) return null;
  const { ratio, stackOnMobile } = parsed.data;
  return (
    <div
      className={`forge-columns${stackOnMobile ? " forge-columns--stack" : ""}`}
      style={{ gridTemplateColumns: ratio.split(":").map((part) => `${Number(part)}fr`).join(" ") }}
    >
      {children.map((content, index) => (
        <div key={index} className="forge-column">
          {content}
        </div>
      ))}
    </div>
  );
}

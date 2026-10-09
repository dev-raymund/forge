/** Long-form text: headings, paragraphs, lists, quotes and links in the site's fonts and colours, at a readable measure. */
export function Prose({ children, className }: { children: React.ReactNode; className?: string }) {
  return <div className={["forge-prose", className ?? ""].filter(Boolean).join(" ")}>{children}</div>;
}

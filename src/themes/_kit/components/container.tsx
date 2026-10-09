/** The content column: the site's chosen width, centred, with side padding that never lets text touch the screen's edge. */
export function Container({ children, wide = false, className }: { children: React.ReactNode; wide?: boolean; className?: string }) {
  return <div className={["forge-container", wide ? "forge-container--wide" : "", className ?? ""].filter(Boolean).join(" ")}>{children}</div>;
}

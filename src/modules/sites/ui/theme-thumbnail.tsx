import type { ThemeChoice } from "../appearance.service";

/**
 * A sketch of a theme for the picker, drawn from its default colours (code,
 * not anything a site saved): a business layout or a publication's. Purely
 * decorative; the name and description say what it is.
 */
export function ThemeThumbnail({ theme }: { theme: Pick<ThemeChoice, "preview" | "colors"> }) {
  const { primary, accent, background, text } = theme.colors;
  const line = (width: string, height = "0.35rem", color = text, opacity = 0.18) => (
    <span className="block rounded-full" style={{ width, height, background: color, opacity }} />
  );
  return (
    <div aria-hidden="true" className="h-36 overflow-hidden rounded-lg border" style={{ background }} data-testid="theme-thumbnail">
      {theme.preview === "business" ? (
        <div className="grid h-full grid-rows-[auto_1fr_auto] gap-3 p-3">
          <div className="flex items-center justify-between">
            {line("30%", "0.5rem", text, 0.75)}
            <span className="block h-3.5 w-12 rounded" style={{ background: primary }} />
          </div>
          <div className="grid content-center gap-1.5">
            {line("20%", "0.4rem", accent, 0.6)}
            {line("70%", "0.8rem", text, 0.8)}
            {line("50%", "0.8rem", text, 0.8)}
          </div>
          <div className="grid grid-cols-3 gap-2">
            {[0, 1, 2].map((n) => (
              <span key={n} className="block h-6 rounded" style={{ background: primary, opacity: 0.12 }} />
            ))}
          </div>
        </div>
      ) : (
        <div className="grid h-full content-start justify-items-center gap-1.5 p-3">
          {line("45%", "0.7rem", text, 0.8)}
          {line("30%", "0.3rem", text, 0.35)}
          <span className="my-1 block h-1 w-full border-y" style={{ borderColor: text, opacity: 0.25 }} />
          {line("55%", "0.6rem", primary, 0.75)}
          {line("80%")}
          {line("75%")}
          {line("78%")}
          {line("40%")}
        </div>
      )}
    </div>
  );
}

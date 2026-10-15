import type { ThemeContext } from "../../types";

/**
 * The site's brand in a header (M6-4): its logo when it has one (the `logo` variant from `/media`, with its size so
 * the header does not jump), named for screen readers by the site's name; otherwise the name itself.
 */
export function Brand({ context }: { context: ThemeContext }) {
  const { logo, name } = context.site;
  if (!logo) return <>{name}</>;
  // eslint-disable-next-line @next/next/no-img-element -- the logo variant, already sized, from /media
  return <img src={logo.url} alt={name} width={logo.width} height={logo.height} className="forge-logo" decoding="async" />;
}

import { Brand } from "../../_kit/components/brand";
import { Container } from "../../_kit/components/container";
import { Nav } from "../../_kit/components/nav";
import { homeHref } from "../../_kit/components/theme-frame";
import { siteHref } from "../../_kit/href";
import type { ThemeContext } from "../../types";

/**
 * Studio's header, in the variant the site chose (M8-1; all three of the kit's):
 *
 *   classic    the site's name on the left, its menu and its call to action on the right
 *   centered   the name centred, with the tagline under it, then the menu and the call to action
 *   minimal    a slim bar: the name, and the menu with the call to action as a plain link
 */
export function StudioHeader({ context }: { context: ThemeContext }) {
  const { header } = context.settings;
  const cta = header.cta ? (
    <a href={siteHref(context, header.cta.href)} className={header.variant === "minimal" ? "studio-header__link" : "forge-button"}>
      {header.cta.label}
    </a>
  ) : null;
  const brand = (
    <a href={homeHref(context)} className="studio-brand">
      <Brand context={context} />
    </a>
  );
  return (
    <header className="studio-header" data-variant={header.variant} data-sticky={header.sticky ? "" : undefined}>
      <Container wide className="studio-header__inner">
        {header.variant === "centered" ? (
          <div className="studio-header__masthead">
            {brand}
            {context.site.tagline ? <p className="studio-header__tagline">{context.site.tagline}</p> : null}
          </div>
        ) : (
          brand
        )}
        <div className="studio-header__end">
          <Nav items={context.menus.header} label="Main" submenus="disclosure" />
          {cta}
        </div>
      </Container>
    </header>
  );
}

import { Container } from "../../_kit/components/container";
import { Nav } from "../../_kit/components/nav";
import { homeHref } from "../../_kit/components/theme-frame";
import { siteHref } from "../../_kit/href";
import type { ThemeContext } from "../../types";

/** Studio's header, `classic`: the site's name on the left, its menu and its call to action on the right. */
export function StudioHeader({ context }: { context: ThemeContext }) {
  const { header } = context.settings;
  return (
    <header className="studio-header" data-sticky={header.sticky ? "" : undefined}>
      <Container wide className="studio-header__inner">
        <a href={homeHref(context)} className="studio-brand">
          {context.site.name}
        </a>
        <div className="studio-header__end">
          <Nav items={context.menus.header} label="Main" />
          {header.cta ? (
            <a href={siteHref(context, header.cta.href)} className="forge-button">
              {header.cta.label}
            </a>
          ) : null}
        </div>
      </Container>
    </header>
  );
}

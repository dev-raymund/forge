import { Container } from "../../_kit/components/container";
import { Nav } from "../../_kit/components/nav";
import { homeHref } from "../../_kit/components/theme-frame";
import { siteHref } from "../../_kit/href";
import type { ThemeContext } from "../../types";

/** Journal's header, `centered`: a masthead with the site's name and tagline, and the menu under it. */
export function JournalHeader({ context }: { context: ThemeContext }) {
  const { header } = context.settings;
  return (
    <header className="journal-header" data-sticky={header.sticky ? "" : undefined}>
      <Container className="journal-header__inner">
        <a href={homeHref(context)} className="journal-brand">
          {context.site.name}
        </a>
        {context.site.tagline ? <p className="journal-tagline">{context.site.tagline}</p> : null}
        <div className="journal-header__end">
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

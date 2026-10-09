import { Container } from "../../_kit/components/container";
import { Nav } from "../../_kit/components/nav";
import type { ThemeContext } from "../../types";

/** Studio's footer, `simple`: the site's name and its copyright line, and the footer menu. */
export function StudioFooter({ context }: { context: ThemeContext }) {
  const { copyright, showSocial } = context.settings.footer;
  return (
    <footer className="studio-footer">
      <Container wide className="studio-footer__inner">
        <p>
          © {context.site.name}
          {copyright ? <span className="studio-footer__note"> · {copyright}</span> : null}
        </p>
        <Nav items={context.menus.footer} label="Footer" />
        {showSocial ? <Nav items={context.site.social} label="Social" rel="me noopener noreferrer" /> : null}
      </Container>
    </footer>
  );
}

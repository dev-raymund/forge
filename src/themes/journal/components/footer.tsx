import { Container } from "../../_kit/components/container";
import { Nav } from "../../_kit/components/nav";
import type { ThemeContext } from "../../types";

/** Journal's footer, `simple`: centred, the site's name and copyright line, and the footer menu. */
export function JournalFooter({ context }: { context: ThemeContext }) {
  const { copyright } = context.settings.footer;
  return (
    <footer className="journal-footer">
      <Container className="journal-footer__inner">
        <Nav items={context.menus.footer} label="Footer" />
        <p>
          © {context.site.name}
          {copyright ? <span> · {copyright}</span> : null}
        </p>
      </Container>
    </footer>
  );
}

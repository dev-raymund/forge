import { Container } from "../../_kit/components/container";
import { Nav } from "../../_kit/components/nav";
import type { ThemeContext } from "../../types";

/**
 * Studio's footer, in the variant the site chose (M8-1; both of the kit's):
 *
 *   simple    one line: the site's name and its copyright line, the footer menu, the social links
 *   columns   three columns: the name, tagline and copyright line; the footer menu; the social links
 *
 * The social links are drawn when `footer.showSocial` (the appearance editor's toggle).
 */
export function StudioFooter({ context }: { context: ThemeContext }) {
  const { variant, copyright, showSocial } = context.settings.footer;
  const social = showSocial ? <Nav items={context.site.social} label="Social" rel="me noopener noreferrer" /> : null;
  if (variant === "columns") {
    return (
      <footer className="studio-footer" data-variant="columns">
        <Container wide className="studio-footer__columns">
          <div className="studio-footer__column">
            <p className="studio-footer__name">{context.site.name}</p>
            {context.site.tagline ? <p>{context.site.tagline}</p> : null}
            <p>
              © {context.site.name}
              {copyright ? <span className="studio-footer__note"> · {copyright}</span> : null}
            </p>
          </div>
          <div className="studio-footer__column">
            <Nav items={context.menus.footer} label="Footer" />
          </div>
          <div className="studio-footer__column">{social}</div>
        </Container>
      </footer>
    );
  }
  return (
    <footer className="studio-footer" data-variant="simple">
      <Container wide className="studio-footer__inner">
        <p>
          © {context.site.name}
          {copyright ? <span className="studio-footer__note"> · {copyright}</span> : null}
        </p>
        <Nav items={context.menus.footer} label="Footer" />
        {social}
      </Container>
    </footer>
  );
}

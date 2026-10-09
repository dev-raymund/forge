import { Container } from "../../_kit/components/container";
import { homeHref } from "../../_kit/components/theme-frame";
import type { TemplateProps } from "../../types";

/** A page of the site that does not exist. */
export function StudioNotFound({ context }: TemplateProps["not-found"]) {
  return (
    <section className="studio-hero studio-hero--missing" aria-labelledby="not-found-title">
      <Container>
        <p className="studio-eyebrow">Error 404</p>
        <h1 id="not-found-title">Page not found</h1>
        <p className="studio-note">The page you are looking for is not here. It may have moved, or the address may be mistyped.</p>
        <p>
          <a href={homeHref(context)} className="forge-button">
            Go to the home page
          </a>
        </p>
      </Container>
    </section>
  );
}

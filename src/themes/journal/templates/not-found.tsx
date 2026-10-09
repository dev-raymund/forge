import { Container } from "../../_kit/components/container";
import { homeHref } from "../../_kit/components/theme-frame";
import type { TemplateProps } from "../../types";

/** A page of the site that does not exist. */
export function JournalNotFound({ context }: TemplateProps["not-found"]) {
  return (
    <section className="journal-notice" aria-labelledby="not-found-title">
      <Container>
        <h1 id="not-found-title">Page not found</h1>
        <p>The page you are looking for is not here. It may have moved, or the address may be mistyped.</p>
        <p>
          <a href={homeHref(context)}>Go to the home page</a>
        </p>
      </Container>
    </section>
  );
}

import { Container } from "../../_kit/components/container";
import type { TemplateProps } from "../../types";

/** What visitors see while the site is not published yet. The masthead already carries the name: this says the rest. */
export function JournalComingSoon({ context }: TemplateProps["coming-soon"]) {
  return (
    <section className="journal-notice" aria-labelledby="coming-soon-title">
      <Container>
        <h1 id="coming-soon-title">Coming soon</h1>
        <p>
          <em>{context.site.name}</em> is not published yet. The first pieces are on their way. Please check back soon.
        </p>
      </Container>
    </section>
  );
}

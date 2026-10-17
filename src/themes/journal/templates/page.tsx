import { Container } from "../../_kit/components/container";
import { Prose } from "../../_kit/components/prose";
import type { TemplateProps } from "../../types";

/** The default page template: the title, centred, then the content at a reading measure. */
export function JournalPage({ title, children }: TemplateProps["page"]) {
  return (
    <article className="journal-page">
      <Container>
        <h1 className="journal-page__title">{title}</h1>
        <Prose>{children}</Prose>
      </Container>
    </article>
  );
}

/** Full width (M8-2): the title at the measure, the content across the wide column (galleries, wide images, columns). */
export function JournalPageFullWidth({ title, children }: TemplateProps["page-full-width"]) {
  return (
    <article className="journal-page journal-page--full">
      <Container>
        <h1 className="journal-page__title">{title}</h1>
      </Container>
      <Container wide>
        <Prose className="forge-prose--wide">{children}</Prose>
      </Container>
    </article>
  );
}

/**
 * Landing (M8-2): an opening with the title set large between rules, in the page's wash, then the content across the
 * wide column. For a site's front page or a section's introduction.
 */
export function JournalPageLanding({ title, children }: TemplateProps["page-landing"]) {
  return (
    <article className="journal-page journal-page--landing">
      <header className="journal-landing__opening">
        <Container>
          <h1 className="journal-landing__title">{title}</h1>
        </Container>
      </header>
      <Container wide>
        <Prose className="forge-prose--wide">{children}</Prose>
      </Container>
    </article>
  );
}

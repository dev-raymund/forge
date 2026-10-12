import { Container } from "../../_kit/components/container";
import { Prose } from "../../_kit/components/prose";
import type { TemplateProps } from "../../types";

/**
 * Studio's two other page templates (M5-6). An author picks one per page (`full-width`, `landing`; M5-7's sidebar).
 *
 *   full-width   the page's title band, then content across the wide container: room for columns and embeds
 *   landing      a hero with the title, then the content across the wide container: for a home or campaign page
 */

export function StudioPageFullWidth({ title, children }: TemplateProps["page-full-width"]) {
  return (
    <article className="studio-page studio-page--wide">
      <header className="studio-page__header">
        <Container wide>
          <h1>{title}</h1>
        </Container>
      </header>
      <Container wide>
        <Prose className="forge-prose--wide">{children}</Prose>
      </Container>
    </article>
  );
}

export function StudioPageLanding({ title, children }: TemplateProps["page-landing"]) {
  return (
    <article className="studio-page studio-page--landing">
      <header className="studio-hero">
        <Container wide>
          <h1>{title}</h1>
        </Container>
      </header>
      <Container wide>
        <Prose className="forge-prose--wide">{children}</Prose>
      </Container>
    </article>
  );
}

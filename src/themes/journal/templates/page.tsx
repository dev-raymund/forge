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

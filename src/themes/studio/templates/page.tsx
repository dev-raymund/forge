import { Container } from "../../_kit/components/container";
import { Prose } from "../../_kit/components/prose";
import type { TemplateProps } from "../../types";

/** The default page template: the page's title, then its content. Content blocks are drawn by M5-6's renderers. */
export function StudioPage({ title, children }: TemplateProps["page"]) {
  return (
    <article className="studio-page">
      <header className="studio-page__header">
        <Container>
          <h1>{title}</h1>
        </Container>
      </header>
      <Container>
        <Prose>{children}</Prose>
      </Container>
    </article>
  );
}

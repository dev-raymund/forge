import { Container } from "../../_kit/components/container";
import type { TemplateProps } from "../../types";

/** What visitors see while the site is not published yet (M4-3 decides when, and marks it `noindex`). */
export function StudioComingSoon({ context }: TemplateProps["coming-soon"]) {
  return (
    <section className="studio-hero studio-hero--soon" aria-labelledby="coming-soon-title">
      <Container>
        <p className="studio-eyebrow">Coming soon</p>
        <h1 id="coming-soon-title">{context.site.name}</h1>
        {context.site.tagline ? <p className="studio-lede">{context.site.tagline}</p> : null}
        <p className="studio-note">We are putting the finishing touches on this site. Please check back soon.</p>
      </Container>
    </section>
  );
}

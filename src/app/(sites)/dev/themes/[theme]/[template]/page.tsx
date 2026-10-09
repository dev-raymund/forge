import { notFound } from "next/navigation";
import { isThemeKey, THEME_KEYS } from "@/themes/registry";
import { themeFor, type RenderableSite } from "@/themes/render";
import { TEMPLATE_KEYS, type TemplateKey } from "@/themes/types";

/**
 * The theme gallery (M4-4): every template of every theme, drawn through the
 * same contract the site renderer will use (`themeFor`), with made-up data.
 * For looking at the themes and testing them in a browser before the renderer
 * (M4-3) puts them on `/s/{address}`. Not a preview of any site: nothing here
 * reads the database. Never served in production.
 *
 * `/dev/themes/{theme}/{template}`, for example `/dev/themes/studio/coming-soon`.
 */

export function generateStaticParams() {
  return THEME_KEYS.flatMap((theme) => TEMPLATE_KEYS.map((template) => ({ theme, template })));
}

const isTemplate = (value: string): value is TemplateKey => (TEMPLATE_KEYS as readonly string[]).includes(value);

/** Made-up, and deliberately awkward: an ampersand, angle brackets and a script tag that must come out as text. */
const fixture = (themeKey: string): RenderableSite => ({
  name: "Harbor & Pine <Studio>",
  tagline: "Architecture and interiors for small spaces <script>window.__xss = 1</script>",
  language: "en",
  basePath: "/s/harbor-and-pine",
  themeKey,
  themeSettings: { header: { cta: { label: "Book a call", href: "/contact" } }, footer: { copyright: "All rights reserved." } },
  menus: {
    header: [
      { label: "Work", href: "/s/harbor-and-pine/work" },
      { label: "Services", href: "/s/harbor-and-pine/services" },
      { label: "About", href: "/s/harbor-and-pine/about" },
    ],
    footer: [{ label: "Privacy", href: "/s/harbor-and-pine/privacy" }],
  },
  social: [
    { label: "Instagram", href: "https://instagram.com/harborandpine" },
    { label: "LinkedIn", href: "https://linkedin.com/company/harborandpine" },
  ],
});

export default async function ThemeGalleryPage({ params }: PageProps<"/dev/themes/[theme]/[template]">) {
  if (process.env.VERCEL_ENV === "production") notFound();
  const { theme: key, template } = await params;
  if (!isThemeKey(key) || !isTemplate(template)) notFound();

  const { theme, context } = themeFor(fixture(key));
  const { Layout, templates } = theme;
  const Page = templates.page;
  const ComingSoon = templates["coming-soon"];
  const NotFound = templates["not-found"];

  return (
    <Layout context={context}>
      {template === "page" ? (
        <Page context={context} title="About the studio">
          <p>
            We design calm, practical rooms for people who live and work in small spaces. Every project starts with how you use the room, not with how it
            looks in a photograph.
          </p>
          <h2>How we work</h2>
          <p>
            A first visit, a measured survey and a set of drawings you can build from. We stay on until the last shelf is up. Read more about{" "}
            <a href={`${context.site.basePath}/services`}>our services</a>.
          </p>
          <ul>
            <li>Kitchens and living rooms</li>
            <li>Studios and home offices</li>
            <li>Shops and small restaurants</li>
          </ul>
          <blockquote>They found room we did not know we had.</blockquote>
        </Page>
      ) : template === "coming-soon" ? (
        <ComingSoon context={context} />
      ) : (
        <NotFound context={context} />
      )}
    </Layout>
  );
}

import { notFound } from "next/navigation";
import { isThemeKey, THEME_KEYS } from "@/themes/registry";
import { themeFor, type RenderableSite } from "@/themes/render";
import { TEMPLATE_KEYS, type PostCard, type TemplateKey } from "@/themes/types";

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

const posts = (base: string): PostCard[] => [
  { title: "A kitchen in nine square metres", href: `${base}/blog/a-kitchen-in-nine-square-metres`, excerpt: "Every drawer earns its place.", date: { iso: "2026-09-12T08:00:00.000Z", label: "12 September 2026" } },
  { title: "Light, <em>and</em> where to find it", href: `${base}/blog/light`, excerpt: "", date: { iso: "2026-08-03T08:00:00.000Z", label: "3 August 2026" } },
];

export default async function ThemeGalleryPage({ params }: PageProps<"/dev/themes/[theme]/[template]">) {
  if (process.env.VERCEL_ENV === "production") notFound();
  const { theme: key, template } = await params;
  if (!isThemeKey(key) || !isTemplate(template)) notFound();

  const { theme, context } = themeFor(fixture(key));
  const { Layout, templates } = theme;
  const base = context.site.basePath;
  const pagination = { page: 2, pages: 3, previousHref: `${base}/blog`, nextHref: `${base}/blog/page/3` };
  const content = (
    <>
      <p>
        We design calm, practical rooms for people who live and work in small spaces. Every project starts with how you use the room, not with how it
        looks in a photograph.
      </p>
      <h2>How we work</h2>
      <p>
        A first visit, a measured survey and a set of drawings you can build from. We stay on until the last shelf is up. Read more about{" "}
        <a href={`${base}/services`}>our services</a>.
      </p>
      <ul>
        <li>Kitchens and living rooms</li>
        <li>Studios and home offices</li>
        <li>Shops and small restaurants</li>
      </ul>
      <blockquote>They found room we did not know we had.</blockquote>
    </>
  );

  const page = (() => {
    switch (template) {
      case "page":
      case "page-full-width":
      case "page-landing": {
        const Page = templates[template];
        return (
          <Page context={context} title="About the studio">
            {content}
          </Page>
        );
      }
      case "post": {
        const Post = templates.post;
        return (
          <Post
            context={context}
            title="A kitchen in nine square metres"
            date={{ iso: "2026-09-12T08:00:00.000Z", label: "12 September 2026" }}
            terms={[{ taxonomy: "category", name: "Kitchens", href: `${base}/blog/category/kitchens` }, { taxonomy: "tag", name: "Small spaces", href: `${base}/blog/tag/small-spaces` }]}
            blogHref={`${base}/blog`}
          >
            {content}
          </Post>
        );
      }
      case "blog-index": {
        const BlogIndex = templates["blog-index"];
        return <BlogIndex context={context} title="Blog" posts={posts(base)} pagination={pagination} />;
      }
      case "term-archive": {
        const TermArchive = templates["term-archive"];
        return <TermArchive context={context} taxonomy="category" name="Kitchens" description="Rooms where people cook." blogHref={`${base}/blog`} posts={posts(base)} pagination={pagination} />;
      }
      case "coming-soon": {
        const ComingSoon = templates["coming-soon"];
        return <ComingSoon context={context} />;
      }
      case "not-found": {
        const NotFound = templates["not-found"];
        return <NotFound context={context} />;
      }
    }
  })();

  return <Layout context={context}>{page}</Layout>;
}

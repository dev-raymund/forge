# ADR 0029: The Journal theme

| | |
|---|---|
| **Status** | Accepted for V1 |
| **Date** | 2026-10-17 |
| **Issue** | M8-2 (v1-github-issues.md) |
| **Decisions touched** | Plan §7 (themes); builds on ADR 0012 (the theme kit), ADR 0017 (the public content: routes, view models, the kit's blog templates), ADR 0023 (images in use: `ResponsiveImage`), ADR 0028 (the appearance editor, the variant fallback); amends ADR 0013 (what a site page ships) and the module-entry rule (plan §18) |

## Context

**M8-2's criteria:**
- Manifest, templates (page, post, blog index, archives, not found, coming soon), styles.
- Switching Studio ↔ Journal keeps kit-level settings.
- Lighthouse ≥ 90 performance and accessibility on a fixture site.
- **Testing:** E2E theme switch; axe checks on templates.

**Hand-offs:**
- **M4-4 (ADR 0012):** Journal is registered with a skeleton (layout, a `centered` header, a `simple` footer, page, coming-soon and not-found templates; Fraunces and Source Serif 4, narrow, relaxed). The blog templates, the full styles and the Lighthouse work remain.
- **M5-6 (ADR 0017):** Journal draws `page-full-width` and `page-landing` with one wide layout and the kit's `post`, `blog-index` and `term-archive`. Replace them with Journal's own. The block styles (`_kit/blocks.css`) are shared and may be adjusted in `journal/styles.css`.
- **M8-1 (ADR 0028):** the hand-off said to add Journal's variants to its definition. M8-2's brief asks the opposite: keep Journal's one header and one footer, and the fallback that draws another theme's variant as Journal's own (§4).

## Decision

### 1. The templates (`src/themes/journal/templates/`)

Every template the renderer draws is now Journal's own (`theme.ts`). None of the kit's templates is used.

| Template | Component | What it draws |
|---|---|---|
| `page` | `JournalPage` | The title, centred, then the content at the reading measure (unchanged from M4-4) |
| `page-full-width` | `JournalPageFullWidth` | The title at the measure; the content across the wide column |
| `page-landing` | `JournalPageLanding` | An opening: the title set large between rules on the page's wash; then the content across the wide column |
| `post` | `JournalPost` | A centred masthead: the categories as a kicker above the title (or "Blog" when there are none), the title, the date. The featured image across the wide column. The text at the measure, with a drop cap. What it is filed under ("Filed under" categories, "Tagged" tags, each a labelled list of links). "← All posts" |
| `blog-index` | `JournalBlogIndex` | The blog's name, "Page n of m" when there are several, a column of entries (date, title as the one link, excerpt) between double rules. The newest on page 1 is the lead, set larger. The kit's pagination, restyled |
| `term-archive` | `JournalTermArchive` | A kicker "Blog · Category" or "Blog · Tag", the term's name, its description, "Page n of m", the entries with no lead, the pagination |
| `coming-soon`, `not-found` | `JournalComingSoon`, `JournalNotFound` | Unchanged from M4-4 |

- **What a post lacks leaves nothing behind:**
  - no image: no figure;
  - no excerpt: no empty paragraph;
  - no date: no `<time>`;
  - no terms: no "Filed under" block, and the kicker is the blog's link;
  - no title: "Untitled".
- **Empty lists say so:** "Nothing has been published here yet." on the blog, and "Nothing is filed under {name} yet." on an archive.
- **Semantics:**
  - one `h1` a page;
  - entries are an ordered list of `article`s with `h2` titles;
  - an archive is a `section` named by its title;
  - the pagination is its own navigation landmark ("Pages of posts");
  - term lists are named by their visible labels (`aria-labelledby`);
  - separators (" · ", "←") are `aria-hidden`.
- **Post cards stay text-only.** `PostCard` has no image, and adding one would change the renderer's view model (ADR 0017). The design is a column of words.

### 2. Styles (`journal/styles.css`)

- **Only the kit's variables:** the site's colours, fonts, width, corners and spacing (M8-1). Journal adds proportions of them (`--forge-gap` multiples, `--forge-line`, `--forge-wash`, `--forge-muted`), never a colour or size of its own. A site's branding is drawn as chosen (tested with Journal's defaults and with a dark palette, sans-serif fonts, wide, compact and square).
- **No motion:** Journal adds no transitions or animations. Focus is the kit's (a 3 px outline in the primary colour); reduced motion is the kit's rule.
- **No sideways scroll:** long titles, words and addresses wrap: the kit's root breaks them where it must (`overflow-wrap: anywhere`), and Journal inherits it. Tested at 360, 768 and 1280 px with a long title, an unbroken word and a long address.
- **The shared block styles** (`_kit/blocks.css`) are unchanged. Journal only centres the measure, so wide images centre too.

### 3. What Journal reuses (and does not duplicate)

- **Content:** the closed renderer's output arrives as `children`. Titles, dates, excerpts and term names are text. Addresses are already public paths. No template parses a document or uses `dangerouslySetInnerHTML`.
- **Images:** `FeaturedImage`, which is `ResponsiveImage`: the stored widths (`srcset`), width and height (no layout shift), the alt text, `eager` for the post's image. Never an original. Which images may be used (same site, ready, not in the trash) is decided before the template is reached (ADR 0023).
- **Routes, lists, pagination and caching:** unchanged. M5-6's resolver, `loadPostList`, `listPageHref`, the cache tags and their invalidation (ADR 0017). A theme only draws.

### 4. Switching themes, and Journal's header and footer

- **Kit-level settings are shared** (`site_settings.theme`, plan §7): colours, fonts, width, corners, spacing, the header's sticky and button, the footer's copyright and social links. Switching to Journal draws them; switching back finds them as they were.
- **Journal draws one header (`centered`) and one footer (`simple`).** A variant saved under Studio (`minimal`, `columns`) is drawn as Journal's own (`drawnVariants`, ADR 0028 §3) and kept, so Studio draws it again after switching back (tested).

### 5. What a site page ships (amends ADR 0013)

The Lighthouse work found that every public page, in every theme, shipped about 200 KB of the admin's scripts:
- the sign-in and sign-up forms, the account menu;
- the organisation switcher and members;
- the appearance editor and site settings;
- the pages tree;
- the media library and picker.

**Why:** Next sends a route every client component reachable from its server imports, used or not. `rendering` imported `@/modules/media` for two image functions. That barrel also exports the library's screens, and its services import the tenancy, auth, sites, content and audit barrels, which export theirs.

**The fix:**
- **A third kind of module entry, `@/modules/<m>/public`:** what the public site reads from a module, server-only and UI-free. `@/modules/media/public` exports `publicImages` and `siteImagery`; `rendering` imports it instead of the barrel.
  - **The lint rule** (plan §18) allows it beside `@/modules/<m>` and `@/modules/<m>/shared`.
  - **What a public page reaches is otherwise unchanged:** the same functions, queries and cache tags.
- **The guard:** `rendering/public-bundle.test.ts` walks the app's imports from `app/(sites)`, static and dynamic, and fails if any `"use client"` module, or any module's barrel but the renderer's, is reachable. It names the chain. Restoring the barrel import makes it fail with the media library's chain (mutation check).
- **Result:** the route ships no app client component (the build's client-reference manifest lists none). A post page's scripts fell from 12 files and 331 KB to 8 files and 140 KB; its total weight fell from 436 KB to 245 KB. Studio's sites benefit the same way.

### 6. Accessibility and Lighthouse

- **axe-core 4.13.0** (dev dependency; WCAG 2.0/2.1 A and AA rules) runs in E2E:
  - on all 16 gallery templates (both themes);
  - on a live Journal site's blog, its page 2, a post, a category archive and its page 2, and a tag archive;
  - on a dark-palette Journal site at 360 and 1280 px;
  - on an empty blog;
  - after the theme switch.

  No violations.
- **Lighthouse 12.6.0** (Chrome for Testing 153, headless, `next start` production build, local Postgres) was run on a fixture: a live Journal site with five posts, two a page, in two categories and a tag, and a post whose featured image was uploaded and chosen in the app. Mobile (the default: simulated slow 4G and 4× CPU) was run five times per page, taking the median; desktop three times.

| Page | Mobile performance (median; runs) | Accessibility | Desktop performance |
|---|---|---|---|
| Blog index | **96** (82, 95, 96, 98, 96) | 100 | 100 (one cold first run at 90) |
| Post with featured image | **96** (96 ×5) | 100 | 100 |
| Category archive | **96** (96, 95, 96, 96, 96) | 100 | 100 |
| Tag archive | **99** (99, 99, 99, 98, 98) | 100 | 100 |
| Blog, page 2 | **92** (92, 92, 91, 92, 92) | 100 | 100 |

- **Before §5's fix,** the mobile medians were 92, 89, 89, 93 and 85 (LCP about 3.6 s, all of the admin's scripts counted before it).
- **After it,** LCP is 2.0–2.6 s on mobile and 0.5–0.6 s on desktop.

**Not fixed: a font swap can move text by a line.**
- **Where:** blog page 2, at 412 px (mobile only; desktop is 0). CLS was 0.123 on every run.
- **Cause:** "Why we bake at four in the morning" is 377 px wide in next/font's metric-matched fallback for Fraunces and 388 px in Fraunces, with 379 px available. It fits on one line until the font arrives, then wraps.
- **The cause is not Journal's.** The kit's fonts use `display: swap` with metric-matched fallbacks, which are good to about 3%. Whether text moves depends on the words. Optical sizing is not the cause (measured: no difference).
- **The remedies are kit-wide:**
  - `font-display: optional`: no late swap, but a first visit on a slow connection may show the fallback;
  - preloading each site's two fonts, which `next/font` cannot do per site.

  Either changes how every theme loads fonts (ADR 0012), so it is left to the launch check (M12-2: "Lighthouse ≥ 90 on both themes"), with this measurement.

## Not in M8-2

- **Menus:** M8-3. Journal's header and footer draw `context.menus`, which stay empty until then.
- **SEO, Open Graph, canonical URLs, sitemaps:** M8-4.
- **Redirects:** M8-5.
- **More Journal variants:** not asked for (§4).
- **Images on post cards:** they would need a view-model change (§1).

## Why, and what it costs

| Decision | Reason | Tradeoff | Reconsider when |
|---|---|---|---|
| Journal draws every template itself; the kit's blog templates stay in `_kit/` unused | Journal's design is its own; a third theme can start from the kit's | Unused code in the kit | A third theme ships without using them |
| Text-only post cards | No change to the renderer's view model; a reading list | No thumbnails on lists | Owners ask for them (an M5-6 view-model change, both themes) |
| One header and one footer, with the fallback | The brief; Journal is a masthead theme | A `minimal` header saved under Studio is drawn centred under Journal | Journal gets variants of its own |
| `@/modules/<m>/public` for what the public site reads | Fixes the cause at the edge where the renderer reaches another module; one more entry kind, documented and linted | Three kinds of module entry | Barrels stop exporting screens (a `ui` entry for every module) |
| A graph test, not only lint, guards the public bundle | It catches the transitive path, through any entry, `/shared` included (`media/shared` exports the picker) | A regex walk of imports, not the bundler's graph | It disagrees with the build's client-reference manifest |
| Font swap left as is | A kit-wide font-loading policy, not a theme's | A rare one-line shift on a first visit | M12-2's check, or field CLS data |

## Evidence

- **Unit (`themes.test.tsx`, 69):**
  - Journal's manifest uses no kit template.
  - **The post:** kicker, date, the image's widths, sizes and dimensions, "Filed under" and "Tagged", "All posts"; without image, date, terms or title, nothing empty.
  - **The blog:** the lead only on page 1, "Page n of m", ordered `h2` links.
  - **Archives:** category or tag, description, no lead.
  - **Pages:** the full-width and landing pages.
  - **Studio's** templates unchanged.
- **Unit (`rendering/public-bundle.test.ts`, 2):**
  - the walk reaches the renderer, both themes and media's images;
  - no client module and no foreign barrel is reachable;
  - fails when the barrel import is restored.
- **E2E (`journal-theme.spec.ts`, 3; production build; 9 of 9 over three repeats):**
  - **The blog:** a live Journal site's blog (the lead, two pages, by navigation and after a reload), a post (kicker, date, tags, the way back), a post with nothing optional, a category archive and its page 2 (by navigation and after a reload), and a tag archive.
  - **Never shown:** drafts and another site's posts are never listed; an unknown tag and pages past the end are 404s in Journal's words.
  - **Accessibility and widths:** axe on each page; no sideways scroll at 360, 768 and 1280 px; at 1280 px the terms and the way back line up with the text (a `ch` measure taken at the link's own smaller size had moved it 47 px right: found in the manual check, fixed, and the assertion fails on the old build).
  - **Other branding:** a dark palette, other fonts, wide, compact and square stay axe-clean at 360 and 1280 px; another Journal site keeps its defaults and its empty blog says so.
  - **The switch, through the admin:** a colour, wide, large corners and Studio's `minimal` and `columns` saved; switched to Journal, the editor and the live site keep them, with Journal's masthead and footer, and axe passes; switched back, Studio draws `minimal` and `columns` again.
- **E2E (`appearance.spec.ts`):** axe on all 16 gallery templates.
- **E2E (`public-content.spec.ts`):** M5-6's routes, lists and archives, now drawn by Journal.
- **Lighthouse:** §6. Run by hand, not in CI: it needs a fixture with an uploaded image and takes minutes.

## Addendum (M8-3, 2026-10-20): Journal's menus

ADR 0030 has the details. Journal's header draws the header menu centred under the masthead. A link with links under it has a button beside it; on a phone the open link's row is centred too. The footer lists the footer menu's links under their link. Only kit variables, as before.

## Addendum (M8-4, 2026-10-20): metadata and structured data

ADR 0031 has the details. Journal's templates still set no metadata: the site page's `generateMetadata` resolves it for both themes. Each live page carries one `<script type="application/ld+json">`: data, not code, with `<` escaped. The site tree still reaches no client component (`public-bundle.test.ts`).

# ADR 0012: Themes: code-defined, one registry, settings as validated variables

| | |
|---|---|
| **Status** | Accepted for V1 |
| **Date** | 2026-10-09 |
| **Issue** | M4-4 (v1-github-issues.md) |
| **Decisions touched** | D-25 (tenants configure themes, never upload code), D-27 (cache tags), D-30 (audit); builds on plan §7, ADR 0006 (one origin: no tenant script), ADR 0009 (`site.settings.manage`), ADR 0011 (sites) |

## Context

Plan §7 describes two built-in themes (Studio, business first; Journal, blog first) on a shared kit, with the customer's settings in `site_settings.theme` and the choice in `sites.theme_key`. Both columns have existed since M1-1; `createSite` already writes `studio` (the column's default). Nothing defined a theme, drew one, or let anyone choose.

M4-4 builds the kit, the registry, Studio's skeleton, Journal's skeleton (see "Journal" below), and the theme picker. No table, column or constraint changed: there is no migration. The public renderer that puts a theme on `/s/{address}` is M4-3's.

## Decision

### 1. A theme is a definition and a manifest

```text
src/themes/
├── registry.ts          THEMES (the one list), THEME_KEYS, DEFAULT_THEME_KEY, themeDefinition, activeThemeDefinition
├── render.ts            key → manifest; themeFor(site) → { theme, context }        (the renderer's entry)
├── types.ts             ThemeDefinition, ThemeManifest, ThemeContext, TEMPLATE_KEYS, TemplateProps
├── _kit/
│   ├── tokens.ts        the settings schema, readThemeSettings, parseThemeSettings, themeVariables
│   ├── font-choices.ts  the 10 curated fonts (keys, names, fallbacks): pure
│   ├── fonts.ts         the same fonts through next/font: render side only
│   ├── href.ts          siteHref: a site path gets the site's base
│   ├── kit.css          base styles, scoped to [data-forge-theme]
│   └── components/      ThemeFrame, Container, Nav, Prose
├── studio/              definition.ts · theme.ts · components/ (layout, header `classic`, footer `simple`) · templates/ · styles.css
└── journal/             the same shape (header `centered`, footer `simple`)
```

- **The definition** is pure data: key, name, description, version, its default kit settings, its own options schema, the header and footer variants it draws, how the picker sketches it. The admin's picker and the settings validation read only definitions, through `registry.ts`.
- **The manifest** is the definition plus React: a `Layout` (the frame of every page) and one component per template. Only `render.ts` imports manifests, and only the site renderer imports `render.ts`. No theme component or stylesheet reaches the admin bundle.
- Plan §7 has one `manifest.ts` per theme. It is split in two (`definition.ts`, `theme.ts`) for the reason above; nothing about a theme is written twice: `theme.ts` spreads the definition.
- **Templates in M4-4:** `page` (the default page template), `coming-soon`, `not-found`. M5-6 adds post, blog index and archives; M8-1 Studio's other header and footer variants.

### 2. The registry is an allow-list

`THEMES` is an array of definitions; a key is compared with each entry's `key`. It is never used as a path, a module name or a property of a plain object. An unknown key (`__proto__`, `../journal`, `Studio`, a theme removed later) finds nothing:

- for choosing, it is refused (`Validation`: "Choose one of the themes.");
- for drawing, the site is drawn with the default theme (`activeThemeDefinition`), instead of failing.

Adding a theme is plan §7's three steps: a folder, a line in `THEMES` and in `render.ts`, nothing in the database.

### 3. Settings

Stored in `site_settings.theme`, in plan §7's shape:

```text
{ tokens: { colors: { primary, accent, background, text }, fonts: { heading, body } },
  header: { variant, sticky, cta: { label, href } | null },
  footer: { variant, copyright, showSocial },
  layout: { width, radius, density },
  options: { [themeKey]: { … } } }
```

- **Every value is a closed choice or a strict shape.** Colours are `#rgb`/`#rrggbb` (stored as `#rrggbb`); fonts are keys of the curated list; variants, width (`narrow`/`normal`/`wide`), radius (`none`/`small`/`medium`/`large`) and density (`compact`/`normal`/`relaxed`) are enums; the button's link is a site path or an `https`/`http`/`mailto`/`tel` address, never `javascript:`, `data:` or `//other.host`.
- **Two ways in:**
  - `parseThemeSettings(input, theme, stored)`, strict, for what someone submits (M8-1's editor will save through it): an unknown key anywhere, an unsafe value, a missing group, or options for another theme is a `ZodError`, and nothing is written. Other themes' stored options are carried over.
  - `readThemeSettings(stored, defaults)`, lenient, for drawing a page: each stored value that passes its rule is used, every other value is the theme's default, one by one. A damaged row cannot take a site down, and one bad value cannot take the others with it.
- **Defaults:** each theme has a complete set. What the site has saved overrides them value by value, so a site that never customised anything gets each theme's own look; once it has chosen colours or fonts, those follow it from theme to theme.
- **Switching keeps the branding** (plan §7): the kit-level settings are every theme's. Each theme's own extras live under `options[key]`, so leaving a theme keeps its options and switching back restores them. Neither theme has options yet (both schemas are empty and strict).
- **Contrast:** text on the primary and accent colours is chosen (white or near-black) from the colour's luminance. The editor's contrast warning is M8-1's.

### 4. CSS from settings: variables only

`themeVariables(settings)` returns eleven custom properties (`--forge-color-*`, `--forge-font-heading|body`, `--forge-content-width`, `--forge-radius`, `--forge-space`). The names are fixed in code; every value is a validated colour, a curated font stack, or a value from a closed table. They are applied as the theme root's `style` attribute (React escapes it), so there is no stylesheet text a value could break out of. No site ever supplies CSS or script. The theme stylesheets are scoped (`[data-theme="studio"]`, `[data-theme="journal"]`, the kit under `[data-forge-theme]`) and read only those variables.

### 5. Fonts

Ten curated fonts (five sans, five serif) through `next/font/google`: fetched once at build time and served by the app, so a visitor's browser never asks Google for anything. All are declared, none is preloaded, and a page applies only its site's two font classes, so a browser downloads two fonts at most (checked in a browser: Studio loads Manrope and Inter, Journal Fraunces and Source Serif 4). Latin and Latin Extended; other scripts fall back to the system's fonts.

### 6. Choosing a theme

```text
chooseTheme(ctx: SiteContext, { theme })       modules/sites/appearance.service.ts
  requirePermission(ctx, "site.settings.manage")   Owner, Admin (plan §13: "settings, appearance, …")
  chooseThemeSchema: a key of the registry
  inTenant: update sites.theme_key; record "site.theme_changed" (name, previousTheme, newTheme)
  → events: site.statusChanged → site:{id}
```

- **Only the key changes.** `site_settings`, the address and every other column stay byte for byte (tested). Content is the content module's and is not touched.
- **Atomic with its record:** an audit failure, or a refused commit, leaves the old key.
- **The same theme again** changes and records nothing.
- **The form** sends `theme` and nothing else is read; the site and the permission come from the URL and the session.
- **Cache:** `site:{id}`, the plan's umbrella tag for "site status or theme switch", flushed with `updateTag` after the commit (the existing `site.statusChanged` event maps to it).

### 7. The picker

`/{org}/sites/{site}/appearance` (plan §19, Admin): the registry's themes as radio cards (a sketch drawn from the theme's default colours, its name and description), the current one marked, and "Use this theme". Other members get the no-access notice and no link to the page. The picker component takes the themes and the current key, so onboarding's step 3 (M4-2) reuses it with the same action.

### 8. The contract with the renderer (M4-3, M5-6)

```ts
themeFor(site: RenderableSite) → { theme: ThemeManifest; context: ThemeContext }
<theme.Layout context={context}>
  <theme.templates["coming-soon"] context={context} />        // or page (title + content), or not-found
</theme.Layout>
```

- **`RenderableSite`** is what the renderer reads for a site: name, tagline, language, base path, `theme_key`, the stored `site_settings.theme`, and menus (empty until M8-3).
- **`ThemeContext`** is all a theme may know: public data only. There is no session, member, organization id or database handle in it, and a theme never reads the database.
- **Links** are built from the base path (`/s/{address}` in V1).
- **Left to the renderer:** choosing the template (coming soon, not found, page), `noindex` on coming-soon pages, `<html lang>`, and resolving the site. Those are M4-3's.

### 9. The gallery (development only)

`/dev/themes/{theme}/{template}` draws every template of every theme through `themeFor`, with made-up data (including markup in the site's name that must come out as text). It is the only place the themes can be seen before M4-3, and it is where the browser tests check them.

- It has its own root layout (no admin CSS, as on a real site).
- It reads no database and no session.
- It is a static page that answers 404 in production, like `/dev/editor`.
- It is not a site preview: preview tokens are M7-4's.

### Journal

The issue file puts Journal in M8-2. The M4-4 instructions ask for both built-in themes to be registered here. Journal therefore exists now with the same skeleton as Studio (layout, a `centered` header, a `simple` footer, page, coming-soon and not-found templates, its own styles and defaults). Its blog templates, archives and Lighthouse work stay in M8-2.

## Why, and what it costs

| Decision | Reason | Tradeoff | Reconsider when |
|---|---|---|---|
| Definition and manifest in separate files | The admin needs names and defaults, never theme components or CSS | Two files per theme instead of one | — |
| Settings as custom properties in `style` | Nothing a customer saves is ever CSS text | Themes can only vary what the kit exposes as a variable | A theme needs a setting the kit does not have: add it to the kit |
| Lenient reading, strict writing | A site keeps rendering whatever is stored; nothing invalid is ever saved | A damaged value is silently replaced by the default on screen | — |
| Fonts from `next/font/google` at build time | Self-hosted, no visitor request to Google, no font files in the repository | The build needs to reach Google Fonts | Builds must run offline: switch to `next/font/local` with committed files |
| Unknown stored key → the default theme | A removed theme cannot take sites down | The site changes look without anyone choosing | — |
| A development gallery | The templates can be seen and tested before the renderer exists | One more `/dev` page | M4-3 renders themes on `/s/*`: the gallery stays for theme work |

## Not in V1 (or not in M4-4)

A theme marketplace, uploaded themes, custom CSS, tenant code, editable template parts (plan §7); the appearance editor and live preview (M8-1); Journal's blog templates (M8-2); the renderer's use of themes on `/s/*` (M4-3); block renderers (M5-6); theme strings in the site's language (the templates' few words, "Coming soon", "Page not found", are English).

## Evidence

- `src/themes/_kit/tokens.test.ts`: unsafe colours, links, keys and missing groups refused; lenient reading value by value; the CSS builder's output is the kit's variables only, each value from a validated set.
- `src/themes/themes.test.tsx`: the registry (two themes, unique keys, the default matching the column's default, every definition valid), unknown keys, every manifest complete, each template's landmarks, single `h1`, escaped text, links from the base path, unsafe buttons not drawn.
- `src/modules/sites/ui/ui.test.tsx`: the picker's radios, the current theme, the sketches.
- `tests/integration/appearance.test.ts` (real Postgres): the default; choosing as Owner and Admin; only the key changes; switching back keeps the saved branding; the same theme records nothing; invalid keys; extra form fields ignored; Editors, Authors and Viewers refused; another organization's site not found; a deleted site; an audit failure and a refused commit leaving the old key; damaged stored settings; an unknown stored key.
- `tests/integration/isolation.test.ts`: the theme form with another organization's site, from either URL.
- `tests/e2e/appearance.spec.ts`: switch, reload, keyboard; an Editor; a phone; every gallery template (landmarks, one `h1`, the variables applied, the skip link, no script run, 360 px).

---

## Addendum (M4-2, 2026-10-10): social links in the theme context

`ThemeContext.site.social` holds the site's social links (already validated as `https` addresses, ADR 0014), in the networks' order. Studio's and Journal's footers draw them as a "Social" navigation (`rel="me noopener noreferrer"`) when `settings.footer.showSocial` (default true; the switch is M8-1's). The theme context still has no analytics: the site layout emits those (ADR 0014 §3).

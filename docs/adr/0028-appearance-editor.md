# ADR 0028: The appearance editor

| | |
|---|---|
| **Status** | Accepted for V1 |
| **Date** | 2026-10-17 |
| **Issue** | M8-1 (v1-github-issues.md) |
| **Decisions touched** | Plan §7 (themes and their settings); builds on ADR 0012 (the theme kit: `parseThemeSettings`, `readThemeSettings`, the CSS variables), ADR 0014 (site settings and their version; the social links), ADR 0023 (the logo), ADR 0027 (preview tokens and their route), ADR 0010 (the audit vocabulary) |

## Context

**M8-1's criteria:**
- **`/…/appearance`:** logo, colours (4 tokens with a contrast warning), fonts (heading and body), header variant + sticky + CTA, footer variant + copyright + social toggle, layout (width, radius, density).
- **A live preview** iframe using a preview token with unsaved settings.
- **Saved** to `site_settings.theme`; invalidates `site:{id}:config`.
- **Studio** gets all the header (3) and footer (2) variants.
- **Testing:** invalid tokens rejected (unit); E2E "change colour → live site updated".

**Hand-offs:**
- **M4-4 (ADR 0012):** save through `parseThemeSettings(input, theme, stored)`; `readThemeSettings` reads everything the editor saves; `readableOn` and `luminance` are there for the contrast warning; add the editor below the theme picker.
- **M4-2 (ADR 0014):** the social toggle is `footer.showSocial`.

**The schema already held every control.** No migration was needed: `site_settings.theme` (JSONB) and the settings `version` exist.

## Decision

### 1. The controls (`sites/ui/appearance-editor.tsx`)

The page (Owner and Admin, `site.settings.manage`, as in M4-4) has three parts:
- **Theme:** the M4-4 picker.
- **Logo:** the M6-4 control, the same component and action as on the settings page, which keeps its own.
- **Customise {theme}:** the editor below.

| Group | Controls | Stored as |
|---|---|---|
| Colours | Primary, accent, background, text: a colour picker and a `#rrggbb` field each; the contrast warning under them | `tokens.colors` |
| Fonts | Headings and body text: the curated list (sans serif and serif) | `tokens.fonts` |
| Header | Style (the theme's variants only), "Stay at the top while scrolling", "Show a button" with its label (1–40) and link (a site path or `https`/`http`/`mailto`/`tel`) | `header` |
| Footer | Style (the theme's variants only), the copyright line (≤ 200), "Show the site's social links" | `footer` |
| Layout | Content width (narrow, normal, wide), corners (none to large), spacing (compact, normal, relaxed) | `layout` |

- **Every value is a closed choice or a strict shape** (ADR 0012). No CSS, HTML or script typed by the site owner reaches a page. The variables are built from validated values and set as the theme root's `style`.
- **The contrast warning** (`contrastWarnings`, the kit, WCAG 2):
  - text on the background below 4.5:1;
  - the primary or accent colour on the background below 3:1.

  It warns and does not refuse: the owner decides. Text on primary and accent surfaces is already chosen for them (`readableOn`). The themes' own defaults raise no warning (tested).
- **Unsaved changes** stay in the editor, marked "Unsaved changes", until saved or discarded.
  - **Save** sends every group (the schema wants them all) and is shown as saved only once the server has answered.
  - **Discard changes** returns to what was saved.
  - The editor starts again when the theme is switched, since it brings its own variants.
- **Field errors** come back keyed by the setting's path (`tokens.colors.primary`, `header.cta.href`) and are shown at the field. A colour that is not one is shown at once, and Save is disabled until it is fixed.
- **Usability:** fieldsets with legends, labelled inputs, radios that move with the arrow keys, and Enter to save. On a phone the preview comes after the form, with no sideways scrolling (tested at 390 px).

### 2. Saving (`sites/appearance.service.ts`, `updateAppearance`)

1. **The permission:** `requirePermission(site.settings.manage)`.
2. **The settings,** checked strictly:
   - `parseThemeSettings`: every group present, no unknown key, no other theme's options, other themes' stored options kept;
   - the header and footer variants must be ones the site's theme draws ("Journal has no minimal header.").
3. **One transaction:**
   - the groups that changed are measured against what the site is drawn with now, and nothing changed means nothing is written, recorded or flushed;
   - `site_settings.theme` is written if the settings are still at the version the page was opened with. This is the same token as M4-2's other groups, so someone else's save since is a Conflict and nothing is written;
   - `site.settings_changed` is recorded with the new group `appearance` and the groups that changed (`colors`, `fonts`, `header`, `footer`, `layout`). A record that cannot be written saves nothing.
4. **After the commit:** `site.configChanged` is flushed, which is `site:{id}:config`, the tag `loadPublicSite` is read under. The public site shows the change on the next request.
   - Only that site's tag: another site of the organization is untouched (tested).
   - Nothing is cached globally.

**Untouched:** the logo and favicon (their own columns and action, M6-4), the general, reading and analytics groups, the theme key, and other themes' options.

**A site saved before M8-1, or with damaged settings,** is drawn value by value with the theme's defaults (`readThemeSettings`, unchanged), and saves normally.

### 3. Studio's variants (and the fallback)

- **Studio's definition** declares every variant the kit has: headers `classic`, `centered`, `minimal`; footers `simple`, `columns`.
  - **`classic`:** the name on the left, the menu and button on the right (as before).
  - **`centered`:** the name and tagline centred, with the menu and button under them.
  - **`minimal`:** a slim bar, where the button is a plain link.
  - **`simple`:** one line (as before).
  - **`columns`:** name, tagline and copyright | footer menu | social links.
- **Journal** still draws one of each (`centered`, `simple`). Its blog templates and styles are M8-2's.
- **A variant a theme does not draw** (one saved under the other theme) is drawn as the theme's first (`drawnVariants`, in `themeFor`), as the theme type always said. The stored value is kept, so switching back restores it.

### 4. The live preview: a token that carries the unsaved settings

- **The editor** asks for a preview a moment after each change (600 ms). `createAppearancePreview` runs the same checks as saving, then signs a 15-minute **appearance token**:
  - `{ v: 1, k: "appearance", o, s, u, t: kit settings, x }`;
  - HMAC with `PREVIEW_TOKEN_SECRET` under its own label (`forge-preview:appearance:v1`), so it is never read as an entry's preview token, nor the other way round (tested);
  - the route's token size limit was raised to about 4 KB for the settings it carries (the longest the kit allows fit; tested).
- **The proxy** accepts either kind at `/_forge/preview/{token}` and sends ADR 0027's headers (`private, no-store`, `noindex`, `no-referrer`, admin-only framing).
- **The page** (`rendering/appearance-preview.ts`, `loadAppearancePreview`):
  - checks the token again;
  - checks the settings again against the kit's schema;
  - requires the person it names to still hold `site.settings.manage` (asked of their role now);
  - requires the site to be neither deleted nor suspended. Coming soon does not stop it;
  - draws the site's home page (its published Home page, or its name and tagline) with the token's settings and the saved logo, social links and theme options, under a banner: "Preview of your appearance changes · Not saved yet: visitors see the saved appearance until you save."
  - **Nothing is written:** the settings live in the token and are never cached.
- **The frame** is ADR 0027's: sandboxed, no referrer, with "Open in a new tab".

## Not in M8-1

- **Journal's other variants, blog templates and styles:** M8-2.
- **Menus:** M8-3. The headers and footers draw empty menus until then.
- **SEO and Open Graph:** M8-4.
- **Previews of pages other than the home page.** The home page shows the header, the footer and the colours; posts use the same frame.
- **Custom CSS or code:** never (plan §7, D-25).

## Why, and what it costs

| Decision | Reason | Tradeoff | Reconsider when |
|---|---|---|---|
| The unsaved settings travel in the token | No draft-settings table, nothing private stored, nothing to clean up | A longer URL (bounded by the kit's limits) | Settings grow past a few KB |
| One version for every settings group | M4-2's token, one row; no lost update between the two pages | Saving the appearance makes an open settings page reload before it saves | The groups move to rows of their own |
| A warning, not a refusal, for contrast | Brand colours are the owner's call; the plan asks for a warning | A site can be hard to read | Accessibility rules for paid plans |
| The editor offers only the theme's variants | No choice that would be drawn as something else | A variant from the other theme stays stored, unseen until switching back | — |
| The logo control appears on both pages | The criterion lists it here; M6-4's place stays | Two places for one setting, one component and one action | The settings page is reorganised |

## Evidence

- **`tests/integration/appearance-editor.test.ts`** (11, real Postgres through PgBouncer):
  - **Saving:** every group saved at the next version, recorded with the groups, flushing `site:{id}:config`, read by the public site under that tag and drawn with the new variables.
  - **Nothing else changes:** general, reading, analytics, logo, other themes' options; only changed groups recorded; the same settings again changes nothing.
  - **Refusals, keyed by the setting:** a colour that is not one, a CSS injection, an unknown font, a `javascript:` link, button labels empty or too long, a copyright too long, a width outside the list, a missing group, an unknown key, another theme's options, Journal's absent variants.
  - **Conflict:** a stale version refused, also through the form.
  - **Roles:** Owner and Admin save; Editor, Author and Viewer are refused (save, preview, form).
  - **Sites:** one site leaves another unchanged; old or damaged settings are drawn with defaults and saved; a failed record saves nothing; the logo rules unchanged.
  - **The preview:** draws the home page with the unsaved settings and writes nothing (an organization digest), the public site keeping the saved ones; it works on Coming soon; the role is checked again (an Admin demoted, then restored); refused for a changed token, bad settings in a signed one, expiry, an entry's token, and a suspended site.
  - **Mutation checks:**
    - without the variant check, the Journal refusal test fails;
    - without the preview's role re-check, the demotion test fails.
- **`isolation.test.ts`:** `submitUpdateAppearance` (B's URL, A's slug, B's site id) and `submitAppearancePreview` with B's site.
- **Unit:**
  - contrast ratio and warnings;
  - Studio's three headers and two footers, and the fallback for Journal;
  - appearance tokens (claims, expiry, never read as the other kind, the longest settings fit the route).
- **E2E `appearance-editor.spec.ts`** (2, production build; 10 of 10 over five repeats):
  - **The editor:** the contrast warning appears and clears; a colour, a heading font, the centred header with a button, the columns footer with a copyright line, and the wide layout; "Unsaved changes".
  - **Preview, then save:** the preview shows them while a visitor still sees the old site; Save, then the visitor's reload shows them; the page reopens with them; Discard.
  - **Limits:** a colour that is not one refused in place, with Save disabled; a phone width with no sideways scroll; the keyboard (arrows, Enter); an Editor gets the no-access notice.

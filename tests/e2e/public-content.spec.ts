import { randomBytes } from "node:crypto";
import { expect, test, type Page } from "@playwright/test";
import { uuidv7 } from "uuidv7";
import { asUniqueVisitor } from "./helpers/auth";
import { homePageOf, seedPublishedEntry, seedSiteSettings, seedTerm, trashEntry } from "./helpers/content";
import { markEmailVerified, seedOrganization, sitesIn } from "./helpers/orgs";
import { createSite, expectSiteCreated, memberOf } from "./helpers/site-ui";
import { addMember, publicView, seedSite, seedUser, type SeededSite } from "./helpers/sites";

/**
 * M5-6 end to end against the production build: a live site's published pages, posts, blog and archives at their
 * public addresses, drawn by its theme; drafts, the trash and other sites' content out of reach; hostile documents
 * inert; and the public pages fresh after publishing, a status change and a theme switch, made in the admin.
 */

const tail = () => randomBytes(3).toString("hex");
const siteUrl = (site: SeededSite | string, path = "/") => `/s/${typeof site === "string" ? site : site.address}${path === "/" ? "" : path}`;
const robots = (page: Page) => page.locator('meta[name="robots"]').evaluateAll((elements) => elements.map((element) => element.getAttribute("content")));
const shown = (page: Page, testId: string) => page.getByTestId(testId).filter({ visible: true });
const sidewaysScroll = (page: Page) => page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
const id = () => uuidv7();
const p = (text: string, marks?: unknown[]) => ({ type: "paragraph", attrs: { id: id() }, content: [{ type: "text", text, ...(marks ? { marks } : {}) }] });
const doc = (...content: unknown[]) => ({ v: 1, doc: { type: "doc", content } });

/** Nothing third-party is loaded by a test: frames to video and map hosts are refused before they leave. */
async function noThirdParties(page: Page) {
  const outside: string[] = [];
  await page.context().route(/youtube-nocookie\.com|youtube\.com|vimeo\.com|openstreetmap\.org|googletagmanager\.com|google-analytics\.com|plausible\.io/, (route) => {
    outside.push(route.request().url());
    return route.abort();
  });
  return outside;
}

/** A live site with a Home page made of blocks, pages (one nested), three posts in a category and a tag, and the leftovers that must not show. */
async function seedBakery(theme: "studio" | "journal" = "studio") {
  const site = await seedSite("bakery", "Bread & more", { status: "live", theme });
  const other = await seedSite("other", "Someone else", { status: "live" });
  const otherSecret = id();
  await seedPublishedEntry(other.orgId, other.siteId, { id: otherSecret, type: "page", title: "Their page", slug: "their-page", path: "/their-page", content: doc(p("Not yours")) });
  await seedSiteSettings(site.orgId, site.siteId, { reading: { blogPath: "news", postsPerPage: 2 }, analytics: { ga4MeasurementId: "G-ABC1234567", plausibleDomain: "bakery.example.org" } });

  const [about, team, home] = [id(), id(), id()];
  const bread = await seedTerm(site.orgId, site.siteId, "category", "bread", "Bread", "Loaves of every kind");
  const rye = await seedTerm(site.orgId, site.siteId, "tag", "rye", "Rye");
  await seedPublishedEntry(site.orgId, site.siteId, { id: about, type: "page", title: "About us", slug: "about", path: "/about", template: "full-width", content: doc(p("Since 1902.")) });
  await seedPublishedEntry(site.orgId, site.siteId, { id: team, type: "page", title: "Our team", slug: "team", path: "/about/team", parentId: about, content: doc(p("Bakers and friends.")) });
  await seedPublishedEntry(site.orgId, site.siteId, {
    id: home, type: "page", title: "Welcome to the bakery", slug: "home", path: "/", template: "landing",
    content: doc(
      p("Fresh bread every morning, and a very long word: Donaudampfschifffahrtsgesellschaftskapitänswitwenrentenversicherung."),
      {
        type: "columns", attrs: { id: id(), v: 1, count: 2, ratio: "2:1", stackOnMobile: true },
        content: [
          { type: "column", attrs: { id: id() }, content: [p("Read about us", [{ type: "link", attrs: { href: `entry:${about}` } }]), p("A link to another site's page", [{ type: "link", attrs: { href: `entry:${otherSecret}` } }])] },
          { type: "column", attrs: { id: id() }, content: [{ type: "button", attrs: { id: id(), v: 1, label: "Meet the team", href: `entry:${team}`, style: "primary", align: "start", newTab: false } }] },
        ],
      },
      { type: "spacer", attrs: { id: id(), v: 1, size: "lg" } },
      { type: "embed", attrs: { id: id(), v: 1, provider: "youtube", url: "https://www.youtube.com/watch?v=dQw4w9WgXcQ", aspect: "16:9" } },
      { type: "embed", attrs: { id: id(), v: 1, provider: "generic", url: "https://www.openstreetmap.org/export/embed.html", aspect: "4:3" } },
      { type: "button", attrs: { id: id(), v: 1, label: "Order online", href: "https://example.org/order", style: "secondary", align: "center", newTab: true } },
    ),
  });
  const day = (n: number) => new Date(Date.UTC(2026, 8, n, 9));
  await seedPublishedEntry(site.orgId, site.siteId, { id: id(), type: "post", title: "Rye season", slug: "rye-season", path: "/news/rye-season", excerpt: "Dark and sour.", termIds: [bread, rye], publishedAt: day(20), content: doc(p("Rye is back.")) });
  await seedPublishedEntry(site.orgId, site.siteId, { id: id(), type: "post", title: "Our new oven", slug: "new-oven", path: "/news/new-oven", excerpt: "", termIds: [], publishedAt: day(10), content: doc(p("It is big.")) });
  await seedPublishedEntry(site.orgId, site.siteId, { id: id(), type: "post", title: "Opening day", slug: "opening-day", path: "/news/opening-day", excerpt: "We opened.", termIds: [bread], publishedAt: day(1), content: doc(p("Come in.")) });
  // Never public: a draft, a page in the trash, a draft post.
  await seedPublishedEntry(site.orgId, site.siteId, { id: id(), type: "page", title: "Secret menu", slug: "secret-menu", path: "/secret-menu", content: doc(p("Draft only")), draftOnly: true });
  await seedPublishedEntry(site.orgId, site.siteId, { id: id(), type: "post", title: "Unfinished post", slug: "unfinished", path: "/news/unfinished", content: doc(p("Draft post")), draftOnly: true });
  const old = id();
  await seedPublishedEntry(site.orgId, site.siteId, { id: old, type: "page", title: "Old offer", slug: "old-offer", path: "/old-offer", content: doc(p("Expired")) });
  await trashEntry(site.orgId, old);
  return { site, other };
}

test.beforeEach(async ({ page }) => {
  await asUniqueVisitor(page);
});

test("a live site's pages, posts, blog and archives at their addresses, in its theme; links and blocks as published", async ({ page }) => {
  const outside = await noThirdParties(page);
  const { site } = await seedBakery();

  // The Home page: its landing template and its blocks.
  const home = (await page.goto(siteUrl(site)))!;
  expect(home.status()).toBe(200);
  expect(await publicView(page)).toMatchObject({ heading: "Welcome to the bakery", theme: "studio" });
  expect(await robots(page)).toEqual(["index, follow"]);
  await expect(page).toHaveTitle(site.name);
  const main = page.getByRole("main");
  await expect(main.locator(".studio-page--landing")).toHaveCount(1);
  await expect(main.getByRole("link", { name: "Read about us" })).toHaveAttribute("href", `/s/${site.address}/about`);
  await expect(main.getByText("A link to another site's page")).toBeVisible();
  await expect(main.getByRole("link", { name: "A link to another site's page" })).toHaveCount(0); // another site's entry: plain text
  await expect(main.getByRole("link", { name: "Meet the team" })).toHaveAttribute("href", `/s/${site.address}/about/team`);
  const order = main.getByRole("link", { name: "Order online" });
  await expect(order).toHaveAttribute("href", "https://example.org/order");
  await expect(order).toHaveAttribute("target", "_blank");
  await expect(order).toHaveAttribute("rel", "noopener noreferrer");
  const [video, map] = [main.locator("iframe").nth(0), main.locator("iframe").nth(1)];
  await expect(main.locator("iframe")).toHaveCount(2);
  await expect(video).toHaveAttribute("src", "https://www.youtube-nocookie.com/embed/dQw4w9WgXcQ");
  await expect(video).toHaveAttribute("title", "YouTube video");
  await expect(map).toHaveAttribute("src", "https://www.openstreetmap.org/export/embed.html");
  for (const frame of [video, map]) {
    await expect(frame).toHaveAttribute("loading", "lazy");
    await expect(frame).toHaveAttribute("sandbox", /^allow-scripts allow-same-origin allow-presentation allow-popups( allow-forms)?$/);
    await expect(frame).toHaveAttribute("referrerpolicy", "strict-origin-when-cross-origin");
  }
  await expect(map).not.toHaveAttribute("allow", /.+/);
  // The columns sit side by side at their widths on a wide screen.
  const columns = main.locator(".forge-column");
  const [left, right] = [(await columns.nth(0).boundingBox())!, (await columns.nth(1).boundingBox())!];
  expect(Math.abs(left.y - right.y)).toBeLessThan(2);
  expect(left.width / right.width).toBeGreaterThan(1.6);

  // Pages, the nested one, the full-width template.
  expect((await page.goto(siteUrl(site, "/about")))!.status()).toBe(200);
  expect(await publicView(page)).toMatchObject({ heading: "About us" });
  await expect(page.getByRole("main").locator(".studio-page--wide")).toHaveCount(1);
  await expect(page).toHaveTitle(`About us · ${site.name}`);
  await page.goto(siteUrl(site, "/about/team"));
  expect(await publicView(page)).toMatchObject({ heading: "Our team" });

  // The blog, under its path (news), two a page, newest first; then page 2.
  expect((await page.goto(siteUrl(site, "/news")))!.status()).toBe(200);
  const posts = page.getByRole("main").locator(".forge-post-card__title a");
  await expect(posts).toHaveText(["Rye season", "Our new oven"]);
  await expect(posts.first()).toHaveAttribute("href", `/s/${site.address}/news/rye-season`);
  await expect(page.getByRole("main").locator("time").first()).toHaveAttribute("datetime", "2026-09-20T09:00:00.000Z");
  const pages = page.getByRole("navigation", { name: "Pages of posts" });
  await expect(pages).toContainText("Page 1 of 2");
  await pages.getByRole("link", { name: /Older posts/ }).click();
  await expect(page).toHaveURL(new RegExp(`/s/${site.address}/news/page/2$`));
  await expect(posts).toHaveText(["Opening day"]);
  await expect(page).toHaveTitle(`Blog · Page 2 · ${site.name}`);

  // A post, its category and tag, and their archives.
  await page.goto(siteUrl(site, "/news/rye-season"));
  expect(await publicView(page)).toMatchObject({ heading: "Rye season" });
  await expect(page.getByRole("main")).toContainText("Rye is back.");
  await page.getByRole("main").getByRole("link", { name: "Bread" }).click();
  await expect(page).toHaveURL(new RegExp(`/s/${site.address}/news/category/bread$`));
  expect(await publicView(page)).toMatchObject({ heading: "Bread" });
  await expect(page.getByRole("main")).toContainText("Loaves of every kind");
  await expect(posts).toHaveText(["Rye season", "Opening day"]);
  await page.goto(siteUrl(site, "/news/tag/rye"));
  await expect(posts).toHaveText(["Rye season"]);

  expect(outside.filter((url) => !/youtube-nocookie|openstreetmap/.test(url))).toEqual([]); // only the two frames asked, and they were refused
});

test("never public: drafts, the trash, other sites' pages, unknown terms, pages past the end, other spellings; analytics stays off", async ({ page }) => {
  await noThirdParties(page);
  const { site, other } = await seedBakery("journal");
  for (const path of ["/secret-menu", "/news/unfinished", "/old-offer", "/their-page", "/news/category/nothing", "/news/tag/bread", "/news/page/3", "/news/page/1", "/About", "/about%2Fteam", "/home", "/blog"]) {
    const response = (await page.goto(siteUrl(site, path)))!;
    expect(response.status(), path).toBe(404);
    await expect(page.getByRole("heading", { level: 1 })).toHaveText("Page not found");
    expect((await publicView(page)).theme, path).toBe("journal");
    expect(await robots(page), path).toContain("noindex");
  }
  // The other site still has its page; this site's address never shows it.
  expect((await page.goto(siteUrl(other, "/their-page")))!.status()).toBe(200);

  // Journal draws the blog with the kit's templates (its own are M8-2's).
  await page.goto(siteUrl(site, "/news/rye-season"));
  expect(await publicView(page)).toMatchObject({ heading: "Rye season", theme: "journal" });
  await expect(page.locator(".forge-post")).toHaveCount(1);
  // No tracking script, and the IDs are not in the page.
  const html = await page.content();
  for (const leak of ["googletagmanager", "plausible", "G-ABC1234567", "bakery.example.org", site.siteId, site.orgId]) expect(html, leak).not.toContain(leak);
  expect(await page.evaluate(() => typeof (window as unknown as { gtag?: unknown }).gtag)).toBe("undefined");
});

test("a hostile document written around the services renders nothing that runs", async ({ page }) => {
  const outside = await noThirdParties(page);
  const site = await seedSite("hostile", "x", { status: "live" });
  const hostile = doc(
    p("<script>window.__xss = (window.__xss || 0) + 1</script><img src=x onerror=\"window.__xss = 1\">"),
    p("bad link", [{ type: "link", attrs: { href: "javascript:window.__xss=1" } }]),
    p("data link", [{ type: "link", attrs: { href: "data:text/html,<script>parent.__xss=1</script>" } }]),
    { type: "html", attrs: { id: id(), html: "<img src=x onerror='window.__xss=1'>" } },
    { type: "iframe", attrs: { src: "javascript:window.__xss=1" } },
    { type: "paragraph", attrs: { id: id(), onclick: "window.__xss=1", style: "background:url(javascript:x)" }, content: [{ type: "text", text: "attrs" }] },
    { type: "button", attrs: { id: id(), v: 1, label: "<b>Go</b>", href: "javascript:window.__xss=1", style: "primary", align: "start", newTab: false } },
    { type: "button", attrs: { id: id(), v: 1, label: "Styled", href: "/", style: 'primary" onmouseover="window.__xss=1', align: "start", newTab: false } },
    { type: "embed", attrs: { id: id(), v: 1, provider: "generic", url: "https://localhost/admin", aspect: "16:9" } },
    { type: "embed", attrs: { id: id(), v: 1, provider: "generic", url: "https://127.0.0.1/", aspect: "16:9" } },
    { type: "embed", attrs: { id: id(), v: 1, provider: "youtube", url: "https://youtube.com.evil.example/watch?v=dQw4w9WgXcQ", aspect: "16:9" } },
    { type: "embed", attrs: { id: id(), v: 1, provider: "youtube", url: "https://youtu.be/dQw4w9WgXcQ", aspect: "16:9", srcdoc: "<script>parent.__xss=1</script>" } },
    { type: "columns", attrs: { id: id(), v: 1, count: 2, ratio: "1:1;background:url(javascript:x)" }, content: [] },
    { type: "spacer", attrs: { id: id(), v: 1, size: 'md" onclick="window.__xss=1' } },
  );
  await seedPublishedEntry(site.orgId, site.siteId, { id: id(), type: "page", title: "Hostile <script>window.__xss=1</script>", slug: "home", path: "/", content: hostile });
  expect((await page.goto(siteUrl(site)))!.status()).toBe(200);
  await expect(page.getByRole("main")).toContainText("bad link");
  await page.getByText("bad link").click();
  await page.mouse.move(10, 10);
  expect(await page.evaluate(() => (window as unknown as { __xss?: number }).__xss)).toBeUndefined();
  const main = await page.getByRole("main").innerHTML();
  // Markup only: the hostile words are there, as escaped text.
  expect(main).toContain("&lt;script&gt;");
  expect(main).not.toMatch(/<script|<img|<[^>]+\s(?:href|src)="\s*(?:javascript|data):|<[^>]+\son[a-z]+=|<[^>]+srcdoc|<[^>]+style="[^"]*url\(/i);
  // Only the one valid video frame, from its privacy player.
  await expect(page.getByRole("main").locator("iframe")).toHaveCount(1);
  await expect(page.getByRole("main").locator("iframe")).toHaveAttribute("src", "https://www.youtube-nocookie.com/embed/dQw4w9WgXcQ");
  await expect(page.getByRole("heading", { level: 1 })).toHaveText("Hostile <script>window.__xss=1</script>");
  expect(outside.filter((url) => /localhost|127\.0\.0\.1|evil/.test(url))).toEqual([]);
});

test("on a phone: the columns stack, long words wrap, nothing scrolls sideways; the blog's lists fit too", async ({ page }) => {
  await noThirdParties(page);
  const { site } = await seedBakery();
  await page.setViewportSize({ width: 360, height: 740 });
  await page.goto(siteUrl(site));
  const columns = page.getByRole("main").locator(".forge-column");
  const [left, right] = [(await columns.nth(0).boundingBox())!, (await columns.nth(1).boundingBox())!];
  expect(right.y).toBeGreaterThanOrEqual(left.y + left.height - 1);
  expect(await sidewaysScroll(page)).toBe(0);
  for (const path of ["/news", "/news/rye-season", "/news/category/bread", "/about"]) {
    await page.goto(siteUrl(site, path));
    expect(await sidewaysScroll(page), path).toBe(0);
  }
  // Keyboard: the skip link leads to the content.
  await page.keyboard.press("Tab");
  await expect(page.getByRole("link", { name: "Skip to content" })).toBeFocused();
});

// ── Made in the admin: fresh on the very next public request ─────────────────

const editor = (page: Page) => page.getByTestId("editor");

/** An Owner, verified, with a site made through the form; on the Home page's editor. */
async function withEditedSite(page: Page) {
  const org = await seedOrganization("content");
  await addMember(org.id, (await seedUser()).email, "owner");
  const member = await memberOf(page, "owner", org);
  await markEmailVerified(member.email);
  const address = `content-${tail()}`;
  await page.goto(`/${org.slug}/sites/new`);
  await createSite(page, { name: "Harbour Bakery", address });
  await expectSiteCreated(page, org.slug, address);
  const [site] = await sitesIn(org.id);
  const overview = `/${org.slug}/sites/${site!.slug}`;
  const home = (await homePageOf(org.id, site!.id))!;
  return { org, address, overview, editorUrl: `${overview}/pages/${home}`, site: site! };
}

test("publish in the editor → visible; a saved draft stays private; republished → updated, no purge; Coming soon ↔ live and a theme switch show at once", async ({ page, browser }) => {
  const { address, overview, editorUrl, site, org } = await withEditedSite(page);
  const visitorContext = await browser.newContext();
  const visitor = await visitorContext.newPage();
  const publicMain = () => visitor.getByRole("main");

  // Live, from the overview; the Home page is still a draft: the site's name.
  await page.goto(overview);
  await page.getByRole("button", { name: "Publish site…" }).click();
  await page.getByRole("dialog").getByRole("button", { name: "Publish site" }).click();
  await expect(shown(page, "site-status")).toHaveText("Live");
  await visitor.goto(siteUrl(address));
  expect(await publicView(visitor)).toMatchObject({ heading: "Harbour Bakery", theme: "studio" });

  // Written and published in the editor: on the very next request.
  await page.goto(editorUrl);
  await expect(editor(page)).toBeVisible({ timeout: 15_000 });
  await page.getByTestId("entry-title").fill("Welcome in");
  await editor(page).click();
  await page.keyboard.type("Fresh bread every morning.");
  await page.getByRole("button", { name: "Publish", exact: true }).click();
  await expect(page.getByTestId("entry-status")).toHaveText("Published", { timeout: 15_000 });
  await visitor.goto(siteUrl(address));
  expect(await publicView(visitor)).toMatchObject({ heading: "Welcome in" });
  await expect(publicMain()).toContainText("Fresh bread every morning.");

  // Edited and saved, not published: the public page does not change.
  await editor(page).click();
  await page.keyboard.press("End");
  await page.keyboard.type(" Draft words.");
  await expect(page.getByTestId("entry-status")).toHaveText("Published, with unpublished changes", { timeout: 15_000 });
  await visitor.reload();
  await expect(publicMain()).toContainText("Fresh bread every morning.");
  await expect(publicMain()).not.toContainText("Draft words.");

  // Republished: updated at once, without anyone purging anything.
  await page.getByRole("button", { name: "Publish changes" }).click();
  await expect(page.getByTestId("entry-status")).toHaveText("Published", { timeout: 15_000 });
  await visitor.reload();
  await expect(publicMain()).toContainText("Fresh bread every morning. Draft words.");

  // Back to Coming soon: the content is gone from the public address at once; live again: back at once.
  await page.goto(overview);
  await page.getByRole("button", { name: "Switch to Coming soon…" }).click();
  await page.getByRole("dialog").getByRole("button", { name: "Switch to Coming soon" }).click();
  await expect(shown(page, "site-status")).toHaveText("Coming soon");
  await visitor.reload();
  await expect(publicMain()).toContainText("Coming soon");
  await expect(publicMain()).not.toContainText("Fresh bread");
  expect(await robots(visitor)).toEqual(["noindex, nofollow"]);
  await page.getByRole("button", { name: "Publish site…" }).click();
  await page.getByRole("dialog").getByRole("button", { name: "Publish site" }).click();
  await expect(shown(page, "site-status")).toHaveText("Live");
  await visitor.reload();
  await expect(publicMain()).toContainText("Fresh bread every morning. Draft words.");

  // A theme switch: the same content, in Journal, on the next request.
  await page.goto(`/${org.slug}/sites/${site.slug}/appearance`);
  await page.getByRole("form", { name: "Theme" }).locator('[data-theme-key="journal"]').click();
  await page.getByRole("button", { name: "Use this theme" }).click();
  await expect(page.locator('[data-form-alert][role="status"]').filter({ visible: true })).toHaveText("The site now uses Journal.");
  await visitor.reload();
  expect(await publicView(visitor)).toMatchObject({ heading: "Welcome in", theme: "journal" });
  await expect(publicMain()).toContainText("Fresh bread every morning. Draft words.");
  await visitorContext.close();
});

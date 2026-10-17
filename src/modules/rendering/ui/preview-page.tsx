import "server-only";
import { REVISION_KIND_WORDS, type RevisionKind } from "@/modules/content/shared";
import { themeFor } from "@/themes/render";
import type { AppearancePreview } from "../appearance-preview";
import type { Preview } from "../preview";
import { renderableSite } from "../public-site";
import { PublicPageView } from "./public-page";

/**
 * A preview (M7-4): a banner that says what this is, then the page as the site would draw it, in its theme. The banner
 * is outside the theme, with its own plain styles, so no theme can hide it: a preview never passes for the live page.
 */
export function PreviewView({ preview }: { preview: Preview }) {
  const { theme, context } = themeFor(renderableSite(preview.site, preview.locator));
  const { Layout } = theme;
  return (
    <>
      <PreviewBanner preview={preview} />
      <Layout context={context}>
        <PublicPageView page={{ kind: "entry", entry: preview.entry, links: preview.links }} site={preview.site} locator={preview.locator} />
      </Layout>
    </>
  );
}

/** A time in the site's zone: "16 Oct 2026, 10:42 (Asia/Manila)". */
const at = (iso: string, timeZone: string) =>
  `${new Intl.DateTimeFormat("en-GB", { dateStyle: "medium", timeStyle: "short", timeZone }).format(new Date(iso))} (${timeZone})`;

const count = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

/** What the banner says, as lines: what is shown, how it stands to the live page, and what cannot be shown. */
export function previewLines(preview: Preview): { title: string; lines: string[] } {
  const { subject, site, status, gaps } = preview;
  const zone = site.timezone;
  const lines: string[] = [];
  let title: string;
  if (subject.kind === "draft") {
    title = "Preview of the draft";
    if (subject.live) lines.push("This is the published version.");
    else if (status === "published") lines.push("Not published: visitors see the published version until this draft is published.");
    else if (status === "scheduled") lines.push("Not published: the schedule publishes the version frozen when it was scheduled, not this draft.");
    else lines.push("Not published: visitors cannot see it yet.");
  } else {
    const kind = REVISION_KIND_WORDS[subject.revisionKind as RevisionKind] ?? subject.revisionKind;
    title = `Preview of revision ${subject.number} · ${kind}${subject.label ? ` · ${subject.label}` : ""}`;
    lines.push(`Saved ${at(subject.createdAt, zone)}. Viewing it does not restore or publish it.`);
    if (subject.live) lines.push("Visitors see this revision now.");
    else if (subject.scheduledFor) lines.push(`The schedule publishes this revision on ${at(subject.scheduledFor, zone)}.`);
    else lines.push("Visitors do not see this revision.");
  }
  if (site.status === "coming_soon") lines.push("The site is not live yet: visitors see its Coming soon page.");
  if (gaps.broken) lines.push(`${count(gaps.broken, "part of it cannot be shown: it is not a block", "parts of it cannot be shown: they are not blocks")} this version of Forge has, or no longer valid.`);
  if (gaps.missingImages) lines.push(`${count(gaps.missingImages, "image is", "images are")} no longer in the media library, and left out.`);
  return { title, lines };
}

function PreviewBanner({ preview }: { preview: Preview }) {
  const { title, lines } = previewLines(preview);
  return (
    <div
      role="note"
      aria-label="Preview"
      data-testid="preview-banner"
      style={{ background: "#1f2937", color: "#f9fafb", font: "14px/1.5 system-ui, sans-serif", padding: "10px 16px", borderBottom: "3px solid #f59e0b" }}
    >
      <strong style={{ display: "block", fontSize: "15px" }}>{title}</strong>
      {lines.map((line) => (
        <span key={line} style={{ display: "block" }}>
          {line}
        </span>
      ))}
    </div>
  );
}

/** A preview that cannot be shown (the token is not valid for anyone now, or what it names is gone): one answer for all. */
export function PreviewUnavailable() {
  return (
    <main data-testid="preview-unavailable" style={{ font: "16px/1.5 system-ui, sans-serif", maxWidth: "36rem", margin: "15vh auto", padding: "0 16px" }}>
      <h1 style={{ fontSize: "1.5rem" }}>This preview is not available</h1>
      <p>It may have expired, or you may no longer have access to it. Open a new preview from the editor.</p>
    </main>
  );
}

/** The appearance editor's preview (M8-1): the home page with settings that are not saved, under a banner that says so. */
export function AppearancePreviewView({ preview }: { preview: AppearancePreview }) {
  const { theme, context } = themeFor(renderableSite(preview.site, preview.locator));
  const { Layout } = theme;
  const lines = ["Not saved yet: visitors see the saved appearance until you save."];
  if (preview.site.status === "coming_soon") lines.push("The site is not live yet: visitors see its Coming soon page.");
  return (
    <>
      <div
        role="note"
        aria-label="Preview"
        data-testid="preview-banner"
        style={{ background: "#1f2937", color: "#f9fafb", font: "14px/1.5 system-ui, sans-serif", padding: "10px 16px", borderBottom: "3px solid #f59e0b" }}
      >
        <strong style={{ display: "block", fontSize: "15px" }}>Preview of your appearance changes</strong>
        {lines.map((line) => (
          <span key={line} style={{ display: "block" }}>
            {line}
          </span>
        ))}
      </div>
      <Layout context={context}>
        <PublicPageView page={preview.page} site={preview.site} locator={preview.locator} />
      </Layout>
    </>
  );
}

import type { ReactNode } from "react";
import type { BlockRenderContext } from "../render-context";
import { embed, embedSrc } from "./schema";

const TITLES: Record<string, string> = { youtube: "YouTube video", vimeo: "Vimeo video", generic: "Embedded page" };

/**
 * An embed on the public site: a lazy, sandboxed frame whose source is made
 * here from the stored address (`embedSrc`: YouTube's and Vimeo's privacy
 * players, or a URL-safe https page that is not one of `blockedHosts`).
 * Anything else renders nothing.
 *
 * What each frame may do (M5-6): scripts and its own origin (the players and
 * maps need both; the frame is always another site's, so it cannot reach this
 * page), presentation and pop-ups (a link opened from it). The videos also get
 * the media features they play with; a generic page gets forms instead (the
 * approved use: a map or a form), and nothing else.
 */
const SANDBOX = "allow-scripts allow-same-origin allow-presentation allow-popups";
export function renderEmbed(attrs: unknown, context: BlockRenderContext): ReactNode {
  const parsed = embed.attrs.safeParse(attrs);
  if (!parsed.success) return null;
  const { provider, url, aspect } = parsed.data;
  const src = embedSrc(provider, url, { blockedHosts: context.blockedHosts });
  if (!src) return null;
  return (
    <div className={`forge-embed forge-embed--${aspect.replace(":", "-")}`}>
      <iframe
        src={src}
        title={TITLES[provider]}
        loading="lazy"
        sandbox={provider === "generic" ? `${SANDBOX} allow-forms` : SANDBOX}
        referrerPolicy="strict-origin-when-cross-origin"
        {...(provider === "generic" ? {} : { allow: "encrypted-media; fullscreen; picture-in-picture", allowFullScreen: true })}
      />
    </div>
  );
}

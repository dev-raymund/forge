import { z } from "zod";
import { checkEmbeddableUrl, URL_MAX } from "@/platform/net/url-safety";
import { blockId, defineBlock } from "../define";

/**
 * An embedded video or page (plan §6.1, decided 2026-10-01): YouTube and Vimeo
 * through their privacy-enhanced players, and a `generic` https page only
 * after URL-safety validation (`platform/net/url-safety`). No other provider
 * integration. The stored `url` is what the person gave; the frame's source
 * is always made from it here (`embedSrc`), never taken as it is for YouTube
 * and Vimeo.
 */
export const EMBED_PROVIDERS = ["youtube", "vimeo", "generic"] as const;
export type EmbedProvider = (typeof EMBED_PROVIDERS)[number];

/** The frame's source for an allowed provider and URL, or null when the URL does not belong to it. */
export function embedSrc(provider: string, url: string, options: { blockedHosts?: readonly string[] } = {}): string | null {
  const checked = checkEmbeddableUrl(url, options);
  if (!checked.ok) return null;
  const u = checked.url;
  const host = u.hostname.toLowerCase().replace(/^www\.|^m\./, "");
  if (provider === "youtube") {
    const id =
      host === "youtu.be"
        ? u.pathname.slice(1)
        : host === "youtube.com" || host === "youtube-nocookie.com"
          ? u.pathname === "/watch"
            ? u.searchParams.get("v")
            : u.pathname.match(/^\/(?:embed|shorts)\/([^/]+)/)?.[1]
          : null;
    return id && /^[A-Za-z0-9_-]{11}$/.test(id) ? `https://www.youtube-nocookie.com/embed/${id}` : null;
  }
  if (provider === "vimeo") {
    const id = host === "vimeo.com" ? u.pathname.match(/^\/(\d{6,12})$/)?.[1] : null;
    return id ? `https://player.vimeo.com/video/${id}?dnt=1` : null;
  }
  if (provider === "generic") return u.href;
  return null;
}

/** Which provider an address belongs to: YouTube or Vimeo when it is theirs, otherwise a generic page. */
export function providerOf(url: string): EmbedProvider {
  return embedSrc("youtube", url) ? "youtube" : embedSrc("vimeo", url) ? "vimeo" : "generic";
}

export const embed = defineBlock({
  type: "embed",
  label: "Embed",
  v: 1,
  migrate: {},
  attrs: z
    .object({
      id: blockId,
      v: z.literal(1).meta({ hidden: true }),
      // Not a field of the panel: it follows the address (`providerOf`), so a YouTube or Vimeo address always gets the privacy player.
      provider: z.enum(EMBED_PROVIDERS).meta({ hidden: true }),
      url: z.string().trim().max(URL_MAX).meta({ title: "Address", description: "A YouTube or Vimeo video, or an https:// page that allows embedding." }),
      aspect: z.enum(["16:9", "4:3", "1:1", "9:16"]).default("16:9").meta({ title: "Shape", options: { "16:9": "Wide (16:9)", "4:3": "Standard (4:3)", "1:1": "Square", "9:16": "Tall (9:16)" } }),
    })
    .refine((attrs) => embedSrc(attrs.provider, attrs.url) !== null, { message: "Use a YouTube or Vimeo video address, or an https:// address of a public page.", path: ["url"] }),
  // A new embed is created from an address (the editor asks for it first), so there is no default address.
  defaults: { v: 1, aspect: "16:9" },
  editable: true,
});

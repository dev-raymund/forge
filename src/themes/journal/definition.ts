import { z } from "zod";
import type { ThemeDefinition } from "../types";

/** Journal (plan §7): blog first. Its blog templates and its full styles are M8-2's; M4-4 gives it the same skeleton as Studio. */
export const journal: ThemeDefinition<"journal"> = {
  key: "journal",
  name: "Journal",
  description: "Warm and editorial, for writers and publications. Serif type, a centred masthead, a comfortable reading measure.",
  version: 1,
  defaults: {
    tokens: {
      colors: { primary: "#9a3412", accent: "#115e59", background: "#fffdf8", text: "#1c1917" },
      fonts: { heading: "fraunces", body: "source-serif-4" },
    },
    header: { variant: "centered", sticky: false, cta: null },
    footer: { variant: "simple", copyright: "", showSocial: true },
    layout: { width: "narrow", radius: "small", density: "relaxed" },
  },
  options: z.strictObject({}),
  headerVariants: ["centered"],
  footerVariants: ["simple"],
  preview: "editorial",
};

import { z } from "zod";
import type { ThemeDefinition } from "../types";

/** Studio (plan §7): business-site first. The theme every new site starts with. */
export const studio: ThemeDefinition<"studio"> = {
  key: "studio",
  name: "Studio",
  description: "Clean and businesslike, for companies, studios and services. Clear headings, generous space, a strong call to action.",
  version: 1,
  defaults: {
    tokens: {
      colors: { primary: "#1d4ed8", accent: "#0f766e", background: "#ffffff", text: "#0f172a" },
      fonts: { heading: "manrope", body: "inter" },
    },
    header: { variant: "classic", sticky: false, cta: null },
    footer: { variant: "simple", copyright: "", showSocial: true },
    layout: { width: "normal", radius: "medium", density: "normal" },
  },
  options: z.strictObject({}),
  headerVariants: ["classic"],
  footerVariants: ["simple"],
  preview: "business",
};

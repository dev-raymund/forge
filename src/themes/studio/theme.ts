import type { ThemeManifest } from "../types";
import { StudioLayout } from "./components/layout";
import { studio } from "./definition";
import { StudioComingSoon } from "./templates/coming-soon";
import { StudioNotFound } from "./templates/not-found";
import { StudioPage } from "./templates/page";

/** Studio's manifest: its definition, and what the public renderer draws with. */
export const studioTheme: ThemeManifest<"studio"> = {
  ...studio,
  Layout: StudioLayout,
  templates: { page: StudioPage, "coming-soon": StudioComingSoon, "not-found": StudioNotFound },
};

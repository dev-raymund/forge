import type { ThemeManifest } from "../types";
import { StudioLayout } from "./components/layout";
import { studio } from "./definition";
import { StudioBlogIndex, StudioPost, StudioTermArchive } from "./templates/blog";
import { StudioComingSoon } from "./templates/coming-soon";
import { StudioNotFound } from "./templates/not-found";
import { StudioPage } from "./templates/page";
import { StudioPageFullWidth, StudioPageLanding } from "./templates/page-variants";

/** Studio's manifest: its definition, and what the public renderer draws with. */
export const studioTheme: ThemeManifest<"studio"> = {
  ...studio,
  Layout: StudioLayout,
  templates: {
    page: StudioPage,
    "page-full-width": StudioPageFullWidth,
    "page-landing": StudioPageLanding,
    post: StudioPost,
    "blog-index": StudioBlogIndex,
    "term-archive": StudioTermArchive,
    "coming-soon": StudioComingSoon,
    "not-found": StudioNotFound,
  },
};

import type { ThemeManifest } from "../types";
import { JournalLayout } from "./components/layout";
import { journal } from "./definition";
import { JournalBlogIndex, JournalPost, JournalTermArchive } from "./templates/blog";
import { JournalComingSoon } from "./templates/coming-soon";
import { JournalNotFound } from "./templates/not-found";
import { JournalPage, JournalPageFullWidth, JournalPageLanding } from "./templates/page";

/** Journal's manifest (M4-4; M8-2): its definition, and its own templates for every page the renderer draws. */
export const journalTheme: ThemeManifest<"journal"> = {
  ...journal,
  Layout: JournalLayout,
  templates: {
    page: JournalPage,
    "page-full-width": JournalPageFullWidth,
    "page-landing": JournalPageLanding,
    post: JournalPost,
    "blog-index": JournalBlogIndex,
    "term-archive": JournalTermArchive,
    "coming-soon": JournalComingSoon,
    "not-found": JournalNotFound,
  },
};

import { KitBlogIndex, KitPost, KitTermArchive } from "../_kit/templates/blog";
import type { ThemeManifest } from "../types";
import { JournalLayout } from "./components/layout";
import { journal } from "./definition";
import { JournalComingSoon } from "./templates/coming-soon";
import { JournalNotFound } from "./templates/not-found";
import { JournalPage, JournalPageWide } from "./templates/page";

/**
 * Journal's manifest: its definition, and what the public renderer draws with. Its post, blog index and archive are
 * the kit's own templates until M8-2 designs Journal's (ADR 0012).
 */
export const journalTheme: ThemeManifest<"journal"> = {
  ...journal,
  Layout: JournalLayout,
  templates: {
    page: JournalPage,
    "page-full-width": JournalPageWide,
    "page-landing": JournalPageWide,
    post: KitPost,
    "blog-index": KitBlogIndex,
    "term-archive": KitTermArchive,
    "coming-soon": JournalComingSoon,
    "not-found": JournalNotFound,
  },
};

import type { ThemeManifest } from "../types";
import { JournalLayout } from "./components/layout";
import { journal } from "./definition";
import { JournalComingSoon } from "./templates/coming-soon";
import { JournalNotFound } from "./templates/not-found";
import { JournalPage } from "./templates/page";

/** Journal's manifest: its definition, and what the public renderer draws with. */
export const journalTheme: ThemeManifest<"journal"> = {
  ...journal,
  Layout: JournalLayout,
  templates: { page: JournalPage, "coming-soon": JournalComingSoon, "not-found": JournalNotFound },
};

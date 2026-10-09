import { ThemeFrame } from "../../_kit/components/theme-frame";
import type { ThemeContext } from "../../types";
import "../styles.css";
import { JournalFooter } from "./footer";
import { JournalHeader } from "./header";

/** Every page of a Journal site: masthead, the page's content, footer. */
export function JournalLayout({ context, children }: { context: ThemeContext; children: React.ReactNode }) {
  return (
    <ThemeFrame theme="journal" context={context}>
      <JournalHeader context={context} />
      <main id="content" className="forge-main" tabIndex={-1}>
        {children}
      </main>
      <JournalFooter context={context} />
    </ThemeFrame>
  );
}

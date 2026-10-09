import { ThemeFrame } from "../../_kit/components/theme-frame";
import type { ThemeContext } from "../../types";
import "../styles.css";
import { StudioFooter } from "./footer";
import { StudioHeader } from "./header";

/** Every page of a Studio site: header, the page's content, footer. */
export function StudioLayout({ context, children }: { context: ThemeContext; children: React.ReactNode }) {
  return (
    <ThemeFrame theme="studio" context={context}>
      <StudioHeader context={context} />
      <main id="content" className="forge-main" tabIndex={-1}>
        {children}
      </main>
      <StudioFooter context={context} />
    </ThemeFrame>
  );
}

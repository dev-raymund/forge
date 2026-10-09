import "./platform.css";

/**
 * The two answers the platform gives instead of a site (M4-3). Neither says
 * whose site it is, whether one ever existed, or why it is unavailable.
 */
function PlatformPage({ title, children, testId }: { title: string; children: React.ReactNode; testId: string }) {
  return (
    <div data-forge-platform="" data-testid={testId}>
      <main>
        <h1>{title}</h1>
        {children}
        <p className="forge-platform-mark">Forge</p>
      </main>
    </div>
  );
}

/** No site has this address. */
export function SiteNotFound() {
  return (
    <PlatformPage title="Site not found" testId="site-not-found">
      <p>There is no website at this address. Check the address and try again.</p>
    </PlatformPage>
  );
}

/** The site exists, and cannot be shown. Nothing of it is: not its name, its theme, or the reason. */
export function SiteUnavailable() {
  return (
    <PlatformPage title="This site is unavailable" testId="site-unavailable">
      <p>This website is not available at the moment.</p>
    </PlatformPage>
  );
}

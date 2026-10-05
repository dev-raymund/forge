/**
 * A page that has one thing to say instead of its content: not found, no
 * access, a suspended organization. A heading, a few lines, and what to do next.
 */
export function PageNotice({ title, children, testId }: { title: string; children: React.ReactNode; testId?: string }) {
  return (
    <main className="mx-auto w-full max-w-5xl flex-1 px-4 py-16 sm:px-6" data-testid={testId}>
      <div className="grid max-w-prose gap-3">
        <h1 className="text-2xl font-semibold tracking-tight text-balance">{title}</h1>
        <div className="grid gap-3 text-muted-foreground [&_a]:font-medium [&_a]:text-foreground [&_a]:underline [&_a]:underline-offset-4">{children}</div>
      </div>
    </main>
  );
}

/** For a member of an organization that staff have suspended. Nothing of the organization is rendered next to it. */
export function OrganizationSuspended({ message }: { message: string }) {
  return (
    <PageNotice title="This organization is suspended" testId="organization-suspended">
      <p>{message} Its pages and settings are not available while it is suspended.</p>
      <p>If you think this is a mistake, contact Forge support. Your other organizations are in the menu at the top of the page.</p>
    </PageNotice>
  );
}

/** For a member who opened a page their role does not include. */
export function NoAccess({ children }: { children: React.ReactNode }) {
  return (
    <PageNotice title="You don’t have access to this page" testId="no-access">
      {children}
    </PageNotice>
  );
}

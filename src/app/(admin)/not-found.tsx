import type { Metadata } from "next";
import Link from "next/link";
import { PageNotice } from "@/components/admin/page-notice";

export const metadata: Metadata = { title: "Page not found" };

/**
 * The admin's 404. The same page for an address that leads nowhere and for an
 * organization the visitor does not belong to: it never says which.
 */
export default function AdminNotFound() {
  return (
    <div className="flex min-h-dvh flex-col">
      <PageNotice title="Page not found" testId="not-found">
        <p>This page does not exist, or you do not have access to it.</p>
        <p>
          {/* `/` redirects to wherever this visitor belongs: their organization, onboarding, or the login page. */}
          <Link href="/">Go to your organization</Link>
        </p>
      </PageNotice>
    </div>
  );
}

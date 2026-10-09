import Script from "next/script";
import type { AnalyticsSettings } from "@/modules/sites/shared";

/**
 * The two analytics services a site may use (M4-2; ADR 0006 §5): their
 * official snippets, built here from IDs that passed the settings' rules, and
 * checked again right before they are written into the page. Nothing a tenant
 * typed is emitted as code. Only on a live site's pages.
 */
const GA4 = /^G-[A-Z0-9]{4,16}$/;
const PLAUSIBLE = /^([a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/;

/** The IDs that may be written into a page: each checked again here, whatever the caller read them from. */
export function safeAnalytics(analytics: AnalyticsSettings): { ga4: string | null; plausible: string | null } {
  return {
    ga4: typeof analytics.ga4MeasurementId === "string" && GA4.test(analytics.ga4MeasurementId) ? analytics.ga4MeasurementId : null,
    plausible: typeof analytics.plausibleDomain === "string" && PLAUSIBLE.test(analytics.plausibleDomain) ? analytics.plausibleDomain : null,
  };
}

export function SiteAnalytics({ analytics }: { analytics: AnalyticsSettings }) {
  const { ga4, plausible } = safeAnalytics(analytics);
  return (
    <>
      {ga4 ? (
        <>
          <Script id="forge-ga4-loader" src={`https://www.googletagmanager.com/gtag/js?id=${ga4}`} strategy="afterInteractive" />
          <Script id="forge-ga4" strategy="afterInteractive">
            {`window.dataLayer=window.dataLayer||[];function gtag(){dataLayer.push(arguments);}gtag("js",new Date());gtag("config","${ga4}");`}
          </Script>
        </>
      ) : null}
      {plausible ? <Script id="forge-plausible" src="https://plausible.io/js/script.js" data-domain={plausible} strategy="afterInteractive" /> : null}
    </>
  );
}

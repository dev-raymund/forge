"use client";

import Script from "next/script";
import { useEffect, useRef, useState } from "react";

type Turnstile = {
  render: (element: HTMLElement, options: { sitekey: string; action?: string }) => string;
  remove: (widgetId: string) => void;
};
declare global {
  interface Window {
    turnstile?: Turnstile;
  }
}

const SCRIPT = "https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit";

/**
 * Cloudflare Turnstile (plan §12, sign-up only). The widget adds a hidden
 * `cf-turnstile-response` field to the surrounding form; the server verifies
 * it with Cloudflare before the account is created. Rendered only when a site
 * key is configured.
 */
export function TurnstileWidget({ siteKey, renewOn }: { siteKey: string; /** A new value replaces the widget with a fresh challenge. */ renewOn?: unknown }) {
  const container = useRef<HTMLDivElement>(null);
  const [ready, setReady] = useState(() => typeof window !== "undefined" && !!window.turnstile);

  useEffect(() => {
    const element = container.current;
    if (!ready || !element || !window.turnstile) return;
    const widgetId = window.turnstile.render(element, { sitekey: siteKey, action: "sign-up" });
    return () => window.turnstile?.remove(widgetId);
  }, [ready, siteKey, renewOn]);

  return (
    <>
      <Script src={SCRIPT} strategy="afterInteractive" onReady={() => setReady(true)} />
      <div ref={container} data-testid="turnstile" className="min-h-[65px]" />
    </>
  );
}

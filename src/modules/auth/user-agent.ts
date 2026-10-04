/**
 * A short, human description of a browser from its User-Agent header, for the
 * session list on the account page: "Chrome on macOS". Deliberately coarse:
 * no versions, no device model, nothing that fingerprints.
 */

const BROWSERS: [RegExp, string][] = [
  // Order matters: most browsers also claim to be Chrome and Safari.
  [/\bEdg(?:e|A|iOS)?\//, "Edge"],
  [/\bOPR\/|\bOpera\b/, "Opera"],
  [/\bSamsungBrowser\//, "Samsung Internet"],
  [/\bFirefox\/|\bFxiOS\//, "Firefox"],
  [/Chrome\/|\bCriOS\/|\bChromium\//, "Chrome"], // no \b: headless Chrome calls itself "HeadlessChrome/…"
  [/\bSafari\//, "Safari"],
];

const SYSTEMS: [RegExp, string][] = [
  [/\biPhone\b|\biPad\b|\biPod\b/, "iOS"],
  [/\bAndroid\b/, "Android"],
  [/\bWindows\b/, "Windows"],
  [/\bMac OS X\b|\bMacintosh\b/, "macOS"],
  [/\bCrOS\b/, "ChromeOS"],
  [/\bLinux\b/, "Linux"],
];

export function describeUserAgent(userAgent: string | null | undefined): string {
  const ua = (userAgent ?? "").slice(0, 512);
  const browser = BROWSERS.find(([pattern]) => pattern.test(ua))?.[1];
  const system = SYSTEMS.find(([pattern]) => pattern.test(ua))?.[1];
  if (browser && system) return `${browser} on ${system}`;
  return browser ?? system ?? "Unknown device";
}

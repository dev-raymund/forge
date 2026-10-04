import { describe, expect, it } from "vitest";
import { describeUserAgent } from "./user-agent";

describe("describeUserAgent", () => {
  it.each([
    ["Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36", "Chrome on macOS"],
    ["Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36 Edg/141.0.0.0", "Edge on Windows"],
    ["Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:143.0) Gecko/20100101 Firefox/143.0", "Firefox on Windows"],
    ["Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Safari/605.1.15", "Safari on macOS"],
    ["Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1", "Safari on iOS"],
    ["Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) CriOS/141.0.0.0 Mobile/15E148 Safari/604.1", "Chrome on iOS"],
    ["Mozilla/5.0 (iPad; CPU OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) FxiOS/143.0 Mobile/15E148 Safari/605.1.15", "Firefox on iOS"],
    ["Mozilla/5.0 (Linux; Android 15; Pixel 9) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Mobile Safari/537.36", "Chrome on Android"],
    ["Mozilla/5.0 (Linux; Android 15; SM-S928B) AppleWebKit/537.36 (KHTML, like Gecko) SamsungBrowser/28.0 Chrome/130.0.0.0 Mobile Safari/537.36", "Samsung Internet on Android"],
    ["Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) HeadlessChrome/141.0.0.0 Safari/537.36", "Chrome on Linux"],
    ["Mozilla/5.0 (X11; Linux x86_64; rv:143.0) Gecko/20100101 Firefox/143.0", "Firefox on Linux"],
    ["Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36 OPR/125.0.0.0", "Opera on Windows"],
    ["Mozilla/5.0 (X11; CrOS x86_64 16000.0.0) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36", "Chrome on ChromeOS"],
  ])("%s → %s", (ua, expected) => expect(describeUserAgent(ua)).toBe(expected));

  it.each([[null], [undefined], [""], ["curl/8.9.1"], ["vitest"], ["Mozilla/5.0"]])("falls back for %s", (ua) =>
    expect(describeUserAgent(ua)).toBe("Unknown device"),
  );

  it("names what it can when only half is recognisable", () => {
    expect(describeUserAgent("SomeApp/1.0 (Windows NT 10.0)")).toBe("Windows");
    expect(describeUserAgent("Mozilla/5.0 (PlayStation 5) AppleWebKit/605.1.15 Safari/605.1.15")).toBe("Safari");
  });

  it("is coarse on purpose: no versions, no device model, nothing from the raw string", () => {
    const hostile = 'Mozilla/5.0 (Macintosh; <script>alert(1)</script>) Chrome/141.0 "x" Safari/537';
    const described = describeUserAgent(hostile);
    expect(described).toBe("Chrome on macOS");
    expect(described).not.toMatch(/[<>"\d]/);
    expect(describeUserAgent(`Chrome/1 ${"x".repeat(100_000)} Windows`)).toBe("Chrome"); // bounded input
  });
});

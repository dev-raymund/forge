import { describe, expect, it } from "vitest";
import { checkEmbeddableUrl, isEmbeddableUrl, URL_MAX } from "./url-safety";

/** What may be framed in a visitor's browser (M5-5; plan §6.1 generic embeds). */

describe("url-safety", () => {
  it.each([
    "https://www.openstreetmap.org/export/embed.html?bbox=1,2,3,4",
    "https://docs.google.com/forms/d/e/x/viewform?embedded=true",
    "https://calendar.google.com/calendar/embed?src=a",
    "https://example.org/",
    "https://xn--bcher-kva.ch/",
    "https://sub.domain.museum/path#frag",
    "https://WWW.OPENSTREETMAP.ORG/",
    "https://www.openstreetmap.org./",
  ])("accepts %s", (url) => expect(isEmbeddableUrl(url)).toBe(true));

  it.each([
    ["http", "http://www.openstreetmap.org/"],
    ["javascript", "javascript:alert(1)"],
    ["data", "data:text/html,<script>alert(1)</script>"],
    ["blob", "blob:https://www.openstreetmap.org/uuid"],
    ["file", "file:///etc/passwd"],
    ["ftp", "ftp://files.openstreetmap.org/"],
    ["no scheme", "www.openstreetmap.org"],
    ["protocol-relative", "//www.openstreetmap.org/"],
    ["a user name", "https://user@www.openstreetmap.org/"],
    ["a password", "https://user:pass@www.openstreetmap.org/"],
    ["a port", "https://www.openstreetmap.org:444/"],
    ["IPv4", "https://93.184.216.34/"],
    ["IPv4 loopback", "https://127.0.0.1/"],
    ["IPv4 as a number", "https://2130706433/"],
    ["IPv4 in hex", "https://0x7f.0.0.1/"],
    ["IPv6", "https://[::1]/"],
    ["IPv6 mapped", "https://[::ffff:127.0.0.1]/"],
    ["a single label", "https://intranet/"],
    ["localhost", "https://localhost/"],
    ["a subdomain of localhost", "https://app.localhost/"],
    [".local", "https://printer.local/"],
    [".internal", "https://metadata.google.internal/"],
    [".test", "https://site.test/"],
    [".example", "https://www.example/"],
    [".invalid", "https://x.invalid/"],
    [".onion", "https://abc.onion/"],
    [".lan", "https://router.lan/"],
    [".home.arpa", "https://nas.home.arpa/"],
    [".corp", "https://wiki.corp/"],
    ["a numeric top-level domain", "https://host.123/"],
    ["a label with an underscore", "https://bad_label.openstreetmap.org/"],
    ["a label starting with a dash", "https://-bad.openstreetmap.org/"],
    ["empty", ""],
    ["not a URL", "not a url"],
  ])("refuses %s", (_name, url) => expect(isEmbeddableUrl(url)).toBe(false));

  it("refuses an address over 2,048 characters", () => {
    expect(isEmbeddableUrl(`https://www.openstreetmap.org/${"x".repeat(URL_MAX)}`)).toBe(false);
  });

  it("refuses a blocked host and every name below it, and only those", () => {
    const blockedHosts = ["cms.forgelinetechnologies.com"];
    expect(isEmbeddableUrl("https://cms.forgelinetechnologies.com/acme/site", { blockedHosts })).toBe(false);
    expect(isEmbeddableUrl("https://CMS.forgelinetechnologies.com/", { blockedHosts })).toBe(false);
    expect(isEmbeddableUrl("https://x.cms.forgelinetechnologies.com/", { blockedHosts })).toBe(false);
    expect(isEmbeddableUrl("https://notcms.forgelinetechnologies.com/", { blockedHosts })).toBe(true);
    expect(isEmbeddableUrl("https://cms.forgelinetechnologies.com.evil.org/", { blockedHosts })).toBe(true); // another site, framed as any other
  });

  it("says why, in words a person can act on", () => {
    expect(checkEmbeddableUrl("http://www.openstreetmap.org/")).toEqual({ ok: false, reason: "Use an https:// address." });
    expect(checkEmbeddableUrl("https://localhost/")).toEqual({ ok: false, reason: "Use the address of a public website." });
    const accepted = checkEmbeddableUrl(" https://www.openstreetmap.org/ ");
    expect(accepted.ok && accepted.url.href).toBe("https://www.openstreetmap.org/");
  });
});

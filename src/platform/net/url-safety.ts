/**
 * URL safety (plan §6.1 "generic iframe URL only after URL-safety validation";
 * M5-5). Pure and client-safe: the editor and the server run the same rule.
 *
 * A URL is safe to embed when it is an `https` address of a public host:
 *  - `https`, nothing else (no `http`, `javascript:`, `data:`, `blob:`, `file:`);
 *  - no user name or password, the default port;
 *  - a domain name, not an IP address, with a dot and a top-level domain of
 *    letters, and not a name that only exists on a private network or in
 *    documentation (`localhost`, `.local`, `.internal`, `.test`, …);
 *  - not one of the `blockedHosts` (the server adds the app's own host, so a
 *    site cannot frame Forge itself), nor below one of them;
 *  - at most 2,048 characters.
 * This decides what may be framed in a visitor's browser. It is not a defence
 * for requests the server makes (none is made to these URLs).
 */

export const URL_MAX = 2_048;

/** Names that never point at the public internet (RFC 6761, RFC 6762, ICANN's `.internal`), and private-network habits. */
const PRIVATE_SUFFIXES = ["localhost", "local", "internal", "test", "example", "invalid", "onion", "lan", "home", "corp", "intranet", "home.arpa"];

export type UrlCheck = { ok: true; url: URL } | { ok: false; reason: string };

const IPV4 = /^\d{1,3}(\.\d{1,3}){3}$/;
const LABEL = /^(?!-)[a-z0-9-]{1,63}(?<!-)$/;

export function checkEmbeddableUrl(input: string, options: { blockedHosts?: readonly string[] } = {}): UrlCheck {
  if (typeof input !== "string" || input.length === 0) return { ok: false, reason: "Enter an address." };
  if (input.length > URL_MAX) return { ok: false, reason: "That address is too long." };
  let url: URL;
  try {
    url = new URL(input.trim());
  } catch {
    return { ok: false, reason: "That is not a web address." };
  }
  if (url.protocol !== "https:") return { ok: false, reason: "Use an https:// address." };
  if (url.username || url.password) return { ok: false, reason: "An address with a user name or password cannot be embedded." };
  if (url.port !== "") return { ok: false, reason: "Use an address without a port." };
  const host = url.hostname.toLowerCase().replace(/\.$/, "");
  if (host.startsWith("[") || IPV4.test(host)) return { ok: false, reason: "Use a domain name, not an IP address." };
  const labels = host.split(".");
  if (labels.length < 2 || !labels.every((label) => LABEL.test(label)) || !/^[a-z]{2,63}$|^xn--[a-z0-9-]{1,59}$/.test(labels.at(-1)!)) {
    return { ok: false, reason: "Use the address of a public website." };
  }
  if (PRIVATE_SUFFIXES.some((suffix) => host === suffix || host.endsWith(`.${suffix}`))) return { ok: false, reason: "Use the address of a public website." };
  if ((options.blockedHosts ?? []).some((blocked) => host === blocked.toLowerCase() || host.endsWith(`.${blocked.toLowerCase()}`))) {
    return { ok: false, reason: "Forge's own pages cannot be embedded." };
  }
  return { ok: true, url };
}

export const isEmbeddableUrl = (input: string, options?: { blockedHosts?: readonly string[] }): boolean => checkEmbeddableUrl(input, options).ok;

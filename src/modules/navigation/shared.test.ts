import { uuidv7 } from "uuidv7";
import { describe, expect, it } from "vitest";
import { checkMenuItems, countItems, itemErrorKey, MENU_ITEMS_MAX, readMenuItems, targetKey } from "./shared";

const id = () => uuidv7();
const entry = (extra: Record<string, unknown> = {}) => ({ id: id(), kind: "entry", entryId: id(), label: "", newTab: false, ...extra });
const url = (href: string, extra: Record<string, unknown> = {}) => ({ id: id(), kind: "url", url: href, label: "Link", newTab: false, ...extra });
const errorsOf = (input: unknown) => {
  const result = checkMenuItems(input);
  return result.ok ? null : result.errors;
};

describe("a menu as it is saved (M8-3, ADR 0030)", () => {
  it("takes the four kinds of link, two levels deep, with their labels trimmed and their new-tab choice", () => {
    const parent = entry({ label: "  About us  ", children: [{ id: id(), kind: "term", termId: id(), label: "", newTab: false }, url("/contact", { newTab: true })] });
    const result = checkMenuItems([parent, { id: id(), kind: "archive", contentType: "post", label: "News", newTab: false }, url("https://shop.example.com")]);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.items[0]!.label).toBe("About us");
    expect(result.items[0]!.children!.map((child) => child.kind)).toEqual(["term", "url"]);
    expect(countItems(result.items)).toBe(5);
    expect(checkMenuItems([])).toEqual({ ok: true, items: [] });
  });

  it("addresses: a path on the site, or a web, mail or phone address; never javascript:, data:, another host by //, or spaces", () => {
    for (const href of ["/contact", "/a/b?x=1#top", "https://example.com", "http://example.com/x", "mailto:hello@example.com", "tel:+15550100"]) {
      expect(errorsOf([url(href)]), href).toBeNull();
    }
    for (const href of ["javascript:alert(1)", "JavaScript:alert(1)", "data:text/html,<b>x</b>", "vbscript:x", "//evil.example", "ftp://example.com", "contact", "/a b", "https://exa mple.com", "", "\\\\evil"]) {
      const item = url(href);
      expect(errorsOf([item]), href).toEqual({ [itemErrorKey(item.id)]: [expect.any(String)] });
    }
  });

  it("labels: at most 80 characters; an address needs one, a page, post, category or the blog may use its own name", () => {
    const long = url("/x", { label: "x".repeat(81) });
    expect(errorsOf([long])).toEqual({ [itemErrorKey(long.id)]: ["Use at most 80 characters."] });
    const bare = url("/x", { label: "   " });
    expect(errorsOf([bare])).toEqual({ [itemErrorKey(bare.id)]: ["Give the link a label."] });
    expect(errorsOf([entry({ label: "" })])).toBeNull();
  });

  it("two levels at most: a link under a link has nothing under it, and says so where it is", () => {
    const grandchild = url("/c");
    const child = url("/b", { children: [grandchild] });
    expect(errorsOf([url("/a", { children: [child] })])).toEqual({ [itemErrorKey(child.id)]: ["A link under another cannot have links under it: menus have two levels."] });
  });

  it(`at most ${MENU_ITEMS_MAX} links, both levels counted; each id once`, () => {
    const hundred = Array.from({ length: 50 }, () => url("/x", { children: [url("/y")] }));
    expect(errorsOf(hundred)).toBeNull();
    expect(errorsOf([...hundred, url("/z")])).toEqual({ items: [`A menu holds at most ${MENU_ITEMS_MAX} links.`] });
    const twice = url("/x");
    expect(errorsOf([twice, { ...twice }])).toEqual({ items: [expect.stringContaining("could not be read")] });
  });

  it("nothing it does not name: an unknown kind, an unknown field, an archive of anything but posts, ids that are not ids", () => {
    const odd = { id: id(), kind: "script", label: "x", newTab: false };
    expect(errorsOf([odd])).toEqual({ [itemErrorKey(odd.id)]: ["Choose a page, a post, a category, the blog or an address."] });
    const extra = entry({ onclick: "alert(1)" });
    expect(errorsOf([extra])).toEqual({ [itemErrorKey(extra.id)]: [expect.any(String)] });
    const pages = { id: id(), kind: "archive", contentType: "page", label: "", newTab: false };
    expect(errorsOf([pages])).toEqual({ [itemErrorKey(pages.id)]: ["Only the blog has an archive."] });
    expect(errorsOf([entry({ entryId: "../other-site" })])).not.toBeNull();
    expect(errorsOf([{ ...url("/x"), id: "1" }])).toEqual({ items: [expect.any(String)] });
    expect(errorsOf([entry({ newTab: "yes" })])).not.toBeNull();
    for (const input of [null, "[]", {}, 42, [null], [[]]]) expect(errorsOf(input), JSON.stringify(input)).toEqual({ items: [expect.any(String)] });
  });
});

describe("a stored menu, read value by value (the public site, the editor)", () => {
  it("keeps what reads as a link and leaves out the rest, never an error", () => {
    const good = url("/a");
    const child = entry();
    const items = readMenuItems([good, { kind: "url", url: "javascript:alert(1)", label: "x", id: id() }, null, "x", entry({ children: [child, { id: "bad" }, url("/c", { children: [url("/d")] })] })]);
    expect(items.map((one) => one.kind)).toEqual(["url", "entry"]);
    expect(items[1]!.children!.map((one) => one.id)).toEqual([child.id, expect.any(String)]);
    expect(items[1]!.children![1]).not.toHaveProperty("children");
    for (const stored of [null, undefined, {}, "[]", 3]) expect(readMenuItems(stored)).toEqual([]);
  });

  it(`stops at ${MENU_ITEMS_MAX} links, a missing new-tab choice is no new tab, and an id seen twice is read once`, () => {
    const many = Array.from({ length: 120 }, () => ({ ...url("/x"), newTab: undefined }));
    const items = readMenuItems(many);
    expect(countItems(items)).toBe(MENU_ITEMS_MAX);
    expect(items[0]!.newTab).toBe(false);
    const one = url("/x");
    expect(readMenuItems([one, one])).toHaveLength(1);
  });

  it("names what an item points at, for the lookups", () => {
    const [a, b, c, d] = readMenuItems([entry(), { id: id(), kind: "term", termId: id(), label: "", newTab: false }, { id: id(), kind: "archive", contentType: "post", label: "", newTab: false }, url("/x")]);
    expect(targetKey(a!)).toMatch(/^entry:/);
    expect(targetKey(b!)).toMatch(/^term:/);
    expect(targetKey(c!)).toBe("archive:post");
    expect(targetKey(d!)).toBeNull();
  });
});

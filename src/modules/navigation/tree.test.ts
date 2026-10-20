import { describe, expect, it } from "vitest";
import type { MenuItem } from "./shared";
import { canDrop, canIndent, canOutdent, dropItem, indentItem, moveItem, outdentItem, removeItem, updateItem } from "./tree";

const link = (id: string, children?: MenuItem[]): MenuItem => ({ id, kind: "url", url: `/${id}`, label: id, newTab: false, ...(children ? { children: children as never } : {}) });
const shape = (items: MenuItem[]): unknown => items.map((one) => (one.children?.length ? { [one.id]: one.children.map((under) => under.id) } : one.id));
const menu = () => [link("a"), link("b", [link("b1"), link("b2")]), link("c")];

describe("arranging a menu in the editor (M8-3)", () => {
  it("moves up and down among siblings, at the top and under a link; not past the ends", () => {
    expect(shape(moveItem(menu(), "c", -1))).toEqual(["a", "c", { b: ["b1", "b2"] }]);
    expect(shape(moveItem(menu(), "b2", -1))).toEqual(["a", { b: ["b2", "b1"] }, "c"]);
    expect(shape(moveItem(menu(), "a", -1))).toEqual(shape(menu()));
    expect(shape(moveItem(menu(), "b2", 1))).toEqual(shape(menu()));
  });

  it("goes under the link above (a top-level link with nothing under it), and back out after its link", () => {
    expect(canIndent(menu(), "c")).toBe(true);
    expect(shape(indentItem(menu(), "c"))).toEqual(["a", { b: ["b1", "b2", "c"] }]);
    expect(canIndent(menu(), "a")).toBe(false); // nothing above
    expect(canIndent(menu(), "b")).toBe(false); // it has links under it: a third level
    expect(canIndent(menu(), "b1")).toBe(false); // already under a link
    expect(canOutdent(menu(), "b1")).toBe(true);
    expect(shape(outdentItem(menu(), "b1"))).toEqual(["a", { b: ["b2"] }, "b1", "c"]);
    expect(shape(outdentItem(outdentItem(menu(), "b1"), "b2"))).toEqual(["a", "b", "b2", "b1", "c"]);
  });

  it("drags before, after or under a link, keeping two levels", () => {
    expect(shape(dropItem(menu(), "a", { targetId: "c", where: "after" }))).toEqual([{ b: ["b1", "b2"] }, "c", "a"]);
    expect(shape(dropItem(menu(), "a", { targetId: "b", where: "into" }))).toEqual([{ b: ["b1", "b2", "a"] }, "c"]);
    expect(shape(dropItem(menu(), "c", { targetId: "b1", where: "before" }))).toEqual(["a", { b: ["c", "b1", "b2"] }]);
    expect(shape(dropItem(menu(), "b2", { targetId: "a", where: "before" }))).toEqual(["b2", "a", { b: ["b1"] }, "c"]);
    // Refused: a third level, a link with links under it going under another, onto itself or into its own links.
    expect(canDrop(menu(), "a", { targetId: "b1", where: "into" })).toBe(false);
    expect(canDrop(menu(), "b", { targetId: "a", where: "into" })).toBe(false);
    expect(canDrop(menu(), "b", { targetId: "b1", where: "after" })).toBe(false);
    expect(canDrop(menu(), "a", { targetId: "a", where: "after" })).toBe(false);
    expect(shape(dropItem(menu(), "b", { targetId: "b1", where: "after" }))).toEqual(shape(menu()));
  });

  it("removes a link (with the links under it, at the top) and changes a label or the new-tab choice", () => {
    expect(shape(removeItem(menu(), "b1"))).toEqual(["a", { b: ["b2"] }, "c"]);
    expect(shape(removeItem(menu(), "b"))).toEqual(["a", "c"]);
    expect(shape(removeItem(removeItem(menu(), "b1"), "b2"))).toEqual(["a", "b", "c"]);
    const changed = updateItem(menu(), "b2", { label: "Kitchens", newTab: true });
    expect(changed[1]!.children![1]).toMatchObject({ id: "b2", label: "Kitchens", newTab: true });
    expect(updateItem(menu(), "a", { label: "Home" })[0]!.label).toBe("Home");
  });
});

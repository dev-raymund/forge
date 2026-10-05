import { describe, expect, it } from "vitest";
import { safeNextPath } from "@/platform/routing/admin-access";
import { chooseHomeOrganization, homePath, type HomeCandidate } from "./home";
import { ONBOARDING_PATH, orgPath, orgSettingsPath } from "./paths";
import { checkOrgSlug, RESERVED_ORG_SLUGS } from "./slugs";

const day = (n: number) => new Date(Date.UTC(2026, 9, n));
const org = (slug: string, joined: number, over: Partial<HomeCandidate> = {}): HomeCandidate => ({ id: `0199a000-0000-7000-8000-0000000000${slug.length}${joined}`, slug, status: "active", joinedAt: day(joined), ...over });

describe("where `/` takes a signed-in user", () => {
  it("no organizations: onboarding", () => {
    expect(chooseHomeOrganization([])).toBeNull();
    expect(homePath(null)).toBe(ONBOARDING_PATH);
    expect(homePath(chooseHomeOrganization([]))).toBe("/onboarding");
  });

  it("one organization: that one", () => {
    const only = org("acme", 1);
    expect(chooseHomeOrganization([only])).toBe(only);
    expect(homePath(only)).toBe("/acme");
  });

  it("several: the one joined last, whatever order they arrive in", () => {
    const [first, second, third] = [org("alpha", 1), org("beta", 5), org("gamma", 3)];
    for (const list of [[first, second, third], [third, second, first], [second, first, third], [third, first, second]]) {
      expect(chooseHomeOrganization(list)?.slug).toBe("beta");
    }
    expect(homePath(chooseHomeOrganization([first, second, third]))).toBe("/beta");
  });

  it("joined at the same instant: the newer organization (the higher id), every time", () => {
    const a = org("alpha", 2, { id: "0199a000-0000-7000-8000-000000000001" });
    const b = org("beta", 2, { id: "0199a000-0000-7000-8000-000000000002" });
    for (let i = 0; i < 5; i++) {
      expect(chooseHomeOrganization([a, b])?.slug).toBe("beta");
      expect(chooseHomeOrganization([b, a])?.slug).toBe("beta");
    }
  });

  it("an organization that can be used comes before a suspended one, however recently that was joined", () => {
    const usable = org("open", 1);
    const suspended = org("frozen", 9, { status: "suspended" });
    expect(chooseHomeOrganization([suspended, usable])?.slug).toBe("open");
    expect(chooseHomeOrganization([usable, suspended])?.slug).toBe("open");
  });

  it("every organization suspended: the one joined last anyway, so its page can say so", () => {
    const [older, newer] = [org("older", 1, { status: "suspended" }), org("newer", 4, { status: "suspended" })];
    expect(chooseHomeOrganization([older, newer])?.slug).toBe("newer");
  });

  it("does not reorder or change the list it was given", () => {
    const list = Object.freeze([org("alpha", 1), org("beta", 3), org("gamma", 2)]);
    const before = list.map((o) => o.slug);
    chooseHomeOrganization(list);
    expect(list.map((o) => o.slug)).toEqual(before);
  });
});

describe("organization URLs", () => {
  it("are the slug as the first segment, and nothing else", () => {
    expect(orgPath("acme-studio")).toBe("/acme-studio");
    expect(orgSettingsPath("acme-studio")).toBe("/acme-studio/settings");
  });

  it("for every slug the rules accept, are paths the app itself would redirect to", () => {
    for (const input of ["acme", "acme-studio", "a1b", "x".repeat(63), "  Acme-Studio  ", "123"]) {
      const checked = checkOrgSlug(input);
      expect(checked.ok, input).toBe(true);
      if (!checked.ok) continue;
      for (const path of [orgPath(checked.slug), orgSettingsPath(checked.slug)]) expect(safeNextPath(path), path).toBe(path);
    }
  });

  it("can never be one of the app's own top-level pages: those words are not slugs", () => {
    for (const word of RESERVED_ORG_SLUGS) expect(checkOrgSlug(word).ok, word).toBe(false);
    for (const word of ["onboarding", "login", "account", "settings", "api", "s"]) expect(checkOrgSlug(word).ok, word).toBe(false);
  });
});

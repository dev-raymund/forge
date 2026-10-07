import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { ActivityItem } from "../activity";
import { AUDIT_ACTIONS } from "../events";
import { ActivityView, type ActivityViewProps } from "./activity-view";

const html = (node: React.ReactNode) => renderToStaticMarkup(node);
const count = (markup: string, pattern: RegExp) => markup.match(pattern)?.length ?? 0;
const tag = (markup: string, pattern: RegExp) => markup.match(pattern)?.[0] ?? "";
const attr = (element: string, name: string) => element.match(new RegExp(`\\b${name}="([^"]*)"`))?.[1];

const MEMBER = "0199a000-0000-7000-8000-0000000000a1";
const BASE = "/acme/activity";
const event = (n: number, over: Partial<ActivityItem> = {}): ActivityItem => ({
  id: `0199a000-0000-7000-8000-${String(n).padStart(12, "0")}`,
  action: "member.role_changed",
  actorName: "Raymund",
  resourceType: "membership",
  metadata: { memberName: "Jane", previousRole: "author", newRole: "editor" },
  occurredAt: new Date("2026-10-06T09:30:00.000Z"),
  ...over,
});
const members = [{ id: MEMBER, name: "Raymund" }, { id: "0199a000-0000-7000-8000-0000000000a2", name: "Jane" }];
const view = (over: Partial<ActivityViewProps> = {}) =>
  html(<ActivityView basePath={BASE} query={{}} page={{ items: [event(1)], nextCursor: null }} members={members} {...over} />);

describe("the activity page", () => {
  it("lists each event as a sentence with when it happened, newest first as given", () => {
    const out = view({
      page: {
        items: [
          event(3, { action: "member.invited", metadata: { email: "john@example.com", role: "author" } }),
          event(2),
          event(1, { action: "organization.created", metadata: { name: "Acme", slug: "acme" }, occurredAt: new Date("2026-10-01T08:00:00.000Z") }),
        ],
        nextCursor: null,
      },
    });
    const lines = [...out.matchAll(/<li[^>]*data-testid="event"[^>]*>(.*?)<\/li>/gs)].map((m) => m[1]!.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim());
    expect(lines).toEqual([
      "Raymund invited john@example.com as an Author. Oct 6, 2026, 9:30 AM UTC",
      "Raymund changed Jane’s role from Author to Editor. Oct 6, 2026, 9:30 AM UTC",
      "Raymund created the organization Acme. Oct 1, 2026, 8:00 AM UTC",
    ]);
    expect(out).toMatch(/<time dateTime="2026-10-06T09:30:00.000Z">/);
    expect(count(out, /<h1/g)).toBe(1);
    expect([...out.matchAll(/data-action="([^"]+)"/g)].map((m) => m[1])).toEqual(["member.invited", "member.role_changed", "organization.created"]);
  });

  it("shows no ids, no addresses of requests and nothing an item does not carry as words", () => {
    const loud = event(7, {
      metadata: { memberName: "Jane", previousRole: "author", newRole: "editor", ip: "203.0.113.9", requestId: "req-secret", token: "tok_secret", userId: "0199a000-dead-7000-8000-00000000beef" },
      ...({ ip: "203.0.113.9", requestId: "req-secret", actorId: "0199a000-dead-7000-8000-00000000beef", actorLabel: "raymund@example.test" } as object),
    });
    const out = view({ page: { items: [loud], nextCursor: null } });
    for (const hidden of ["203.0.113.9", "req-secret", "tok_secret", "0199a000-dead", "raymund@example.test", loud.id]) expect(out).not.toContain(hidden);
    expect(out).toContain("Raymund changed Jane’s role from Author to Editor.");
  });

  it("an event from elsewhere, or one whose details are unreadable, is still a line", () => {
    const out = view({ page: { items: [event(2, { action: "entry.published", metadata: { type: "post" } }), event(1, { metadata: {} })], nextCursor: null } });
    expect(out).toContain("Raymund did something Forge cannot describe yet (entry.published).");
    expect(out).toContain("Raymund changed a member’s role.");
  });

  it("text from the log is shown as text: markup in a name stays markup-free", () => {
    const out = view({ page: { items: [event(1, { actorName: '<img src=x onerror="alert(1)">', metadata: { memberName: "<script>alert(1)</script>", previousRole: "author", newRole: "editor" } })], nextCursor: null } });
    expect(out).not.toMatch(/<img|<script/);
    expect(out).toContain("&lt;script&gt;");
  });

  it("the filters are an ordinary GET form on the page's own path: events from the catalog, members by membership id, two days", () => {
    const out = view();
    const form = tag(out, /<form[^>]*>/);
    expect({ method: attr(form, "method"), action: attr(form, "action"), label: attr(form, "aria-label") }).toEqual({ method: "get", action: BASE, label: "Filter activity" });

    const select = (name: string) => out.match(new RegExp(`<select[^>]*name="${name}"[^>]*>(.*?)</select>`, "s"))?.[1] ?? "";
    const values = (markup: string) => [...markup.matchAll(/<option[^>]*value="([^"]*)"/g)].map((m) => m[1]);
    expect(values(select("action"))).toEqual(["", ...AUDIT_ACTIONS]);
    expect(values(select("member"))).toEqual(["", ...members.map((m) => m.id)]);
    expect(select("member")).toContain(">Jane<");
    for (const name of ["from", "to"]) expect(attr(tag(out, new RegExp(`<input[^>]*name="${name}"[^>]*>`)), "type")).toBe("date");
    // Every control has a label; nothing hidden travels with the form.
    for (const id of ["activity-action", "activity-member", "activity-from", "activity-to"]) expect(out).toMatch(new RegExp(`<label[^>]*for="${id}"`));
    expect(out).not.toMatch(/type="hidden"/);
    expect(out).not.toMatch(/name="(organizationId|org|orgSlug|userId|limit|sort)"/);
  });

  it("the form shows what is being filtered, and offers a way back to everything only then", () => {
    const filtered = view({ query: { action: "member.invited", member: MEMBER, from: "2026-01-10", to: "2026-01-31" } });
    expect(filtered).toMatch(/<option value="member.invited" selected="">/);
    expect(filtered).toMatch(new RegExp(`<option value="${MEMBER}" selected="">`));
    expect(attr(tag(filtered, /<input[^>]*name="from"[^>]*>/), "value")).toBe("2026-01-10");
    expect(attr(tag(filtered, /<input[^>]*name="to"[^>]*>/), "value")).toBe("2026-01-31");
    expect(filtered).toMatch(new RegExp(`<a[^>]*href="${BASE}"[^>]*>Clear filters</a>`));
    expect(view()).not.toContain("Clear filters");
  });

  it("pages: a link to older events when there are some, carrying the filters; and a way back to the newest", () => {
    const cursor = `1767225600123456_${MEMBER}`;
    const first = view({ query: { action: "member.left" }, page: { items: [event(1)], nextCursor: cursor } });
    expect(first).toMatch(new RegExp(`<a[^>]*href="${BASE}\\?action=member.left&amp;before=${cursor}"[^>]*>Older activity</a>`));
    expect(first).not.toContain("Back to the newest");

    const later = view({ query: { action: "member.left", before: cursor }, page: { items: [event(1)], nextCursor: null } });
    expect(later).toMatch(new RegExp(`<a[^>]*href="${BASE}\\?action=member.left"[^>]*>Back to the newest</a>`));
    expect(later).not.toContain("Older activity");

    const only = view();
    expect(only).not.toMatch(/<nav/);
  });

  it("says so when there is nothing: nothing yet, or nothing that matches", () => {
    expect(view({ page: { items: [], nextCursor: null } })).toContain("Nothing has been recorded yet.");
    expect(view({ query: { action: "member.left" }, page: { items: [], nextCursor: null } })).toContain("No activity matches these filters.");
    expect(view({ page: { items: [], nextCursor: null } })).not.toMatch(/data-testid="activity"/);
  });

  it("offers nothing that changes the log: no button but the filter's, no form but the filter's", () => {
    const out = view({ page: { items: [event(2), event(1)], nextCursor: `1767225600123456_${MEMBER}` } });
    expect(count(out, /<form/g)).toBe(1);
    expect(count(out, /<button/g)).toBe(1);
    // What can be clicked: the filter, the pages. Nothing that would change or take away a line.
    const clickable = [...out.matchAll(/<(a|button)\b[^>]*>(.*?)<\/\1>/gs)].map((m) => m[2]!.replace(/<[^>]+>/g, "").trim());
    expect(clickable).toEqual(["Apply filters", "Older activity"]);
  });
});

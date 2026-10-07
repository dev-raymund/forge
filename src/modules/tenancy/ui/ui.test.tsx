import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

// The forms import their Server Actions; rendering needs only their identity.
vi.mock("../actions", () => ({
  createOrganizationAction: vi.fn(), renameOrganizationAction: vi.fn(), changeOrganizationSlugAction: vi.fn(), transferOwnershipAction: vi.fn(),
  inviteMemberAction: vi.fn(), resendInvitationAction: vi.fn(), revokeInvitationAction: vi.fn(), changeMemberRoleAction: vi.fn(),
  removeMemberAction: vi.fn(), leaveOrganizationAction: vi.fn(), acceptInvitationAction: vi.fn(),
}));
const location = vi.hoisted(() => ({ pathname: "/acme" }));
vi.mock("next/navigation", () => ({ usePathname: () => location.pathname }));

import { SectionNav } from "@/components/admin/section-nav";
import type { InvitationSummary } from "../invitations.service";
import { describeMembers } from "../members-view";
import type { RoleKey } from "../schema";
import type { MemberSummary } from "../shared";
import { AcceptInvitationForm } from "./accept-invitation";
import { CreateOrganizationForm } from "./create-organization-form";
import { MembersPage } from "./members-view";
import { OrganizationSettingsView, type OrganizationSettingsViewProps } from "./organization-settings-view";
import { OrgSwitcher } from "./org-switcher";

const html = (node: React.ReactNode) => renderToStaticMarkup(node);
const count = (markup: string, pattern: RegExp) => markup.match(pattern)?.length ?? 0;
const tag = (markup: string, pattern: RegExp) => markup.match(pattern)?.[0] ?? "";
const attr = (element: string, name: string) => element.match(new RegExp(`\\b${name}="([^"]*)"`))?.[1];

const organization = { name: "Acme Studio", slug: "acme-studio" };
const candidates = [
  { memberId: "0199a000-0000-7000-8000-0000000000b1", name: "Bob Member", email: "bob@example.test", role: "Editor" },
  { memberId: "0199a000-0000-7000-8000-0000000000c1", name: "Cy Admin", email: "cy@example.test", role: "Admin" },
];
const settings = (over: Partial<OrganizationSettingsViewProps>) =>
  html(<OrganizationSettingsView organization={organization} canUpdate={false} canTransfer={false} candidates={[]} {...over} />);

describe("organization settings: what is on the page follows what the member may do", () => {
  it("someone who may change the organization gets the name and URL forms, filled in", () => {
    const out = settings({ canUpdate: true });
    expect(out).toMatch(/<form[^>]*aria-label="Organization name"/);
    expect(out).toMatch(/<form[^>]*aria-label="Organization URL"/);
    expect(attr(tag(out, /<input[^>]*name="name"[^>]*>/), "value")).toBe("Acme Studio");
    expect(attr(tag(out, /<input[^>]*name="slug"[^>]*>/), "value")).toBe("acme-studio");
    expect(out).not.toContain('data-testid="organization-details"');
    expect(out).toContain("Changing the URL breaks links and bookmarks");
  });

  it("someone who may only look gets the same two facts and nothing to change them with", () => {
    const out = settings({ canUpdate: false, canTransfer: false });
    expect(out).toContain('data-testid="organization-details"');
    expect(out).toContain("Acme Studio");
    expect(out).toContain("/acme-studio");
    expect(out).toContain("Only an Owner can change the name or the URL of this organization.");
    expect(out).toContain("Only an Owner can transfer this organization to another member.");
    for (const control of [/<form/, /<input/, /<select/, /<button/, /<textarea/]) expect(out, String(control)).not.toMatch(control);
  });

  it("the transfer button is there only for someone who may transfer, and only when there is somebody to hand it to", () => {
    const withMembers = settings({ canUpdate: true, canTransfer: true, candidates });
    expect(count(withMembers, /<button[^>]*>Transfer ownership…<\/button>/g)).toBe(1);
    expect(withMembers).toContain("They become an Owner, and you become an Admin.");

    const alone = settings({ canUpdate: true, canTransfer: true, candidates: [] });
    expect(alone).not.toContain("Transfer ownership…");
    expect(alone).toContain('data-testid="no-transfer-candidates"');

    // Candidates without the permission change nothing: the page does not offer what the server would refuse.
    const notAllowed = settings({ canUpdate: false, canTransfer: false, candidates });
    expect(notAllowed).not.toContain("Transfer ownership…");
    expect(notAllowed).not.toContain("Bob Member");
    expect(notAllowed).not.toContain("bob@example.test");
  });

  it("the two permissions are independent: each form follows its own", () => {
    const transferOnly = settings({ canUpdate: false, canTransfer: true, candidates });
    expect(transferOnly).toContain("Transfer ownership…");
    expect(transferOnly).not.toMatch(/aria-label="Organization name"/);
    const updateOnly = settings({ canUpdate: true, canTransfer: false, candidates });
    expect(updateOnly).toMatch(/aria-label="Organization name"/);
    expect(updateOnly).not.toContain("Transfer ownership…");
  });

  it("nothing in the markup carries an organization id, a role or a permission for the browser to send back", () => {
    for (const out of [settings({ canUpdate: true, canTransfer: true, candidates }), settings({})]) {
      expect(out).not.toMatch(/name="(id|organizationId|orgId|role|permissions?|userId|ownerId)"/);
      expect(out).not.toMatch(/org\.manage|org\.members\.manage/);
      expect(out).not.toMatch(/data-(role|permission)/);
    }
  });

  it("confirmations: the new URL after a move; the transfer only for someone who is no longer an Owner", () => {
    expect(settings({ canUpdate: true, canTransfer: true, notice: "url" })).toMatch(/role="status"[^>]*>.*The organization’s URL is now .*\/acme-studio/s);
    expect(settings({ notice: "owner" })).toContain("Ownership has been transferred. You are now an Admin of Acme Studio.");
    // `?changed=owner` typed into the address bar by someone who still is an Owner says nothing.
    expect(settings({ canUpdate: true, canTransfer: true, notice: "owner" })).not.toContain("Ownership has been transferred");
    expect(settings({})).not.toMatch(/role="status"/);
  });

  it("has one h1 and a labelled section for each part", () => {
    const out = settings({ canUpdate: true, canTransfer: true, candidates });
    expect(count(out, /<h1/g)).toBe(1);
    const sections = [...out.matchAll(/<section aria-labelledby="([^"]+)"/g)].map((match) => match[1]!);
    expect(sections).toHaveLength(3);
    for (const id of sections) expect(out).toContain(`id="${id}"`);
  });
});

describe("the organization switcher", () => {
  const organizations = [
    { slug: "acme", name: "Acme Studio", suspended: false },
    { slug: "beta", name: "Beta Co", suspended: true },
  ];

  it("shows the organization the URL names, and says so to a screen reader", () => {
    const out = html(<OrgSwitcher organizations={organizations} currentSlug="acme" />);
    const trigger = tag(out, /<button[^>]*>/);
    expect(attr(trigger, "aria-label")).toBe("Switch organization. Current: Acme Studio");
    expect(attr(trigger, "aria-haspopup")).toBe("menu");
    expect(attr(trigger, "aria-expanded")).toBe("false");
    expect(out).toMatch(/data-testid="current-organization"[^>]*>Acme Studio</);
  });

  it("with no organization in the URL (the account page), or a slug that is not in the list, it names none", () => {
    for (const currentSlug of [undefined, "somebody-elses"]) {
      const out = html(<OrgSwitcher organizations={organizations} currentSlug={currentSlug} />);
      expect(attr(tag(out, /<button[^>]*>/), "aria-label")).toBe("Switch organization");
      expect(out).toMatch(/data-testid="current-organization"[^>]*>Organizations</);
      expect(out).not.toContain("somebody-elses");
    }
  });

  it("keeps nothing of its own: what it shows is exactly what it was given", () => {
    const first = html(<OrgSwitcher organizations={organizations} currentSlug="acme" />);
    const second = html(<OrgSwitcher organizations={organizations} currentSlug="beta" />);
    expect(first).toContain("Acme Studio");
    expect(second).toMatch(/data-testid="current-organization"[^>]*>Beta Co</);
    expect(second).not.toMatch(/data-testid="current-organization"[^>]*>Acme Studio</);
  });
});

describe("the organization's links", () => {
  const items = [{ href: "/acme", label: "Overview" }, { href: "/acme/settings", label: "Settings" }];

  it("marks the page that is open, and only that one", () => {
    location.pathname = "/acme/settings";
    const out = html(<SectionNav label="Organization" items={items} />);
    expect(out).toMatch(/<nav aria-label="Organization"/);
    expect(attr(tag(out, /<a[^>]*href="\/acme\/settings"[^>]*>/), "aria-current")).toBe("page");
    expect(attr(tag(out, /<a[^>]*href="\/acme"[^>]*>/), "aria-current")).toBeUndefined();
  });

  it("shows the links it is given and no others: a member without the page gets no link to it", () => {
    location.pathname = "/acme";
    const out = html(<SectionNav label="Organization" items={items.slice(0, 1)} />);
    expect(count(out, /<a /g)).toBe(1);
    expect(out).not.toContain("Settings");
  });
});

describe("the onboarding form", () => {
  it("asks for a name and a URL, both labelled and required, and says what creating the organization means", () => {
    const out = html(<CreateOrganizationForm trialDays={14} />);
    expect(out).toMatch(/<form[^>]*aria-label="Create your organization"/);
    for (const name of ["name", "slug"]) {
      const input = tag(out, new RegExp(`<input[^>]*name="${name}"[^>]*>`));
      expect(input, name).toContain('required=""');
      expect(out).toMatch(new RegExp(`<label[^>]*for="${attr(input, "id")}"`));
      expect(attr(input, "aria-describedby")).toBe(`${attr(input, "id")}-hint`);
    }
    expect(attr(tag(out, /<input[^>]*name="name"[^>]*>/), "maxLength")).toBe("80");
    expect(out).toContain("You will be the Owner. A 14-day Pro trial starts now, with no card needed.");
    expect(out).toContain("Your organization will be at /your-organization");
    expect(count(out, /<button[^>]*type="submit"/g)).toBe(1);
    // The form sends a name and a URL. Who the Owner is, is not a field.
    expect(out).not.toMatch(/name="(id|organizationId|ownerId|userId|role|status|planKey)"/);
  });
});

describe("the members page: what is on it follows what the viewer may do", () => {
  const person = (role: RoleKey, name: string): MemberSummary => ({
    id: `m-${role}`, userId: `u-${role}`, name, email: `${role}@example.test`, role, joinedAt: new Date("2026-10-01T09:00:00Z"),
  });
  const people = [person("owner", "Olive Owner"), person("admin", "Adam Admin"), person("editor", "Edith Editor"), person("viewer", "Vic Viewer")];
  const invitation = (over: Partial<InvitationSummary> = {}): InvitationSummary => ({
    id: "0199a000-0000-7000-8000-0000000000e1", email: "newcomer@example.test", role: "author", invitedByName: "Olive Owner",
    createdAt: new Date("2026-10-05T09:00:00Z"), expiresAt: new Date("2026-10-12T09:00:00Z"), expired: false, ...over,
  });
  const page = (role: RoleKey, options: { emailVerified?: boolean; invitations?: InvitationSummary[] } = {}) => {
    const view = describeMembers({ membershipId: `m-${role}`, role, emailVerified: options.emailVerified ?? true }, people);
    return html(<MembersPage organization={organization} view={view} invitations={view.canManage ? (options.invitations ?? []) : []} />);
  };
  const rowOf = (out: string, name: string) => out.match(new RegExp(`<tr[^>]*data-testid="member"[^>]*>(?:(?!</tr>).)*${name}(?:(?!</tr>).)*</tr>`, "s"))?.[0] ?? "";

  it("every member sees everyone: name, address, role and when they joined", () => {
    for (const role of ["owner", "admin", "editor", "viewer"] as const) {
      const out = page(role);
      expect(count(out, /data-testid="member"/g), role).toBe(4);
      for (const p of people) {
        expect(rowOf(out, p.name)).toContain(p.email);
      }
      expect(rowOf(out, "Olive Owner")).toMatch(/data-testid="role"[^>]*>Owner</);
      expect(rowOf(out, "Edith Editor")).toMatch(/data-testid="role"[^>]*>Editor</);
      expect(out).toMatch(/<time dateTime="2026-10-01T09:00:00.000Z">Oct 1, 2026<\/time>/);
      expect(count(out, /<h1/g)).toBe(1);
    }
  });

  it("someone who cannot manage members gets the list, their own way out, and nothing else", () => {
    const out = page("viewer", { invitations: [invitation()] });
    expect(out).not.toContain("Invite member");
    expect(out).not.toContain("Invitations");
    expect(out).not.toContain("newcomer@example.test"); // who has been invited is not theirs to see
    expect(out).not.toMatch(/aria-label="Actions for /);
    expect(out).not.toContain("Resend");
    // Their own row is marked, and has the one thing they can do.
    expect(rowOf(out, "Vic Viewer")).toContain(">You<");
    expect(rowOf(out, "Vic Viewer")).toMatch(/<button[^>]*>Leave<\/button>/);
    expect(count(out, /<button/g)).toBe(1);
  });

  it("an Admin gets the invite button and a menu on everyone they may manage: not the Owner, not themselves", () => {
    const out = page("admin");
    expect(count(out, /<button[^>]*>Invite member<\/button>/g)).toBe(1);
    expect(rowOf(out, "Edith Editor")).toMatch(/aria-label="Actions for Edith Editor"/);
    expect(rowOf(out, "Vic Viewer")).toMatch(/aria-label="Actions for Vic Viewer"/);
    expect(rowOf(out, "Olive Owner")).not.toMatch(/<button/);
    expect(rowOf(out, "Adam Admin")).not.toMatch(/aria-label="Actions for/);
    expect(rowOf(out, "Adam Admin")).toMatch(/<button[^>]*>Leave<\/button>/);
    expect(out).toContain("ownership is not a role to pick from a list");
  });

  it("the Owner gets a menu on everyone else; on their own row only the way out, which the page knows is closed to them", () => {
    const out = page("owner");
    for (const name of ["Adam Admin", "Edith Editor", "Vic Viewer"]) expect(rowOf(out, name)).toMatch(new RegExp(`aria-label="Actions for ${name}"`));
    expect(rowOf(out, "Olive Owner")).not.toMatch(/aria-label="Actions for/);
    expect(rowOf(out, "Olive Owner")).toMatch(/<button[^>]*>Leave<\/button>/);
  });

  it("a manager whose own email is not verified is told so, and is not offered the invite button", () => {
    for (const role of ["owner", "admin"] as const) {
      const out = page(role, { emailVerified: false });
      expect(out).not.toContain("Invite member");
      expect(out).toMatch(/role="status"[^>]*>.*Verify your email address to invite people\./s);
      expect(out).toContain('href="/verify-email"');
      // Managing who is already here does not need it.
      expect(out).toMatch(/aria-label="Actions for Vic Viewer"/);
    }
    expect(page("viewer", { emailVerified: false })).not.toContain("Verify your email address to invite people.");
  });

  it("pending invitations: the address, the role, who invited, when it ends, and the two things that can be done with it", () => {
    const out = page("admin", { invitations: [invitation(), invitation({ id: "0199a000-0000-7000-8000-0000000000e2", email: "late@example.test", role: "viewer", expired: true, invitedByName: null })] });
    expect(count(out, /data-testid="invitation"/g)).toBe(2);
    const [first, second] = [...out.matchAll(/<li[^>]*data-testid="invitation"[^>]*>(.*?)<\/li>/gs)].map((m) => m[1]!);
    expect(first).toContain("newcomer@example.test");
    expect(first).toContain(">Author<");
    expect(first).toContain("Invited by Olive Owner.");
    expect(first).toContain("Expires on ");
    expect(first).not.toContain(">Expired<");
    expect(first).toMatch(/aria-label="Send the invitation to newcomer@example.test again"/);
    expect(first).toMatch(/aria-label="Revoke the invitation to newcomer@example.test"/);
    // Each button's form names the invitation by its id and carries nothing else.
    expect([...first!.matchAll(/<input[^>]*type="hidden"[^>]*>/g)].map((m) => attr(m[0], "name"))).toEqual(["invitationId", "invitationId"]);
    expect(second).toContain(">Expired<");
    expect(second).toContain("Expired on ");
    expect(second).not.toContain("Invited by");

    expect(page("owner", { invitations: [] })).toContain('data-testid="no-invitations"');
  });

  it("nothing on the page carries an organization id, a user id or a permission for the browser to send back", () => {
    for (const role of ["owner", "admin", "viewer"] as const) {
      const out = page(role, { invitations: [invitation()] });
      expect(out).not.toMatch(/name="(organizationId|orgId|userId|actorRole|permissions?)"/);
      expect(out).not.toMatch(/u-(owner|admin|editor|viewer)/); // user ids never reach the markup; members are named by membership id
      expect(out).not.toMatch(/org\.members\.manage|org\.manage/);
    }
  });
});

describe("the invitation page's button", () => {
  it("is one form with one button: there is no field for an address, a role or an organization", () => {
    const out = html(<AcceptInvitationForm action={vi.fn()} />);
    expect(out).toMatch(/<form[^>]*aria-label="Accept invitation"/);
    expect(count(out, /<button[^>]*type="submit"/g)).toBe(1);
    expect(out).toContain("Accept invitation");
    expect(out).not.toMatch(/<input(?![^>]*type="hidden")/);
    expect(out).not.toMatch(/name="(email|role|organizationId|token)"/);
  });
});

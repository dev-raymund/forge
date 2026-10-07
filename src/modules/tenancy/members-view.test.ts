import { describe, expect, it } from "vitest";
import { describeMembers, type MembersViewer } from "./members-view";
import { ROLE_KEYS, type RoleKey } from "./schema";
import type { MemberSummary } from "./shared";

const member = (role: RoleKey, n = 1): MemberSummary => ({
  id: `m-${role}-${n}`, userId: `u-${role}-${n}`, name: `${role} ${n}`, email: `${role}${n}@example.test`, role, joinedAt: new Date("2026-10-01T00:00:00Z"),
});
/** One of each role, plus a second Admin, Editor and Viewer to act on. */
const everyone = [member("owner"), member("admin"), member("admin", 2), member("editor"), member("editor", 2), member("author"), member("viewer"), member("viewer", 2)];
const viewerAs = (role: RoleKey, over: Partial<MembersViewer> = {}): MembersViewer => ({ membershipId: `m-${role}-1`, role, emailVerified: true, ...over });
const row = (view: ReturnType<typeof describeMembers>, id: string) => view.members.find((m) => m.id === id)!;

describe("what the members page offers", () => {
  it("Editors, Authors and Viewers see the list and nothing to change it with, except their own way out", () => {
    for (const role of ["editor", "author", "viewer"] as const) {
      const view = describeMembers(viewerAs(role), everyone);
      expect({ canManage: view.canManage, canInvite: view.canInvite, mustVerifyEmail: view.mustVerifyEmail }, role).toEqual({ canManage: false, canInvite: false, mustVerifyEmail: false });
      expect(view.members).toHaveLength(everyone.length);
      for (const m of view.members) expect({ canChangeRole: m.canChangeRole, canRemove: m.canRemove }, `${role} → ${m.id}`).toEqual({ canChangeRole: false, canRemove: false });
      expect(view.members.filter((m) => m.isSelf).map((m) => m.id)).toEqual([`m-${role}-1`]);
      expect(view.leaveBlocked).toBeNull();
    }
  });

  it("an Admin manages everyone below Owner, and is offered nothing on the Owner or on themselves", () => {
    const view = describeMembers(viewerAs("admin"), everyone);
    expect({ canManage: view.canManage, canInvite: view.canInvite }).toEqual({ canManage: true, canInvite: true });
    expect(row(view, "m-owner-1")).toMatchObject({ isOwner: true, canChangeRole: false, canRemove: false });
    expect(row(view, "m-admin-1")).toMatchObject({ isSelf: true, canChangeRole: false, canRemove: false });
    for (const id of ["m-admin-2", "m-editor-1", "m-author-1", "m-viewer-1"]) expect(row(view, id), id).toMatchObject({ canChangeRole: true, canRemove: true });
    expect(view.leaveBlocked).toBeNull();
  });

  it("the Owner manages everyone else; their own row offers no role change and no removal", () => {
    const view = describeMembers(viewerAs("owner"), everyone);
    expect(row(view, "m-owner-1")).toMatchObject({ isSelf: true, isOwner: true, canChangeRole: false, canRemove: false });
    for (const m of view.members.filter((m) => !m.isSelf)) expect(m, m.id).toMatchObject({ canChangeRole: true, canRemove: true, isOwner: false });
  });

  it("ownership is never a role to pick: an Owner's row has no role control, for another Owner either", () => {
    const twoOwners = [...everyone, member("owner", 2)];
    const view = describeMembers(viewerAs("owner"), twoOwners);
    expect(row(view, "m-owner-2")).toMatchObject({ isOwner: true, canChangeRole: false });
    // With a second Owner the rules do allow removing one of them; that stays possible.
    expect(row(view, "m-owner-2").canRemove).toBe(true);
    // An Admin still may not.
    expect(row(describeMembers(viewerAs("admin"), twoOwners), "m-owner-2")).toMatchObject({ canChangeRole: false, canRemove: false });
  });

  it("the only Owner cannot leave; with a second Owner either can; everyone else always can", () => {
    expect(describeMembers(viewerAs("owner"), everyone).leaveBlocked).toBe("last-owner");
    expect(describeMembers(viewerAs("owner"), [...everyone, member("owner", 2)]).leaveBlocked).toBeNull();
    for (const role of ["admin", "editor", "author", "viewer"] as const) expect(describeMembers(viewerAs(role), everyone).leaveBlocked, role).toBeNull();
    // Alone in the organization: the Owner stays.
    expect(describeMembers(viewerAs("owner"), [member("owner")]).leaveBlocked).toBe("last-owner");
  });

  it("inviting takes a verified email as well as the permission: without one the page says so instead of offering it", () => {
    for (const role of ["owner", "admin"] as const) {
      expect(describeMembers(viewerAs(role, { emailVerified: false }), everyone)).toMatchObject({ canManage: true, canInvite: false, mustVerifyEmail: true });
      expect(describeMembers(viewerAs(role), everyone)).toMatchObject({ canManage: true, canInvite: true, mustVerifyEmail: false });
    }
    // Verifying an email gives no permission: an Editor with one still cannot invite, and is not told to verify.
    expect(describeMembers(viewerAs("editor", { emailVerified: false }), everyone)).toMatchObject({ canManage: false, canInvite: false, mustVerifyEmail: false });
  });

  it("someone whose membership is not in the list is nobody's 'self', and a role this code does not know is offered nothing", () => {
    const stranger = describeMembers({ membershipId: "m-nobody", role: "admin", emailVerified: true }, everyone);
    expect(stranger.members.some((m) => m.isSelf)).toBe(false);
    const unknown = describeMembers({ membershipId: "m-x", role: "superuser" as RoleKey, emailVerified: true }, everyone);
    expect(unknown).toMatchObject({ canManage: false, canInvite: false });
    for (const m of unknown.members) expect(m.canChangeRole || m.canRemove, m.id).toBe(false);
  });

  it("covers every role as a viewer and keeps the list as it was given", () => {
    for (const role of ROLE_KEYS) {
      const view = describeMembers(viewerAs(role), everyone);
      expect(view.members.map((m) => m.id)).toEqual(everyone.map((m) => m.id));
      expect(view.members.map((m) => m.role)).toEqual(everyone.map((m) => m.role));
    }
  });
});

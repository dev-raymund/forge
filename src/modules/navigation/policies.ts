import { can, type OrgContext } from "@/modules/tenancy";

/** The menus page and its saves (M8-3): `site.menus.manage`, Owners, Admins and Editors. */
export const canManageMenus = (ctx: OrgContext): boolean => can(ctx, "site.menus.manage");

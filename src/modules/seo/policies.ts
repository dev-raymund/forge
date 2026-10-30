import { can, type OrgContext } from "@/modules/tenancy";

/** A site's redirects and not-found page (M8-5): `site.seo.manage` ("incl. redirects", plan §15), Owners, Admins and Editors. */
export const canManageRedirects = (ctx: OrgContext): boolean => can(ctx, "site.seo.manage");

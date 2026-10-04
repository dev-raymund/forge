-- M3-1: organizations and organization_members are readable by their members
-- before a tenant is chosen (the organization list), but writable only inside
-- the organization's own tenant context.
--
-- The original policies were FOR ALL, so their USING clause ("or I am a member",
-- "or it is my own row") also covered UPDATE and DELETE. With only a user
-- context, any member could delete the organization, and an Owner could delete
-- their own membership, without the tenancy module ever being involved.
--
-- Each table keeps its SELECT policy under the old name and gets explicit
-- INSERT / UPDATE / DELETE policies that require the tenant context. Between
-- the DROP and the CREATE below a table has no SELECT policy at all, which
-- under FORCE ROW LEVEL SECURITY means "no rows": it fails closed.
DROP POLICY "organization_members_membership" ON "organization_members" CASCADE;--> statement-breakpoint
DROP POLICY "organizations_membership" ON "organizations" CASCADE;--> statement-breakpoint
CREATE POLICY "organization_members_insert" ON "organization_members" AS PERMISSIVE FOR INSERT TO public WITH CHECK (organization_id = app_current_org_id());--> statement-breakpoint
CREATE POLICY "organization_members_update" ON "organization_members" AS PERMISSIVE FOR UPDATE TO public USING (organization_id = app_current_org_id()) WITH CHECK (organization_id = app_current_org_id());--> statement-breakpoint
CREATE POLICY "organization_members_delete" ON "organization_members" AS PERMISSIVE FOR DELETE TO public USING (organization_id = app_current_org_id());--> statement-breakpoint
CREATE POLICY "organizations_insert" ON "organizations" AS PERMISSIVE FOR INSERT TO public WITH CHECK (id = app_current_org_id());--> statement-breakpoint
CREATE POLICY "organizations_update" ON "organizations" AS PERMISSIVE FOR UPDATE TO public USING (id = app_current_org_id()) WITH CHECK (id = app_current_org_id());--> statement-breakpoint
CREATE POLICY "organizations_delete" ON "organizations" AS PERMISSIVE FOR DELETE TO public USING (id = app_current_org_id());--> statement-breakpoint
CREATE POLICY "organization_members_membership" ON "organization_members" AS PERMISSIVE FOR SELECT TO public USING (organization_id = app_current_org_id() or user_id = app_current_user_id());--> statement-breakpoint
CREATE POLICY "organizations_membership" ON "organizations" AS PERMISSIVE FOR SELECT TO public USING (id = app_current_org_id() or id in (select m.organization_id from organization_members m where m.user_id = app_current_user_id()));
CREATE TABLE "auth_accounts" (
	"id" uuid PRIMARY KEY NOT NULL,
	"user_id" uuid NOT NULL,
	"provider_id" text NOT NULL,
	"account_id" text NOT NULL,
	"password" text,
	"access_token" text,
	"refresh_token" text,
	"id_token" text,
	"access_token_expires_at" timestamp with time zone,
	"refresh_token_expires_at" timestamp with time zone,
	"scope" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "auth_sessions" (
	"id" uuid PRIMARY KEY NOT NULL,
	"user_id" uuid NOT NULL,
	"token" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"ip_address" text,
	"user_agent" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "auth_sessions_token_unique" UNIQUE("token")
);
--> statement-breakpoint
CREATE TABLE "auth_verifications" (
	"id" uuid PRIMARY KEY NOT NULL,
	"identifier" text NOT NULL,
	"value" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "users" (
	"id" uuid PRIMARY KEY NOT NULL,
	"name" text DEFAULT '' NOT NULL,
	"email" text NOT NULL,
	"email_verified" boolean DEFAULT false NOT NULL,
	"image" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "users_email_unique" UNIQUE("email"),
	CONSTRAINT "users_email_lowercase" CHECK ("email" = lower("email"))
);
--> statement-breakpoint
CREATE TABLE "organization_invitations" (
	"id" uuid PRIMARY KEY NOT NULL,
	"organization_id" uuid NOT NULL,
	"email" text NOT NULL,
	"role_id" uuid NOT NULL,
	"token_hash" text NOT NULL,
	"invited_by" uuid,
	"expires_at" timestamp with time zone NOT NULL,
	"accepted_at" timestamp with time zone,
	"revoked_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "organization_invitations_token_hash_unique" UNIQUE("token_hash"),
	CONSTRAINT "organization_invitations_email_lowercase" CHECK ("email" = lower("email"))
);
--> statement-breakpoint
ALTER TABLE "organization_invitations" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "organization_members" (
	"id" uuid PRIMARY KEY NOT NULL,
	"organization_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"role_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "organization_members_org_user_unique" UNIQUE("organization_id","user_id")
);
--> statement-breakpoint
ALTER TABLE "organization_members" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "organizations" (
	"id" uuid PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"slug" text NOT NULL,
	"status" text DEFAULT 'active' NOT NULL,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone,
	CONSTRAINT "organizations_slug_unique" UNIQUE("slug"),
	CONSTRAINT "organizations_status_check" CHECK ("status" in ('active', 'suspended')),
	CONSTRAINT "organizations_slug_format" CHECK ("slug" ~ '^[a-z0-9]+(-[a-z0-9]+)*$')
);
--> statement-breakpoint
ALTER TABLE "organizations" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "roles" (
	"id" uuid PRIMARY KEY NOT NULL,
	"organization_id" uuid,
	"key" text NOT NULL,
	"name" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "roles_org_key_unique" UNIQUE NULLS NOT DISTINCT("organization_id","key")
);
--> statement-breakpoint
CREATE TABLE "subscriptions" (
	"organization_id" uuid PRIMARY KEY NOT NULL,
	"plan_key" text DEFAULT 'pro' NOT NULL,
	"status" text DEFAULT 'trialing' NOT NULL,
	"trial_ends_at" timestamp with time zone,
	"stripe_customer_id" text,
	"stripe_subscription_id" text,
	"current_period_end" timestamp with time zone,
	"cancel_at_period_end" boolean DEFAULT false NOT NULL,
	"grace_until" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "subscriptions_stripe_customer_id_unique" UNIQUE("stripe_customer_id"),
	CONSTRAINT "subscriptions_stripe_subscription_id_unique" UNIQUE("stripe_subscription_id"),
	CONSTRAINT "subscriptions_plan_check" CHECK ("plan_key" in ('free', 'pro')),
	CONSTRAINT "subscriptions_status_check" CHECK ("status" in ('trialing', 'active', 'past_due', 'canceled', 'free'))
);
--> statement-breakpoint
ALTER TABLE "subscriptions" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "api_keys" (
	"id" uuid PRIMARY KEY NOT NULL,
	"organization_id" uuid NOT NULL,
	"site_id" uuid NOT NULL,
	"name" text NOT NULL,
	"prefix" text NOT NULL,
	"secret_hash" text NOT NULL,
	"scope" text NOT NULL,
	"created_by" uuid,
	"last_used_at" timestamp with time zone,
	"revoked_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "api_keys_secret_hash_unique" UNIQUE("secret_hash"),
	CONSTRAINT "api_keys_scope_check" CHECK ("scope" in ('read', 'write'))
);
--> statement-breakpoint
ALTER TABLE "api_keys" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "audit_logs" (
	"id" uuid PRIMARY KEY NOT NULL,
	"organization_id" uuid,
	"site_id" uuid,
	"actor_type" text NOT NULL,
	"actor_id" uuid,
	"actor_label" text DEFAULT '' NOT NULL,
	"action" text NOT NULL,
	"resource_type" text DEFAULT '' NOT NULL,
	"resource_id" uuid,
	"request_id" text DEFAULT '' NOT NULL,
	"ip" text DEFAULT '' NOT NULL,
	"metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "audit_logs_actor_type_check" CHECK ("actor_type" in ('user', 'api_key', 'system'))
);
--> statement-breakpoint
ALTER TABLE "audit_logs" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "site_settings" (
	"site_id" uuid PRIMARY KEY NOT NULL,
	"organization_id" uuid NOT NULL,
	"homepage_entry_id" uuid,
	"not_found_entry_id" uuid,
	"logo_media_id" uuid,
	"favicon_media_id" uuid,
	"general" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"reading" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"seo" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"analytics" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"theme" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"updated_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "site_settings" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "sites" (
	"id" uuid PRIMARY KEY NOT NULL,
	"organization_id" uuid NOT NULL,
	"name" text NOT NULL,
	"slug" text NOT NULL,
	"status" text DEFAULT 'coming_soon' NOT NULL,
	"theme_key" text DEFAULT 'studio' NOT NULL,
	"default_locale" text DEFAULT 'en' NOT NULL,
	"timezone" text DEFAULT 'UTC' NOT NULL,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone,
	CONSTRAINT "sites_org_id_unique" UNIQUE("organization_id","id"),
	CONSTRAINT "sites_status_check" CHECK ("status" in ('coming_soon', 'live', 'suspended')),
	CONSTRAINT "sites_slug_format" CHECK ("slug" ~ '^[a-z0-9]+(-[a-z0-9]+)*$')
);
--> statement-breakpoint
ALTER TABLE "sites" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "domains" (
	"id" uuid PRIMARY KEY NOT NULL,
	"organization_id" uuid NOT NULL,
	"site_id" uuid NOT NULL,
	"hostname" text NOT NULL,
	"kind" text NOT NULL,
	"is_primary" boolean DEFAULT false NOT NULL,
	"status" text NOT NULL,
	"verification_token" text,
	"verified_at" timestamp with time zone,
	"provider_state" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"last_checked_at" timestamp with time zone,
	"next_check_at" timestamp with time zone,
	"error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "domains_hostname_unique" UNIQUE("hostname"),
	CONSTRAINT "domains_kind_check" CHECK ("kind" in ('subdomain', 'custom')),
	CONSTRAINT "domains_status_check" CHECK ("status" in ('pending_verification', 'pending_dns', 'active', 'failed')),
	CONSTRAINT "domains_hostname_normalised" CHECK ("hostname" = lower("hostname") and "hostname" !~ '[.:]$|:')
);
--> statement-breakpoint
CREATE TABLE "entries" (
	"id" uuid PRIMARY KEY NOT NULL,
	"organization_id" uuid NOT NULL,
	"site_id" uuid NOT NULL,
	"type" text NOT NULL,
	"locale" text NOT NULL,
	"parent_id" uuid,
	"author_id" uuid,
	"status" text DEFAULT 'draft' NOT NULL,
	"title" text DEFAULT '' NOT NULL,
	"slug" text NOT NULL,
	"path" text NOT NULL,
	"excerpt" text DEFAULT '' NOT NULL,
	"featured_media_id" uuid,
	"published_revision_id" uuid,
	"published_at" timestamp with time zone,
	"first_published_at" timestamp with time zone,
	"scheduled_at" timestamp with time zone,
	"sort_order" integer DEFAULT 0 NOT NULL,
	"created_by" uuid,
	"updated_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone,
	CONSTRAINT "entries_site_id_unique" UNIQUE("site_id","id"),
	CONSTRAINT "entries_type_check" CHECK ("type" in ('page', 'post')),
	CONSTRAINT "entries_status_check" CHECK ("status" in ('draft', 'scheduled', 'published')),
	CONSTRAINT "entries_slug_format" CHECK (slug ~ '^[a-z0-9]+(-[a-z0-9]+)*$'),
	CONSTRAINT "entries_path_format" CHECK (path ~ '^(/[a-z0-9]+(-[a-z0-9]+)*)+$'),
	CONSTRAINT "entries_published_has_revision" CHECK ((status = 'published') = (published_revision_id is not null)),
	CONSTRAINT "entries_scheduled_has_time" CHECK ((status = 'scheduled') = (scheduled_at is not null)),
	CONSTRAINT "entries_trash_not_live" CHECK (deleted_at is null or status <> 'published'),
	CONSTRAINT "entries_only_pages_nest" CHECK (parent_id is null or type = 'page')
);
--> statement-breakpoint
ALTER TABLE "entries" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "entry_drafts" (
	"entry_id" uuid PRIMARY KEY NOT NULL,
	"organization_id" uuid NOT NULL,
	"site_id" uuid NOT NULL,
	"title" text DEFAULT '' NOT NULL,
	"slug" text NOT NULL,
	"excerpt" text DEFAULT '' NOT NULL,
	"featured_media_id" uuid,
	"template" text,
	"content" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"fields" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"seo" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"term_ids" uuid[] DEFAULT '{}'::uuid[] NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"content_hash" text DEFAULT '' NOT NULL,
	"updated_by" uuid,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "entry_drafts_version_positive" CHECK (version > 0)
);
--> statement-breakpoint
ALTER TABLE "entry_drafts" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "entry_revisions" (
	"id" uuid PRIMARY KEY NOT NULL,
	"organization_id" uuid NOT NULL,
	"site_id" uuid NOT NULL,
	"entry_id" uuid NOT NULL,
	"number" integer NOT NULL,
	"kind" text NOT NULL,
	"label" text,
	"title" text NOT NULL,
	"slug" text NOT NULL,
	"excerpt" text DEFAULT '' NOT NULL,
	"featured_media_id" uuid,
	"template" text,
	"content" jsonb NOT NULL,
	"fields" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"seo" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"term_ids" uuid[] DEFAULT '{}'::uuid[] NOT NULL,
	"content_hash" text NOT NULL,
	"source_draft_version" integer NOT NULL,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "entry_revisions_entry_number_unique" UNIQUE("entry_id","number"),
	CONSTRAINT "entry_revisions_entry_id_unique" UNIQUE("entry_id","id"),
	CONSTRAINT "entry_revisions_kind_check" CHECK ("kind" in ('save', 'publish', 'scheduled', 'restore'))
);
--> statement-breakpoint
ALTER TABLE "entry_revisions" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "entry_terms" (
	"organization_id" uuid NOT NULL,
	"site_id" uuid NOT NULL,
	"entry_id" uuid NOT NULL,
	"term_id" uuid NOT NULL,
	CONSTRAINT "entry_terms_pk" PRIMARY KEY("entry_id","term_id")
);
--> statement-breakpoint
ALTER TABLE "entry_terms" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "terms" (
	"id" uuid PRIMARY KEY NOT NULL,
	"organization_id" uuid NOT NULL,
	"site_id" uuid NOT NULL,
	"taxonomy" text NOT NULL,
	"parent_id" uuid,
	"name" text NOT NULL,
	"slug" text NOT NULL,
	"description" text DEFAULT '' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "terms_site_id_unique" UNIQUE("site_id","id"),
	CONSTRAINT "terms_site_taxonomy_slug_unique" UNIQUE("site_id","taxonomy","slug"),
	CONSTRAINT "terms_taxonomy_check" CHECK ("taxonomy" in ('category', 'tag')),
	CONSTRAINT "terms_slug_format" CHECK (slug ~ '^[a-z0-9]+(-[a-z0-9]+)*$'),
	CONSTRAINT "terms_only_categories_nest" CHECK (parent_id is null or taxonomy = 'category')
);
--> statement-breakpoint
ALTER TABLE "terms" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "media_assets" (
	"id" uuid PRIMARY KEY NOT NULL,
	"organization_id" uuid NOT NULL,
	"site_id" uuid NOT NULL,
	"folder_id" uuid,
	"kind" text NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"storage_driver" text DEFAULT 's3' NOT NULL,
	"storage_key" text NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"original_filename" text NOT NULL,
	"mime_type" text NOT NULL,
	"size_bytes" bigint NOT NULL,
	"width" integer,
	"height" integer,
	"title" text DEFAULT '' NOT NULL,
	"alt_text" text DEFAULT '' NOT NULL,
	"caption" text DEFAULT '' NOT NULL,
	"variants" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"uploaded_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone,
	CONSTRAINT "media_assets_storage_key_unique" UNIQUE("storage_key"),
	CONSTRAINT "media_assets_site_id_unique" UNIQUE("site_id","id"),
	CONSTRAINT "media_assets_kind_check" CHECK ("kind" in ('image', 'document')),
	CONSTRAINT "media_assets_status_check" CHECK ("status" in ('pending', 'ready', 'failed'))
);
--> statement-breakpoint
ALTER TABLE "media_assets" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "media_folders" (
	"id" uuid PRIMARY KEY NOT NULL,
	"organization_id" uuid NOT NULL,
	"site_id" uuid NOT NULL,
	"parent_id" uuid,
	"name" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "media_folders_site_id_unique" UNIQUE("site_id","id"),
	CONSTRAINT "media_folders_site_parent_name_unique" UNIQUE NULLS NOT DISTINCT("site_id","parent_id","name")
);
--> statement-breakpoint
ALTER TABLE "media_folders" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "menus" (
	"id" uuid PRIMARY KEY NOT NULL,
	"organization_id" uuid NOT NULL,
	"site_id" uuid NOT NULL,
	"location" text NOT NULL,
	"name" text DEFAULT '' NOT NULL,
	"items" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"updated_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "menus_site_location_unique" UNIQUE("site_id","location"),
	CONSTRAINT "menus_location_check" CHECK ("location" in ('header', 'footer'))
);
--> statement-breakpoint
ALTER TABLE "menus" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "redirects" (
	"id" uuid PRIMARY KEY NOT NULL,
	"organization_id" uuid NOT NULL,
	"site_id" uuid NOT NULL,
	"source_path" text NOT NULL,
	"destination" text NOT NULL,
	"status_code" integer DEFAULT 301 NOT NULL,
	"origin" text DEFAULT 'manual' NOT NULL,
	"is_active" boolean DEFAULT true NOT NULL,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "redirects_site_source_unique" UNIQUE("site_id","source_path"),
	CONSTRAINT "redirects_status_code_check" CHECK (status_code in (301, 302, 307, 308)),
	CONSTRAINT "redirects_source_is_path" CHECK (source_path like '/%' and source_path not like '/\_forge%'),
	CONSTRAINT "redirects_origin_check" CHECK ("origin" in ('manual', 'auto'))
);
--> statement-breakpoint
ALTER TABLE "redirects" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "jobs" (
	"id" uuid PRIMARY KEY NOT NULL,
	"type" text NOT NULL,
	"organization_id" uuid,
	"payload" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"status" text DEFAULT 'queued' NOT NULL,
	"run_at" timestamp with time zone DEFAULT now() NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"max_attempts" integer DEFAULT 5 NOT NULL,
	"locked_until" timestamp with time zone,
	"last_error" text,
	"dedupe_key" text,
	"finished_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "jobs_status_check" CHECK ("status" in ('queued', 'running', 'succeeded', 'failed', 'dead', 'canceled'))
);
--> statement-breakpoint
ALTER TABLE "auth_accounts" ADD CONSTRAINT "auth_accounts_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "auth_sessions" ADD CONSTRAINT "auth_sessions_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "organization_invitations" ADD CONSTRAINT "organization_invitations_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "organization_invitations" ADD CONSTRAINT "organization_invitations_role_id_roles_id_fk" FOREIGN KEY ("role_id") REFERENCES "public"."roles"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "organization_invitations" ADD CONSTRAINT "organization_invitations_invited_by_users_id_fk" FOREIGN KEY ("invited_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "organization_members" ADD CONSTRAINT "organization_members_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "organization_members" ADD CONSTRAINT "organization_members_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "organization_members" ADD CONSTRAINT "organization_members_role_id_roles_id_fk" FOREIGN KEY ("role_id") REFERENCES "public"."roles"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "organizations" ADD CONSTRAINT "organizations_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "roles" ADD CONSTRAINT "roles_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "subscriptions" ADD CONSTRAINT "subscriptions_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "api_keys" ADD CONSTRAINT "api_keys_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "api_keys" ADD CONSTRAINT "api_keys_site_fk" FOREIGN KEY ("organization_id","site_id") REFERENCES "public"."sites"("organization_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "site_settings" ADD CONSTRAINT "site_settings_updated_by_users_id_fk" FOREIGN KEY ("updated_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "site_settings" ADD CONSTRAINT "site_settings_site_fk" FOREIGN KEY ("organization_id","site_id") REFERENCES "public"."sites"("organization_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sites" ADD CONSTRAINT "sites_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sites" ADD CONSTRAINT "sites_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "domains" ADD CONSTRAINT "domains_site_fk" FOREIGN KEY ("organization_id","site_id") REFERENCES "public"."sites"("organization_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "entries" ADD CONSTRAINT "entries_author_id_users_id_fk" FOREIGN KEY ("author_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "entries" ADD CONSTRAINT "entries_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "entries" ADD CONSTRAINT "entries_updated_by_users_id_fk" FOREIGN KEY ("updated_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "entries" ADD CONSTRAINT "entries_site_fk" FOREIGN KEY ("organization_id","site_id") REFERENCES "public"."sites"("organization_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "entry_drafts" ADD CONSTRAINT "entry_drafts_updated_by_users_id_fk" FOREIGN KEY ("updated_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "entry_drafts" ADD CONSTRAINT "entry_drafts_site_fk" FOREIGN KEY ("organization_id","site_id") REFERENCES "public"."sites"("organization_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "entry_drafts" ADD CONSTRAINT "entry_drafts_entry_fk" FOREIGN KEY ("site_id","entry_id") REFERENCES "public"."entries"("site_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "entry_revisions" ADD CONSTRAINT "entry_revisions_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "entry_revisions" ADD CONSTRAINT "entry_revisions_site_fk" FOREIGN KEY ("organization_id","site_id") REFERENCES "public"."sites"("organization_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "entry_revisions" ADD CONSTRAINT "entry_revisions_entry_fk" FOREIGN KEY ("site_id","entry_id") REFERENCES "public"."entries"("site_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "entry_terms" ADD CONSTRAINT "entry_terms_site_fk" FOREIGN KEY ("organization_id","site_id") REFERENCES "public"."sites"("organization_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "entry_terms" ADD CONSTRAINT "entry_terms_entry_fk" FOREIGN KEY ("site_id","entry_id") REFERENCES "public"."entries"("site_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "entry_terms" ADD CONSTRAINT "entry_terms_term_fk" FOREIGN KEY ("site_id","term_id") REFERENCES "public"."terms"("site_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "terms" ADD CONSTRAINT "terms_site_fk" FOREIGN KEY ("organization_id","site_id") REFERENCES "public"."sites"("organization_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "media_assets" ADD CONSTRAINT "media_assets_uploaded_by_users_id_fk" FOREIGN KEY ("uploaded_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "media_assets" ADD CONSTRAINT "media_assets_site_fk" FOREIGN KEY ("organization_id","site_id") REFERENCES "public"."sites"("organization_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "media_folders" ADD CONSTRAINT "media_folders_site_fk" FOREIGN KEY ("organization_id","site_id") REFERENCES "public"."sites"("organization_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "menus" ADD CONSTRAINT "menus_updated_by_users_id_fk" FOREIGN KEY ("updated_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "menus" ADD CONSTRAINT "menus_site_fk" FOREIGN KEY ("organization_id","site_id") REFERENCES "public"."sites"("organization_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "redirects" ADD CONSTRAINT "redirects_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "redirects" ADD CONSTRAINT "redirects_site_fk" FOREIGN KEY ("organization_id","site_id") REFERENCES "public"."sites"("organization_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "auth_accounts_user_idx" ON "auth_accounts" USING btree ("user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "auth_accounts_provider_account_unique" ON "auth_accounts" USING btree ("provider_id","account_id");--> statement-breakpoint
CREATE INDEX "auth_sessions_user_idx" ON "auth_sessions" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "auth_sessions_expires_idx" ON "auth_sessions" USING btree ("expires_at");--> statement-breakpoint
CREATE INDEX "auth_verifications_identifier_idx" ON "auth_verifications" USING btree ("identifier");--> statement-breakpoint
CREATE UNIQUE INDEX "organization_invitations_open_email_unique" ON "organization_invitations" USING btree ("organization_id","email") WHERE accepted_at is null and revoked_at is null;--> statement-breakpoint
CREATE INDEX "organization_members_user_idx" ON "organization_members" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "api_keys_site_idx" ON "api_keys" USING btree ("site_id");--> statement-breakpoint
CREATE INDEX "audit_logs_org_created_idx" ON "audit_logs" USING btree ("organization_id","created_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "audit_logs_org_resource_idx" ON "audit_logs" USING btree ("organization_id","resource_type","resource_id");--> statement-breakpoint
CREATE UNIQUE INDEX "sites_org_slug_unique" ON "sites" USING btree ("organization_id","slug") WHERE deleted_at is null;--> statement-breakpoint
CREATE UNIQUE INDEX "domains_one_primary_per_site" ON "domains" USING btree ("site_id") WHERE is_primary;--> statement-breakpoint
CREATE INDEX "domains_site_idx" ON "domains" USING btree ("site_id");--> statement-breakpoint
CREATE INDEX "domains_next_check_idx" ON "domains" USING btree ("next_check_at") WHERE status in ('pending_verification', 'pending_dns');--> statement-breakpoint
CREATE UNIQUE INDEX "entries_site_locale_path_unique" ON "entries" USING btree ("site_id","locale","path") WHERE deleted_at is null;--> statement-breakpoint
CREATE INDEX "entries_list_published_idx" ON "entries" USING btree ("site_id","type","status","published_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "entries_list_updated_idx" ON "entries" USING btree ("site_id","type","updated_at" DESC NULLS LAST) WHERE deleted_at is null;--> statement-breakpoint
CREATE INDEX "entries_tree_idx" ON "entries" USING btree ("site_id","parent_id","sort_order");--> statement-breakpoint
CREATE INDEX "entry_revisions_entry_created_idx" ON "entry_revisions" USING btree ("entry_id","created_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "entry_terms_term_idx" ON "entry_terms" USING btree ("term_id");--> statement-breakpoint
CREATE INDEX "media_assets_site_created_idx" ON "media_assets" USING btree ("site_id","created_at" DESC NULLS LAST) WHERE deleted_at is null;--> statement-breakpoint
CREATE INDEX "media_assets_site_folder_idx" ON "media_assets" USING btree ("site_id","folder_id");--> statement-breakpoint
CREATE INDEX "jobs_queued_run_at_idx" ON "jobs" USING btree ("run_at") WHERE status = 'queued';--> statement-breakpoint
CREATE UNIQUE INDEX "jobs_active_dedupe_unique" ON "jobs" USING btree ("dedupe_key") WHERE dedupe_key is not null and status in ('queued', 'running');--> statement-breakpoint
CREATE POLICY "organization_invitations_tenant_isolation" ON "organization_invitations" AS PERMISSIVE FOR ALL TO public USING (organization_id = app_current_org_id()) WITH CHECK (organization_id = app_current_org_id());--> statement-breakpoint
CREATE POLICY "organization_members_membership" ON "organization_members" AS PERMISSIVE FOR ALL TO public USING (organization_id = app_current_org_id() or user_id = app_current_user_id()) WITH CHECK (organization_id = app_current_org_id());--> statement-breakpoint
CREATE POLICY "organizations_membership" ON "organizations" AS PERMISSIVE FOR ALL TO public USING (id = app_current_org_id() or id in (select m.organization_id from organization_members m where m.user_id = app_current_user_id())) WITH CHECK (id = app_current_org_id());--> statement-breakpoint
CREATE POLICY "subscriptions_tenant_isolation" ON "subscriptions" AS PERMISSIVE FOR ALL TO public USING (organization_id = app_current_org_id()) WITH CHECK (organization_id = app_current_org_id());--> statement-breakpoint
CREATE POLICY "api_keys_tenant_isolation" ON "api_keys" AS PERMISSIVE FOR ALL TO public USING (organization_id = app_current_org_id()) WITH CHECK (organization_id = app_current_org_id());--> statement-breakpoint
CREATE POLICY "audit_logs_tenant_isolation" ON "audit_logs" AS PERMISSIVE FOR ALL TO public USING (organization_id = app_current_org_id()) WITH CHECK (organization_id is null or organization_id = app_current_org_id());--> statement-breakpoint
CREATE POLICY "site_settings_tenant_isolation" ON "site_settings" AS PERMISSIVE FOR ALL TO public USING (organization_id = app_current_org_id()) WITH CHECK (organization_id = app_current_org_id());--> statement-breakpoint
CREATE POLICY "sites_tenant_isolation" ON "sites" AS PERMISSIVE FOR ALL TO public USING (organization_id = app_current_org_id()) WITH CHECK (organization_id = app_current_org_id());--> statement-breakpoint
CREATE POLICY "entries_tenant_isolation" ON "entries" AS PERMISSIVE FOR ALL TO public USING (organization_id = app_current_org_id()) WITH CHECK (organization_id = app_current_org_id());--> statement-breakpoint
CREATE POLICY "entry_drafts_tenant_isolation" ON "entry_drafts" AS PERMISSIVE FOR ALL TO public USING (organization_id = app_current_org_id()) WITH CHECK (organization_id = app_current_org_id());--> statement-breakpoint
CREATE POLICY "entry_revisions_tenant_isolation" ON "entry_revisions" AS PERMISSIVE FOR ALL TO public USING (organization_id = app_current_org_id()) WITH CHECK (organization_id = app_current_org_id());--> statement-breakpoint
CREATE POLICY "entry_terms_tenant_isolation" ON "entry_terms" AS PERMISSIVE FOR ALL TO public USING (organization_id = app_current_org_id()) WITH CHECK (organization_id = app_current_org_id());--> statement-breakpoint
CREATE POLICY "terms_tenant_isolation" ON "terms" AS PERMISSIVE FOR ALL TO public USING (organization_id = app_current_org_id()) WITH CHECK (organization_id = app_current_org_id());--> statement-breakpoint
CREATE POLICY "media_assets_tenant_isolation" ON "media_assets" AS PERMISSIVE FOR ALL TO public USING (organization_id = app_current_org_id()) WITH CHECK (organization_id = app_current_org_id());--> statement-breakpoint
CREATE POLICY "media_folders_tenant_isolation" ON "media_folders" AS PERMISSIVE FOR ALL TO public USING (organization_id = app_current_org_id()) WITH CHECK (organization_id = app_current_org_id());--> statement-breakpoint
CREATE POLICY "menus_tenant_isolation" ON "menus" AS PERMISSIVE FOR ALL TO public USING (organization_id = app_current_org_id()) WITH CHECK (organization_id = app_current_org_id());--> statement-breakpoint
CREATE POLICY "redirects_tenant_isolation" ON "redirects" AS PERMISSIVE FOR ALL TO public USING (organization_id = app_current_org_id()) WITH CHECK (organization_id = app_current_org_id());
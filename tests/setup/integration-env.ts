/**
 * Integration-test connection defaults (docker-compose services).
 *
 *   owner (direct, :5432)  — runs migrations, like CI's DATABASE_MIGRATION_URL
 *   app   (pooled, :6432)  — the runtime role through PgBouncer in transaction
 *                            mode, like production's pooled DATABASE_URL
 */
process.env.TEST_DATABASE_OWNER_URL ??= "postgres://forge_owner:forge_owner@localhost:5432/forge";
process.env.TEST_DATABASE_APP_URL ??= "postgres://forge_app:forge_app@localhost:6432/forge";

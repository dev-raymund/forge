import "server-only";

/**
 * Public database API for modules. The raw client (./client) is private to
 * platform/: services and queries go through these transaction helpers so
 * every query carries tenant context for RLS (D-04).
 */
export { withTenant, withUser, withPlatform } from "./tenant";
export type { Tx, TenantTx, UserTx, PlatformTx } from "./tenant";
export { withRetry, isTransientDbError } from "./retry";
export { isUniqueViolation, pgErrorOf } from "./errors";
export type { PgError } from "./errors";
export { pingDatabase } from "./health";
export { TABLE_CLASSES, tablesOfClass } from "./table-classes";
export type { TableClass, TableName } from "./table-classes";

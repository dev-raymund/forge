import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

/**
 * One writer for the audit log (D-30, ADR 0010), checked by reading the source:
 * only the audit module touches the `audit_logs` table. Every other module
 * records an event by calling `record(tx, entry)`, which is what takes the
 * organization and the actor from the transaction and refuses anything that is
 * not in the vocabulary. A module that inserted rows itself could name any
 * organization, any actor, and store anything.
 */

const ROOT = path.resolve(import.meta.dirname, "../..");
const SRC = path.join(ROOT, "src");

function sourcesUnder(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) return sourcesUnder(full);
    return /\.tsx?$/.test(entry.name) && !/\.test\.tsx?$/.test(entry.name) ? [full] : [];
  });
}
const relative = (file: string) => path.relative(ROOT, file);
const all = sourcesUnder(SRC);
/** Where the table may be named: its own module, and the two registries that list every table. */
const ALLOWED = (file: string) => relative(file).startsWith("src/modules/audit/") || ["src/platform/db/schema.ts", "src/platform/db/table-classes.ts"].includes(relative(file));

describe("the audit log has one writer", () => {
  it("looks at the whole application", () => {
    expect(all.length).toBeGreaterThan(100);
    expect(all.map(relative)).toEqual(expect.arrayContaining(["src/modules/audit/record.ts", "src/modules/tenancy/members.service.ts", "src/modules/tenancy/invitations.service.ts"]));
  });

  it("no code outside the audit module uses the table, by its Drizzle name or in SQL", () => {
    const offenders = all
      .filter((file) => !ALLOWED(file))
      .filter((file) => {
        // Comments may mention the table; code may not.
        const code = readFileSync(file, "utf8").replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
        return /\bauditLogs\b/.test(code) || /\baudit_logs\b/.test(code) || /modules\/audit\/schema/.test(code);
      })
      .map(relative);
    expect(offenders).toEqual([]);
  });

  it("the services that change who belongs to an organization, the organization itself, or its sites, each record what they do", () => {
    const expected: Record<string, string[]> = {
      "src/modules/tenancy/organizations.service.ts": ["organization.created", "organization.updated"],
      "src/modules/tenancy/members.service.ts": ["member.role_changed", "member.removed", "member.left", "organization.ownership_transferred"],
      "src/modules/tenancy/invitations.service.ts": ["member.invited", "invitation.resent", "invitation.revoked", "invitation.accepted"],
      "src/modules/sites/sites.service.ts": ["site.created", "site.address_changed", "site.deleted"],
      "src/modules/sites/appearance.service.ts": ["site.theme_changed"],
      "src/modules/sites/settings.service.ts": ["site.settings_changed"],
    };
    for (const [file, actions] of Object.entries(expected)) {
      const source = readFileSync(path.join(ROOT, file), "utf8");
      expect(source, file).toMatch(/import \{[^}]*\brecord\b[^}]*\} from "@\/modules\/audit";/);
      for (const action of actions) expect(source, `${file}: ${action}`).toContain(`action: "${action}"`);
      // Always with the transaction of the change itself as its first argument.
      for (const call of source.match(/\brecord\(\s*\w+/g) ?? []) expect(call.replace(/\s+/g, ""), file).toBe("record(tx");
    }
  });

  it("the activity page's query selects nothing it must not show", () => {
    const query = readFileSync(path.join(SRC, "modules/audit/activity.ts"), "utf8");
    const selected = query.slice(query.indexOf(".select({"), query.indexOf(".from(auditLogs)"));
    expect(selected).toContain("auditLogs.action");
    for (const column of ["auditLogs.ip", "auditLogs.requestId", "auditLogs.actorId", "users.email", "users.id"]) expect(selected, column).not.toContain(column);
  });
});

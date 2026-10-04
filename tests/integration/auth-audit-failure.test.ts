import { eq } from "drizzle-orm";
import { uuidv7 } from "uuidv7";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

// The audit store is "down" for this whole file.
const recordPlatformEvent = vi.hoisted(() =>
  vi.fn(async (event: { action: string }): Promise<void> => {
    throw new Error(`audit store is down (${event.action})`);
  }),
);
vi.mock("@/modules/audit", () => ({ recordPlatformEvent }));

import { changePassword } from "@/modules/auth/account.service";
import { createAuth, setAuthForTests } from "@/modules/auth/auth";
import { signIn, signOut, signUp, type AuthRequest } from "@/modules/auth/credentials.service";
import { resolveAuth } from "@/modules/auth/session";
import { withPlatform } from "@/platform/db/tenant";
import { jobs } from "@/platform/jobs/schema";
import { setLogSink } from "@/platform/observability/logger";

/**
 * M2-4: account events are written to the audit trail after Better Auth has
 * done its work, outside its queries. If that write fails, it is reported; it
 * never locks anyone out, leaves anyone signed in, or undoes a password change.
 */

const BASE = "http://localhost:3000";
const PASSWORD = "correct horse battery staple";
const NEW_PASSWORD = "an entirely new passphrase";
const logs: string[] = [];

beforeAll(() => {
  setAuthForTests(createAuth({ baseURL: BASE, secret: "integration-secret-integration-secret-0123" }));
  setLogSink((_level, line) => logs.push(line));
});
afterAll(async () => {
  await withPlatform((tx) => tx.delete(jobs).where(eq(jobs.type, "email.send")));
  setAuthForTests(null);
  setLogSink(null);
});

const browser = (cookie?: string): AuthRequest => ({
  headers: new Headers({ origin: BASE, "sec-fetch-site": "same-origin", "sec-fetch-mode": "cors", ...(cookie ? { cookie } : {}) }),
});
const cookieOf = (setCookies: string[]) =>
  setCookies
    .map((c) => c.split(";")[0]!)
    .filter((pair) => !pair.endsWith("="))
    .join("; ");

describe("when the audit trail cannot be written", () => {
  it("signing up, logging in, changing the password and logging out all still work, and each failure is reported", async () => {
    const email = `audit-down-${uuidv7()}@example.test`;

    const created = await signUp({ name: "Audit Down", email, password: PASSWORD }, browser());
    expect((await resolveAuth(browser(cookieOf(created.setCookies)).headers))?.user.email).toBe(email);

    const second = await signIn({ email, password: PASSWORD }, browser());
    const changed = await changePassword({ currentPassword: PASSWORD, newPassword: NEW_PASSWORD }, browser(cookieOf(second.setCookies)));
    const current = browser(cookieOf(changed.setCookies));
    expect(await resolveAuth(current.headers)).not.toBeNull();
    expect(await resolveAuth(browser(cookieOf(created.setCookies)).headers)).toBeNull(); // still revoked by the change

    await signOut(current);
    expect(await resolveAuth(current.headers)).toBeNull(); // really signed out
    await expect(signIn({ email, password: NEW_PASSWORD }, browser())).resolves.toBeDefined();

    expect(recordPlatformEvent.mock.calls.map(([event]) => event.action)).toEqual([
      "auth.login", "auth.login", "auth.password_changed", "auth.logout", "auth.login",
    ]);
    const reported = logs.filter((line) => line.includes("audit store is down"));
    expect(reported).toHaveLength(5);
    for (const operation of ["audit auth.login", "audit auth.password_changed", "audit auth.logout"]) {
      expect(logs.some((line) => line.includes(operation))).toBe(true);
    }
    expect(logs.join("\n")).not.toContain(NEW_PASSWORD);
  });
});

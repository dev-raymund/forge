import { describe, expect, it } from "vitest";
import { assignRequestId, requestIdFrom } from "./request-id";

const UUID_V7 = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

describe("request IDs", () => {
  it("the proxy reuses Vercel's id, else mints a UUIDv7, and ignores client-supplied ids", () => {
    expect(assignRequestId(new Headers({ "x-vercel-id": "iad1::abcde-1727700000000-0123456789ab" }))).toBe(
      "iad1::abcde-1727700000000-0123456789ab",
    );
    expect(assignRequestId(new Headers({ "x-request-id": "client-chosen-id" }))).toMatch(UUID_V7);
  });

  it("handlers read the proxy's id, rejecting anything unsafe for logs and headers", () => {
    expect(requestIdFrom(new Headers({ "x-request-id": "01a0f2c0-0000-7000-8000-000000000001" }))).toBe(
      "01a0f2c0-0000-7000-8000-000000000001",
    );
    expect(requestIdFrom(new Headers({ "x-request-id": "bad id <script>" }))).toMatch(UUID_V7);
    expect(requestIdFrom(new Headers())).toMatch(UUID_V7);
  });
});

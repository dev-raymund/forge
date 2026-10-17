import { describe, expect, it } from "vitest";
import { PREVIEW_FRAME_SANDBOX } from "./preview-frame";

/** The preview frames' sandbox (M7-4, M8-1) outside development: Next's scripts run; the page cannot reach the admin. */
describe("the preview frame's sandbox", () => {
  it("lets scripts run and popups open, and nothing else: no same origin, no forms, no top navigation", () => {
    expect(process.env.NODE_ENV).not.toBe("development");
    expect(PREVIEW_FRAME_SANDBOX.split(" ").sort()).toEqual(["allow-popups", "allow-popups-to-escape-sandbox", "allow-scripts"]);
  });
});

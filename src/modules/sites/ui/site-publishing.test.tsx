// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { FormState } from "@/platform/forms";

/**
 * The Publish control in a DOM (M4-5): the confirmation it asks for, what it
 * sends, and what it shows for the server's answer. The action is replaced;
 * the real one runs against Postgres in tests/integration/publishing.test.ts
 * and in a browser in tests/e2e/publishing.spec.ts.
 */
const server = vi.hoisted(() => ({
  calls: [] as { bound: unknown[]; status: FormDataEntryValue | null; fields: string[] }[],
  answer: { status: "success", message: "Bakery is live." } as FormState,
}));
vi.mock("../actions", () => ({
  setSiteStatusAction: (...args: unknown[]) => {
    const formData = args.at(-1) as FormData;
    server.calls.push({ bound: args.slice(0, 2), status: formData.get("status"), fields: [...formData.keys()].filter((key) => !key.startsWith("$ACTION")) });
    return Promise.resolve(server.answer);
  },
}));

import { SiteStatusControl, type SiteStatusControlProps } from "./site-publishing";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const URL_ = "https://cms.forgelinetechnologies.com/s/acme-bakery";
let container: HTMLDivElement;
let root: Root;

async function mount(props: Partial<SiteStatusControlProps> = {}) {
  await act(async () => {
    root.render(<SiteStatusControl orgSlug="acme" siteSlug="bakery" siteName="Bakery" status="coming_soon" publicUrl={URL_} mustVerifyEmail={false} {...props} />);
  });
}
const button = (name: RegExp) => [...document.querySelectorAll("button")].find((b) => name.test(b.textContent ?? "")) as HTMLButtonElement | undefined;
const dialog = () => document.querySelector<HTMLElement>('[role="dialog"]');
async function click(name: RegExp) {
  const target = button(name);
  expect(target, String(name)).toBeDefined();
  // As a browser does: the button takes focus, then the click.
  await act(async () => {
    target!.focus();
    target!.click();
  });
}
async function confirm(name: RegExp) {
  const submit = button(name)!;
  await act(async () => submit.form!.requestSubmit(submit));
}

beforeEach(() => {
  server.calls = [];
  server.answer = { status: "success", message: "Bakery is live." };
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});
afterEach(async () => {
  await act(async () => root.unmount());
  document.body.innerHTML = "";
});

describe("publishing, in a browser's DOM", () => {
  it("asks first: the dialog says what changes, at the site's real public address, and what visitors will see", async () => {
    await mount();
    expect(dialog()).toBeNull();
    await click(/Publish site…/);

    const shown = dialog()!;
    expect(shown.getAttribute("aria-labelledby")).toBeTruthy();
    expect(document.getElementById(shown.getAttribute("aria-labelledby")!)!.textContent).toBe("Publish Bakery?");
    expect(document.getElementById(shown.getAttribute("aria-describedby")!)!.textContent).toBe(`The site goes from Coming soon to live at ${URL_}.`);
    expect(shown.querySelector('[data-testid="publish-url"]')!.textContent).toBe(URL_);
    const consequences = shown.querySelector('[data-testid="publish-consequences"]')!.textContent!;
    expect(consequences).toContain("search engines may list it");
    expect(consequences).toContain("shows its name and tagline in its theme. Adding pages and posts is not available yet.");
    expect(server.calls).toEqual([]);
  });

  it("cancelling changes nothing and sends nothing", async () => {
    await mount();
    await click(/Publish site…/);
    await click(/^Cancel$/);
    expect(dialog()).toBeNull();
    expect(server.calls).toEqual([]);
  });

  it("confirming sends the status it asks for and nothing else, then says so once the server has answered", async () => {
    await mount();
    await click(/Publish site…/);
    await confirm(/^Publish site$/);

    expect(server.calls).toEqual([{ bound: ["acme", "bakery"], status: "live", fields: ["status"] }]);
    expect(dialog()).toBeNull();
    const alert = container.querySelector<HTMLElement>("[data-form-alert]")!;
    expect(alert.getAttribute("role")).toBe("status");
    expect(alert.textContent).toContain("Bakery is live.");
    // The page re-renders with the new status (here, by hand): the link to the public site is in the message.
    await mount({ status: "live" });
    expect(container.querySelector('[data-testid="published-link"]')!.getAttribute("href")).toBe(URL_);
    expect(button(/Switch to Coming soon…/)).toBeDefined();
  });

  it("after a success, cancelling a later dialog returns focus to its button, not to the old message", async () => {
    await mount();
    await click(/Publish site…/);
    await confirm(/^Publish site$/);
    await mount({ status: "live" });
    await click(/Switch to Coming soon…/);
    await click(/^Cancel$/);
    expect(dialog()).toBeNull();
    expect(document.activeElement).toBe(button(/Switch to Coming soon…/));
  });

  it("a refusal stays in the dialog, as an alert, and the site is not said to be live", async () => {
    server.answer = { status: "error", message: "This site is unavailable, so its status cannot be changed here. Contact Forge support." };
    await mount();
    await click(/Publish site…/);
    await confirm(/^Publish site$/);

    const shown = dialog()!;
    const alert = shown.querySelector<HTMLElement>("[data-form-alert]")!;
    expect(alert.getAttribute("role")).toBe("alert");
    expect(alert.textContent).toContain("This site is unavailable");
    expect(document.activeElement).toBe(alert);
    expect(container.textContent).not.toContain("is live");
  });

  it("a live site: the way back to Coming soon, asked first, at the same address", async () => {
    server.answer = { status: "success", message: "Bakery shows the Coming soon page again." };
    await mount({ status: "live" });
    expect(container.querySelector('[data-testid="view-site"]')!.getAttribute("href")).toBe(URL_);
    await click(/Switch to Coming soon…/);
    expect(dialog()!.textContent).toContain(`Visitors to ${URL_} see the Coming soon page again. The address stays the same.`);
    await confirm(/^Switch to Coming soon$/);
    expect(server.calls.map((call) => call.status)).toEqual(["coming_soon"]);
    expect(container.querySelector("[data-form-alert]")!.textContent).toContain("Bakery shows the Coming soon page again.");
  });
});

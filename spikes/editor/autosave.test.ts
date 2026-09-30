import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { bufferKey, createAutosave, readBuffer, type AutosaveStatus, type SaveResult } from "./autosave";

class MemoryStorage {
  data = new Map<string, string>();
  getItem = (k: string) => this.data.get(k) ?? null;
  setItem = (k: string, v: string) => void this.data.set(k, v);
  removeItem = (k: string) => void this.data.delete(k);
}

/** A fake server with optimistic versions, like saveDraft(). */
function fakeServer(start = 1) {
  const server = {
    version: start,
    saves: [] as { expected: number; doc: string }[],
    delayMs: 0,
    fail: false,
    async save(expected: number, doc: string): Promise<SaveResult> {
      if (server.delayMs) await new Promise((r) => setTimeout(r, server.delayMs));
      if (server.fail) throw new Error("network down");
      server.saves.push({ expected, doc });
      if (expected !== server.version) return { ok: false, reason: "conflict", currentVersion: server.version };
      return { ok: true, version: ++server.version };
    },
  };
  return server;
}

const ENTRY = "0192f000-0000-7000-8000-000000000002";

function setup(start = 1) {
  const server = fakeServer(start);
  const storage = new MemoryStorage();
  const statuses: AutosaveStatus[] = [];
  const autosave = createAutosave<string>({
    entryId: ENTRY,
    version: start,
    save: server.save,
    storage,
    onStatus: (s) => statuses.push(s),
  });
  return { server, storage, statuses, autosave, last: () => statuses.at(-1) };
}

beforeEach(() => void vi.useFakeTimers());
afterEach(() => void vi.useRealTimers());

describe("autosave cadence", () => {
  it("saves 2 s after the last change, once", async () => {
    const { server, autosave, last } = setup();
    autosave.change("a");
    await vi.advanceTimersByTimeAsync(1_500);
    autosave.change("ab");
    await vi.advanceTimersByTimeAsync(1_999);
    expect(server.saves).toEqual([]);
    await vi.advanceTimersByTimeAsync(1);
    expect(server.saves).toEqual([{ expected: 1, doc: "ab" }]);
    expect(last()).toMatchObject({ state: "saved", version: 2 });
  });

  it("forces a save every 30 s during continuous typing", async () => {
    const { server, autosave } = setup();
    for (let t = 0; t < 65_000; t += 1_000) {
      autosave.change(`t${t}`);
      await vi.advanceTimersByTimeAsync(1_000);
    }
    expect(server.saves.map((s) => s.doc)).toEqual(["t29000", "t59000"]);
  });

  it("flush() saves immediately (before preview or publish)", async () => {
    const { server, autosave } = setup();
    autosave.change("x");
    await autosave.flush();
    expect(server.saves).toHaveLength(1);
  });

  it("never runs two saves at once; changes made during a save are saved next", async () => {
    const { server, autosave } = setup();
    server.delayMs = 5_000;
    autosave.change("v1");
    await vi.advanceTimersByTimeAsync(2_000); // save 1 starts
    autosave.change("v2");
    await vi.advanceTimersByTimeAsync(4_000); // still in flight
    expect(server.saves).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(1_000 + 2_000 + 5_000);
    expect(server.saves).toEqual([
      { expected: 1, doc: "v1" },
      { expected: 2, doc: "v2" },
    ]);
  });
});

describe("conflicts and failures", () => {
  it("a version mismatch stops autosave and reports the server's version", async () => {
    const { server, autosave, last } = setup();
    server.version = 5; // another tab saved meanwhile
    autosave.change("mine");
    await vi.advanceTimersByTimeAsync(2_000);
    expect(last()).toEqual({ state: "conflict", currentVersion: 5 });
    autosave.change("more");
    await vi.advanceTimersByTimeAsync(60_000);
    expect(server.saves).toHaveLength(1); // no retries, no overwrite
  });

  it("after the user resolves the conflict, autosave resumes from the new version", async () => {
    const { server, autosave, last } = setup();
    server.version = 5;
    autosave.change("mine");
    await vi.advanceTimersByTimeAsync(2_000);
    autosave.resume(5); // e.g. "overwrite" after saving theirs as a revision
    await vi.advanceTimersByTimeAsync(2_000);
    expect(last()).toMatchObject({ state: "saved", version: 6 });
    expect(server.saves.at(-1)).toEqual({ expected: 5, doc: "mine" });
  });

  it("a network error keeps the change and retries on the normal cadence", async () => {
    const { server, autosave, statuses } = setup();
    server.fail = true;
    autosave.change("x");
    await vi.advanceTimersByTimeAsync(2_000);
    expect(statuses.at(-1)).toMatchObject({ state: "error" });
    server.fail = false;
    await vi.advanceTimersByTimeAsync(2_000);
    expect(server.saves).toEqual([{ expected: 1, doc: "x" }]);
  });
});

describe("local buffer (nobody loses work)", () => {
  it("buffers every unsynced change per entry + version and clears it once saved", async () => {
    const { storage, autosave } = setup(3);
    autosave.change("draft");
    expect(readBuffer(storage, ENTRY, 3)).toBe("draft");
    await vi.advanceTimersByTimeAsync(2_000);
    expect(storage.data.has(bufferKey(ENTRY, 3))).toBe(false);
  });

  it("keeps the buffer on conflict, for 'copy my content'", async () => {
    const { server, storage, autosave } = setup();
    server.version = 9;
    autosave.change("mine");
    await vi.advanceTimersByTimeAsync(2_000);
    expect(readBuffer(storage, ENTRY, 1)).toBe("mine");
  });

  it("works when storage throws (private mode, quota)", async () => {
    const server = fakeServer();
    const broken = { getItem: () => null, setItem: () => { throw new Error("quota"); }, removeItem: () => { throw new Error("x"); } };
    const autosave = createAutosave<string>({ entryId: ENTRY, version: 1, save: server.save, storage: broken });
    autosave.change("x");
    await vi.advanceTimersByTimeAsync(2_000);
    expect(server.saves).toHaveLength(1);
  });
});

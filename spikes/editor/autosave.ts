/**
 * Autosave controller (plan §6.3). Framework-free so it can be unit tested with
 * fake timers; the editor calls `change()` on every document update.
 *
 * - Debounced: saves 2 s after the last change.
 * - Forced: during continuous typing, saves at least every 30 s.
 * - One save in flight at a time; changes made meanwhile trigger another save.
 * - `saveDraft(expectedVersion, doc)` is optimistic: a version mismatch is a
 *   conflict. On conflict autosave stops, and the UI offers reload / overwrite /
 *   copy my content.
 * - Every unsynced change is buffered in storage under entry + base version,
 *   so a crash or reload loses nothing; the buffer is cleared once saved.
 */

export type SaveResult =
  | { ok: true; version: number }
  | { ok: false; reason: "conflict"; currentVersion: number }
  | { ok: false; reason: "invalid"; issues?: string[] };

export type AutosaveStatus =
  | { state: "idle" | "pending" | "saving" }
  | { state: "saved"; version: number; at: Date }
  | { state: "conflict"; currentVersion: number }
  | { state: "invalid"; issues?: string[] }
  | { state: "error"; message: string };

type Store = Pick<Storage, "getItem" | "setItem" | "removeItem">;

export type AutosaveOptions<Doc> = {
  entryId: string;
  version: number;
  save: (expectedVersion: number, doc: Doc) => Promise<SaveResult>;
  storage?: Store;
  onStatus?: (status: AutosaveStatus) => void;
  debounceMs?: number;
  maxWaitMs?: number;
  now?: () => number;
};

export const bufferKey = (entryId: string, version: number) => `forge:draft:${entryId}:v${version}`;

/** Unsynced content left by a previous session for this entry + version, if any. */
export function readBuffer<Doc>(storage: Store, entryId: string, version: number): Doc | null {
  try {
    const raw = storage.getItem(bufferKey(entryId, version));
    return raw ? (JSON.parse(raw) as Doc) : null;
  } catch {
    return null;
  }
}

export function createAutosave<Doc>(options: AutosaveOptions<Doc>) {
  const { entryId, save, storage, onStatus = () => {}, debounceMs = 2_000, maxWaitMs = 30_000 } = options;
  const now = options.now ?? Date.now;
  let version = options.version;
  let latest: Doc | undefined;
  let dirty = false;
  let firstUnsavedAt: number | null = null;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let inFlight: Promise<void> | null = null;
  let stopped = false;

  const setStatus = (s: AutosaveStatus) => onStatus(s);
  const safe = (fn: () => void) => {
    try {
      fn();
    } catch {
      // storage full or unavailable: autosave still works, only the crash buffer is lost
    }
  };

  function schedule() {
    clearTimeout(timer);
    const forcedIn = firstUnsavedAt === null ? maxWaitMs : Math.max(0, firstUnsavedAt + maxWaitMs - now());
    timer = setTimeout(() => void flush(), Math.min(debounceMs, forcedIn));
  }

  async function run(): Promise<void> {
    if (!dirty || stopped || latest === undefined) return;
    const doc = latest;
    const base = version;
    dirty = false;
    firstUnsavedAt = null;
    setStatus({ state: "saving" });
    let result: SaveResult;
    try {
      result = await save(base, doc);
    } catch (e) {
      dirty = true;
      firstUnsavedAt ??= now();
      setStatus({ state: "error", message: e instanceof Error ? e.message : String(e) });
      schedule(); // retry on the normal cadence
      return;
    }
    if (result.ok) {
      version = result.version;
      if (storage) safe(() => storage.removeItem(bufferKey(entryId, base)));
      if (dirty && storage) safe(() => storage.setItem(bufferKey(entryId, version), JSON.stringify(latest)));
      setStatus({ state: "saved", version, at: new Date(now()) });
      if (dirty) schedule();
    } else if (result.reason === "conflict") {
      stopped = true;
      dirty = true; // keep the buffer: "copy my content" needs it
      setStatus({ state: "conflict", currentVersion: result.currentVersion });
    } else {
      setStatus({ state: "invalid", issues: result.issues });
    }
  }

  async function flush(): Promise<void> {
    clearTimeout(timer);
    while (inFlight) await inFlight;
    inFlight = run().finally(() => {
      inFlight = null;
    });
    await inFlight;
  }

  return {
    change(doc: Doc) {
      if (stopped) return;
      latest = doc;
      dirty = true;
      firstUnsavedAt ??= now();
      if (storage) safe(() => storage.setItem(bufferKey(entryId, version), JSON.stringify(doc)));
      setStatus({ state: "pending" });
      if (!inFlight) schedule();
    },
    /** Saves now (before preview, publish or navigation). */
    flush,
    /** After the user resolved a conflict by reloading or overwriting. */
    resume(newVersion: number) {
      version = newVersion;
      stopped = false;
      if (dirty) schedule();
    },
    get version() {
      return version;
    },
    dispose() {
      clearTimeout(timer);
      stopped = true;
    },
  };
}

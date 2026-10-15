import { describe, expect, it } from "vitest";
import { afterComplete, afterLateConflict, afterRequest, afterSend, batchesOf, itemOf, linkValid, summaryOf, type QueueItem, type Target } from "./upload-queue";

const MiB = 1024 * 1024;
const NOW = Date.parse("2026-10-15T10:00:00Z");
const target = (minutes: number): Target => ({ method: "PUT", url: "https://storage.example/x", headers: { "content-type": "image/png" }, expiresAt: new Date(NOW + minutes * 60_000).toISOString() });
const sending = (minutes = 9): QueueItem => ({ ...itemOf({ name: "a.png", size: 10, type: "image/png" }, "k"), status: "sending", mediaId: "m", target: target(minutes) });

describe("choosing files (M6-3)", () => {
  it("each file is checked as the server will: refused ones say why and are never sent", () => {
    expect(itemOf({ name: "photo.jpg", size: 20 * MiB, type: "image/jpeg" }, "1")).toMatchObject({ status: "waiting", kind: "image", type: "image/jpeg" });
    expect(itemOf({ name: "menu.pdf", size: 25 * MiB, type: "application/pdf" }, "2")).toMatchObject({ status: "waiting", kind: "document" });
    expect(itemOf({ name: "big.jpg", size: 20 * MiB + 1, type: "image/jpeg" }, "3")).toMatchObject({ status: "refused", message: "big.jpg is 20 MiB. Images can be at most 20 MiB." });
    expect(itemOf({ name: "logo.svg", size: 10, type: "image/svg+xml" }, "4")).toMatchObject({ status: "refused", message: expect.stringMatching(/can't be uploaded/) });
    expect(itemOf({ name: `${"n".repeat(256)}.png`, size: 10, type: "image/png" }, "5")).toMatchObject({ status: "refused", message: expect.stringMatching(/too long/) });
    expect(itemOf({ name: "C:\\fakepath\\shot.png", size: 10, type: "image/png" }, "6")).toMatchObject({ status: "waiting", name: "shot.png" });
  });

  it("a selection of more than 20 goes in several requests of at most 20, each on its own", () => {
    const files = Array.from({ length: 45 }, (_, i) => i);
    expect(batchesOf(files).map((batch) => batch.length)).toEqual([20, 20, 5]);
    expect(batchesOf([])).toEqual([]);
  });
});

describe("a request's answer", () => {
  const batch = [itemOf({ name: "a.png", size: 10, type: "image/png" }, "a"), itemOf({ name: "b.png", size: 10, type: "image/png" }, "b")];

  it("accepted: every file has its own link", () => {
    const next = afterRequest(batch, { ok: true, data: { uploads: [{ mediaId: "1", upload: target(10) }, { mediaId: "2", upload: target(10) }] } });
    expect(next.map((i) => [i.status, i.mediaId])).toEqual([["sending", "1"], ["sending", "2"]]);
  });

  it("refused for one file: that one is refused with its reason; the others were not sent and can be sent alone", () => {
    const next = afterRequest(batch, { ok: false, code: "Validation", error: "Some of these files can't be uploaded.", fieldErrors: { "files.1": ["b.png is not allowed."] } });
    expect(next[1]).toMatchObject({ status: "refused", message: "b.png is not allowed.", retry: undefined });
    expect(next[0]).toMatchObject({ status: "failed", retry: "request", message: expect.stringMatching(/another file in the same group was refused/) });
  });

  it("the storage limit, storage down, anything else: none of the request is reserved; each can be asked for again", () => {
    for (const [code, message] of [
      ["LimitExceeded", "The Free plan includes 1 GiB of storage, and these files would take this organization past it (1 GiB used)."],
      ["Unavailable", "Storage is not answering right now. Try again in a moment."],
      ["Internal", "Something went wrong, and the file was not uploaded."],
    ] as const) {
      const next = afterRequest(batch, { ok: false, code, error: code === "LimitExceeded" ? message : "x" });
      expect(next.map((i) => [i.status, i.retry, i.message]), code).toEqual([["failed", "request", message], ["failed", "request", message]]);
      expect(next.every((i) => !i.mediaId), code).toBe(true);
    }
    expect(afterRequest(batch, { ok: false, code: "Forbidden", error: "x" })[0]).toMatchObject({ status: "failed", retry: undefined, message: "You can't upload to this site." });
  });
});

describe("a send's answer", () => {
  it("sent, or already there (412 from a retry: the link creates the file once): on to completion", () => {
    expect(afterSend(sending(), 200, NOW)).toMatchObject({ status: "finishing", progress: 1 });
    expect(afterSend(sending(), 412, NOW)).toMatchObject({ status: "finishing" });
  });

  it("a network failure or a storage error while the link is valid: send again to the same link", () => {
    for (const status of [0, 500, 503, 429]) expect(afterSend(sending(9), status, NOW), String(status)).toMatchObject({ status: "failed", retry: "send" });
  });

  it("the link expired, or the storage refused it (403, 400): only a new upload", () => {
    expect(afterSend(sending(0.25), 0, NOW)).toMatchObject({ status: "failed", retry: "request", target: undefined }); // within the margin
    for (const status of [400, 403]) expect(afterSend(sending(9), status, NOW), String(status)).toMatchObject({ retry: "request" });
    expect(linkValid(target(1), NOW)).toBe(true);
    expect(linkValid(target(0.4), NOW)).toBe(false);
  });
});

describe("a completion's answer", () => {
  const finishing = (minutes = 9): QueueItem => ({ ...sending(minutes), status: "finishing" });

  it("ready only when the server says so", () => {
    expect(afterComplete(finishing(), { ok: true, data: {} }, NOW)).toMatchObject({ status: "ready" });
  });

  it("refused (the file, or the storage limit): the reason, and no retry: the server deleted it", () => {
    for (const code of ["Validation", "LimitExceeded"]) {
      expect(afterComplete(finishing(), { ok: false, code, error: "a.png is a JPEG file, but was sent as PNG." }, NOW)).toMatchObject({
        status: "refused", message: "a.png is a JPEG file, but was sent as PNG.", retry: undefined,
      });
    }
  });

  it("not there yet or still being finished: send again while the link holds (a 412 means it is there), else complete again, then upload anew", () => {
    expect(afterComplete(finishing(9), { ok: false, code: "Conflict", error: "x" }, NOW)).toMatchObject({ status: "failed", retry: "send" });
    expect(afterComplete(finishing(0), { ok: false, code: "Conflict", error: "x" }, NOW)).toMatchObject({ status: "failed", retry: "complete" });
    expect(afterLateConflict(finishing(0))).toMatchObject({ status: "failed", retry: "request", mediaId: undefined, target: undefined });
  });

  it("storage down or an unexpected error: complete again (the upload is still pending); gone: upload anew", () => {
    for (const code of ["Unavailable", "Internal"]) expect(afterComplete(finishing(), { ok: false, code, error: "x" }, NOW)).toMatchObject({ status: "failed", retry: "complete" });
    expect(afterComplete(finishing(), { ok: false, code: "NotFound", error: "x" }, NOW)).toMatchObject({ status: "failed", retry: "request", mediaId: undefined });
    expect(afterComplete(finishing(), { ok: false, code: "Unauthenticated", error: "x" }, NOW)).toMatchObject({ status: "failed", retry: undefined });
  });
});

describe("the queue's summary", () => {
  it("never says done while anything is going or failed", () => {
    const items = [
      { ...sending(), status: "ready" as const },
      { ...sending(), status: "sending" as const },
      { ...sending(), status: "failed" as const },
      { ...sending(), status: "refused" as const },
    ];
    expect(summaryOf(items)).toBe("1 uploading, 1 ready, 1 failed, 1 refused");
    expect(summaryOf([{ ...sending(), status: "ready" }])).toBe("1 ready");
  });
});

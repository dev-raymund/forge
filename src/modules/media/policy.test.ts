import { describe, expect, it } from "vitest";
import { checkFile, displayName, keyNameOf, sniffType, UPLOAD_TYPES, uploadTypeOf } from "./policy";

const MB = 1024 * 1024;
const bytes = (...parts: (number[] | string)[]) =>
  new Uint8Array(parts.flatMap((part) => (typeof part === "string" ? [...part].map((c) => c.charCodeAt(0)) : part)));

describe("what may be uploaded (plan §8)", () => {
  it("JPEG, PNG, WebP and GIF up to 20 MB; PDF up to 25 MB; nothing else", () => {
    expect(Object.keys(UPLOAD_TYPES).sort()).toEqual(["application/pdf", "image/gif", "image/jpeg", "image/png", "image/webp"]);
    expect(UPLOAD_TYPES["image/jpeg"]).toMatchObject({ kind: "image", ext: "jpg", maxBytes: 20 * MB });
    expect(UPLOAD_TYPES["application/pdf"]).toMatchObject({ kind: "document", ext: "pdf", maxBytes: 25 * MB });
    for (const type of ["image/svg+xml", "text/html", "video/mp4", "application/zip", "image/heic", "application/octet-stream", "", "toString", "__proto__", "constructor"]) {
      expect(uploadTypeOf(type), type).toBeNull();
    }
    expect(Object.isFrozen(UPLOAD_TYPES)).toBe(true);
  });

  it("accepts a file within its type's size, and says why not otherwise", () => {
    expect(checkFile({ name: "Team photo.JPG", size: 20 * MB, type: "image/jpeg" })).toMatchObject({ ok: true, file: { name: "Team photo.JPG", size: 20 * MB, mimeType: "image/jpeg" } });
    expect(checkFile({ name: "menu.pdf", size: 25 * MB, type: "application/pdf" })).toMatchObject({ ok: true });
    expect(checkFile({ name: "Logo.PNG", size: 10, type: " IMAGE/PNG " })).toMatchObject({ ok: true, file: { mimeType: "image/png" } });
    const refused = (input: unknown) => {
      const result = checkFile(input);
      return result.ok ? null : result.message;
    };
    expect(refused({ name: "big.jpg", size: 20 * MB + 1, type: "image/jpeg" })).toBe("big.jpg is 20 MB. Images can be at most 20 MB.");
    expect(refused({ name: "huge.pdf", size: 30 * MB, type: "application/pdf" })).toBe("huge.pdf is 30 MB. PDFs can be at most 25 MB.");
    expect(refused({ name: "big.png", size: 25 * MB, type: "image/png" })).toMatch(/Images can be at most 20 MB/); // a PDF's limit is not an image's
    expect(refused({ name: "logo.svg", size: 10, type: "image/svg+xml" })).toBe("logo.svg can't be uploaded. Upload JPEG, PNG, WebP, GIF or PDF files.");
    expect(refused({ name: "page.html", size: 10, type: "text/html" })).toMatch(/can't be uploaded/);
    expect(refused({ name: "clip.mp4", size: 10, type: "video/mp4" })).toMatch(/can't be uploaded/);
    expect(refused({ name: "empty.png", size: 0, type: "image/png" })).toBe("empty.png is empty.");
    for (const size of [-1, 1.5, Number.NaN, Infinity, "10", null, undefined, 2 ** 60]) {
      expect(refused({ name: "x.png", size, type: "image/png" }), String(size)).toBe("The size of x.png is not valid.");
    }
    for (const name of ["", "   ", "/", "\u0000\u0007", null, 7, undefined]) expect(refused({ name, size: 1, type: "image/png" }), String(name)).toBe("A file has no name.");
    expect(refused({ name: `${"a".repeat(256)}.png`, size: 1, type: "image/png" })).toMatch(/is too long/);
    for (const input of [null, undefined, "x.png", 42, []]) expect(refused(input)).toBe("A file has no name.");
  });
});

describe("recognising a file by its first bytes", () => {
  it("each allowed type by its signature", () => {
    expect(sniffType(bytes([0xff, 0xd8, 0xff, 0xe0, 0, 0x10], "JFIF"))).toBe("image/jpeg");
    expect(sniffType(bytes([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0x0d], "IHDR"))).toBe("image/png");
    expect(sniffType(bytes("GIF89a", [1, 0, 1, 0]))).toBe("image/gif");
    expect(sniffType(bytes("GIF87a", [1, 0, 1, 0]))).toBe("image/gif");
    expect(sniffType(bytes("RIFF", [0x24, 0, 0, 0], "WEBPVP8 "))).toBe("image/webp");
    expect(sniffType(bytes("%PDF-1.7\n"))).toBe("application/pdf");
  });

  it("nothing else, and nothing from a near miss or a truncated signature", () => {
    for (const [what, sample] of [
      ["empty", bytes()],
      ["html", bytes("<!doctype html><script>alert(1)</script>")],
      ["svg", bytes('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>')],
      ["a truncated png", bytes([0x89, 0x50, 0x4e, 0x47])],
      ["a png signature not at the start", bytes([0x20, 0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])],
      ["RIFF but WAVE", bytes("RIFF", [0, 0, 0, 0], "WAVEfmt ")],
      ["GIF90a", bytes("GIF90a")],
      ["%PDF without the dash", bytes("%PDF1.7")],
      ["a zip", bytes([0x50, 0x4b, 0x03, 0x04])],
      ["an executable", bytes([0x4d, 0x5a, 0x90, 0])],
    ] as const) {
      expect(sniffType(sample), what).toBeNull();
    }
  });
});

describe("file names", () => {
  it("shows the last path segment, without control or direction characters", () => {
    expect(displayName("C:\\Users\\me\\Pictures\\photo.jpg")).toBe("photo.jpg");
    expect(displayName("../../etc/passwd")).toBe("passwd");
    expect(displayName("  Café menu.pdf  ")).toBe("Café menu.pdf");
    expect(displayName("evil\u202Egnp.exe")).toBe("evilgnp.exe");
    expect(displayName("line\nbreak.png")).toBe("linebreak.png");
  });

  it("makes the key's name part from it: ASCII words joined by hyphens, never a path, `file` when nothing is left", () => {
    expect(keyNameOf("Team Photo (final) 2.JPG")).toBe("team-photo-final-2");
    expect(keyNameOf("Café menu.pdf")).toBe("cafe-menu");
    expect(keyNameOf(displayName("../../etc/passwd")!)).toBe("passwd");
    expect(keyNameOf("../../etc/passwd")).toBe("file"); // never a path, whatever it is given
    expect(keyNameOf("..png")).toBe("file");
    expect(keyNameOf("東京.png")).toBe("file");
    expect(keyNameOf(".htaccess")).toBe("file");
    expect(keyNameOf(`${"word-".repeat(40)}.png`)).toMatch(/^[a-z0-9]+(-[a-z0-9]+)*$/);
    expect(keyNameOf(`${"word-".repeat(40)}.png`).length).toBeLessThanOrEqual(60);
  });
});

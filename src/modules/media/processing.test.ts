import sharp from "sharp";
import { describe, expect, it } from "vitest";
import { ImageRejected, MAX_INPUT_PIXELS, planVariants, processImage } from "./processing";

const solid = (format: "png" | "jpeg" | "webp" | "gif", width: number, height: number) =>
  sharp({ create: { width, height, channels: 3, background: { r: 90, g: 30, b: 160 } } })[format]().toBuffer().then((b) => new Uint8Array(b));
const reasonOf = async (run: () => Promise<unknown>) => {
  try {
    await run();
  } catch (error) {
    if (error instanceof ImageRejected) return error.message;
    throw error;
  }
  throw new Error("expected a refusal");
};

describe("the variants of an image (plan §8)", () => {
  it.each([
    [3000, 2000, [["thumb", 400, 400], ["w800", 800, 533], ["w1600", 1600, 1067], ["w2400", 2400, 1600]]],
    [2400, 2400, [["thumb", 400, 400], ["w800", 800, 800], ["w1600", 1600, 1600], ["w2400", 2400, 2400]]],
    [2399, 1000, [["thumb", 400, 400], ["w800", 800, 333], ["w1600", 1600, 667]]],
    [800, 1200, [["thumb", 400, 400], ["w800", 800, 1200]]],
    [799, 300, [["thumb", 300, 300], ["w799", 799, 300]]],
    [120, 4000, [["thumb", 120, 120], ["w120", 120, 4000]]],
    [1, 1, [["thumb", 1, 1], ["w1", 1, 1]]],
  ])("%i × %i: a square of 400 (never above the image), each width of the ladder it reaches, or its own", (width, height, expected) => {
    expect(planVariants(width, height).map((v) => [v.key, v.width, v.height])).toEqual(expected);
    expect(planVariants(width, height)[0]!.square).toBe(true);
  });

  it("an avatar is only the square", () => {
    expect(planVariants(3000, 2000, "avatar")).toEqual([{ key: "thumb", width: 400, height: 400, square: true }]);
  });

  it("every key is a valid variant segment", () => {
    for (const [w, h] of [[3000, 2000], [640, 480], [1, 1]] as const) for (const v of planVariants(w, h)) expect(v.key).toMatch(/^[a-z0-9]{1,32}$/);
  });
});

describe("processImage", () => {
  it("WebP variants at the planned sizes, auto-rotated, with no metadata left", async () => {
    const photo = await sharp({ create: { width: 1000, height: 600, channels: 3, background: "#c33" } })
      .jpeg()
      .withMetadata({ orientation: 6 })
      .withExifMerge({ IFD3: { GPSLatitudeRef: "N", GPSLatitude: "48/1 51/1 2981/100" } })
      .toBuffer();
    const processed = await processImage(new Uint8Array(photo), "image/jpeg");
    expect([processed.width, processed.height, processed.animated]).toEqual([600, 1000, false]); // turned a quarter
    expect(processed.variants.map((v) => [v.key, v.width, v.height])).toEqual([["thumb", 400, 400], ["w600", 600, 1000]]);
    for (const variant of processed.variants) {
      const meta = await sharp(variant.data).metadata();
      expect({ format: meta.format, exif: meta.exif, xmp: meta.xmp, icc: meta.icc, orientation: meta.orientation }).toEqual({
        format: "webp", exif: undefined, xmp: undefined, icc: undefined, orientation: undefined,
      });
    }
    expect(processed.durationMs).toBeGreaterThanOrEqual(0);
  });

  it("refuses what the file is not: another format than it was checked as, garbage, a cut-off file", async () => {
    const jpeg = await solid("jpeg", 300, 200);
    expect(await reasonOf(() => processImage(jpeg, "image/png"))).toBe("is not the kind of image it was sent as");
    expect(await reasonOf(() => processImage(new Uint8Array([0x89, 0x50, 0x4e, 0x47, 1, 2, 3]), "image/png"))).toBe("could not be read as an image");
    expect(await reasonOf(() => processImage(jpeg.subarray(0, 400), "image/jpeg"))).toMatch(/could not be (read|processed) as an image/);
  });

  it("refuses more than 50 megapixels from the header, before decoding (a decompression bomb is a small file)", async () => {
    const bomb = await sharp({ create: { width: 10_000, height: 6_000, channels: 3, background: "#fff" } }).png({ compressionLevel: 9 }).toBuffer();
    expect(bomb.byteLength).toBeLessThan(1_000_000);
    expect(10_000 * 6_000).toBeGreaterThan(MAX_INPUT_PIXELS);
    const started = Date.now();
    expect(await reasonOf(() => processImage(new Uint8Array(bomb), "image/png"))).toBe("is 60 megapixels; images can be at most 50");
    expect(Date.now() - started).toBeLessThan(2_000);
  });

  it("keeps an animation animated, frame for frame", async () => {
    const frames = await Promise.all(["#f00", "#0f0", "#00f", "#ff0"].map((c) => sharp({ create: { width: 900, height: 450, channels: 3, background: c } }).png().toBuffer()));
    const gif = await sharp(frames, { join: { animated: true } }).gif({ delay: [80, 80, 80, 80] }).toBuffer();
    const processed = await processImage(new Uint8Array(gif), "image/gif");
    expect(processed.animated).toBe(true);
    for (const variant of processed.variants) {
      const meta = await sharp(variant.data, { animated: true }).metadata();
      expect([variant.key, meta.pages, meta.pageHeight]).toEqual([variant.key, 4, variant.height]);
    }
    expect(processed.variants.map((v) => [v.key, v.width, v.height])).toEqual([["thumb", 400, 400], ["w800", 800, 400]]);
  });
});

import "server-only";
import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { createReadStream } from "node:fs";
import { link, mkdir, open, readFile, rename, stat, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { Readable } from "node:stream";
import type { CreateUploadInput, ObjectInfo, PutOptions, StorageDriver, UploadTarget } from "../driver";
import { StorageError } from "../errors";
import { assertStorageKey } from "../keys";

/**
 * Filesystem driver for development and tests (ADR 0008): no account, no
 * container. Objects live under `{root}/objects/{key}` with a JSON sidecar
 * under `{root}/meta/{key}.json`; the directory is gitignored.
 *
 * It behaves like the S3 driver so media code has one path: immutable `put`,
 * range reads, idempotent delete, and an upload target the browser PUTs to
 * with a signed content type and length. That target is this app's own
 * `/api/storage/local/{key}` route, which calls `receiveUpload()`.
 */

type Meta = { contentType: string; size: number; cacheControl?: string; contentDisposition?: string };
export const LOCAL_UPLOAD_ROUTE = "/api/storage/local";

const errno = (e: unknown) => (e as NodeJS.ErrnoException)?.code;

export class LocalStorageDriver implements StorageDriver {
  readonly name = "local";
  private readonly root: string;
  private secret: Buffer | undefined;

  constructor(private readonly config: { root: string; appOrigin: () => string; publicBaseUrl: () => string }) {
    this.root = path.resolve(/* turbopackIgnore: true */ config.root);
  }

  /** The absolute path for a key. Validation makes traversal unrepresentable; the containment check is a second lock. */
  private locate(key: string, tree: "objects" | "meta"): string {
    assertStorageKey(key);
    const base = path.join(/* turbopackIgnore: true */ this.root, tree);
    const target = path.resolve(/* turbopackIgnore: true */ base, tree === "meta" ? `${key}.json` : key);
    if (!target.startsWith(base + path.sep)) throw new StorageError("InvalidKey", "Invalid storage key");
    return target;
  }

  private async fail(action: string, err: unknown): Promise<never> {
    if (err instanceof StorageError) throw err;
    throw new StorageError("Unavailable", `Local storage ${action} failed`, errno(err));
  }

  private async write(key: string, body: Uint8Array, options: PutOptions, replace: boolean): Promise<void> {
    const objectPath = this.locate(key, "objects");
    const metaPath = this.locate(key, "meta");
    const meta: Meta = { contentType: options.contentType, size: body.byteLength, cacheControl: options.cacheControl, contentDisposition: options.contentDisposition };
    const temp = `${objectPath}.${randomBytes(6).toString("hex")}.tmp`;
    try {
      await mkdir(path.dirname(objectPath), { recursive: true });
      await mkdir(path.dirname(metaPath), { recursive: true });
      await writeFile(temp, body);
      if (replace) {
        await rename(temp, objectPath);
      } else {
        // link() fails if the target exists: an atomic "create only".
        await link(temp, objectPath).finally(() => unlink(temp).catch(() => undefined));
      }
      await writeFile(metaPath, JSON.stringify(meta));
    } catch (err) {
      await unlink(temp).catch(() => undefined);
      if (errno(err) === "EEXIST") throw new StorageError("AlreadyExists", "An object already exists at this key");
      throw new StorageError("UploadFailed", "Local storage write failed", errno(err));
    }
  }

  async put(key: string, body: Uint8Array, options: PutOptions): Promise<void> {
    await this.write(key, body, options, false);
  }

  async head(key: string): Promise<ObjectInfo | null> {
    const objectPath = this.locate(key, "objects");
    try {
      const [stats, meta] = await Promise.all([stat(objectPath), this.meta(key)]);
      if (!stats.isFile()) return null;
      return { size: stats.size, contentType: meta?.contentType ?? "application/octet-stream" };
    } catch (err) {
      if (errno(err) === "ENOENT" || errno(err) === "ENOTDIR") return null;
      return this.fail("read", err);
    }
  }

  private async meta(key: string): Promise<Meta | null> {
    try {
      return JSON.parse(await readFile(this.locate(key, "meta"), "utf8")) as Meta;
    } catch {
      return null;
    }
  }

  async get(key: string) {
    const info = await this.head(key);
    if (!info) throw new StorageError("NotFound", "Object not found");
    const stream = createReadStream(this.locate(key, "objects"));
    return { body: Readable.toWeb(stream) as ReadableStream<Uint8Array>, info };
  }

  async readRange(key: string, start: number, end: number): Promise<Uint8Array> {
    if (!Number.isInteger(start) || !Number.isInteger(end) || start < 0 || end < start) {
      throw new StorageError("InvalidKey", "Invalid byte range");
    }
    const objectPath = this.locate(key, "objects"); // validates the key before any filesystem access
    let handle;
    try {
      handle = await open(objectPath, "r");
    } catch (err) {
      if (errno(err) === "ENOENT" || errno(err) === "ENOTDIR") throw new StorageError("NotFound", "Object not found");
      return this.fail("read", err);
    }
    try {
      const buffer = Buffer.alloc(end - start + 1);
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, start);
      return new Uint8Array(buffer.subarray(0, bytesRead));
    } finally {
      await handle.close();
    }
  }

  async delete(key: string): Promise<void> {
    for (const target of [this.locate(key, "objects"), this.locate(key, "meta")]) {
      try {
        await unlink(target);
      } catch (err) {
        if (errno(err) !== "ENOENT" && errno(err) !== "ENOTDIR") {
          throw new StorageError("DeleteFailed", "Local storage delete failed", errno(err));
        }
      }
    }
  }

  publicUrl(key: string): string {
    assertStorageKey(key);
    return `${this.config.publicBaseUrl()}/${key}`;
  }

  // ── Upload targets: an HMAC-signed URL on this app, like a presigned PUT ───

  /** A per-directory secret, created on first use, so signatures survive restarts and work across processes. */
  private async signingSecret(): Promise<Buffer> {
    if (this.secret) return this.secret;
    const file = path.join(/* turbopackIgnore: true */ this.root, ".upload-secret");
    try {
      this.secret = Buffer.from((await readFile(file, "utf8")).trim(), "hex");
    } catch {
      await mkdir(this.root, { recursive: true });
      const generated = randomBytes(32);
      // "wx": if another process created it first, use theirs.
      await writeFile(file, generated.toString("hex"), { flag: "wx", mode: 0o600 }).catch(() => undefined);
      this.secret = Buffer.from((await readFile(file, "utf8")).trim(), "hex");
    }
    return this.secret;
  }

  private async sign(key: string, contentType: string, contentLength: number, expires: number): Promise<string> {
    return createHmac("sha256", await this.signingSecret())
      .update(`PUT\n${key}\n${contentType}\n${contentLength}\n${expires}`)
      .digest("hex");
  }

  async createUpload(input: CreateUploadInput): Promise<UploadTarget> {
    assertStorageKey(input.key);
    const expires = Math.floor(Date.now() / 1000) + input.expiresInSeconds;
    const query = new URLSearchParams({
      type: input.contentType,
      size: String(input.contentLength),
      expires: String(expires),
      signature: await this.sign(input.key, input.contentType, input.contentLength, expires),
    });
    return {
      kind: "presigned-put",
      url: `${this.config.appOrigin()}${LOCAL_UPLOAD_ROUTE}/${input.key}?${query}`,
      headers: { "content-type": input.contentType },
      expiresAt: new Date(expires * 1000),
    };
  }

  /**
   * The receiving end of `createUpload`, called by the upload route. Accepts
   * the bytes only if the signature is valid and unexpired and the content
   * type and length are exactly the signed ones. Overwrites, as a presigned
   * PUT does.
   */
  async receiveUpload(key: string, query: URLSearchParams, contentType: string | null, body: Uint8Array): Promise<void> {
    assertStorageKey(key);
    const type = query.get("type") ?? "";
    const size = Number(query.get("size"));
    const expires = Number(query.get("expires"));
    const given = Buffer.from(query.get("signature") ?? "", "hex");
    const expected = Buffer.from(await this.sign(key, type, size, expires), "hex");
    if (given.length !== expected.length || !timingSafeEqual(given, expected)) {
      throw new StorageError("PermissionDenied", "Invalid upload signature");
    }
    if (!Number.isFinite(expires) || expires * 1000 < Date.now()) throw new StorageError("PermissionDenied", "Upload link expired");
    if (contentType !== type) throw new StorageError("UploadFailed", "Content-Type does not match the signed upload");
    if (body.byteLength !== size) throw new StorageError("UploadFailed", "Content-Length does not match the signed upload");
    await this.write(key, body, { contentType: type }, true);
  }
}

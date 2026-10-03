/**
 * The storage contract (D-18, plan §8, ADR 0008): bytes, keys, content type
 * and size. Nothing about media records, variants, folders or validation
 * policy; that is the media module's (M6).
 *
 * Operations are exactly what V1 media needs:
 *   createUpload  browser uploads straight to storage (requestUploads)
 *   head          completeUpload checks the declared size
 *   readRange     completeUpload sniffs the first bytes
 *   put           server-written objects (image variants)
 *   get           the /media route streams an object
 *   delete        failed uploads, trash purge
 *   publicUrl     the URL stored content is served at
 */

export type ObjectInfo = { size: number; contentType: string };

export type PutOptions = {
  contentType: string;
  cacheControl?: string;
  contentDisposition?: string;
};

export type CreateUploadInput = {
  key: string;
  /** Signed: the upload must send exactly this Content-Type… */
  contentType: string;
  /** …and exactly this many bytes. */
  contentLength: number;
  expiresInSeconds: number;
};

/** Where the browser sends the bytes. A union so a provider with a different upload model can be added later. */
export type UploadTarget = {
  kind: "presigned-put";
  url: string;
  /** Headers the client must send with the PUT. */
  headers: Record<string, string>;
  expiresAt: Date;
};

export interface StorageDriver {
  readonly name: "local" | "s3";

  /** Stores a new object. Keys are immutable: throws `AlreadyExists` instead of overwriting. */
  put(key: string, body: Uint8Array, options: PutOptions): Promise<void>;

  /** Streams an object. Throws `NotFound`. */
  get(key: string): Promise<{ body: ReadableStream<Uint8Array>; info: ObjectInfo }>;

  /** Size and content type, or null when the object does not exist. */
  head(key: string): Promise<ObjectInfo | null>;

  /** Bytes `start`…`end` inclusive (fewer if the object is shorter). Throws `NotFound`. */
  readRange(key: string, start: number, end: number): Promise<Uint8Array>;

  /** Removes an object. Deleting a missing object is not an error. */
  delete(key: string): Promise<void>;

  /** A short-lived target for a direct browser upload of exactly `contentLength` bytes of `contentType`. */
  createUpload(input: CreateUploadInput): Promise<UploadTarget>;

  /** The public URL of an object, independent of where it is stored. */
  publicUrl(key: string): string;
}

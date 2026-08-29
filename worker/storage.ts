export const DEFAULT_STORAGE_LIST_LIMIT = 50;
export const MAX_STORAGE_LIST_LIMIT = 100;

export interface PublicStorageEnv {
  RELEASE_ASSETS?: R2Bucket;
  ASSET_PUBLIC_BASE_URL?: string;
}

export interface PublicStorageObject {
  key: string;
  version: string;
  size: number;
  etag: string;
  uploadedAt: string;
  storageClass: string;
  checksums: Record<string, string>;
  httpMetadata: Record<string, string>;
  customMetadata: Record<string, string>;
  publicUrl: string;
}

interface StorageListOptionsWithMetadata extends R2ListOptions {
  include?: Array<"httpMetadata" | "customMetadata">;
}

export interface StorageListQuery {
  limit: number;
  cursor?: string;
}

function hex(value: ArrayBuffer): string {
  return Array.from(new Uint8Array(value), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

export function parseAssetPublicBaseUrl(value: string | undefined): URL | null {
  if (!value) return null;
  try {
    const url = new URL(value);
    if ((url.protocol !== "https:" && url.protocol !== "http:") || url.username || url.password ||
        url.search || url.hash || (url.pathname !== "/" && url.pathname !== "")) return null;
    url.pathname = "/";
    return url;
  } catch {
    return null;
  }
}

export function publicAssetUrl(baseUrl: string | undefined, key: string): string | null {
  const base = parseAssetPublicBaseUrl(baseUrl);
  if (!base) return null;
  const encodedKey = key.split("/").map((segment) => encodeURIComponent(segment)).join("/");
  return new URL(encodedKey, base).toString();
}

export function assetRedirect(baseUrl: string | undefined, key: string, cacheControl: string): Response | null {
  const location = publicAssetUrl(baseUrl, key);
  if (!location) return null;
  return new Response(null, {
    status: 307,
    headers: {
      "Cache-Control": cacheControl,
      Location: location,
      "X-Content-Type-Options": "nosniff",
    },
  });
}

export function parseStorageListQuery(url: URL): StorageListQuery | null {
  const limitText = url.searchParams.get("limit") || String(DEFAULT_STORAGE_LIST_LIMIT);
  const limit = Number(limitText);
  const cursor = url.searchParams.get("cursor") || undefined;
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > MAX_STORAGE_LIST_LIMIT ||
      (cursor !== undefined && (cursor.length === 0 || cursor.length > 2048))) return null;
  return { limit, cursor };
}

function serializeHttpMetadata(metadata: R2HTTPMetadata | undefined): Record<string, string> {
  if (!metadata) return {};
  const result: Record<string, string> = {};
  for (const [key, value] of Object.entries(metadata)) {
    if (value instanceof Date) result[key] = value.toISOString();
    else if (typeof value === "string") result[key] = value;
  }
  return result;
}

function serializeChecksums(checksums: R2Checksums): Record<string, string> {
  const result: Record<string, string> = {};
  for (const algorithm of ["md5", "sha1", "sha256", "sha384", "sha512"] as const) {
    const value = checksums[algorithm];
    if (value) result[algorithm] = hex(value);
  }
  return result;
}

export function serializeStorageObject(object: R2Object, baseUrl: string): PublicStorageObject {
  const url = publicAssetUrl(baseUrl, object.key);
  if (!url) throw new Error("Public asset storage is not configured.");
  return {
    key: object.key,
    version: object.version,
    size: object.size,
    etag: object.etag,
    uploadedAt: object.uploaded.toISOString(),
    storageClass: object.storageClass,
    checksums: serializeChecksums(object.checksums),
    httpMetadata: serializeHttpMetadata(object.httpMetadata),
    customMetadata: object.customMetadata || {},
    publicUrl: url,
  };
}

export async function listStorageObjects(
  bucket: R2Bucket,
  baseUrl: string,
  prefix: string,
  query: StorageListQuery,
): Promise<{ objects: PublicStorageObject[]; nextCursor: string | null }> {
  const options: StorageListOptionsWithMetadata = {
    prefix,
    limit: query.limit,
    cursor: query.cursor,
    include: ["httpMetadata", "customMetadata"],
  };
  const result = await bucket.list(options as R2ListOptions);
  return {
    objects: result.objects.map((object) => serializeStorageObject(object, baseUrl)),
    nextCursor: result.truncated ? result.cursor || null : null,
  };
}

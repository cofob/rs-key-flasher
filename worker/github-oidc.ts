const GITHUB_OIDC_ISSUER = "https://token.actions.githubusercontent.com";
const GITHUB_OIDC_JWKS_URL = `${GITHUB_OIDC_ISSUER}/.well-known/jwks`;
const CLOCK_SKEW_SECONDS = 60;
const DEFAULT_JWKS_TTL_SECONDS = 60 * 60;
const MIN_JWKS_REFRESH_SECONDS = 5 * 60;
const MAX_TOKEN_LENGTH = 32 * 1024;

type GitHubJwk = JsonWebKey & {
  alg?: string;
  kid?: string;
  kty?: string;
  use?: string;
};

export interface GitHubOidcEnv {
  GITHUB_OIDC_AUDIENCE?: string;
  GITHUB_OIDC_REPOSITORY_ID?: string;
  GITHUB_OIDC_WORKFLOW_REF?: string;
}

export interface GitHubOidcTrust {
  audience: string;
  repositoryId: string;
  workflowRef: string;
}

export type GitHubJwksLoader = (force?: boolean) => Promise<GitHubJwk[]>;

interface JwksCache {
  expiresAt: number;
  fetchedAt: number;
  keys: GitHubJwk[];
}

let jwksCache: JwksCache | undefined;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function decodeBase64Url(value: string): Uint8Array {
  if (!value || !/^[A-Za-z0-9_-]+$/.test(value)) throw new Error("Invalid JWT encoding.");
  const base64 = value.replace(/-/g, "+").replace(/_/g, "/");
  const padded = base64.padEnd(Math.ceil(base64.length / 4) * 4, "=");
  return Uint8Array.from(atob(padded), (character) => character.charCodeAt(0));
}

function decodeJson(value: string): Record<string, unknown> {
  const parsed = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(decodeBase64Url(value))) as unknown;
  if (!isRecord(parsed)) throw new Error("Invalid JWT JSON.");
  return parsed;
}

function isGitHubJwk(value: unknown): value is GitHubJwk {
  return isRecord(value) && value.kty === "RSA" && typeof value.kid === "string" && value.kid.length > 0 &&
    (value.alg === undefined || value.alg === "RS256") && (value.use === undefined || value.use === "sig");
}

function cacheSeconds(response: Response): number {
  const value = response.headers.get("Cache-Control")?.match(/(?:^|,)\s*max-age=(\d+)/i)?.[1];
  const parsed = value ? Number(value) : DEFAULT_JWKS_TTL_SECONDS;
  return Number.isSafeInteger(parsed) && parsed > 0 ? Math.min(parsed, 6 * 60 * 60) : DEFAULT_JWKS_TTL_SECONDS;
}

async function loadGitHubJwks(force = false): Promise<GitHubJwk[]> {
  const now = Date.now();
  if (jwksCache && jwksCache.expiresAt > now &&
      (!force || jwksCache.fetchedAt + MIN_JWKS_REFRESH_SECONDS * 1000 > now)) {
    return jwksCache.keys;
  }
  const response = await fetch(GITHUB_OIDC_JWKS_URL, {
    headers: { Accept: "application/json" },
  });
  if (!response.ok) throw new Error(`GitHub OIDC JWKS returned ${response.status}.`);
  const body = await response.json() as unknown;
  if (!isRecord(body) || !Array.isArray(body.keys)) throw new Error("GitHub OIDC JWKS is invalid.");
  const keys = body.keys.filter(isGitHubJwk);
  if (!keys.length) throw new Error("GitHub OIDC JWKS has no signing keys.");
  jwksCache = { expiresAt: now + cacheSeconds(response) * 1000, fetchedAt: now, keys };
  return keys;
}

function audienceMatches(value: unknown, expected: string): boolean {
  if (typeof value === "string") return value === expected;
  return Array.isArray(value) && value.length === 1 && value[0] === expected;
}

function numericDate(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

export function githubOidcTrustFromEnv(env: GitHubOidcEnv): GitHubOidcTrust | null {
  if (!env.GITHUB_OIDC_AUDIENCE || !env.GITHUB_OIDC_REPOSITORY_ID || !env.GITHUB_OIDC_WORKFLOW_REF) return null;
  return {
    audience: env.GITHUB_OIDC_AUDIENCE,
    repositoryId: env.GITHUB_OIDC_REPOSITORY_ID,
    workflowRef: env.GITHUB_OIDC_WORKFLOW_REF,
  };
}

export async function verifyGitHubOidcToken(
  token: string,
  trust: GitHubOidcTrust,
  loadJwks: GitHubJwksLoader = loadGitHubJwks,
): Promise<boolean> {
  try {
    if (!token || token.length > MAX_TOKEN_LENGTH) return false;
    const parts = token.split(".");
    if (parts.length !== 3) return false;
    const [encodedHeader, encodedClaims, encodedSignature] = parts;
    const header = decodeJson(encodedHeader);
    if (header.alg !== "RS256" || typeof header.kid !== "string" || !header.kid ||
        (header.typ !== undefined && header.typ !== "JWT") || header.crit !== undefined) {
      return false;
    }

    let keys = await loadJwks(false);
    let jwk = keys.find((candidate) => candidate.kid === header.kid);
    if (!jwk) {
      keys = await loadJwks(true);
      jwk = keys.find((candidate) => candidate.kid === header.kid);
    }
    if (!jwk) return false;

    const key = await crypto.subtle.importKey(
      "jwk",
      jwk,
      { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
      false,
      ["verify"],
    );
    const signature = decodeBase64Url(encodedSignature);
    const signingInput = new TextEncoder().encode(`${encodedHeader}.${encodedClaims}`);
    const verified = await crypto.subtle.verify(
      "RSASSA-PKCS1-v1_5",
      key,
      signature.slice().buffer,
      signingInput.slice().buffer,
    );
    if (!verified) return false;

    const claims = decodeJson(encodedClaims);
    const now = Math.floor(Date.now() / 1000);
    return claims.iss === GITHUB_OIDC_ISSUER &&
      audienceMatches(claims.aud, trust.audience) &&
      numericDate(claims.exp) && claims.exp > now - CLOCK_SKEW_SECONDS &&
      numericDate(claims.nbf) && claims.nbf <= now + CLOCK_SKEW_SECONDS &&
      numericDate(claims.iat) && claims.iat <= now + CLOCK_SKEW_SECONDS &&
      String(claims.repository_id) === trust.repositoryId &&
      claims.workflow_ref === trust.workflowRef &&
      claims.event_name === "workflow_run";
  } catch {
    return false;
  }
}

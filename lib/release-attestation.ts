import type { Release } from "./releases";

export const RS_KEY_REPOSITORY = "TheMaxMur/RS-Key";
export const RS_KEY_REPOSITORY_ID = 1266469959;
export const RS_KEY_REPOSITORY_URL = `https://github.com/${RS_KEY_REPOSITORY}`;
export const RS_KEY_RELEASES_URL = `${RS_KEY_REPOSITORY_URL}/releases`;
export const GITHUB_RELEASE_PREDICATE = "https://in-toto.io/attestation/release/v0.2";
export const GITHUB_RELEASE_SIGNER = "https://dotcom.releases.github.com";

export interface SerializedSigstoreBundle {
  mediaType: string;
  verificationMaterial: {
    certificate?: { rawBytes: string };
    timestampVerificationData?: {
      rfc3161Timestamps?: Array<{ signedTimestamp: string }>;
    };
  };
  dsseEnvelope?: {
    payload: string;
    payloadType: string;
    signatures: Array<{ sig: string; keyid?: string }>;
  };
}

export interface ReleaseAttestation {
  repositoryId: number;
  refDigest: string;
  bundle: SerializedSigstoreBundle;
}

interface AttestationSubject {
  name?: string;
  uri?: string;
  digest?: Record<string, string>;
}

interface ReleaseStatement {
  _type: string;
  subject: AttestationSubject[];
  predicateType: string;
  predicate: {
    databaseId: string;
    ownerId: string;
    packageId: string;
    purl: string;
    repository: string;
    repositoryId: string;
    tag: string;
  };
}

interface GitHubAttestationResponse {
  attestations?: Array<{
    initiator?: string;
    repository_id?: number;
    bundle?: SerializedSigstoreBundle;
  }>;
}

interface GitHubRefResponse {
  object?: { sha?: string };
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

export function base64Bytes(value: string): Uint8Array {
  const decoded = atob(value);
  return Uint8Array.from(decoded, (character) => character.charCodeAt(0));
}

export function parseReleaseStatement(bundle: SerializedSigstoreBundle): ReleaseStatement {
  const envelope = bundle.dsseEnvelope;
  if (!envelope || envelope.payloadType !== "application/vnd.in-toto+json") {
    throw new Error("The GitHub release attestation has an invalid DSSE envelope.");
  }
  if (envelope.signatures.length !== 1 || !envelope.signatures[0]?.sig) {
    throw new Error("The GitHub release attestation must have one signature.");
  }

  const raw = JSON.parse(new TextDecoder().decode(base64Bytes(envelope.payload))) as unknown;
  if (!isObject(raw) || raw._type !== "https://in-toto.io/Statement/v1" ||
      raw.predicateType !== GITHUB_RELEASE_PREDICATE || !Array.isArray(raw.subject) ||
      !isObject(raw.predicate)) {
    throw new Error("The GitHub release attestation statement is invalid.");
  }
  return raw as unknown as ReleaseStatement;
}

export function assertReleaseAttestationClaims(release: Release, attestation: ReleaseAttestation): ReleaseStatement {
  if (!release.immutable) throw new Error(`GitHub release ${release.tag} is not immutable.`);
  if (attestation.repositoryId !== RS_KEY_REPOSITORY_ID) {
    throw new Error("The release attestation has the wrong repository ID.");
  }
  if (attestation.bundle.mediaType !== "application/vnd.dev.sigstore.bundle.v0.3+json") {
    throw new Error("The GitHub release attestation uses an unsupported bundle format.");
  }

  const statement = parseReleaseStatement(attestation.bundle);
  const purl = `pkg:github/${RS_KEY_REPOSITORY}@${release.tag}`;
  const predicate = statement.predicate;
  if (predicate.tag !== release.tag || predicate.repository !== RS_KEY_REPOSITORY ||
      predicate.repositoryId !== String(RS_KEY_REPOSITORY_ID) ||
      predicate.packageId !== String(RS_KEY_REPOSITORY_ID) ||
      predicate.databaseId !== String(release.id) || predicate.purl !== purl) {
    throw new Error(`The release attestation does not describe ${release.tag}.`);
  }

  const refMatch = attestation.refDigest.match(/^(sha1|sha256):([0-9a-f]+)$/);
  if (!refMatch || refMatch[2].length !== (refMatch[1] === "sha1" ? 40 : 64)) {
    throw new Error("The release attestation has an invalid tag digest.");
  }
  const refSubject = statement.subject.find((subject) => subject.uri === purl);
  if (refSubject?.digest?.[refMatch[1]] !== refMatch[2]) {
    throw new Error("The release attestation does not match the Git tag.");
  }

  const assetSubjects = statement.subject.filter((subject) => typeof subject.name === "string");
  if (assetSubjects.length !== release.assets.length) {
    throw new Error("The release attestation does not contain the complete asset list.");
  }
  for (const asset of release.assets) {
    const subject = assetSubjects.find((candidate) => candidate.name === asset.name);
    if (subject?.digest?.sha256?.toLowerCase() !== asset.sha256) {
      throw new Error(`The release attestation does not match ${asset.name}.`);
    }
  }
  return statement;
}

export async function fetchReleaseAttestation(
  release: Release,
  headers?: HeadersInit,
  fetcher: typeof fetch = fetch,
): Promise<ReleaseAttestation> {
  const refResponse = await fetcher(
    `https://api.github.com/repos/${RS_KEY_REPOSITORY}/git/ref/tags/${encodeURIComponent(release.tag)}`,
    { headers },
  );
  if (!refResponse.ok) throw new Error(`GitHub tag lookup returned ${refResponse.status}.`);
  const ref = await refResponse.json() as GitHubRefResponse;
  const sha = ref.object?.sha?.toLowerCase() || "";
  const algorithm = sha.length === 64 ? "sha256" : sha.length === 40 ? "sha1" : "";
  if (!algorithm || !/^[0-9a-f]+$/.test(sha)) throw new Error("GitHub returned an invalid tag digest.");
  const refDigest = `${algorithm}:${sha}`;

  const url = new URL(`https://api.github.com/repos/${RS_KEY_REPOSITORY}/attestations/${refDigest}`);
  url.searchParams.set("predicate_type", "release");
  url.searchParams.set("per_page", "100");
  const response = await fetcher(url, { headers });
  if (!response.ok) throw new Error(`GitHub attestation lookup returned ${response.status}.`);
  const raw = await response.json() as GitHubAttestationResponse;
  const candidates = (raw.attestations || []).filter((candidate) =>
    candidate.initiator === "github" && candidate.repository_id === RS_KEY_REPOSITORY_ID && candidate.bundle,
  );
  if (candidates.length !== 1) {
    throw new Error(`GitHub returned ${candidates.length} release attestations for ${release.tag}.`);
  }

  const attestation: ReleaseAttestation = {
    repositoryId: candidates[0].repository_id!,
    refDigest,
    bundle: candidates[0].bundle!,
  };
  assertReleaseAttestationClaims(release, attestation);
  return attestation;
}

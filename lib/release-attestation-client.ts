import * as asn1js from "asn1js";
import {
  Certificate,
  CertificateChainValidationEngine,
  createECDSASignatureFromCMS,
  id_ContentType_SignedData,
  id_eContentType_TSTInfo,
  SignedData,
  TimeStampResp,
  TSTInfo,
} from "pkijs";
import githubTrustedRoot from "./github-trusted-root.json";
import {
  assertReleaseAttestationClaims,
  base64Bytes,
  GITHUB_RELEASE_SIGNER,
  type ReleaseAttestation,
  type SerializedSigstoreBundle,
} from "./release-attestation";
import type { Release } from "./releases";

interface TrustedCertificate {
  rawBytes: string;
}

interface TrustedAuthority {
  uri: string;
  certChain: { certificates: TrustedCertificate[] };
  validFor?: { start?: string; end?: string };
}

interface GitHubTrustedRoot {
  certificateAuthorities: TrustedAuthority[];
  timestampAuthorities: TrustedAuthority[];
}

const root = githubTrustedRoot as GitHubTrustedRoot;
const encoder = new TextEncoder();

function arrayBuffer(bytes: Uint8Array): ArrayBuffer {
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
}

function certificate(rawBytes: string): Certificate {
  const decoded = base64Bytes(rawBytes);
  const parsed = asn1js.fromBER(arrayBuffer(decoded));
  if (parsed.offset === -1) throw new Error("The GitHub certificate is invalid.");
  return new Certificate({ schema: parsed.result });
}

function authorityValidAt(authority: TrustedAuthority, date: Date): boolean {
  const start = authority.validFor?.start ? new Date(authority.validFor.start) : new Date(0);
  const end = authority.validFor?.end ? new Date(authority.validFor.end) : new Date(8640000000000000);
  return start <= date && date <= end;
}

function timestampData(bundle: SerializedSigstoreBundle): { signedData: SignedData; time: Date } {
  const encoded = bundle.verificationMaterial.timestampVerificationData?.rfc3161Timestamps?.[0]?.signedTimestamp;
  if (!encoded) throw new Error("The GitHub release attestation has no RFC3161 timestamp.");
  const parsed = asn1js.fromBER(arrayBuffer(base64Bytes(encoded)));
  if (parsed.offset === -1) throw new Error("The GitHub release timestamp is invalid.");
  const response = new TimeStampResp({ schema: parsed.result });
  if (response.status.status !== 0 && response.status.status !== 1) {
    throw new Error("The GitHub timestamp authority rejected the timestamp.");
  }
  if (!response.timeStampToken || response.timeStampToken.contentType !== id_ContentType_SignedData) {
    throw new Error("The GitHub release timestamp has an invalid CMS container.");
  }
  const signedData = new SignedData({ schema: response.timeStampToken.content });
  if (signedData.encapContentInfo.eContentType !== id_eContentType_TSTInfo ||
      !signedData.encapContentInfo.eContent) {
    throw new Error("The GitHub release timestamp has invalid TSTInfo.");
  }
  const info = TSTInfo.fromBER(arrayBuffer(signedData.encapContentInfo.eContent.valueBlock.valueHexView));
  return { signedData, time: info.genTime };
}

async function verifyTimestamp(bundle: SerializedSigstoreBundle, signature: Uint8Array): Promise<Date> {
  const { signedData, time } = timestampData(bundle);
  const authorities = root.timestampAuthorities.filter((authority) =>
    authority.uri === "timestamp.githubapp.com" && authorityValidAt(authority, time),
  );
  for (const authority of authorities) {
    try {
      const chain = authority.certChain.certificates.map((item) => certificate(item.rawBytes));
      signedData.certificates = chain;
      const verified = await signedData.verify({
        signer: 0,
        data: arrayBuffer(signature),
        trustedCerts: chain.slice(1),
        checkChain: true,
        passedWhenNotRevValues: true,
      });
      if (verified) return time;
    } catch {
      // Try the next GitHub TSA authority that was active at this time.
    }
  }
  throw new Error("The GitHub RFC3161 timestamp signature is invalid.");
}

async function verifyLeafCertificate(leaf: Certificate, time: Date): Promise<void> {
  const san = leaf.extensions?.find((extension) => extension.extnID === "2.5.29.17")?.parsedValue as
    { altNames?: Array<{ type: number; value: string }> } | undefined;
  const identities = san?.altNames?.filter((name) => name.type === 6).map((name) => name.value) || [];
  if (identities.length !== 1 || identities[0] !== GITHUB_RELEASE_SIGNER) {
    throw new Error("The GitHub release attestation has the wrong certificate identity.");
  }

  const authorities = root.certificateAuthorities.filter((authority) =>
    authority.uri === "fulcio.githubapp.com" && authorityValidAt(authority, time),
  );
  for (const authority of authorities) {
    const trustedCerts = authority.certChain.certificates.map((item) => certificate(item.rawBytes));
    const result = await new CertificateChainValidationEngine({
      checkDate: time,
      certs: [leaf],
      trustedCerts,
    }).verify();
    if (result.result) return;
  }
  throw new Error("The GitHub release certificate chain is invalid.");
}

function dssePreAuthEncoding(payloadType: string, payload: Uint8Array): Uint8Array {
  const type = encoder.encode(payloadType);
  const prefix = encoder.encode(`DSSEv1 ${type.length} ${payloadType} ${payload.length} `);
  const output = new Uint8Array(prefix.length + payload.length);
  output.set(prefix);
  output.set(payload, prefix.length);
  return output;
}

async function verifyDsseSignature(bundle: SerializedSigstoreBundle, leaf: Certificate): Promise<void> {
  const envelope = bundle.dsseEnvelope!;
  const payload = base64Bytes(envelope.payload);
  const signature = base64Bytes(envelope.signatures[0].sig);
  const parsedSignature = asn1js.fromBER(arrayBuffer(signature));
  if (parsedSignature.offset === -1) throw new Error("The GitHub DSSE signature is invalid.");
  const webSignature = createECDSASignatureFromCMS(parsedSignature.result, 32);
  const publicKey = await leaf.getPublicKey();
  const verified = await crypto.subtle.verify(
    { name: "ECDSA", hash: "SHA-256" },
    publicKey,
    webSignature,
    arrayBuffer(dssePreAuthEncoding(envelope.payloadType, payload)),
  );
  if (!verified) throw new Error("The GitHub DSSE signature is invalid.");
}

export async function verifyReleaseAttestationClient(
  release: Release,
  attestation: ReleaseAttestation,
): Promise<void> {
  assertReleaseAttestationClaims(release, attestation);
  const rawLeaf = attestation.bundle.verificationMaterial.certificate?.rawBytes;
  if (!rawLeaf) throw new Error("The GitHub release attestation has no signing certificate.");
  const signature = base64Bytes(attestation.bundle.dsseEnvelope!.signatures[0].sig);
  const time = await verifyTimestamp(attestation.bundle, signature);
  const leaf = certificate(rawLeaf);
  await verifyLeafCertificate(leaf, time);
  await verifyDsseSignature(attestation.bundle, leaf);
}

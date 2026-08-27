import { bundleFromJSON } from "@sigstore/bundle";
import { TrustedRoot } from "@sigstore/protobuf-specs";
import { toSignedEntity, toTrustMaterial, Verifier } from "@sigstore/verify";
import githubTrustedRoot from "./github-trusted-root.json";
import {
  assertReleaseAttestationClaims,
  GITHUB_RELEASE_SIGNER,
  type ReleaseAttestation,
} from "./release-attestation";
import type { Release } from "./releases";

const trustedRoot = TrustedRoot.fromJSON(githubTrustedRoot);
const verifier = new Verifier(toTrustMaterial(trustedRoot), {
  ctlogThreshold: 0,
  tlogThreshold: 0,
  timestampThreshold: 1,
});

export function verifyReleaseAttestationServer(release: Release, attestation: ReleaseAttestation): void {
  const bundle = bundleFromJSON(attestation.bundle);
  verifier.verify(toSignedEntity(bundle), {
    subjectAlternativeName: new RegExp(`^${GITHUB_RELEASE_SIGNER.replaceAll(".", "\\.")}$`),
  });
  assertReleaseAttestationClaims(release, attestation);
}

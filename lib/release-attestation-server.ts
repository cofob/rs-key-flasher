import { verifyReleaseAttestationClient } from "./release-attestation-client";
import type { ReleaseAttestation } from "./release-attestation";
import type { Release } from "./releases";

export async function verifyReleaseAttestationServer(
  release: Release,
  attestation: ReleaseAttestation,
): Promise<void> {
  await verifyReleaseAttestationClient(release, attestation);
}

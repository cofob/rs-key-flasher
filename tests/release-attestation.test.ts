import { describe, expect, it, vi } from "vitest";
import { verifyReleaseAttestationClient } from "../lib/release-attestation-client";
import {
  assertReleaseAttestationClaims,
  fetchReleaseAttestation,
  fetchReleaseAttestations,
} from "../lib/release-attestation";
import { verifyReleaseAttestationServer } from "../lib/release-attestation-server";
import type { ReleaseAttestation } from "../lib/release-attestation";
import type { Release } from "../lib/releases";
import fixture from "./fixtures/github-release-attestation.json";

function testData(): { release: Release; attestation: ReleaseAttestation } {
  return structuredClone(fixture) as { release: Release; attestation: ReleaseAttestation };
}

describe("GitHub keyless release attestation", () => {
  it("verifies the official release bundle on the server", async () => {
    const { release, attestation } = testData();
    await expect(verifyReleaseAttestationServer(release, attestation)).resolves.toBeUndefined();
  });

  it("verifies the official release bundle in the browser verifier", async () => {
    const { release, attestation } = testData();
    await expect(verifyReleaseAttestationClient(release, attestation)).resolves.toBeUndefined();
  });

  it("rejects an asset digest that is not in the signed statement", () => {
    const { release, attestation } = testData();
    release.assets[0].sha256 = "0".repeat(64);
    expect(() => assertReleaseAttestationClaims(release, attestation)).toThrow(/does not match/);
  });

  it("rejects a different release tag", () => {
    const { release, attestation } = testData();
    release.tag = "v0.4.11";
    expect(() => assertReleaseAttestationClaims(release, attestation)).toThrow(/does not describe/);
  });

  it("rejects a modified keyless signature on the server and client", async () => {
    const { release, attestation } = testData();
    const signature = attestation.bundle.dsseEnvelope!.signatures[0];
    signature.sig = `${signature.sig[0] === "A" ? "B" : "A"}${signature.sig.slice(1)}`;
    await expect(verifyReleaseAttestationServer(release, attestation)).rejects.toThrow();
    await expect(verifyReleaseAttestationClient(release, attestation)).rejects.toThrow(/timestamp signature is invalid/);
  });

  it("loads the release attestation by the signed Git tag digest", async () => {
    const { release, attestation } = testData();
    const fetcher = vi.fn(async (input: string | URL | Request) => {
      const url = String(input);
      if (url.includes("/git/ref/tags/")) {
        return Response.json({ object: { sha: attestation.refDigest.slice("sha1:".length) } });
      }
      return Response.json({ attestations: [{
        initiator: "github",
        repository_id: attestation.repositoryId,
        bundle: attestation.bundle,
      }] });
    });

    await expect(fetchReleaseAttestation(release, undefined, fetcher)).resolves.toEqual(attestation);
    expect(String(fetcher.mock.calls[1][0])).toContain(`/attestations/${attestation.refDigest}`);
  });

  it("loads tag refs once when it loads a release list", async () => {
    const { release, attestation } = testData();
    const fetcher = vi.fn(async (input: string | URL | Request) => {
      const url = String(input);
      if (url.includes("/git/matching-refs/tags/")) {
        return Response.json([{ ref: `refs/tags/${release.tag}`, object: {
          sha: attestation.refDigest.slice("sha1:".length),
        } }]);
      }
      return Response.json({ attestations: [{
        initiator: "github",
        repository_id: attestation.repositoryId,
        bundle: attestation.bundle,
      }] });
    });

    await expect(fetchReleaseAttestations([release], undefined, fetcher)).resolves.toEqual([attestation]);
    expect(fetcher).toHaveBeenCalledTimes(2);
  });
});

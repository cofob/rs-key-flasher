import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";

const documentedPaths = [
  "/api/releases",
  "/api/assets/{assetId}",
  "/api/previews",
  "/api/previews/{buildId}",
  "/api/preview-assets/{assetId}",
  "/api/storage/releases",
  "/api/storage/previews",
];

describe("OpenAPI documentation", () => {
  it("documents every public API path and redirect response", async () => {
    const specification = await readFile(new URL("../public/openapi.yml", import.meta.url), "utf8");
    expect(specification).toContain("openapi: 3.1.0");
    for (const path of documentedPaths) expect(specification).toContain(`  ${path}:`);
    expect(specification).toContain('"307": { $ref: "#/components/responses/AssetRedirect" }');
    expect(specification).toContain("https://rskey-assets.cofob.dev/");
  });

  it("loads the public specification from the Swagger page", async () => {
    const page = await readFile(new URL("../app/docs/swagger.tsx", import.meta.url), "utf8");
    expect(page).toContain('url="/openapi.yml"');
    expect(page).toContain("<SwaggerUI");
  });
});

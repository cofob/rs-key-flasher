import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";

describe("preview archive Cloudflare configuration", () => {
  it("uses one Queue consumer with retries, a DLQ, and one basic Container", async () => {
    const configuration = JSON.parse(await readFile(
      new URL("../wrangler.jsonc", import.meta.url),
      "utf8",
    )) as {
      queues: {
        producers: unknown[];
        consumers: unknown[];
      };
      containers: unknown[];
    };

    expect(configuration.queues.producers).toContainEqual({
      binding: "PREVIEW_TASKS",
      queue: "rs-key-preview-tasks",
    });
    expect(configuration.queues.consumers).toContainEqual(expect.objectContaining({
      queue: "rs-key-preview-tasks",
      max_batch_size: 1,
      max_concurrency: 1,
      max_retries: 5,
      dead_letter_queue: "rs-key-preview-tasks-dlq",
    }));
    expect(configuration.containers).toEqual([expect.objectContaining({
      class_name: "PreviewArchiver",
      instance_type: "basic",
      max_instances: 1,
    })]);
  });

  it("uses level 15 without a long-distance window", async () => {
    const source = await readFile(new URL("../worker/preview-archiver.ts", import.meta.url), "utf8");
    expect(source).toContain("zstd -T0 -15 -o archive.tar.zst");
    expect(source).not.toContain("--long");
  });
});

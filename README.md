# RS-Key Web Flasher

A web app for downloading, signing, and flashing [RS-Key](https://github.com/TheMaxMur/RS-Key) firmware on RP2350 devices.

**Live app:** [https://rskey.fob.wtf/](https://rskey.fob.wtf/)

## Features

- Select a release or local UF2 file.
- Search CI preview history by pull request, branch, actor, or commit.
- Verify the GitHub immutable-release attestation in the Worker and in the browser.
- Verify firmware SHA-256 before downloading or flashing.
- Compare a local UF2 SHA-256 with all official release assets.
- Create per-device signed UF2 files.
- Follow a guided Secure Boot and OTP provisioning flow.

Flashing requires a desktop Chromium browser on HTTPS or localhost. Firmware download and UF2 signing remain available without WebUSB.

## Development

Requires Node.js 24.11 or newer.

```sh
npm install
npm run dev
npm test
npm run typecheck
npm run build
```

The generated Rust/WASM preview archive fallback is committed. A normal Node.js build does not need Rust. To regenerate it, install Rust 1.98.0, `wasm32-unknown-unknown`, and `wasm-bindgen-cli` 0.2.127, then run:

```sh
npm run wasm:build
```

Preview storage uses the `PREVIEWS` database binding and the existing `RELEASE_ASSETS` object-storage binding. Create the database, add its ID to `wrangler.jsonc`, and apply migrations:

```sh
wrangler d1 create rs-key-flasher-previews
wrangler d1 migrations apply rs-key-flasher-previews --remote
```

Preview uploads send archive work to Cloudflare Queues. Create the task queue and its dead-letter queue before the first deploy:

```sh
wrangler queues create rs-key-preview-tasks-dlq
wrangler queues create rs-key-preview-tasks
```

The Worker sends each new build to the queue at once. The existing daily trigger also finds old or missed builds and sends tasks to the same queue. A Cloudflare Container creates a deterministic `tar.zst` file with `zstd -T0 -15`. Individual UF2 objects stay available for 24 hours after the database switches to the archive. A later queue task removes them. The daily trigger still synchronizes release assets and removes expired previews.

Asset download endpoints redirect to the public storage domain configured by `ASSET_PUBLIC_BASE_URL`. Apply the read-only CORS policy before deploying redirect support, then verify it:

```sh
npx wrangler r2 bucket cors set rs-key-flasher-release-assets --file asset-storage-cors.json
npx wrangler r2 bucket cors list rs-key-flasher-release-assets
```

If the public domain already cached objects before the policy was applied, purge that hostname so that responses include the new CORS headers.

The privileged `preview-publish` workflow authenticates with a short-lived GitHub Actions OIDC token. The Worker verifies GitHub's signature, the dedicated audience, the immutable RS-Key repository ID, and the publisher workflow ref on `main`. Preview publishing does not use a shared secret.

Secure Boot and OTP changes can be permanent. Read the warnings in the app before provisioning a device.

`lib/github-trusted-root.json` contains the GitHub Sigstore trust root used for offline verification. Refresh it with a current `gh attestation trusted-root` result when GitHub rotates this root.

## License

[cofob.dev License](https://cofob.dev/license/)

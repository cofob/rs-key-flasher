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

Preview storage uses the `PREVIEWS` database binding and the existing `RELEASE_ASSETS` object-storage binding. Create the database, add its ID to `wrangler.jsonc`, and apply migrations:

```sh
wrangler d1 create rs-key-flasher-previews
wrangler d1 migrations apply rs-key-flasher-previews --remote
```

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

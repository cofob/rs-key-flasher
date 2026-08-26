# RS-Key Web Flasher

A small Vinext app that installs [RS-Key](https://github.com/TheMaxMur/RS-Key)
firmware for RP2350 devices through the picoboot WebUSB interface. It checks the release
SHA-256 before flashing and reads the flash back before reboot.

The opt-in security tools create one in-memory secp256k1 signing key per device,
export it as SEC1 PEM or a 24-word mnemonic, seal the selected RP2350 UF2, and
provide WebUSB and manual flashing paths. Private keys and derived signed files
are never sent to the Worker, KV, or R2.

You can select a release or load a local UF2 file. The easy picker lists the
available release profiles, including FIPS and FIPS + PQC builds. The footer
switch can load release metadata from the direct GitHub API. This setting stays
in `localStorage` and applies after the page reloads.

## Requirements

- Node.js 24.11 or newer
- npm
- A GitHub Packages token with `read:packages` access for the public
  `@cofob/design-system-*` packages
- A secure browser context: HTTPS or localhost

Authenticate npm without saving a token in this repository:

```sh
npm login --scope=@cofob --auth-type=legacy --registry=https://npm.pkg.github.com
```

## Development

```sh
npm install
npm run dev
npm test
npm run typecheck
npm run build
```

The default Worker configuration declares:

- `GITHUB_CACHE`: Workers KV for the GitHub release manifest and mirror cursor
- `RELEASE_ASSETS`: R2 for release files
- `GITHUB_TOKEN`: optional Worker secret for a higher GitHub API rate limit

Release metadata stays in KV without an expiry. It refreshes after one hour and
remains available during a GitHub outage. The daily cron mirrors release files
to R2 and saves its cursor after each file. A user request also fills R2 on a
cache miss while the same response streams to the browser.

Cloudflare Cache API keeps release responses and verified UF2 responses at the
edge. An edge hit does not read KV or R2. Release responses use a five-minute
edge TTL. Versioned UF2 responses are immutable and use a one-year TTL.

The R2 object path is `releases/<tag>/<original filename>`. The HTTP response
also keeps the original release filename.

For a non-Cloudflare deployment, run the same API handlers as a simple proxy or
set `VITE_FLASHER_API_BASE` to a compatible proxy. Direct GitHub release asset
requests are not a complete fallback because browsers cannot always read them
through CORS.

## rsk CLI

Use `uvx` to run `rsk` without a persistent installation. Python 3.10 or later
is required:

```sh
git clone https://github.com/TheMaxMur/RS-Key.git
cd RS-Key
uvx --from ./tools rsk status --json
```

For a persistent command, run `uv tool install ./tools`. On Linux, install
PC/SC and start `pcscd`. See the
[rsk CLI guide](https://github.com/TheMaxMur/RS-Key/blob/main/tools/README.md)
for system dependencies and other installation methods.

## Safety

Choose the correct 2 MB, 4 MB, 16 MB, or display image. The boot ROM does not
give this small flasher a reliable flash-size value. Published RS-Key UF2 files
are also not sealed for a device that enforces secure boot. Download and verify
the private-key backup before writing any secure-boot OTP fuse. Losing that key
after `SECURE_BOOT_ENABLE` prevents all future firmware updates for the device.

The production wizard reads every relevant OTP row before a write, refuses
partial or foreign state, and verifies each write. Runtime-only page-58 and
anti-rollback fuses use the RS-Key rescue CCID applet. If the operating system
owns the CCID interface, use the exact `rsk` fallback shown in the app and paste
`rsk status --json` as boot proof.

# RS-Key Web Flasher

A small Vinext app that installs [RS-Key](https://github.com/TheMaxMur/RS-Key)
firmware through the RP2 picoboot WebUSB interface. It checks the release
SHA-256 before flashing and reads the flash back before reboot.

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

The R2 object path is `releases/<tag>/<original filename>`. The HTTP response
also keeps the original release filename.

For a non-Cloudflare deployment, run the same API handlers as a simple proxy or
set `VITE_FLASHER_API_BASE` to a compatible proxy. Direct GitHub release asset
requests are not a complete fallback because browsers cannot always read them
through CORS.

## Safety

Choose the correct 2 MB, 4 MB, 16 MB, or display image. The boot ROM does not
give this small flasher a reliable flash-size value. Published RS-Key UF2 files
are also not sealed for a device that enforces secure boot.

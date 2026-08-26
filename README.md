# RS-Key Web Flasher

A web app for downloading, signing, and flashing [RS-Key](https://github.com/TheMaxMur/RS-Key) firmware on RP2350 devices.

**Live app:** [https://rskey.fob.wtf/](https://rskey.fob.wtf/)

## Features

- Select a release or local UF2 file.
- Verify firmware before downloading or flashing.
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

Secure Boot and OTP changes can be permanent. Read the warnings in the app before provisioning a device.

## License

[cofob.dev License](https://cofob.dev/license/)

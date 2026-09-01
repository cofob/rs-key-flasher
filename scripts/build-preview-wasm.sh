#!/bin/sh
set -eu

repository_root=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
crate_directory="$repository_root/wasm/preview-archive"
output_directory="$repository_root/lib/wasm/generated"

mkdir -p "$output_directory"
cargo build --manifest-path "$crate_directory/Cargo.toml" --locked --release --target wasm32-unknown-unknown
wasm-bindgen \
  "$crate_directory/target/wasm32-unknown-unknown/release/preview_archive.wasm" \
  --target web \
  --out-dir "$output_directory" \
  --out-name preview_archive

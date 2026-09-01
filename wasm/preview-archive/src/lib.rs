use std::collections::HashSet;
use std::io::{self, Cursor, Read};
use wasm_bindgen::prelude::*;

const MAX_OUTPUT_SIZE: u64 = 100 * 1024 * 1024;
const MAX_MEMBER_SIZE: u64 = 32 * 1024 * 1024;

const EXPECTED_NAMES: [&str; 20] = [
    "firmware-default.uf2",
    "firmware-pqc.uf2",
    "firmware-fips.uf2",
    "firmware-fips-pqc.uf2",
    "firmware-strong-pin.uf2",
    "firmware-strong-pin-pqc.uf2",
    "firmware-always-uv.uf2",
    "firmware-always-uv-pqc.uf2",
    "firmware-strict-up.uf2",
    "firmware-strict-up-pqc.uf2",
    "firmware-display.uf2",
    "firmware-2mb.uf2",
    "firmware-16mb.uf2",
    "firmware-board-waveshare-one.uf2",
    "firmware-board-tenstar-usb.uf2",
    "firmware-board-seeed-xiao.uf2",
    "firmware-board-waveshare-touch-lcd.uf2",
    "firmware-board-abrobot-4m.uf2",
    "firmware-board-abrobot-16m.uf2",
    "firmware-strict-config.uf2",
];

struct LimitedReader<R> {
    inner: R,
    remaining: u64,
}

impl<R: Read> Read for LimitedReader<R> {
    fn read(&mut self, output: &mut [u8]) -> io::Result<usize> {
        if self.remaining == 0 {
            return Err(io::Error::other("The archive output is too large."));
        }
        let limit = usize::try_from(self.remaining.min(output.len() as u64)).unwrap_or(output.len());
        let count = self.inner.read(&mut output[..limit])?;
        self.remaining -= count as u64;
        Ok(count)
    }
}

fn extract(
    compressed: &[u8],
    member_name: &str,
    expected_size: u64,
    expected_uncompressed_size: u64,
) -> Result<Vec<u8>, String> {
    if !EXPECTED_NAMES.contains(&member_name)
        || expected_size == 0
        || expected_size > MAX_MEMBER_SIZE
        || expected_uncompressed_size == 0
        || expected_uncompressed_size > MAX_OUTPUT_SIZE
    {
        return Err("The preview archive metadata is invalid.".into());
    }

    let decoder = ruzstd::decoding::StreamingDecoder::new_with_max_window_size(
        Cursor::new(compressed),
        4 * 1024 * 1024,
    )
        .map_err(|error| format!("Could not start Zstandard decompression: {error}"))?;
    let limited = LimitedReader {
        inner: decoder,
        remaining: MAX_OUTPUT_SIZE,
    };
    let mut archive = tar::Archive::new(limited);
    let entries = archive
        .entries()
        .map_err(|error| format!("Could not read the TAR archive: {error}"))?;
    let mut names = HashSet::new();
    let mut selected = None;
    let mut content_size = 0_u64;

    for item in entries {
        let mut entry = item.map_err(|error| format!("Could not read a TAR entry: {error}"))?;
        if !entry.header().entry_type().is_file() {
            return Err("The TAR archive contains a non-file entry.".into());
        }
        let path = entry
            .path()
            .map_err(|_| "The TAR archive has an invalid file name.".to_string())?;
        let name = path
            .to_str()
            .ok_or_else(|| "The TAR archive has a non-UTF-8 file name.".to_string())?
            .to_string();
        if !EXPECTED_NAMES.contains(&name.as_str()) {
            return Err("The TAR archive contains an unsafe file name.".into());
        }
        if !names.insert(name.clone()) {
            return Err("The TAR archive contains a duplicate member.".into());
        }
        let size = entry.size();
        if size > MAX_MEMBER_SIZE {
            return Err("A TAR member is too large.".into());
        }
        content_size = content_size
            .checked_add(size)
            .ok_or_else(|| "The TAR content size is invalid.".to_string())?;
        if content_size > expected_uncompressed_size {
            return Err("The TAR content is larger than its metadata.".into());
        }
        if name == member_name {
            if size != expected_size {
                return Err("The firmware size does not match the TAR metadata.".into());
            }
            let mut bytes = Vec::with_capacity(expected_size as usize);
            entry
                .read_to_end(&mut bytes)
                .map_err(|error| format!("Could not read the firmware member: {error}"))?;
            selected = Some(bytes);
        } else {
            io::copy(&mut entry, &mut io::sink())
                .map_err(|error| format!("Could not validate a TAR member: {error}"))?;
        }
    }

    if content_size != expected_uncompressed_size
        || names.len() != EXPECTED_NAMES.len()
        || EXPECTED_NAMES.iter().any(|name| !names.contains(*name))
    {
        return Err("The TAR archive is incomplete.".into());
    }
    selected.ok_or_else(|| "The requested firmware is not in the TAR archive.".into())
}

#[wasm_bindgen]
pub fn extract_preview_member(
    compressed: &[u8],
    member_name: &str,
    expected_size: u32,
    expected_uncompressed_size: u32,
) -> Result<Vec<u8>, JsError> {
    extract(
        compressed,
        member_name,
        u64::from(expected_size),
        u64::from(expected_uncompressed_size),
    )
    .map_err(|message| JsError::new(&message))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn test_archive() -> (Vec<u8>, u64) {
        let mut builder = tar::Builder::new(Vec::new());
        let mut content_size = 0;
        for (index, name) in EXPECTED_NAMES.iter().enumerate() {
            let data = vec![index as u8; 512 + index];
            content_size += data.len() as u64;
            let mut header = tar::Header::new_ustar();
            header.set_size(data.len() as u64);
            header.set_mode(0o644);
            header.set_mtime(0);
            header.set_cksum();
            builder.append_data(&mut header, name, data.as_slice()).unwrap();
        }
        builder.finish().unwrap();
        let tar = builder.into_inner().unwrap();
        (
            ruzstd::encoding::compress_to_vec(
                tar.as_slice(),
                ruzstd::encoding::CompressionLevel::Fastest,
            ),
            content_size,
        )
    }

    #[test]
    fn rejects_an_unknown_member_name_before_decompression() {
        let result = extract(&[], "../firmware.uf2", 512, 10_240);
        assert_eq!(result.unwrap_err(), "The preview archive metadata is invalid.");
    }

    #[test]
    fn rejects_an_oversized_member_before_decompression() {
        let result = extract(&[], EXPECTED_NAMES[0], MAX_MEMBER_SIZE + 1, 10_240);
        assert_eq!(result.unwrap_err(), "The preview archive metadata is invalid.");
    }

    #[test]
    fn extracts_one_member_and_validates_the_complete_archive() {
        let (archive, content_size) = test_archive();
        let result = extract(&archive, EXPECTED_NAMES[7], 519, content_size).unwrap();
        assert_eq!(result, vec![7; 519]);
    }

    #[test]
    fn rejects_wrong_content_metadata() {
        let (archive, content_size) = test_archive();
        let result = extract(&archive, EXPECTED_NAMES[0], 512, content_size - 1);
        assert_eq!(result.unwrap_err(), "The TAR content is larger than its metadata.");
    }
}

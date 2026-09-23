use anyhow::{Context, Result, anyhow};
use axum::{body::Body, extract::multipart::Field};
use bytes::Bytes;
use futures_util::{Stream, StreamExt};
use sha2::{Digest, Sha256};
use std::{
    path::{Path, PathBuf},
    process::Stdio,
    time::Duration,
};
use tokio::{io::AsyncWriteExt, process::Command};
use tokio_util::io::ReaderStream;
use uuid::Uuid;

pub const MAX_UPLOAD_BYTES: u64 = 200 * 1024 * 1024;
pub const MAX_FORM_FIELD_BYTES: usize = 64 * 1024;

pub async fn persist_chunks<S>(mut chunks: S, destination: &Path, max_bytes: u64) -> Result<u64>
where
    S: Stream<Item = Result<Bytes>> + Unpin,
{
    if let Some(parent) = destination.parent() {
        tokio::fs::create_dir_all(parent).await?;
    }
    let write_result = async {
        let mut file = tokio::fs::File::create(destination).await?;
        let mut written = 0_u64;
        while let Some(chunk) = chunks.next().await {
            let chunk = chunk?;
            let next = written.saturating_add(chunk.len() as u64);
            if next > max_bytes {
                return Err(anyhow!("upload_too_large"));
            }
            file.write_all(&chunk).await?;
            written = next;
        }
        file.flush().await?;
        Ok(written)
    }
    .await;
    if write_result.is_err() {
        let _ = tokio::fs::remove_file(destination).await;
    }
    write_result
}

pub async fn read_text_field(mut field: Field<'_>, max_bytes: usize) -> Result<String> {
    let mut bytes = Vec::new();
    while let Some(chunk) = field.chunk().await? {
        if bytes.len().saturating_add(chunk.len()) > max_bytes {
            return Err(anyhow!("form_field_too_large"));
        }
        bytes.extend_from_slice(&chunk);
    }
    Ok(String::from_utf8_lossy(&bytes).into_owned())
}

pub async fn persist_multipart_field(
    field: Field<'_>,
    destination: &Path,
    max_bytes: u64,
) -> Result<u64> {
    let chunks = futures_util::stream::unfold(field, |mut field| async move {
        match field.chunk().await {
            Ok(Some(bytes)) => Some((Ok(bytes), field)),
            Ok(None) => None,
            Err(error) => Some((Err(anyhow!(error)), field)),
        }
    });
    persist_chunks(Box::pin(chunks), destination, max_bytes).await
}

pub fn media_kind_for_upload(
    filename: &str,
    content_type: &str,
    size: u64,
) -> Result<(&'static str, &'static str)> {
    if size == 0 {
        return Err(anyhow!("media_required"));
    }
    let content_type = content_type
        .split(';')
        .next()
        .unwrap_or("")
        .trim()
        .to_ascii_lowercase();
    let by_type = match content_type.as_str() {
        "image/jpeg" | "image/jpg" => Some(("image", ".jpg")),
        "image/png" => Some(("image", ".jpg")),
        "video/mp4" => Some(("video", ".mp4")),
        "video/quicktime" => Some(("video", ".mov")),
        _ => None,
    };
    if let Some(kind) = by_type {
        return Ok(kind);
    }
    let suffix = Path::new(filename)
        .extension()
        .and_then(|extension| extension.to_str())
        .unwrap_or("")
        .to_ascii_lowercase();
    match suffix.as_str() {
        "jpg" | "jpeg" => Ok(("image", ".jpg")),
        "mp4" => Ok(("video", ".mp4")),
        _ => Err(anyhow!("unsupported_media_type")),
    }
}

pub fn mime_for_filename(filename: &str) -> &'static str {
    match Path::new(filename)
        .extension()
        .and_then(|extension| extension.to_str())
        .unwrap_or("")
        .to_ascii_lowercase()
        .as_str()
    {
        "jpg" | "jpeg" => "image/jpeg",
        "png" => "image/png",
        "mp4" => "video/mp4",
        "mov" => "video/quicktime",
        _ => "application/octet-stream",
    }
}

pub async fn sha256_file(path: &Path) -> Result<String> {
    use tokio::io::AsyncReadExt;
    let mut file = tokio::fs::File::open(path).await?;
    let mut digest = Sha256::new();
    let mut chunk = vec![0_u8; 1024 * 1024];
    loop {
        let count = file.read(&mut chunk).await?;
        if count == 0 {
            break;
        }
        digest.update(&chunk[..count]);
    }
    Ok(format!("{:x}", digest.finalize()))
}

pub async fn stream_file(path: &Path) -> Result<Body, std::io::Error> {
    let file = tokio::fs::File::open(path).await?;
    Ok(Body::from_stream(ReaderStream::new(file)))
}

fn find_ffmpeg() -> Option<PathBuf> {
    if let Ok(configured) = std::env::var("FFMPEG_BIN")
        && !configured.trim().is_empty()
    {
        return Some(PathBuf::from(configured));
    }
    if let Some(path) = std::env::var_os("PATH") {
        for directory in std::env::split_paths(&path) {
            let candidate = directory.join("ffmpeg");
            if candidate.is_file() {
                return Some(candidate);
            }
        }
    }
    std::env::var_os("HOME")
        .map(PathBuf::from)
        .map(|home| home.join(".local/bin/ffmpeg"))
        .filter(|candidate| candidate.is_file())
}

async fn run_ffmpeg(args: &[&std::ffi::OsStr], timeout: Duration) -> Result<()> {
    let ffmpeg = find_ffmpeg().ok_or_else(|| anyhow!("ffmpeg_unavailable"))?;
    let result = tokio::time::timeout(timeout, async {
        Command::new(ffmpeg)
            .args(args)
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .status()
            .await
    })
    .await
    .map_err(|_| anyhow!("ffmpeg_timeout"))??;
    if !result.success() {
        return Err(anyhow!("ffmpeg_failed"));
    }
    Ok(())
}

pub async fn convert_png_to_jpeg(input: &Path, output: &Path) -> Result<()> {
    if find_ffmpeg().is_none() {
        return Err(anyhow!("png_conversion_unavailable"));
    }
    let input_path = input;
    let output_path = output;
    let args = [
        "-hide_banner".as_ref(),
        "-loglevel".as_ref(),
        "error".as_ref(),
        "-nostdin".as_ref(),
        "-y".as_ref(),
        "-i".as_ref(),
        input_path.as_os_str(),
        "-map_metadata".as_ref(),
        "-1".as_ref(),
        "-frames:v".as_ref(),
        "1".as_ref(),
        "-q:v".as_ref(),
        "2".as_ref(),
        "-f".as_ref(),
        "image2".as_ref(),
        output_path.as_os_str(),
    ];
    if run_ffmpeg(&args, Duration::from_secs(20)).await.is_err() {
        let _ = tokio::fs::remove_file(output_path).await;
        return Err(anyhow!("png_conversion_failed"));
    }
    ensure_nonempty(output_path)
        .await
        .map_err(|_| anyhow!("png_conversion_failed"))
}

pub async fn normalize_reel_video(path: &Path) -> Result<()> {
    let output = path.with_file_name(format!(
        "{}.{}.normalized.mp4",
        path.file_stem().and_then(|s| s.to_str()).unwrap_or("reel"),
        Uuid::new_v4().simple()
    ));
    let input_arg = path.as_os_str();
    let output_arg = output.as_os_str();
    let args = [
        "-hide_banner".as_ref(),
        "-loglevel".as_ref(),
        "error".as_ref(),
        "-nostdin".as_ref(),
        "-y".as_ref(),
        "-i".as_ref(),
        input_arg,
        "-map".as_ref(),
        "0:v:0".as_ref(),
        "-map".as_ref(),
        "0:a:0?".as_ref(),
        "-c".as_ref(),
        "copy".as_ref(),
        "-map_metadata".as_ref(),
        "-1".as_ref(),
        "-movflags".as_ref(),
        "+faststart".as_ref(),
        "-use_editlist".as_ref(),
        "0".as_ref(),
        "-f".as_ref(),
        "mp4".as_ref(),
        output_arg,
    ];
    let conversion = run_ffmpeg(&args, Duration::from_secs(120)).await;
    if conversion.is_err() || ensure_nonempty(&output).await.is_err() {
        let _ = tokio::fs::remove_file(&output).await;
        return Err(anyhow!("reel_conversion_failed"));
    }
    tokio::fs::rename(&output, path)
        .await
        .context("could not replace normalized Reel")?;
    Ok(())
}

async fn ensure_nonempty(path: &Path) -> Result<()> {
    let metadata = tokio::fs::metadata(path).await?;
    if metadata.len() == 0 {
        return Err(anyhow!("empty media output"));
    }
    Ok(())
}

pub fn safe_filename(filename: &str) -> bool {
    !filename.is_empty()
        && filename != "."
        && filename != ".."
        && !filename.contains('/')
        && !filename.contains('\\')
        && Path::new(filename)
            .file_name()
            .and_then(|part| part.to_str())
            == Some(filename)
}

#[cfg(test)]
mod tests {
    use super::{convert_png_to_jpeg, find_ffmpeg, normalize_reel_video};
    use std::{path::PathBuf, process::Command};
    use tempfile::TempDir;

    #[tokio::test]
    async fn converts_a_valid_png_to_jpeg() {
        let Some(ffmpeg) = find_ffmpeg() else {
            eprintln!("skipping FFmpeg conversion check because FFmpeg is unavailable");
            return;
        };
        let temp = TempDir::new().unwrap();
        let png = temp.path().join("fixture.png");
        let jpeg = temp.path().join("fixture.jpg");
        let source_jpeg = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../assets/avatar.jpg");
        let generated = Command::new(&ffmpeg)
            .args(["-hide_banner", "-loglevel", "error", "-nostdin", "-y", "-i"])
            .arg(source_jpeg)
            .args(["-frames:v", "1"])
            .arg(&png)
            .status()
            .unwrap();
        assert!(generated.success());

        convert_png_to_jpeg(&png, &jpeg).await.unwrap();

        let mut converted = tokio::fs::File::open(&jpeg).await.unwrap();
        use tokio::io::AsyncReadExt;
        let mut signature = [0_u8; 2];
        converted.read_exact(&mut signature).await.unwrap();
        assert_eq!(signature, [0xff, 0xd8]);
    }

    #[tokio::test]
    async fn remuxes_quicktime_reel_for_fast_start_without_edit_lists() {
        let Some(ffmpeg) = find_ffmpeg() else {
            eprintln!("skipping Reel remux check because FFmpeg is unavailable");
            return;
        };
        let temp = TempDir::new().unwrap();
        let source = temp.path().join("fixture.mov");
        let generated = Command::new(&ffmpeg)
            .args([
                "-hide_banner",
                "-loglevel",
                "error",
                "-nostdin",
                "-y",
                "-f",
                "lavfi",
                "-i",
                "color=c=black:s=160x288:r=30:d=1",
                "-f",
                "lavfi",
                "-i",
                "sine=frequency=440:duration=1",
                "-map",
                "0:v:0",
                "-map",
                "1:a:0",
                "-c:v",
                "libx264",
                "-c:a",
                "aac",
                "-use_editlist",
                "1",
                "-movflags",
                "-faststart",
                "-f",
                "mov",
            ])
            .arg(&source)
            .status()
            .unwrap();
        assert!(generated.success());
        let original = tokio::fs::read(&source).await.unwrap();
        assert_eq!(&original[8..12], b"qt  ");
        assert!(original.windows(4).any(|part| part == b"edts"));

        normalize_reel_video(&source).await.unwrap();

        let normalized = tokio::fs::read(&source).await.unwrap();
        assert_ne!(&normalized[8..12], b"qt  ");
        let moov_at = normalized
            .windows(4)
            .position(|part| part == b"moov")
            .unwrap();
        let mdat_at = normalized
            .windows(4)
            .position(|part| part == b"mdat")
            .unwrap();
        assert!(moov_at < mdat_at);
        assert!(!normalized.windows(4).any(|part| part == b"edts"));
        let decoded = Command::new(ffmpeg)
            .args(["-hide_banner", "-loglevel", "error", "-nostdin", "-i"])
            .arg(&source)
            .args(["-f", "null", "-"])
            .status()
            .unwrap();
        assert!(decoded.success());
    }
}

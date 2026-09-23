"""Static planner server and Instagram Story publishing API."""

from __future__ import annotations

import argparse
import hashlib
import json
import mimetypes
import os
import shutil
import subprocess
import sys
import tempfile
import threading
import time
import uuid
from concurrent.futures import ThreadPoolExecutor
from dataclasses import dataclass
from datetime import date, datetime, timedelta, timezone
from email.parser import BytesParser
from email.policy import default
from http import HTTPStatus
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.error import HTTPError, URLError
from urllib.parse import parse_qs, unquote, urlparse
from urllib.request import Request, urlopen
from zoneinfo import ZoneInfo

if __package__:
    from .storage import StoryStore, build_public_media_url, utc_now_iso
    from .story_service import MetaAPIError, StoryService
else:  # Running as: python3 backend/server.py
    sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
    from backend.storage import StoryStore, build_public_media_url, utc_now_iso
    from backend.story_service import MetaAPIError, StoryService


PROJECT_ROOT = Path(__file__).resolve().parent.parent
API_ENV_PATH = PROJECT_ROOT / "api" / ".env"
DATA_PATH = PROJECT_ROOT / "backend" / "data" / "schedules.json"
UPLOADS_PATH = PROJECT_ROOT / "backend" / "uploads"
ANALYTICS_CACHE_TTL_SECONDS = 20.0
ANALYTICS_META_CONCURRENCY = 5
ANALYTICS_TIMEZONE = ZoneInfo("America/Sao_Paulo")
MAX_UPLOAD_BYTES = 200 * 1024 * 1024
DUPLICATE_REEL_MESSAGE = (
    "Este Reel já foi enviado ou agendado. Para evitar uma publicação duplicada, "
    "o servidor bloqueou um novo envio."
)
SUPPORTED_TYPES = {
    "image/jpeg": ("image", ".jpg"),
    "image/jpg": ("image", ".jpg"),
    "image/png": ("image", ".jpg"),
    "video/mp4": ("video", ".mp4"),
    "video/quicktime": ("video", ".mov"),
}


def load_env_file(path: Path) -> dict[str, str]:
    values: dict[str, str] = {}
    if not path.exists():
        return values
    for raw_line in path.read_text(encoding="utf-8").splitlines():
        line = raw_line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, value = line.split("=", 1)
        value = value.strip()
        if len(value) >= 2 and value[0] == value[-1] and value[0] in {"'", '"'}:
            value = value[1:-1]
        values[key.strip()] = value
    return values


def env_value(name: str, env_file: dict[str, str], default: str = "") -> str:
    return os.environ.get(name, env_file.get(name, default))


@dataclass(frozen=True)
class AppConfig:
    access_token: str
    instagram_user_id: str
    instagram_username: str
    graph_api_base_url: str
    graph_api_version: str
    public_base_url: str

    @classmethod
    def load(cls) -> "AppConfig":
        env_file = load_env_file(API_ENV_PATH)
        return cls(
            access_token=env_value("INSTAGRAM_ACCESS_TOKEN", env_file),
            instagram_user_id=env_value("INSTAGRAM_USER_ID", env_file),
            instagram_username=env_value("INSTAGRAM_USERNAME", env_file),
            graph_api_base_url=env_value("GRAPH_API_BASE_URL", env_file, "https://graph.instagram.com"),
            graph_api_version=env_value("GRAPH_API_VERSION", env_file, "v25.0"),
            public_base_url=env_value("PUBLIC_BASE_URL", env_file),
        )


def build_health_payload(
    *,
    access_token: str,
    instagram_user_id: str,
    instagram_username: str,
    public_base_url: str,
) -> dict:
    public_configured = False
    public_reason = "PUBLIC_BASE_URL is not configured"
    if public_base_url:
        try:
            build_public_media_url(public_base_url, "health-check.jpg")
            public_configured = True
            public_reason = ""
        except ValueError as exc:
            public_reason = str(exc)
    return {
        "ok": True,
        "meta_configured": bool(access_token and instagram_user_id),
        "instagram_user_id": instagram_user_id,
        "instagram_username": instagram_username,
        "public_media_configured": public_configured,
        "public_media_reason": public_reason,
    }


def media_kind_for_upload(media: dict | None) -> tuple[str, str]:
    if not media or not media.get("content"):
        raise ValueError("media_required")
    content_type = (media.get("content_type") or "").lower().split(";", 1)[0]
    if content_type in SUPPORTED_TYPES:
        return SUPPORTED_TYPES[content_type]
    suffix = Path(media.get("filename", "")).suffix.lower()
    if suffix in {".jpg", ".jpeg"}:
        return "image", ".jpg"
    if suffix == ".mp4":
        return "video", ".mp4"
    raise ValueError("unsupported_media_type")


def verify_public_media(media_url: str, expected_size: int) -> None:
    """Confirm that Meta can address the exact uploaded file before creating a container."""
    try:
        with urlopen(Request(media_url, method="HEAD"), timeout=10) as response:
            content_type = response.headers.get("Content-Type", "").split(";", 1)[0].lower()
            content_length = response.headers.get("Content-Length", "")
            if response.status != 200 or content_type not in {"video/mp4", "image/jpeg", "video/quicktime"}:
                raise ValueError("Mídia pública inacessível: resposta HTTPS inesperada.")
            if not content_length.isdigit() or int(content_length) != expected_size:
                raise ValueError("Mídia pública inacessível: tamanho do arquivo diferente no endereço público.")
    except HTTPError as exc:
        raise ValueError(f"Mídia pública inacessível: HTTP {exc.code} no endereço configurado.") from exc
    except (URLError, TimeoutError, OSError) as exc:
        raise ValueError("Mídia pública inacessível: verifique o túnel HTTPS e PUBLIC_BASE_URL.") from exc


def find_ffmpeg() -> str | None:
    ffmpeg = os.environ.get("FFMPEG_BIN") or shutil.which("ffmpeg")
    if not ffmpeg:
        local_ffmpeg = Path.home() / ".local" / "bin" / "ffmpeg"
        ffmpeg = str(local_ffmpeg) if local_ffmpeg.is_file() else None
    return ffmpeg


def normalize_reel_video(path: Path) -> None:
    """Remux a Reel to a fast-start MP4 without edit lists before Meta fetches it."""
    ffmpeg = find_ffmpeg()
    if not ffmpeg:
        raise ValueError("reel_conversion_unavailable")

    output = path.with_name(f"{path.stem}.{uuid.uuid4().hex}.normalized.mp4")
    try:
        subprocess.run(
            [
                ffmpeg, "-hide_banner", "-loglevel", "error", "-nostdin", "-y",
                "-i", str(path), "-map", "0:v:0", "-map", "0:a:0?",
                "-c", "copy", "-map_metadata", "-1", "-movflags", "+faststart",
                "-use_editlist", "0", "-f", "mp4", str(output),
            ],
            check=True, capture_output=True, timeout=120,
        )
        if output.stat().st_size == 0:
            raise ValueError("reel_conversion_failed")
        os.replace(output, path)
    except (FileNotFoundError, subprocess.CalledProcessError, subprocess.TimeoutExpired, OSError) as exc:
        raise ValueError("reel_conversion_failed") from exc
    finally:
        output.unlink(missing_ok=True)


def validate_story_request(fields: dict, media: dict | None) -> tuple[str, str, datetime | None]:
    action = fields.get("action", "").strip()
    if action not in {"publish_now", "schedule"}:
        raise ValueError("invalid_action")
    media_kind, _ = media_kind_for_upload(media)
    scheduled_at = None
    if action == "schedule":
        raw_scheduled_at = fields.get("scheduled_at", "").strip()
        if not raw_scheduled_at:
            raise ValueError("scheduled_at_required")
        try:
            scheduled_at = datetime.fromisoformat(raw_scheduled_at.replace("Z", "+00:00"))
        except ValueError as exc:
            raise ValueError("invalid_scheduled_at") from exc
        if scheduled_at.tzinfo is None:
            raise ValueError("scheduled_at_timezone_required")
        if scheduled_at <= datetime.now(timezone.utc):
            raise ValueError("scheduled_at_must_be_future")
    return action, media_kind, scheduled_at


def validate_reel_request(fields: dict, media: dict | None) -> tuple[str, str]:
    action = fields.get("action", "").strip()
    if action not in {"publish_now", "schedule"}:
        raise ValueError("invalid_action")
    strategy = fields.get("graduation_strategy", "MANUAL").strip().upper() or "MANUAL"
    if strategy not in {"MANUAL", "SS_PERFORMANCE"}:
        raise ValueError("graduation_strategy_invalid")
    if media is not None:
        media_kind, _ = media_kind_for_upload(media)
        if media_kind != "video":
            raise ValueError("reel_video_required")
    return action, strategy


def validate_schedule_edit(payload: dict) -> dict:
    allowed = {"scheduled_at", "caption"}
    if not payload or set(payload) - allowed:
        raise ValueError("invalid_schedule_update")

    patch: dict[str, str] = {}
    if "scheduled_at" in payload:
        raw_scheduled_at = payload["scheduled_at"]
        if not isinstance(raw_scheduled_at, str) or not raw_scheduled_at.strip():
            raise ValueError("scheduled_at_required")
        try:
            scheduled_at = datetime.fromisoformat(raw_scheduled_at.replace("Z", "+00:00"))
        except ValueError as exc:
            raise ValueError("invalid_scheduled_at") from exc
        if scheduled_at.tzinfo is None:
            raise ValueError("scheduled_at_timezone_required")
        if scheduled_at <= datetime.now(timezone.utc):
            raise ValueError("scheduled_at_must_be_future")
        patch["scheduled_at"] = scheduled_at.isoformat()

    if "caption" in payload:
        caption = payload["caption"]
        if not isinstance(caption, str):
            raise ValueError("invalid_schedule_update")
        if len(caption) > 2200:
            raise ValueError("caption_too_long")
        patch["caption"] = caption.strip()

    return patch


def parse_multipart(content_type: str, body: bytes) -> tuple[dict, dict | None]:
    envelope = BytesParser(policy=default).parsebytes(
        b"MIME-Version: 1.0\r\nContent-Type: " + content_type.encode("utf-8") + b"\r\n\r\n" + body
    )
    fields: dict[str, str] = {}
    media = None
    for part in envelope.iter_parts():
        disposition = part.get_content_disposition()
        name = part.get_param("name", header="content-disposition")
        if disposition != "form-data" or not name:
            continue
        payload = part.get_payload(decode=True) or b""
        filename = part.get_filename()
        if filename:
            media = {
                "filename": Path(filename).name,
                "content_type": part.get_content_type(),
                "content": payload,
            }
        else:
            fields[name] = payload.decode("utf-8", errors="replace")
    return fields, media


class StoryApplication:
    def __init__(
        self, config: AppConfig | None = None, *, store: StoryStore | None = None,
        service=None, media_probe=None, video_converter=None,
    ) -> None:
        self.config = config or AppConfig.load()
        self.store = store or StoryStore(DATA_PATH)
        self.uploads_path = UPLOADS_PATH
        self.uploads_path.mkdir(parents=True, exist_ok=True)
        self.service = service or (
            StoryService(
                self.config.access_token,
                self.config.instagram_user_id,
                base_url=self.config.graph_api_base_url,
                api_version=self.config.graph_api_version,
            )
            if self.config.access_token and self.config.instagram_user_id
            else None
        )
        self.media_probe = media_probe or verify_public_media
        self.video_converter = video_converter or normalize_reel_video
        self._reel_submit_lock = threading.Lock()
        self._analytics_snapshot_lock = threading.Lock()
        self._analytics_snapshot: tuple[float, dict, list[dict]] | None = None
        self.store.recover_processing()

    def health(self) -> dict:
        payload = build_health_payload(
            access_token=self.config.access_token,
            instagram_user_id=self.config.instagram_user_id,
            instagram_username=self.config.instagram_username,
            public_base_url=self.config.public_base_url,
        )
        payload["graph_api_version"] = self.config.graph_api_version
        return payload

    def _require_publish_configuration(self) -> None:
        if not self.config.access_token or not self.config.instagram_user_id or not self.service:
            raise ValueError("meta_not_configured")
        try:
            build_public_media_url(self.config.public_base_url, "configuration-check.jpg")
        except ValueError as exc:
            raise ValueError("public_media_not_configured") from exc

    @staticmethod
    def _failure_patch(exc: Exception) -> dict:
        patch = {"status": "failed", "error": str(exc)}
        container_id = getattr(exc, "container_id", None)
        if container_id:
            patch["container_id"] = container_id
        return patch

    def _save_media(self, media: dict, extension: str) -> str:
        filename = f"{uuid.uuid4().hex}{extension}"
        output_path = self.uploads_path / filename
        if (media.get("content_type") or "").lower().split(";", 1)[0] == "image/png":
            ffmpeg = find_ffmpeg()
            if not ffmpeg:
                raise ValueError("png_conversion_unavailable")
            temporary_path = None
            try:
                with tempfile.NamedTemporaryFile(
                    mode="wb", suffix=".png", dir=self.uploads_path, delete=False
                ) as temporary_file:
                    temporary_file.write(media["content"])
                    temporary_path = Path(temporary_file.name)
                subprocess.run(
                    [
                        ffmpeg, "-hide_banner", "-loglevel", "error", "-nostdin", "-y",
                        "-i", str(temporary_path), "-map_metadata", "-1",
                        "-frames:v", "1", "-q:v", "2", "-f", "image2", str(output_path),
                    ],
                    check=True,
                    stdout=subprocess.DEVNULL,
                    stderr=subprocess.DEVNULL,
                    timeout=20,
                )
                if not output_path.is_file() or output_path.stat().st_size == 0:
                    output_path.unlink(missing_ok=True)
                    raise ValueError("png_conversion_failed")
            except (FileNotFoundError, subprocess.CalledProcessError, subprocess.TimeoutExpired) as exc:
                output_path.unlink(missing_ok=True)
                raise ValueError("png_conversion_failed") from exc
            finally:
                if temporary_path:
                    temporary_path.unlink(missing_ok=True)
        else:
            output_path.write_bytes(media["content"])
        return filename

    def _save_public_media(self, media: dict, extension: str, *, normalize_video: bool = False) -> tuple[str, str]:
        filename = self._save_media(media, extension)
        media_url = build_public_media_url(self.config.public_base_url, filename)
        try:
            if normalize_video:
                self.video_converter(self.uploads_path / filename)
            self.media_probe(media_url, (self.uploads_path / filename).stat().st_size)
        except Exception:
            (self.uploads_path / filename).unlink(missing_ok=True)
            raise
        return filename, media_url

    @staticmethod
    def _sha256_file(path: Path) -> str:
        digest = hashlib.sha256()
        with path.open("rb") as media_file:
            for chunk in iter(lambda: media_file.read(1024 * 1024), b""):
                digest.update(chunk)
        return digest.hexdigest()

    def _is_duplicate_reel(self, media_sha256: str, *, exclude_schedule_ids: set[str] | None = None) -> bool:
        excluded = exclude_schedule_ids or set()
        for record in self.store.list_schedules():
            if record.get("id") in excluded:
                continue
            if record.get("type") not in {"reel", "test_reel"} or record.get("media_kind") != "video":
                continue
            existing_sha256 = record.get("media_sha256")
            if not existing_sha256:
                filename = Path(record.get("media_filename", "")).name
                if not filename:
                    continue
                existing_path = self.uploads_path / filename
                if not existing_path.is_file():
                    continue
                existing_sha256 = self._sha256_file(existing_path)
            if existing_sha256 == media_sha256:
                return True
        return False

    def create_story(self, fields: dict, media: dict | None) -> dict:
        action, media_kind, scheduled_at = validate_story_request(fields, media)
        self._require_publish_configuration()
        _, extension = media_kind_for_upload(media)
        filename, media_url = self._save_public_media(media, extension)
        record_payload = {
            "type": "story",
            "media_filename": filename,
            "media_kind": media_kind,
            "caption": fields.get("caption", "").strip(),
            "scheduled_at": scheduled_at.isoformat() if scheduled_at else utc_now_iso(),
        }
        if action == "schedule":
            return self.store.create_schedule(record_payload)

        record = self.store.create_schedule({**record_payload, "status": "processing"})
        try:
            result = self.service.publish_story(media_url, media_kind)
        except (MetaAPIError, OSError, TimeoutError, ValueError) as exc:
            failed = self.store.update_schedule(record["id"], self._failure_patch(exc))
            raise PublishRequestError("meta_publish_failed", str(exc), failed) from exc
        return self.store.update_schedule(
            record["id"],
            {
                "status": "published",
                "instagram_media_id": result["id"],
                "container_id": result["container_id"],
                "published_at": utc_now_iso(),
            },
        ) or record

    def create_reel(self, fields: dict, media: dict | None) -> dict:
        with self._reel_submit_lock:
            return self._create_reel_once(fields, media)

    def _create_reel_once(self, fields: dict, media: dict | None) -> dict:
        action, graduation_strategy = validate_reel_request(fields, media)
        if not media:
            raise ValueError("media_required")
        media_kind, _ = media_kind_for_upload(media)
        if media_kind != "video":
            raise ValueError("reel_video_required")
        self._require_publish_configuration()
        scheduled_at = None
        if action == "schedule":
            raw_scheduled_at = fields.get("scheduled_at", "").strip()
            if not raw_scheduled_at:
                raise ValueError("scheduled_at_required")
            try:
                scheduled_at = datetime.fromisoformat(raw_scheduled_at.replace("Z", "+00:00"))
            except ValueError as exc:
                raise ValueError("invalid_scheduled_at") from exc
            if scheduled_at.tzinfo is None:
                raise ValueError("scheduled_at_timezone_required")
            if scheduled_at <= datetime.now(timezone.utc):
                raise ValueError("scheduled_at_must_be_future")
        filename = self._save_media(media, ".mp4")
        media_path = self.uploads_path / filename
        try:
            self.video_converter(media_path)
            media_sha256 = self._sha256_file(media_path)
            if self._is_duplicate_reel(media_sha256):
                raise ValueError("duplicate_reel")
            media_url = build_public_media_url(self.config.public_base_url, filename)
            self.media_probe(media_url, media_path.stat().st_size)
        except Exception:
            media_path.unlink(missing_ok=True)
            raise
        record_payload = {
            "type": "test_reel",
            "media_filename": filename,
            "media_kind": media_kind,
            "media_sha256": media_sha256,
            "caption": fields.get("caption", "").strip(),
            "graduation_strategy": graduation_strategy,
            "scheduled_at": scheduled_at.isoformat() if scheduled_at else utc_now_iso(),
        }
        if action == "schedule":
            return self.store.create_schedule(record_payload)

        record = self.store.create_schedule({**record_payload, "status": "processing"})
        try:
            result = self.service.publish_reel(
                media_url,
                record_payload["caption"],
                graduation_strategy=graduation_strategy,
            )
        except (MetaAPIError, OSError, TimeoutError, ValueError) as exc:
            failed = self.store.update_schedule(record["id"], self._failure_patch(exc))
            raise PublishRequestError("meta_publish_failed", str(exc), failed) from exc
        return self.store.update_schedule(
            record["id"],
            {
                "status": "published",
                "instagram_media_id": result["id"],
                "container_id": result["container_id"],
                "published_at": utc_now_iso(),
            },
        ) or record

    def run_due_schedules(self) -> int:
        claimed = self.store.claim_due(datetime.now(timezone.utc))
        claimed_ids = {record.get("id") for record in claimed}
        claimed_reel_hashes: set[str] = set()
        claimed.sort(key=lambda record: (record.get("scheduled_at", ""), record.get("created_at", "")))
        completed = 0
        for record in claimed:
            try:
                if record.get("type") == "test_reel":
                    media_path = self.uploads_path / record["media_filename"]
                    media_sha256 = record.get("media_sha256") or self._sha256_file(media_path)
                    if (
                        media_sha256 in claimed_reel_hashes
                        or self._is_duplicate_reel(media_sha256, exclude_schedule_ids=claimed_ids)
                    ):
                        self.store.update_schedule(record["id"], {
                            "status": "failed",
                            "error": DUPLICATE_REEL_MESSAGE,
                            "media_sha256": media_sha256,
                        })
                        continue
                    claimed_reel_hashes.add(media_sha256)
                    if not record.get("media_sha256"):
                        self.store.update_schedule(record["id"], {"media_sha256": media_sha256})
                self._require_publish_configuration()
                media_url = build_public_media_url(self.config.public_base_url, record["media_filename"])
                self.media_probe(media_url, (self.uploads_path / record["media_filename"]).stat().st_size)
                if record.get("type") == "test_reel":
                    result = self.service.publish_reel(
                        media_url,
                        record.get("caption", ""),
                        graduation_strategy=record.get("graduation_strategy", "MANUAL"),
                    )
                else:
                    result = self.service.publish_story(media_url, record["media_kind"])
                self.store.update_schedule(record["id"], {
                    "status": "published",
                    "instagram_media_id": result["id"],
                    "container_id": result["container_id"],
                    "published_at": utc_now_iso(),
                })
                completed += 1
            except (MetaAPIError, OSError, TimeoutError, ValueError) as exc:
                self.store.update_schedule(record["id"], self._failure_patch(exc))
        return completed

    def _get_analytics_snapshot(self, *, force_refresh: bool = False) -> tuple[dict, list[dict]]:
        with self._analytics_snapshot_lock:
            now = time.monotonic()
            if (
                not force_refresh
                and self._analytics_snapshot
                and now - self._analytics_snapshot[0] < ANALYTICS_CACHE_TTL_SECONDS
            ):
                return self._analytics_snapshot[1], self._analytics_snapshot[2]

            profile: dict = {}
            media_items: list[dict] = []
            if self.service and hasattr(self.service, "get_profile"):
                try:
                    profile = self.service.get_profile()
                except Exception:
                    pass
            if self.service and hasattr(self.service, "get_recent_media"):
                try:
                    media_items = self.service.get_recent_media(limit=100)
                except Exception:
                    pass

            self._analytics_snapshot = (time.monotonic(), profile, media_items)
            return profile, media_items

    @staticmethod
    def _analytics_datetime(day: date) -> datetime:
        return datetime.combine(day, datetime.min.time(), tzinfo=ANALYTICS_TIMEZONE)

    def get_analytics(self, period: str = "30d", *, force_refresh: bool = False) -> dict:
        period = period.strip().lower()
        if period not in {"30d", "7d", "today"}:
            period = "30d"

        if not self.service or not hasattr(self.service, "get_account_insights"):
            raise MetaAPIError("Instagram account insights are not configured")

        today = datetime.now(ANALYTICS_TIMEZONE).date()
        days_count = {"today": 1, "7d": 7, "30d": 30}[period]
        first_day = today - timedelta(days=days_count - 1)
        day_after_today = today + timedelta(days=1)
        first_timestamp = int(self._analytics_datetime(first_day).timestamp())
        end_timestamp = int(self._analytics_datetime(day_after_today).timestamp())

        profile, media_items = self._get_analytics_snapshot(force_refresh=force_refresh)
        username = profile.get("username") or self.config.instagram_username or ""
        followers_count = profile.get("followers_count")
        media_count = profile.get("media_count")
        profile_picture_url = profile.get("profile_picture_url") or "assets/avatar.jpg"

        metrics = self.service.get_account_insights(
            ["views", "reach"],
            since=first_timestamp,
            until=end_timestamp,
        )

        last_24_hours_until = int(time.time())
        last_24_hours_since = last_24_hours_until - 24 * 60 * 60
        try:
            last_24_hours_metrics = self.service.get_account_insights(
                ["views", "reach"],
                since=last_24_hours_since,
                until=last_24_hours_until,
            )
        except MetaAPIError:
            last_24_hours_metrics = None

        days = [first_day + timedelta(days=index) for index in range(days_count)]

        def read_daily_views(day):
            since = int(self._analytics_datetime(day).timestamp())
            until = int(self._analytics_datetime(day + timedelta(days=1)).timestamp())
            value = self.service.get_account_insights(["views"], since=since, until=until)["views"]
            return day, value

        with ThreadPoolExecutor(max_workers=ANALYTICS_META_CONCURRENCY) as executor:
            daily_views = dict(executor.map(read_daily_views, days))

        reels: list[dict] = []
        reels_count_24h = 0
        for item in media_items:
            product_type = (item.get("media_product_type") or "").upper()
            media_type = (item.get("media_type") or "").upper()
            if product_type != "REELS" and media_type != "VIDEO":
                continue
            timestamp = item.get("timestamp") or ""
            try:
                published_at = datetime.fromisoformat(timestamp.replace("Z", "+00:00"))
                if published_at.tzinfo is None:
                    published_at = published_at.replace(tzinfo=timezone.utc)
                if last_24_hours_since <= published_at.timestamp() <= last_24_hours_until:
                    reels_count_24h += 1
                published_day = published_at.astimezone(ANALYTICS_TIMEZONE).date()
            except (TypeError, ValueError):
                continue
            if published_day < first_day or published_day > today:
                continue

            reel = {
                "id": str(item.get("id")),
                "caption": (item.get("caption") or "").strip() or "Reel sem legenda",
                "thumbnail_url": item.get("thumbnail_url") or item.get("media_url") or "assets/avatar.jpg",
                "permalink": item.get("permalink", f"https://www.instagram.com/{username}"),
                "timestamp": timestamp,
                "_published_day": published_day,
            }
            for field in ("like_count", "comments_count"):
                value = item.get(field)
                if isinstance(value, (int, float)) and not isinstance(value, bool):
                    reel[field] = int(value)
            reels.append(reel)

        def read_media_views(reel):
            try:
                reel["views"] = self.service.get_media_views(reel["id"])
            except (MetaAPIError, OSError, TimeoutError, ValueError):
                # Keep the real Reel metadata; never estimate its views from likes.
                pass
            return reel

        with ThreadPoolExecutor(max_workers=ANALYTICS_META_CONCURRENCY) as executor:
            reels = list(executor.map(read_media_views, reels))

        reels_by_day: dict[date, list[dict]] = {}
        for reel in reels:
            reels_by_day.setdefault(reel.pop("_published_day"), []).append(reel)

        months_pt = ["Jan", "Fev", "Mar", "Abr", "Mai", "Jun", "Jul", "Ago", "Set", "Out", "Nov", "Dez"]
        points = []
        for day in days:
            day_reels = reels_by_day.get(day, [])
            label = "Hoje*" if day == today else f"{day.day:02d} {months_pt[day.month - 1]}"
            points.append({
                "date": day.isoformat(),
                "label": label,
                "views": daily_views[day],
                "partial": day == today,
                "reels": day_reels,
            })

        max_view = max((point["views"] for point in points), default=0)
        ceiling = max(10000, ((max_view + 9999) // 10000) * 10000)
        if ceiling < 10000:
            ceiling = 10000
        step = ceiling // 5
        steps = [step * i for i in range(5, -1, -1)]

        views = metrics["views"]
        reach = metrics["reach"]
        metrics = {
            "views": views,
            "views_formatted": f"{views / 1000:.1f}".replace(".", ",") + " mil" if views >= 1000 else str(views),
            "reach": reach,
            "reach_formatted": f"{reach / 1000:.1f}".replace(".", ",") + " mil" if reach >= 1000 else str(reach),
            "followers_count": followers_count,
            "reels_count": len(reels),
            "views_24h": last_24_hours_metrics["views"] if last_24_hours_metrics else None,
            "reach_24h": last_24_hours_metrics["reach"] if last_24_hours_metrics else None,
            "reels_count_24h": reels_count_24h,
        }

        return {
            "ok": True,
            "period": period,
            "updated_at": datetime.now(timezone.utc).isoformat(),
            "timezone": "America/Sao_Paulo",
            "freshness_notice": "A Meta pode levar até 48 horas para consolidar alguns Insights.",
            "range": {
                "start": first_day.isoformat(),
                "end": today.isoformat(),
                "days": days_count,
                "today_partial": True,
            },
            "account": {
                "username": username,
                "media_count": media_count,
                "profile_picture_url": profile_picture_url,
            },
            "metrics": metrics,
            "chart": {
                "lateral_axis": {
                    "min": 0,
                    "max": ceiling,
                    "steps": steps,
                    "labels": [f"{s // 1000}k" if s >= 1000 else "0" for s in steps],
                },
                "points": points,
            },
            "reels": reels,
        }


class PublishRequestError(RuntimeError):
    def __init__(self, code: str, message: str, record: dict | None = None) -> None:
        super().__init__(message)
        self.code = code
        self.record = record


class PlannerHandler(SimpleHTTPRequestHandler):
    application: StoryApplication

    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=str(PROJECT_ROOT), **kwargs)

    def log_message(self, format, *args):  # noqa: A003
        # Keep access logs free of query strings and request body contents.
        print(f"{self.command} {self.path.split('?', 1)[0]} -> {args[1] if len(args) > 1 else ''}")

    def _send_json(self, status: int, payload: dict | list) -> None:
        encoded = json.dumps(payload, ensure_ascii=False).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Cache-Control", "no-store")
        self.send_header("Content-Length", str(len(encoded)))
        self.end_headers()
        self.wfile.write(encoded)

    @staticmethod
    def _public_schedule(record: dict | None) -> dict | None:
        if record is None:
            return None
        return {key: value for key, value in record.items() if key != "media_sha256"}

    def _read_body(self) -> bytes:
        try:
            content_length = int(self.headers.get("Content-Length", "0"))
        except ValueError as exc:
            raise ValueError("invalid_content_length") from exc
        if content_length <= 0:
            return b""
        if content_length > MAX_UPLOAD_BYTES:
            raise ValueError("upload_too_large")
        return self.rfile.read(content_length)

    def _route_path(self) -> str:
        return unquote(urlparse(self.path).path)

    def do_GET(self):  # noqa: N802
        path = self._route_path()
        if path == "/api/health":
            self._send_json(HTTPStatus.OK, self.application.health())
            return
        if path == "/api/schedules":
            schedules = self.application.store.list_schedules()
            self._send_json(HTTPStatus.OK, {"schedules": [self._public_schedule(record) for record in schedules]})
            return
        if path == "/api/analytics":
            query_params = parse_qs(urlparse(self.path).query)
            period = query_params.get("period", ["30d"])[0]
            force_refresh = query_params.get("refresh", ["0"])[0] == "1"
            try:
                payload = self.application.get_analytics(period, force_refresh=force_refresh)
            except MetaAPIError:
                self._send_json(HTTPStatus.BAD_GATEWAY, {
                    "ok": False,
                    "error": "meta_insights_unavailable",
                    "message": "A Meta não retornou Insights atuais. Atualize novamente em instantes.",
                })
                return
            self._send_json(HTTPStatus.OK, payload)
            return
        if path.startswith("/media/"):
            filename = Path(path.removeprefix("/media/")).name
            file_path = self.application.uploads_path / filename
            if filename != path.removeprefix("/media/") or not file_path.is_file():
                self._send_json(HTTPStatus.NOT_FOUND, {"error": "media_not_found"})
                return
            self.send_response(HTTPStatus.OK)
            self.send_header("Content-Type", mimetypes.guess_type(file_path.name)[0] or "application/octet-stream")
            self.send_header("Content-Length", str(file_path.stat().st_size))
            self.end_headers()
            self.wfile.write(file_path.read_bytes())
            return
        if path == "/" or path == "/index.html" or path.startswith(("/css/", "/js/", "/assets/")) or path == "/CLIP6.mp4":
            super().do_GET()
            return
        self._send_json(HTTPStatus.NOT_FOUND, {"error": "not_found"})

    def do_HEAD(self):  # noqa: N802
        path = self._route_path()
        if path.startswith("/media/"):
            filename = Path(path.removeprefix("/media/")).name
            file_path = self.application.uploads_path / filename
            if filename != path.removeprefix("/media/") or not file_path.is_file():
                self.send_error(HTTPStatus.NOT_FOUND)
                return
            self.send_response(HTTPStatus.OK)
            self.send_header("Content-Type", mimetypes.guess_type(file_path.name)[0] or "application/octet-stream")
            self.send_header("Content-Length", str(file_path.stat().st_size))
            self.end_headers()
            return
        super().do_HEAD()

    def do_POST(self):  # noqa: N802
        route_path = self._route_path()
        if route_path not in {"/api/stories", "/api/reels"}:
            self._send_json(HTTPStatus.NOT_FOUND, {"error": "not_found"})
            return
        try:
            body = self._read_body()
            content_type = self.headers.get("Content-Type", "")
            if not content_type.lower().startswith("multipart/form-data"):
                raise ValueError("multipart_required")
            fields, media = parse_multipart(content_type, body)
            result = (
                self.application.create_reel(fields, media)
                if route_path == "/api/reels"
                else self.application.create_story(fields, media)
            )
            self._send_json(HTTPStatus.CREATED, {"story": self._public_schedule(result)})
        except PublishRequestError as exc:
            self._send_json(HTTPStatus.BAD_GATEWAY, {
                "error": exc.code,
                "message": str(exc),
                "story": self._public_schedule(exc.record),
            })
        except ValueError as exc:
            code = str(exc)
            if code == "upload_too_large":
                status = HTTPStatus.REQUEST_ENTITY_TOO_LARGE
            elif code == "duplicate_reel":
                status = HTTPStatus.CONFLICT
            else:
                status = HTTPStatus.BAD_REQUEST
            self._send_json(status, {"error": code, "message": self._friendly_error(code)})
        except Exception as exc:  # pragma: no cover - last-resort API boundary
            self._send_json(HTTPStatus.INTERNAL_SERVER_ERROR, {"error": "internal_error", "message": str(exc)})

    def do_PATCH(self):  # noqa: N802
        prefix = "/api/schedules/"
        path = self._route_path()
        if not path.startswith(prefix):
            self._send_json(HTTPStatus.NOT_FOUND, {"error": "not_found"})
            return
        schedule_id = path.removeprefix(prefix)
        try:
            if self.headers.get("Content-Type", "").split(";", 1)[0].lower() != "application/json":
                raise ValueError("json_required")
            payload = json.loads(self._read_body().decode("utf-8"))
            if not isinstance(payload, dict):
                raise ValueError("invalid_schedule_update")
            patch = validate_schedule_edit(payload)
            current = next(
                (record for record in self.application.store.list_schedules() if record.get("id") == schedule_id),
                None,
            )
            if current is None:
                self._send_json(HTTPStatus.NOT_FOUND, {"error": "schedule_not_found"})
                return
            if current.get("status") != "scheduled":
                self._send_json(HTTPStatus.CONFLICT, {"error": "schedule_not_editable"})
                return
            updated = self.application.store.update_schedule(schedule_id, patch, expected_status="scheduled")
            if updated is None:
                self._send_json(HTTPStatus.CONFLICT, {"error": "schedule_not_editable"})
                return
            self._send_json(HTTPStatus.OK, {"schedule": self._public_schedule(updated)})
        except (ValueError, UnicodeDecodeError, json.JSONDecodeError) as exc:
            code = "invalid_schedule_update" if isinstance(exc, json.JSONDecodeError) else str(exc) or "invalid_schedule_update"
            self._send_json(HTTPStatus.BAD_REQUEST, {"error": code, "message": self._friendly_error(code)})
        except Exception as exc:  # pragma: no cover - last-resort API boundary
            self._send_json(HTTPStatus.INTERNAL_SERVER_ERROR, {"error": "internal_error", "message": str(exc)})

    def do_DELETE(self):  # noqa: N802
        prefix = "/api/schedules/"
        path = self._route_path()
        if not path.startswith(prefix):
            self._send_json(HTTPStatus.NOT_FOUND, {"error": "not_found"})
            return
        deleted = self.application.store.delete_schedule(path.removeprefix(prefix))
        self._send_json(HTTPStatus.OK if deleted else HTTPStatus.NOT_FOUND, {"deleted": deleted})

    @staticmethod
    def _friendly_error(code: str) -> str:
        messages = {
            "media_required": "Selecione uma imagem JPG ou vídeo MP4 para o Story.",
            "png_conversion_unavailable": "O servidor não dispõe de FFmpeg para converter a imagem PNG.",
            "png_conversion_failed": "Não foi possível converter a imagem PNG para JPEG.",
            "duplicate_reel": DUPLICATE_REEL_MESSAGE,
            "public_media_not_configured": "Configure PUBLIC_BASE_URL com uma URL HTTPS pública para o Meta acessar a mídia.",
            "meta_not_configured": "Configure o token e o Instagram User ID no backend.",
            "reel_video_required": "Selecione um vídeo MP4 para o Reel de teste.",
            "reel_conversion_unavailable": "FFmpeg não está instalado no servidor para preparar o vídeo do Reel.",
            "reel_conversion_failed": "Não foi possível preparar o vídeo como MP4 compatível com Reels.",
            "graduation_strategy_invalid": "A estratégia do Reel de teste deve ser MANUAL ou SS_PERFORMANCE.",
            "scheduled_at_required": "Informe a data e o horário da publicação.",
            "invalid_scheduled_at": "Informe uma data e um horário válidos.",
            "scheduled_at_timezone_required": "Não foi possível identificar o fuso horário.",
            "scheduled_at_must_be_future": "A data e o horário precisam estar no futuro.",
            "caption_too_long": "A legenda pode ter no máximo 2.200 caracteres.",
            "invalid_schedule_update": "Os dados enviados para edição são inválidos.",
            "json_required": "Não foi possível enviar as alterações.",
        }
        return messages.get(code, code)


def scheduler_loop(application: StoryApplication, stop_event: threading.Event) -> None:
    while not stop_event.wait(2.0):
        try:
            application.run_due_schedules()
        except Exception as exc:  # Keep the server alive; do not print secrets.
            print(f"scheduler error: {exc}")


def serve(host: str, port: int) -> None:
    application = StoryApplication()
    PlannerHandler.application = application
    server = ThreadingHTTPServer((host, port), PlannerHandler)
    stop_event = threading.Event()
    worker = threading.Thread(target=scheduler_loop, args=(application, stop_event), daemon=True)
    worker.start()
    print(f"Planner backend listening on http://{host}:{port}")
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        stop_event.set()
        server.server_close()


def main() -> None:
    parser = argparse.ArgumentParser(description="Story publishing backend")
    parser.add_argument("--host", default="127.0.0.1")
    parser.add_argument("--port", type=int, default=3000)
    args = parser.parse_args()
    serve(args.host, args.port)


if __name__ == "__main__":
    main()

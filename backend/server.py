"""Static planner server and Instagram Story publishing API."""

from __future__ import annotations

import argparse
import json
import mimetypes
import os
import subprocess
import sys
import tempfile
import threading
import time
import uuid
from dataclasses import dataclass
from datetime import datetime, timezone
from email.parser import BytesParser
from email.policy import default
from http import HTTPStatus
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import unquote, urlparse

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
MAX_UPLOAD_BYTES = 200 * 1024 * 1024
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
    def __init__(self, config: AppConfig | None = None, *, store: StoryStore | None = None, service=None) -> None:
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

    def _save_media(self, media: dict, extension: str) -> str:
        filename = f"{uuid.uuid4().hex}{extension}"
        output_path = self.uploads_path / filename
        if (media.get("content_type") or "").lower().split(";", 1)[0] == "image/png":
            temporary_path = None
            try:
                with tempfile.NamedTemporaryFile(
                    mode="wb", suffix=".png", dir=self.uploads_path, delete=False
                ) as temporary_file:
                    temporary_file.write(media["content"])
                    temporary_path = Path(temporary_file.name)
                subprocess.run(
                    ["sips", "-s", "format", "jpeg", "-s", "formatOptions", "90", str(temporary_path), "--out", str(output_path)],
                    check=True,
                    stdout=subprocess.DEVNULL,
                    stderr=subprocess.DEVNULL,
                    timeout=20,
                )
            except (FileNotFoundError, subprocess.CalledProcessError, subprocess.TimeoutExpired) as exc:
                raise ValueError("png_conversion_failed") from exc
            finally:
                if temporary_path:
                    temporary_path.unlink(missing_ok=True)
        else:
            output_path.write_bytes(media["content"])
        return filename

    def create_story(self, fields: dict, media: dict | None) -> dict:
        action, media_kind, scheduled_at = validate_story_request(fields, media)
        self._require_publish_configuration()
        _, extension = media_kind_for_upload(media)
        filename = self._save_media(media, extension)
        media_url = build_public_media_url(self.config.public_base_url, filename)
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
            failed = self.store.update_schedule(record["id"], {"status": "failed", "error": str(exc)})
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
        action, graduation_strategy = validate_reel_request(fields, media)
        if not media:
            raise ValueError("media_required")
        media_kind, extension = media_kind_for_upload(media)
        if media_kind != "video":
            raise ValueError("reel_video_required")
        self._require_publish_configuration()
        filename = self._save_media(media, extension)
        media_url = build_public_media_url(self.config.public_base_url, filename)
        record_payload = {
            "type": "test_reel",
            "media_filename": filename,
            "media_kind": media_kind,
            "caption": fields.get("caption", "").strip(),
            "graduation_strategy": graduation_strategy,
            "scheduled_at": utc_now_iso(),
        }
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
            record_payload["scheduled_at"] = scheduled_at.isoformat()
            return self.store.create_schedule(record_payload)

        record = self.store.create_schedule({**record_payload, "status": "processing"})
        try:
            result = self.service.publish_reel(
                media_url,
                record_payload["caption"],
                graduation_strategy=graduation_strategy,
            )
        except (MetaAPIError, OSError, TimeoutError, ValueError) as exc:
            failed = self.store.update_schedule(record["id"], {"status": "failed", "error": str(exc)})
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
        completed = 0
        for record in claimed:
            try:
                self._require_publish_configuration()
                media_url = build_public_media_url(self.config.public_base_url, record["media_filename"])
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
                self.store.update_schedule(record["id"], {"status": "failed", "error": str(exc)})
        return completed


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
            self._send_json(HTTPStatus.OK, {"schedules": self.application.store.list_schedules()})
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
            self._send_json(HTTPStatus.CREATED, {"story": result})
        except PublishRequestError as exc:
            self._send_json(HTTPStatus.BAD_GATEWAY, {
                "error": exc.code,
                "message": str(exc),
                "story": exc.record,
            })
        except ValueError as exc:
            code = str(exc)
            status = HTTPStatus.REQUEST_ENTITY_TOO_LARGE if code == "upload_too_large" else HTTPStatus.BAD_REQUEST
            self._send_json(status, {"error": code, "message": self._friendly_error(code)})
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
            "public_media_not_configured": "Configure PUBLIC_BASE_URL com uma URL HTTPS pública para o Meta acessar a mídia.",
            "meta_not_configured": "Configure o token e o Instagram User ID no backend.",
            "reel_video_required": "Selecione um vídeo MP4 para o Reel de teste.",
            "graduation_strategy_invalid": "A estratégia do Reel de teste deve ser MANUAL ou SS_PERFORMANCE.",
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

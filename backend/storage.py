"""Atomic local persistence for Instagram publication schedules."""

from __future__ import annotations

import json
import os
import threading
import uuid
from datetime import datetime, timezone
from pathlib import Path
from urllib.parse import quote, urlparse


def utc_now_iso() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="seconds")


def build_public_media_url(base_url: str, filename: str) -> str:
    if not base_url or not base_url.strip():
        raise ValueError("PUBLIC_BASE_URL is required for Meta media access")
    parsed = urlparse(base_url.strip())
    if parsed.scheme != "https" or not parsed.netloc:
        raise ValueError("PUBLIC_BASE_URL must be an HTTPS URL")
    safe_name = Path(filename).name
    if safe_name != filename or not safe_name:
        raise ValueError("invalid media filename")
    return f"{base_url.rstrip('/')}/media/{quote(safe_name, safe='')}"


class StoryStore:
    def __init__(self, path: str | Path) -> None:
        self.path = Path(path)
        self._lock = threading.RLock()
        self.path.parent.mkdir(parents=True, exist_ok=True)

    def _read(self) -> list[dict]:
        if not self.path.exists():
            return []
        try:
            payload = json.loads(self.path.read_text(encoding="utf-8"))
        except (OSError, json.JSONDecodeError) as exc:
            raise RuntimeError(f"could not read schedule store: {exc}") from exc
        if not isinstance(payload, list):
            raise RuntimeError("schedule store must contain a JSON array")
        return payload

    def _write(self, records: list[dict]) -> None:
        temporary_path = self.path.with_suffix(f"{self.path.suffix}.{uuid.uuid4().hex}.tmp")
        temporary_path.write_text(json.dumps(records, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
        os.replace(temporary_path, self.path)

    def list_schedules(self) -> list[dict]:
        with self._lock:
            return self._read()

    def create_schedule(self, payload: dict) -> dict:
        allowed = {
            "type", "media_filename", "media_kind", "caption", "scheduled_at",
            "status", "instagram_media_id", "container_id", "graduation_strategy", "error",
            "media_sha256",
        }
        record = {key: value for key, value in payload.items() if key in allowed and value is not None}
        record_type = record.get("type", "story")
        record.setdefault("id", f"{record_type}-{uuid.uuid4().hex}")
        record.setdefault("type", "story")
        record.setdefault("status", "scheduled")
        record.setdefault("caption", "")
        record["created_at"] = utc_now_iso()
        record["updated_at"] = record["created_at"]
        with self._lock:
            records = self._read()
            records.insert(0, record)
            self._write(records)
        return record

    def update_schedule(self, schedule_id: str, patch: dict, *, expected_status: str | None = None) -> dict | None:
        with self._lock:
            records = self._read()
            for record in records:
                if record.get("id") == schedule_id:
                    if expected_status is not None and record.get("status") != expected_status:
                        return None
                    record.update({key: value for key, value in patch.items() if key not in {"id", "created_at"}})
                    record["updated_at"] = utc_now_iso()
                    self._write(records)
                    return record
        return None

    def claim_due(self, now: datetime) -> list[dict]:
        claimed = []
        with self._lock:
            records = self._read()
            changed = False
            for record in records:
                if record.get("status") != "scheduled":
                    continue
                scheduled_at = record.get("scheduled_at")
                if not scheduled_at:
                    continue
                try:
                    due_at = datetime.fromisoformat(scheduled_at)
                except ValueError:
                    continue
                if due_at <= now:
                    record["status"] = "processing"
                    record["updated_at"] = utc_now_iso()
                    claimed.append(dict(record))
                    changed = True
            if changed:
                self._write(records)
        return claimed

    def delete_schedule(self, schedule_id: str) -> bool:
        with self._lock:
            records = self._read()
            remaining = [record for record in records if record.get("id") != schedule_id]
            if len(remaining) == len(records):
                return False
            self._write(remaining)
            return True

    def recover_processing(self) -> None:
        with self._lock:
            records = self._read()
            changed = False
            for record in records:
                if record.get("status") == "processing":
                    record["status"] = "scheduled"
                    record["updated_at"] = utc_now_iso()
                    changed = True
            if changed:
                self._write(records)

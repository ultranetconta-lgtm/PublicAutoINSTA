"""Small, secret-safe adapter for Instagram Story publishing."""

from __future__ import annotations

import json
import time
from typing import Callable
from urllib.error import HTTPError, URLError
from urllib.parse import urlencode
from urllib.request import Request, urlopen


class MetaAPIError(RuntimeError):
    """An error returned by Meta or by the media publishing transport."""


RequestFn = Callable[..., dict]


class StoryService:
    def __init__(
        self,
        access_token: str,
        instagram_user_id: str,
        *,
        base_url: str = "https://graph.instagram.com",
        api_version: str = "v25.0",
        request_fn: RequestFn | None = None,
        poll_interval_seconds: float = 1.0,
    ) -> None:
        if not access_token:
            raise ValueError("Instagram access token is required")
        if not instagram_user_id:
            raise ValueError("Instagram user id is required")
        self._access_token = access_token
        self.instagram_user_id = instagram_user_id
        self.base_url = base_url.rstrip("/")
        self.api_version = api_version.strip("/")
        self._request_fn = request_fn or self._request_json
        self.poll_interval_seconds = poll_interval_seconds

    def _endpoint(self, path: str) -> str:
        return f"{self.base_url}/{self.api_version}/{self.instagram_user_id}/{path.lstrip('/')}"

    def _container_endpoint(self, container_id: str) -> str:
        return f"{self.base_url}/{self.api_version}/{container_id}"

    def _request_json(
        self,
        method: str,
        url: str,
        *,
        data: dict | None = None,
        headers: dict | None = None,
    ) -> dict:
        request_headers = {"Accept": "application/json"}
        request_headers.update(headers or {})
        request_headers["Authorization"] = f"Bearer {self._access_token}"
        encoded_data = None
        if method.upper() == "POST":
            encoded_data = urlencode(data or {}).encode("utf-8")
            request_headers["Content-Type"] = "application/x-www-form-urlencoded"
        request = Request(url, data=encoded_data, headers=request_headers, method=method.upper())
        try:
            with urlopen(request, timeout=45) as response:
                return json.loads(response.read().decode("utf-8"))
        except (HTTPError, URLError, TimeoutError, json.JSONDecodeError) as exc:
            detail = "Meta request failed"
            if isinstance(exc, HTTPError):
                try:
                    body = json.loads(exc.read().decode("utf-8"))
                    detail = body.get("error", {}).get("message", detail)
                except (OSError, UnicodeDecodeError, json.JSONDecodeError):
                    pass
            elif isinstance(exc, URLError):
                detail = f"Meta connection failed: {exc.reason}"
            raise MetaAPIError(detail) from exc

    def create_container(self, media_url: str, media_kind: str) -> str:
        if media_kind not in {"image", "video"}:
            raise ValueError("media_kind must be image or video")
        parameter_name = "image_url" if media_kind == "image" else "video_url"
        response = self._request_fn(
            "POST",
            self._endpoint("media"),
            data={"media_type": "STORIES", parameter_name: media_url},
            headers={"Authorization": f"Bearer {self._access_token}"},
        )
        container_id = response.get("id")
        if not container_id:
            raise MetaAPIError("Meta did not return a Story container id")
        return container_id

    def create_reel_container(
        self,
        media_url: str,
        caption: str = "",
        *,
        graduation_strategy: str = "MANUAL",
    ) -> str:
        if graduation_strategy not in {"MANUAL", "SS_PERFORMANCE"}:
            raise ValueError("graduation_strategy must be MANUAL or SS_PERFORMANCE")
        response = self._request_fn(
            "POST",
            self._endpoint("media"),
            data={
                "media_type": "REELS",
                "video_url": media_url,
                "caption": caption,
                "trial_params": json.dumps(
                    {"graduation_strategy": graduation_strategy},
                    separators=(",", ":"),
                ),
            },
            headers={"Authorization": f"Bearer {self._access_token}"},
        )
        container_id = response.get("id")
        if not container_id:
            raise MetaAPIError("Meta did not return a Reel container id")
        return container_id

    def publish_reel(
        self,
        media_url: str,
        caption: str = "",
        *,
        graduation_strategy: str = "MANUAL",
    ) -> dict:
        container_id = self.create_reel_container(
            media_url,
            caption,
            graduation_strategy=graduation_strategy,
        )
        self.wait_until_ready(container_id)
        media_id = self.publish_container(container_id)
        return {"id": media_id, "container_id": container_id}

    def wait_until_ready(self, container_id: str, timeout_seconds: float = 60.0) -> str:
        deadline = time.monotonic() + timeout_seconds
        last_status = "IN_PROGRESS"
        while time.monotonic() <= deadline:
            response = self._request_fn(
                "GET",
                f"{self._container_endpoint(container_id)}?fields=status_code",
                headers={"Authorization": f"Bearer {self._access_token}"},
            )
            last_status = str(response.get("status_code", "")).upper()
            if last_status == "FINISHED":
                return last_status
            if last_status in {"ERROR", "EXPIRED"}:
                raise MetaAPIError(f"Story container status: {last_status}")
            time.sleep(self.poll_interval_seconds)
        raise MetaAPIError(f"Story container did not finish: {last_status}")

    def publish_container(self, container_id: str) -> str:
        response = self._request_fn(
            "POST",
            self._endpoint("media_publish"),
            data={"creation_id": container_id},
            headers={"Authorization": f"Bearer {self._access_token}"},
        )
        media_id = response.get("id")
        if not media_id:
            raise MetaAPIError("Meta did not return a published Story id")
        return media_id

    def publish_story(self, media_url: str, media_kind: str) -> dict:
        container_id = self.create_container(media_url, media_kind)
        self.wait_until_ready(container_id)
        media_id = self.publish_container(container_id)
        return {"id": media_id, "container_id": container_id}

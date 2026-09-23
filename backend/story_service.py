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

    def __init__(self, message: str, *, container_id: str | None = None) -> None:
        super().__init__(message)
        self.container_id = container_id


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
        poll_interval_seconds: float = 20.0,
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
                    error = body.get("error") if isinstance(body, dict) else None
                    if isinstance(error, dict):
                        parts = [str(error.get("message") or detail)]
                        for label, key in (("code", "code"), ("subcode", "error_subcode"), ("trace", "fbtrace_id")):
                            if error.get(key) is not None:
                                parts.append(f"{label}={error[key]}")
                        detail = "; ".join(parts)
                except (OSError, UnicodeDecodeError, json.JSONDecodeError):
                    pass
            elif isinstance(exc, URLError):
                detail = f"Meta connection failed: {exc.reason}"
            raise MetaAPIError(detail.replace(self._access_token, "[redacted]")) from exc

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
        try:
            self.wait_until_ready(container_id)
            media_id = self.publish_container(container_id)
        except MetaAPIError as exc:
            exc.container_id = container_id
            raise
        return {"id": media_id, "container_id": container_id}

    def wait_until_ready(self, container_id: str, timeout_seconds: float = 300.0) -> str:
        deadline = time.monotonic() + timeout_seconds
        last_status = "IN_PROGRESS"
        while True:
            response = self._request_fn(
                "GET",
                f"{self._container_endpoint(container_id)}?fields=status_code,status",
                headers={"Authorization": f"Bearer {self._access_token}"},
            )
            last_status = str(response.get("status_code", "")).upper()
            if last_status == "FINISHED":
                return last_status
            if last_status in {"ERROR", "EXPIRED"}:
                detail = str(response.get("status") or "").strip().replace(self._access_token, "[redacted]")
                message = f"Meta container status: {last_status}"
                if detail:
                    message += f" — {detail}"
                raise MetaAPIError(message, container_id=container_id)
            remaining = deadline - time.monotonic()
            if remaining <= 0:
                break
            time.sleep(min(self.poll_interval_seconds, remaining))
        raise MetaAPIError(f"Meta container did not finish: {last_status}", container_id=container_id)

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
        try:
            self.wait_until_ready(container_id)
            media_id = self.publish_container(container_id)
        except MetaAPIError as exc:
            exc.container_id = container_id
            raise
        return {"id": media_id, "container_id": container_id}

    def get_profile(self) -> dict:
        url = f"{self.base_url}/{self.api_version}/{self.instagram_user_id}?fields=id,username,name,profile_picture_url,followers_count,media_count"
        return self._request_fn("GET", url, headers={"Authorization": f"Bearer {self._access_token}"})

    def get_recent_media(self, limit: int = 100) -> list[dict]:
        url = f"{self._endpoint('media')}?fields=id,caption,media_type,media_product_type,media_url,thumbnail_url,permalink,timestamp,like_count,comments_count&limit={limit}"
        response = self._request_fn("GET", url, headers={"Authorization": f"Bearer {self._access_token}"})
        return response.get("data", [])

    def get_account_insights(
        self,
        metrics: list[str],
        *,
        since: int,
        until: int,
        metric_type: str = "total_value",
    ) -> dict[str, int]:
        """Read a date-bounded account insight total without exposing the token."""
        supported_metrics = {
            "views", "reach", "accounts_engaged", "total_interactions", "likes",
            "comments", "shares", "saves", "replies", "follows_and_unfollows",
            "profile_links_taps",
        }
        if not metrics or any(metric not in supported_metrics for metric in metrics):
            raise ValueError("unsupported Instagram account insight metric")
        if metric_type != "total_value":
            raise ValueError("unsupported Instagram account insight type")
        if until <= since:
            raise ValueError("Instagram insight end must be after its start")

        query = urlencode({
            "metric": ",".join(metrics),
            "period": "day",
            "metric_type": metric_type,
            "since": since,
            "until": until,
        })
        response = self._request_fn(
            "GET",
            f"{self._endpoint('insights')}?{query}",
            headers={"Authorization": f"Bearer {self._access_token}"},
        )
        rows = response.get("data")
        if not isinstance(rows, list):
            raise MetaAPIError("Meta returned an invalid account insights response")

        results: dict[str, int] = {}
        for row in rows:
            if not isinstance(row, dict) or row.get("name") not in metrics:
                continue
            value = (row.get("total_value") or {}).get("value")
            if isinstance(value, (int, float)) and not isinstance(value, bool):
                results[row["name"]] = int(value)

        missing = [metric for metric in metrics if metric not in results]
        if missing:
            raise MetaAPIError(f"Meta did not return account insight metric: {', '.join(missing)}")
        return results

    def get_media_views(self, media_id: str) -> int:
        """Read the current lifetime views for one media item."""
        query = urlencode({"metric": "views"})
        response = self._request_fn(
            "GET",
            f"{self._container_endpoint(media_id)}/insights?{query}",
            headers={"Authorization": f"Bearer {self._access_token}"},
        )
        rows = response.get("data")
        if not isinstance(rows, list):
            raise MetaAPIError("Meta returned an invalid media insights response")
        row = next((item for item in rows if isinstance(item, dict) and item.get("name") == "views"), None)
        if not row:
            raise MetaAPIError("Meta did not return media views")
        value = (row.get("total_value") or {}).get("value")
        if value is None:
            values = row.get("values")
            if isinstance(values, list) and values and isinstance(values[0], dict):
                value = values[0].get("value")
        if not isinstance(value, (int, float)) or isinstance(value, bool):
            raise MetaAPIError("Meta returned an invalid media views value")
        return int(value)

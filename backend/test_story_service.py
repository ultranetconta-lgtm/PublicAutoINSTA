import unittest
from io import BytesIO
from unittest.mock import patch
from urllib.error import HTTPError

from backend.story_service import MetaAPIError, StoryService


class StoryServiceTests(unittest.TestCase):
    def test_reel_processing_can_finish_after_more_than_one_minute(self):
        clock = [0.0]
        checks = []

        def request(method, url, *, data=None, headers=None):
            checks.append(clock[0])
            return {"status_code": "FINISHED" if len(checks) == 7 else "IN_PROGRESS"}

        service = StoryService("token", "ig-user", request_fn=request, poll_interval_seconds=20)
        with patch("backend.story_service.time.monotonic", side_effect=lambda: clock[0]):
            with patch("backend.story_service.time.sleep", side_effect=lambda seconds: clock.__setitem__(0, clock[0] + seconds + 0.001)):
                self.assertEqual(service.wait_until_ready("slow-container"), "FINISHED")

        self.assertEqual(len(checks), 7)
        self.assertGreater(checks[-1], 60)

    def test_http_error_keeps_meta_subcode_and_trace_without_token(self):
        body = (
            b'{"error":{"message":"Upload rejected for token secret-token",'
            b'"code":400,"error_subcode":2207052,"fbtrace_id":"trace-123"}}'
        )
        response_error = HTTPError("https://graph.instagram.com/v26.0/media", 400, "Bad Request", {}, BytesIO(body))
        service = StoryService("secret-token", "ig-user")

        with patch("backend.story_service.urlopen", side_effect=response_error):
            with self.assertRaises(MetaAPIError) as captured:
                service._request_json("POST", service._endpoint("media"), data={"media_type": "REELS"})

        message = str(captured.exception)
        self.assertIn("2207052", message)
        self.assertIn("trace-123", message)
        self.assertNotIn("secret-token", message)

    def test_failed_reel_exposes_container_id_and_meta_status_detail(self):
        calls = []

        def request(method, url, *, data=None, headers=None):
            calls.append((method, url))
            if method == "POST" and url.endswith("/media"):
                return {"id": "reel-container-42"}
            if method == "GET":
                return {"status_code": "ERROR", "status": "Error: Media could not be fetched."}
            self.fail("media_publish must not be called for a failed container")

        service = StoryService("token", "ig-user", request_fn=request)
        with self.assertRaises(MetaAPIError) as captured:
            service.publish_reel("https://public.example/reel.mp4", "Teste")

        self.assertEqual(captured.exception.container_id, "reel-container-42")
        self.assertIn("Media could not be fetched", str(captured.exception))
        self.assertIn("fields=status_code,status", calls[1][1])
        self.assertNotIn("token", str(captured.exception))

    def test_trial_reel_container_uses_reels_and_manual_trial_params(self):
        calls = []

        def request(method, url, *, data=None, headers=None):
            calls.append((method, url, data, headers))
            if method == "POST" and url.endswith("/media"):
                return {"id": "trial-container-1"}
            if method == "GET":
                return {"status_code": "FINISHED"}
            return {"id": "trial-published-1"}

        service = StoryService(
            "token",
            "ig-user",
            api_version="v26.0",
            request_fn=request,
        )
        result = service.publish_reel(
            "https://public.example/reel.mp4",
            "Minha legenda de teste",
            graduation_strategy="MANUAL",
        )

        self.assertEqual(result, {"id": "trial-published-1", "container_id": "trial-container-1"})
        self.assertEqual(calls[0][2], {
            "media_type": "REELS",
            "video_url": "https://public.example/reel.mp4",
            "caption": "Minha legenda de teste",
            "trial_params": '{"graduation_strategy":"MANUAL"}',
        })

    def test_trial_reel_rejects_unknown_graduation_strategy(self):
        service = StoryService("token", "ig-user", request_fn=lambda *args, **kwargs: {})

        with self.assertRaisesRegex(ValueError, "graduation_strategy"):
            service.create_reel_container(
                "https://public.example/reel.mp4",
                "Legenda",
                graduation_strategy="AUTOMATIC",
            )

    def test_story_container_uses_stories_and_selected_media_parameter(self):
        calls = []

        def request(method, url, *, data=None, headers=None):
            calls.append((method, url, data, headers))
            if method == "POST" and url.endswith("/media"):
                return {"id": "container-1"}
            if method == "GET":
                return {"status_code": "FINISHED"}
            return {"id": "published-1"}

        service = StoryService(
            "token",
            "ig-user",
            base_url="https://graph.instagram.com",
            api_version="v25.0",
            request_fn=request,
        )
        result = service.publish_story("https://public.example/story.jpg", "image")

        self.assertEqual(result, {"id": "published-1", "container_id": "container-1"})
        self.assertEqual(calls[0][2], {
            "media_type": "STORIES",
            "image_url": "https://public.example/story.jpg",
        })
        self.assertNotIn("token", calls[0][1])
        self.assertEqual(calls[0][3]["Authorization"], "Bearer token")

    def test_story_video_uses_video_url(self):
        calls = []

        def request(method, url, *, data=None, headers=None):
            calls.append(data)
            if method == "POST" and url.endswith("/media"):
                return {"id": "container-1"}
            if method == "GET":
                return {"status_code": "FINISHED"}
            return {"id": "published-1"}

        service = StoryService(
            "token",
            "ig-user",
            base_url="https://graph.instagram.com",
            api_version="v25.0",
            request_fn=request,
        )
        service.create_container("https://public.example/story.mp4", "video")

        self.assertEqual(calls[0], {
            "media_type": "STORIES",
            "video_url": "https://public.example/story.mp4",
        })


if __name__ == "__main__":
    unittest.main()

import unittest

from backend.story_service import StoryService


class StoryServiceTests(unittest.TestCase):
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

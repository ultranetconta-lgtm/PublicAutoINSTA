import json
import tempfile
import unittest
from datetime import datetime, timedelta, timezone
from pathlib import Path

from backend.server import (
    AppConfig,
    StoryApplication,
    build_health_payload,
    validate_reel_request,
    validate_story_request,
)
from backend.storage import StoryStore
from backend.story_service import MetaAPIError


class ServerContractTests(unittest.TestCase):
    def test_invalid_reel_schedule_does_not_create_an_upload(self):
        config = AppConfig(
            access_token="secret-token", instagram_user_id="123",
            instagram_username="alesantorooficial", graph_api_base_url="https://graph.instagram.com",
            graph_api_version="v26.0", public_base_url="https://public.example",
        )
        with tempfile.TemporaryDirectory() as temp_dir:
            application = StoryApplication(
                config, store=StoryStore(Path(temp_dir) / "schedules.json"),
                service=object(), media_probe=lambda url, size: None,
                video_converter=lambda path: None,
            )
            application.uploads_path = Path(temp_dir) / "uploads"
            application.uploads_path.mkdir()
            with self.assertRaisesRegex(ValueError, "invalid_scheduled_at"):
                application.create_reel(
                    {"action": "schedule", "scheduled_at": "not-a-date"},
                    {"filename": "reel.mp4", "content_type": "video/mp4", "content": b"mp4"},
                )
            self.assertEqual(list(application.uploads_path.iterdir()), [])

    def test_invalid_reel_is_rejected_and_unlinked_before_scheduling(self):
        config = AppConfig(
            access_token="secret-token", instagram_user_id="123",
            instagram_username="alesantorooficial", graph_api_base_url="https://graph.instagram.com",
            graph_api_version="v26.0", public_base_url="https://public.example",
        )
        with tempfile.TemporaryDirectory() as temp_dir:
            application = StoryApplication(
                config, store=StoryStore(Path(temp_dir) / "schedules.json"),
                service=object(), media_probe=lambda url, size: None,
            )
            application.uploads_path = Path(temp_dir) / "uploads"
            application.uploads_path.mkdir()

            with self.assertRaisesRegex(ValueError, "reel_conversion_failed"):
                application.create_reel(
                    {"action": "schedule", "scheduled_at": (datetime.now(timezone.utc) + timedelta(minutes=10)).isoformat()},
                    {"filename": "invalid.mp4", "content_type": "video/mp4", "content": b"not a movie"},
                )
            self.assertEqual(application.store.list_schedules(), [])
            self.assertEqual(list(application.uploads_path.iterdir()), [])

    def test_due_reel_checks_public_media_again_before_meta(self):
        class UnusedService:
            def publish_reel(self, *args, **kwargs):
                raise AssertionError("Meta must not receive an inaccessible URL")

        checks = 0

        def probe(url, size):
            nonlocal checks
            checks += 1
            if checks == 2:
                raise ValueError("Mídia pública inacessível: túnel encerrado")

        config = AppConfig(
            access_token="secret-token", instagram_user_id="123",
            instagram_username="alesantorooficial", graph_api_base_url="https://graph.instagram.com",
            graph_api_version="v26.0", public_base_url="https://public.example",
        )
        with tempfile.TemporaryDirectory() as temp_dir:
            application = StoryApplication(
                config, store=StoryStore(Path(temp_dir) / "schedules.json"),
                service=UnusedService(), media_probe=probe,
                video_converter=lambda path: None,
            )
            application.uploads_path = Path(temp_dir) / "uploads"
            application.uploads_path.mkdir()
            record = application.create_reel(
                {"action": "schedule", "scheduled_at": (datetime.now(timezone.utc) + timedelta(minutes=10)).isoformat()},
                {"filename": "reel.mp4", "content_type": "video/mp4", "content": b"mp4"},
            )
            application.store.update_schedule(record["id"], {
                "scheduled_at": (datetime.now(timezone.utc) - timedelta(minutes=1)).isoformat(),
            })

            self.assertEqual(application.run_due_schedules(), 0)
            failed = application.store.list_schedules()[0]
            self.assertEqual(checks, 2)
            self.assertEqual(failed["status"], "failed")
            self.assertIn("túnel encerrado", failed["error"])
            self.assertNotIn("container_id", failed)

    def test_unreachable_public_media_prevents_scheduling(self):
        class UnusedService:
            def publish_reel(self, *args, **kwargs):
                self.fail("Meta must not receive an inaccessible URL")

        config = AppConfig(
            access_token="secret-token",
            instagram_user_id="123",
            instagram_username="alesantorooficial",
            graph_api_base_url="https://graph.instagram.com",
            graph_api_version="v26.0",
            public_base_url="https://expired.example",
        )
        with tempfile.TemporaryDirectory() as temp_dir:
            application = StoryApplication(
                config,
                store=StoryStore(Path(temp_dir) / "schedules.json"),
                service=UnusedService(),
                media_probe=lambda url, size: (_ for _ in ()).throw(ValueError("Mídia pública inacessível: DNS")),
                video_converter=lambda path: None,
            )
            application.uploads_path = Path(temp_dir) / "uploads"
            application.uploads_path.mkdir()
            with self.assertRaisesRegex(ValueError, "Mídia pública inacessível"):
                application.create_reel(
                    {"action": "schedule", "scheduled_at": (datetime.now(timezone.utc) + timedelta(minutes=10)).isoformat()},
                    {"filename": "reel.mp4", "content_type": "video/mp4", "content": b"mp4"},
                )
            self.assertEqual(application.store.list_schedules(), [])

    def test_failed_scheduled_reel_retains_container_id_and_meta_detail(self):
        class FailedService:
            def publish_reel(self, media_url, caption, graduation_strategy):
                raise MetaAPIError(
                    "Meta container status: ERROR — Media could not be fetched.",
                    container_id="failed-container-42",
                )

        config = AppConfig(
            access_token="secret-token",
            instagram_user_id="123",
            instagram_username="alesantorooficial",
            graph_api_base_url="https://graph.instagram.com",
            graph_api_version="v26.0",
            public_base_url="https://public.example",
        )
        with tempfile.TemporaryDirectory() as temp_dir:
            application = StoryApplication(
                config,
                store=StoryStore(Path(temp_dir) / "schedules.json"),
                service=FailedService(),
                media_probe=lambda url, size: None,
                video_converter=lambda path: None,
            )
            application.uploads_path = Path(temp_dir) / "uploads"
            application.uploads_path.mkdir()
            record = application.create_reel(
                {
                    "action": "schedule",
                    "scheduled_at": (datetime.now(timezone.utc) + timedelta(minutes=10)).isoformat(),
                    "caption": "Teste",
                },
                {"filename": "reel.mp4", "content_type": "video/mp4", "content": b"mp4"},
            )
            application.store.update_schedule(record["id"], {
                "scheduled_at": (datetime.now(timezone.utc) - timedelta(minutes=1)).isoformat(),
            })

            self.assertEqual(application.run_due_schedules(), 0)
            failed = application.store.list_schedules()[0]
            self.assertEqual(failed["status"], "failed")
            self.assertEqual(failed["container_id"], "failed-container-42")
            self.assertIn("Media could not be fetched", failed["error"])
            self.assertNotIn("secret-token", json.dumps(failed))

    def test_trial_reel_publish_persists_meta_result_without_calling_real_api(self):
        class FakeService:
            def publish_reel(self, media_url, caption, graduation_strategy):
                self.args = (media_url, caption, graduation_strategy)
                return {"id": "reel-published-1", "container_id": "reel-container-1"}

        config = AppConfig(
            access_token="secret-token",
            instagram_user_id="123",
            instagram_username="alesantorooficial",
            graph_api_base_url="https://graph.instagram.com",
            graph_api_version="v26.0",
            public_base_url="https://public.example",
        )
        with tempfile.TemporaryDirectory() as temp_dir:
            fake_service = FakeService()
            application = StoryApplication(
                config,
                store=StoryStore(Path(temp_dir) / "schedules.json"),
                service=fake_service,
                media_probe=lambda url, size: None,
                video_converter=lambda path: None,
            )
            application.uploads_path = Path(temp_dir) / "uploads"
            application.uploads_path.mkdir()
            result = application.create_reel(
                {
                    "action": "publish_now",
                    "caption": "Reel de teste",
                    "graduation_strategy": "MANUAL",
                },
                {"filename": "reel.mp4", "content_type": "video/mp4", "content": b"mp4"},
            )

            self.assertEqual(result["status"], "published")
            self.assertEqual(result["instagram_media_id"], "reel-published-1")
            self.assertEqual(fake_service.args[1:], ("Reel de teste", "MANUAL"))

    def test_trial_reel_request_defaults_to_manual_strategy(self):
        action, strategy = validate_reel_request({"action": "publish_now"}, None)

        self.assertEqual(action, "publish_now")
        self.assertEqual(strategy, "MANUAL")

    def test_health_payload_contains_safe_configuration_only(self):
        payload = build_health_payload(
            access_token="secret-token",
            instagram_user_id="123",
            instagram_username="alesantorooficial",
            public_base_url="",
        )

        serialized = json.dumps(payload)
        self.assertNotIn("secret-token", serialized)
        self.assertNotIn("access_token", payload)
        self.assertTrue(payload["meta_configured"])
        self.assertFalse(payload["public_media_configured"])

    def test_story_route_requires_media(self):
        with self.assertRaisesRegex(ValueError, "media_required"):
            validate_story_request({"action": "publish_now"}, None)

    def test_story_publish_requires_public_media_configuration(self):
        config = AppConfig(
            access_token="secret-token",
            instagram_user_id="123",
            instagram_username="alesantorooficial",
            graph_api_base_url="https://graph.instagram.com",
            graph_api_version="v25.0",
            public_base_url="",
        )
        with tempfile.TemporaryDirectory() as temp_dir:
            application = StoryApplication(config, store=StoryStore(Path(temp_dir) / "schedules.json"), service=object(), media_probe=lambda url, size: None)
            application.uploads_path = Path(temp_dir) / "uploads"
            application.uploads_path.mkdir()
            with self.assertRaisesRegex(ValueError, "public_media_not_configured"):
                application.create_story(
                    {"action": "publish_now", "caption": "Story de teste"},
                    {"filename": "story.jpg", "content_type": "image/jpeg", "content": b"jpeg"},
                )

    def test_story_publish_persists_meta_result_without_calling_real_api(self):
        class FakeService:
            def publish_story(self, media_url, media_kind):
                self.media_url = media_url
                self.media_kind = media_kind
                return {"id": "published-1", "container_id": "container-1"}

        config = AppConfig(
            access_token="secret-token",
            instagram_user_id="123",
            instagram_username="alesantorooficial",
            graph_api_base_url="https://graph.instagram.com",
            graph_api_version="v25.0",
            public_base_url="https://public.example",
        )
        with tempfile.TemporaryDirectory() as temp_dir:
            fake_service = FakeService()
            application = StoryApplication(
                config,
                store=StoryStore(Path(temp_dir) / "schedules.json"),
                service=fake_service,
                media_probe=lambda url, size: None,
            )
            application.uploads_path = Path(temp_dir) / "uploads"
            application.uploads_path.mkdir()
            result = application.create_story(
                {"action": "publish_now", "caption": "Story de teste"},
                {"filename": "story.jpg", "content_type": "image/jpeg", "content": b"jpeg"},
            )

            self.assertEqual(result["status"], "published")
            self.assertEqual(result["instagram_media_id"], "published-1")
            self.assertEqual(fake_service.media_url, f"https://public.example/media/{result['media_filename']}")
            self.assertEqual(fake_service.media_kind, "image")

    def test_story_schedule_persists_and_does_not_publish_before_due_time(self):
        class FakeService:
            def publish_story(self, media_url, media_kind):
                raise AssertionError("scheduled Story was published too early")

        config = AppConfig(
            access_token="secret-token",
            instagram_user_id="123",
            instagram_username="alesantorooficial",
            graph_api_base_url="https://graph.instagram.com",
            graph_api_version="v25.0",
            public_base_url="https://public.example",
        )
        future = (datetime.now(timezone.utc) + timedelta(minutes=10)).isoformat()
        with tempfile.TemporaryDirectory() as temp_dir:
            application = StoryApplication(
                config,
                store=StoryStore(Path(temp_dir) / "schedules.json"),
                service=FakeService(),
                media_probe=lambda url, size: None,
            )
            application.uploads_path = Path(temp_dir) / "uploads"
            application.uploads_path.mkdir()
            result = application.create_story(
                {"action": "schedule", "scheduled_at": future, "caption": "Story agendado"},
                {"filename": "story.jpg", "content_type": "image/jpeg", "content": b"jpeg"},
            )

            self.assertEqual(result["status"], "scheduled")
            self.assertEqual(application.run_due_schedules(), 0)
            self.assertEqual(application.store.list_schedules()[0]["status"], "scheduled")

    def test_due_story_is_published_by_worker(self):
        class FakeService:
            def publish_story(self, media_url, media_kind):
                return {"id": "published-2", "container_id": "container-2"}

        config = AppConfig(
            access_token="secret-token",
            instagram_user_id="123",
            instagram_username="alesantorooficial",
            graph_api_base_url="https://graph.instagram.com",
            graph_api_version="v25.0",
            public_base_url="https://public.example",
        )
        with tempfile.TemporaryDirectory() as temp_dir:
            application = StoryApplication(
                config,
                store=StoryStore(Path(temp_dir) / "schedules.json"),
                service=FakeService(),
                media_probe=lambda url, size: None,
            )
            application.uploads_path = Path(temp_dir) / "uploads"
            application.uploads_path.mkdir()
            result = application.create_story(
                {
                    "action": "schedule",
                    "scheduled_at": (datetime.now(timezone.utc) + timedelta(minutes=10)).isoformat(),
                },
                {"filename": "story.jpg", "content_type": "image/jpeg", "content": b"jpeg"},
            )
            application.store.update_schedule(
                result["id"],
                {"scheduled_at": (datetime.now(timezone.utc) - timedelta(minutes=1)).isoformat()},
            )

            self.assertEqual(application.run_due_schedules(), 1)
            self.assertEqual(application.store.list_schedules()[0]["status"], "published")

    def test_png_story_is_converted_to_jpeg_for_public_media(self):
        class FakeService:
            def publish_story(self, media_url, media_kind):
                return {"id": "published-png", "container_id": "container-png"}

        config = AppConfig(
            access_token="secret-token",
            instagram_user_id="123",
            instagram_username="alesantorooficial",
            graph_api_base_url="https://graph.instagram.com",
            graph_api_version="v25.0",
            public_base_url="https://public.example",
        )
        with tempfile.TemporaryDirectory() as temp_dir:
            application = StoryApplication(
                config,
                store=StoryStore(Path(temp_dir) / "schedules.json"),
                service=FakeService(),
                media_probe=lambda url, size: None,
            )
            application.uploads_path = Path(temp_dir) / "uploads"
            application.uploads_path.mkdir()
            result = application.create_story(
                {"action": "publish_now"},
                {
                    "filename": "story.png",
                    "content_type": "image/png",
                    "content": (
                        b"\x89PNG\r\n\x1a\n\x00\x00\x00\rIHDR"
                        b"\x00\x00\x00\x01\x00\x00\x00\x01\x08\x02\x00\x00\x00"
                        b"\x90wS\xde\x00\x00\x00\x0cIDAT\x08\xd7c\xf8\xcf\xc0\xf0\x1f\x00\x05\x00\x01\xff\x89\x99=\x1d\x00\x00\x00\x00IEND\xaeB\x82"
                    ),
                },
            )

            output_path = application.uploads_path / result["media_filename"]
            self.assertTrue(result["media_filename"].endswith(".jpg"))
            self.assertEqual(output_path.read_bytes()[:2], b"\xff\xd8")


if __name__ == "__main__":
    unittest.main()

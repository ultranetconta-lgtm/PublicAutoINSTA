import json
import tempfile
import unittest
from pathlib import Path

from backend.storage import StoryStore, build_public_media_url


class StoryStorageTests(unittest.TestCase):
    def test_store_round_trips_schedule_without_credentials(self):
        with tempfile.TemporaryDirectory() as temp_dir:
            path = Path(temp_dir) / "schedules.json"
            store = StoryStore(path)
            created = store.create_schedule({
                "media_filename": "story.jpg",
                "media_kind": "image",
                "scheduled_at": "2026-09-22T12:00:00-03:00",
            })

            self.assertEqual(created["status"], "scheduled")
            self.assertEqual(store.list_schedules()[0]["media_filename"], "story.jpg")
            self.assertNotIn("access_token", json.loads(path.read_text())[0])
            self.assertNotIn("token", path.read_text().lower())

    def test_public_media_url_requires_nonempty_base_url(self):
        with self.assertRaisesRegex(ValueError, "PUBLIC_BASE_URL"):
            build_public_media_url("", "story.jpg")

    def test_public_media_url_quotes_filename(self):
        self.assertEqual(
            build_public_media_url("https://public.example", "a story.jpg"),
            "https://public.example/media/a%20story.jpg",
        )


if __name__ == "__main__":
    unittest.main()

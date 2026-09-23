import shutil
import subprocess
import tempfile
import threading
import unittest
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

from backend.server import normalize_reel_video, verify_public_media


class ReelVideoTests(unittest.TestCase):
    def test_public_media_probe_checks_status_type_and_size(self):
        class MediaHandler(BaseHTTPRequestHandler):
            def do_HEAD(self):
                self.send_response(200)
                self.send_header("Content-Type", "video/mp4")
                self.send_header("Content-Length", "1234")
                self.end_headers()

            def log_message(self, *args):
                pass

        server = ThreadingHTTPServer(("127.0.0.1", 0), MediaHandler)
        thread = threading.Thread(target=server.serve_forever, daemon=True)
        thread.start()
        try:
            url = f"http://127.0.0.1:{server.server_port}/media/reel.mp4"
            verify_public_media(url, 1234)
            with self.assertRaisesRegex(ValueError, "tamanho do arquivo diferente"):
                verify_public_media(url, 1235)
        finally:
            server.shutdown()
            server.server_close()
            thread.join(timeout=2)

    @unittest.skipUnless(shutil.which("ffmpeg"), "FFmpeg is required for Reel upload")
    def test_normalizes_mov_container_with_faststart_and_no_edit_list(self):
        with tempfile.TemporaryDirectory() as temp_dir:
            source = Path(temp_dir) / "reel.mp4"
            subprocess.run([
                shutil.which("ffmpeg"), "-hide_banner", "-loglevel", "error", "-y",
                "-f", "lavfi", "-i", "color=c=black:s=160x288:r=30:d=1",
                "-f", "lavfi", "-i", "sine=frequency=440:duration=1",
                "-map", "0:v:0", "-map", "1:a:0", "-c:v", "libx264", "-c:a", "aac",
                "-use_editlist", "1", "-movflags", "-faststart", "-f", "mov", str(source),
            ], check=True, timeout=30)

            original = source.read_bytes()
            self.assertEqual(original[8:12], b"qt  ")
            self.assertIn(b"edts", original)

            normalize_reel_video(source)

            normalized = source.read_bytes()
            self.assertNotEqual(normalized[8:12], b"qt  ")
            self.assertLess(normalized.find(b"moov"), normalized.find(b"mdat"))
            self.assertNotIn(b"edts", normalized)
            subprocess.run([
                shutil.which("ffmpeg"), "-hide_banner", "-loglevel", "error",
                "-i", str(source), "-f", "null", "-",
            ], check=True, timeout=30, capture_output=True)


if __name__ == "__main__":
    unittest.main()

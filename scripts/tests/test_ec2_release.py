import json
import os
from pathlib import Path
import shutil
import subprocess
import tempfile
import unittest

DEPLOY = Path(__file__).resolve().parents[2] / "deploy/ec2"

class EC2ReleaseTest(unittest.TestCase):
    def test_switching_releases_keeps_project_and_tls_storage(self):
        with tempfile.TemporaryDirectory() as tmp:
            base = Path(tmp)
            shared = base / "shared"
            shared.mkdir()
            config = shared / "production.env"
            names = ("DISCORD_MEDIA_KEY DISCORD_MEDIA_SECRET DISCORD_PRIVATE_ADMISSION_KEY DISCORD_CHANNELS "
                     "DISCORD_CLIENT_ID DISCORD_CLIENT_SECRET DISCORD_PRIVATE_ROOM_KEY DISCORD_PRIVATE_VOICE_KEY DISCORD_BOT_TOKEN").split()
            config.write_text("PUBLIC_IPV4=192.0.2.2\nBIND_IPV4=10.0.0.2\n" + "".join(k+"=unit-test\n" for k in names))
            config.chmod(0o600)
            for revision in ["a"*40, "b"*40]:
                release = base / "releases" / revision
                release.mkdir(parents=True)
                for name in ("compose", "compose.yaml"):
                    shutil.copy(DEPLOY / name, release / name)
                (release / "RELEASE").write_text(revision)
            for revision in ["a"*40, "b"*40, "a"*40]:
                current = base / "current"
                current.unlink(missing_ok=True)
                current.symlink_to(base / "releases" / revision)
                result = subprocess.run([current/"compose", "config", "--format", "json"], check=True, capture_output=True,
                                        env=dict(os.environ, WHITERUN_RELEASE="wrong", PUBLIC_IPV4="wrong", COMPOSE_PROJECT_NAME="unrelated"))
                model = json.loads(result.stdout)
                self.assertEqual(model["name"], "whiterun-live-prod")
                self.assertEqual(model["volumes"]["caddy-data"]["name"], "whiterun-live-prod_caddy-data")
                for service in model["services"].values():
                    self.assertTrue(service["image"].endswith(":"+revision))
                self.assertEqual(model["services"]["backend"]["environment"]["APP_ORIGIN"], "https://192.0.2.2:8443")
            config.chmod(0o644)
            self.assertNotEqual(subprocess.run([current/"compose","config","-q"], capture_output=True).returncode, 0)

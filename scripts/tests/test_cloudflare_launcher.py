import os
from pathlib import Path
import runpy
import tempfile
import unittest
from unittest.mock import patch

SCRIPT = Path(__file__).resolve().parents[1] / "cloudflare-sfu"


class ProtectedSettings(unittest.TestCase):
    def test_provider_values_only_reach_the_go_media_test(self):
        with tempfile.TemporaryDirectory() as tmp, patch.dict(os.environ, {}, clear=True):
            runner = runpy.run_path(str(SCRIPT))
            config = Path(tmp) / ".env"
            id_key, secret_key = runner["NAMES"]
            config.write_text(f"{id_key}=" + "a" * 32 + f"\n{secret_key}=" + "b" * 64 +
                              "\nDISCORD_BOT_TOKEN=unrelated-fixture\n")
            config.chmod(0o600)
            with patch("sys.argv", ["cloudflare-sfu", "test-hosted", "--env-file", str(config)]), \
                    patch("subprocess.run") as run:
                runner["main"]()
            build, test = run.call_args_list
            self.assertNotIn(secret_key, build.kwargs["env"])
            self.assertNotIn("DISCORD_BOT_TOKEN", test.kwargs["env"])
            self.assertEqual(test.kwargs["env"][secret_key], "b" * 64)
            self.assertNotIn("b" * 64, str(test.args))
            config.chmod(0o644)
            with self.assertRaisesRegex(SystemExit, "owner-only"):
                runner["credentials"](config)

    def test_offline_mode_never_loads_provider_file(self):
        runner = runpy.run_path(str(SCRIPT))
        with patch("sys.argv", ["cloudflare-sfu", "test-local", "--env-file", "/missing"]), \
                patch("subprocess.run") as run:
            runner["main"]()
        self.assertEqual(run.call_args_list[1].kwargs["env"]["WHITERUN_SFU_MEDIA_TEST"], "loopback")
        for call in run.call_args_list:
            for key in runner["NAMES"]:
                self.assertNotIn(key, call.kwargs["env"])

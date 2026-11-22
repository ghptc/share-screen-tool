import contextlib
import importlib.machinery
import importlib.util
import io
import json
import os
from pathlib import Path
import secrets
import subprocess
import tempfile
import unittest
from unittest.mock import patch

loader = importlib.machinery.SourceFileLoader("prepare", str(Path(__file__).resolve().parents[1] / "prepare-discord-private"))
spec = importlib.util.spec_from_loader(loader.name, loader)
prepare = importlib.util.module_from_spec(spec)
loader.exec_module(prepare)


class PrivateSetupTest(unittest.TestCase):
    def test_origin_report_only_discloses_the_expected_localhost_url(self):
        canary = "fixture-value-that-must-stay-private"
        localhost = "https://localhost:8443"
        custom = "https://tester:" + canary + "@example.invalid"
        services = {
            "backend": {"environment": {"APP_ORIGIN": localhost, "DISCORD_ADMISSION_KEY": canary}},
            "discord-bot": {"environment": {"APP_ORIGIN": custom, "DISCORD_BOT_TOKEN": canary}},
            "livekit": {"environment": {"DISCORD_ADMISSION_KEY": canary, "UNRELATED": canary}},
        }

        def docker(args, **kwargs):
            self.assertTrue(kwargs["capture_output"] and kwargs["check"])
            if "config" in args:
                value = json.dumps({"services": services})
            elif "ps" in args:
                value = "container-id" if args[-1] == "backend" else ""
            else:
                self.assertEqual(args[:3], ["docker", "inspect", "--format"])
                self.assertIn('"APP_ORIGIN"', args[3])
                value = "APP_ORIGIN=" + custom + "\n"
            return subprocess.CompletedProcess(args, 0, value, canary)

        output = io.StringIO()
        with patch.object(prepare.subprocess, "run", side_effect=docker), contextlib.redirect_stdout(output):
            prepare.show_origins()
        self.assertIn("backend configured APP_ORIGIN " + localhost, output.getvalue())
        self.assertIn("backend running APP_ORIGIN [custom value redacted] (differs from configuration)", output.getvalue())
        self.assertIn("discord-bot not running", output.getvalue())
        self.assertIn("livekit DISCORD_ADMISSION_KEY [set, redacted]", output.getvalue())
        self.assertNotIn(canary, output.getvalue())
        self.assertNotIn("UNRELATED", output.getvalue())

    def test_origin_report_suppresses_compose_error_output(self):
        with tempfile.TemporaryDirectory() as tmp:
            docker = Path(tmp, "docker")
            docker.write_text("#!/bin/sh\necho synthetic-parse-secret\necho synthetic-error-secret >&2\nexit 1\n")
            docker.chmod(0o700)
            result = subprocess.run([loader.path, "--show-origins"], capture_output=True, text=True,
                                    env={**os.environ, "PATH": tmp + os.pathsep + os.environ["PATH"]})
        self.assertNotEqual(result.returncode, 0)
        self.assertEqual(result.stdout, "")
        self.assertEqual(result.stderr.strip(), "Private setup check unavailable (CalledProcessError)")

    def test_ec2_advertises_public_ip_but_binds_to_assigned_eni(self):
        with patch.object(prepare.subprocess, "run") as interfaces:
            interfaces.return_value.stdout = b'[{"addr_info":[{"local":"10.0.1.8","scope":"global"}]}]'
            self.assertTrue(prepare.ec2_addresses("1.2.3.4", "10.0.1.8"))
            self.assertFalse(prepare.ec2_addresses("1.2.3.4", "10.0.1.9"))
            self.assertFalse(prepare.ec2_addresses("10.0.1.8", "1.2.3.4"))
            self.assertFalse(prepare.ec2_addresses("1.2.3.4", "0.0.0.0"))

    def test_preserves_operator_configuration_and_generated_keys(self):
        with tempfile.TemporaryDirectory() as tmp, patch.object(prepare, "ROOT", Path(tmp)):
            path = Path(tmp, ".env")
            original = "# operator configuration\nDISCORD_CLIENT_SECRET='value with spaces'\n"
            path.write_text(original)
            path.chmod(0o600)
            with patch.dict(prepare.os.environ, {"DISCORD_CLIENT_SECRET": "shell-override"}):
                initial = prepare.configuration()
                self.assertNotIn("DISCORD_CLIENT_SECRET", prepare.compose_env())
            content = path.read_bytes()
            self.assertTrue(content.startswith(original.encode()))
            self.assertEqual(initial["DISCORD_CLIENT_SECRET"], "value with spaces")
            self.assertEqual(len({initial[k] for k in prepare.PRIVATE}), len(prepare.PRIVATE))
            self.assertEqual(initial, prepare.configuration())
            self.assertEqual(content, path.read_bytes())
            path.chmod(0o644)
            with self.assertRaises(SystemExit):
                prepare.configuration()

    def test_reports_provider_results_without_credentials(self):
        conf = {k: "" for k in prepare.OPTIONAL}
        conf.update({k: secrets.token_hex(32) for k in prepare.PRIVATE + prepare.PROVIDER})
        guild, voice = "222222222222222222", "333333333333333333"
        conf.update(DISCORD_CLIENT_ID="111111111111111111", DISCORD_CHANNELS=guild + "/" + voice,
                    DISCORD_BOT_TOKEN="unit-test-bot.credential." + secrets.token_hex(16))
        access = secrets.token_hex(32)
        for wrong_channel, shared_secret in [(False, False), (True, False), (False, True)]:
            with self.subTest(wrong_channel=wrong_channel, shared_secret=shared_secret):
                issued, revoked = [], []
                def api(method, path, auth, form=None):
                    if path == "/applications/@me":
                        return 200, {"id": conf["DISCORD_CLIENT_ID"], "verify_key": conf["DISCORD_PUBLIC_KEY"],
                                     "redirect_uris": ["https://localhost:8443/api/discord/callback"]}
                    if path.startswith("/users/@me/guilds"):
                        return 200, [{"id": guild}]
                    if path == "/channels/" + voice:
                        return 200, {"type": 2, "guild_id": voice if wrong_channel else guild}
                    if path.endswith("/commands"):
                        return 200, [{"name": "live", "type": 1}]
                    if path == "/oauth2/token":
                        self.assertEqual((method, form), ("POST", {"grant_type": "client_credentials", "scope": "identify"}))
                        issued.append(True)
                        return 200, {"access_token": access}
                    if path == "/oauth2/token/revoke":
                        self.assertEqual(form["token"], access)
                        revoked.append(True)
                        return 204, None
                    self.fail("unexpected provider endpoint")

                output = io.StringIO()
                with patch.object(prepare, "configuration", return_value=conf), patch.object(prepare, "api", api), \
                     patch.object(prepare, "used_by_fixture", return_value=shared_secret), contextlib.redirect_stdout(output):
                    self.assertEqual(prepare.verify(), not wrong_channel and not shared_secret)
                self.assertEqual(bool(issued), not shared_secret)
                self.assertEqual(issued, revoked)
                for value in [access, guild, voice, *(conf[k] for k in prepare.PRIVATE + prepare.PROVIDER)]:
                    self.assertNotIn(value, output.getvalue())

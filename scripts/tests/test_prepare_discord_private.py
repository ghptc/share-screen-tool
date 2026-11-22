import contextlib
import importlib.machinery
import importlib.util
import io
from pathlib import Path
import secrets
import tempfile
import unittest
from unittest.mock import patch

loader = importlib.machinery.SourceFileLoader("prepare", str(Path(__file__).resolve().parents[1] / "prepare-discord-private"))
spec = importlib.util.spec_from_loader(loader.name, loader)
prepare = importlib.util.module_from_spec(spec)
loader.exec_module(prepare)


class PrivateSetupTest(unittest.TestCase):
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

package discord

import (
	"strings"
	"testing"
)

func TestPrivatePilotConfig(t *testing.T) {
	t.Setenv("DISCORD_MODE", "discord")
	t.Setenv("SCREEN_SHARE_ENV", "production")
	t.Setenv("SCREEN_SHARE_MEDIA_TRANSPORT", "cloudflare-private")
	t.Setenv("DISCORD_CLIENT_ID", "100000000000000001")
	t.Setenv("DISCORD_CHANNELS", "12/34")
	t.Setenv("DISCORD_VOICE_URL", "http://localhost:8091")
	for i, key := range []string{"DISCORD_ROOM_KEY", "DISCORD_VOICE_KEY", "CLOUDFLARE_SFU_APP_SECRET", "DISCORD_CLIENT_SECRET"} {
		t.Setenv(key, strings.Repeat(string(rune('a'+i)), 32))
	}
	for _, ids := range []string{"", "*", "100000000000000001,", "100000000000000001,anyone"} {
		t.Setenv("DISCORD_PILOT_USERS", ids)
		if _, err := Load("https://player.test", "", "", ""); err == nil {
			t.Fatal("invalid private tester list accepted")
		}
	}
	t.Setenv("DISCORD_PILOT_USERS", "100000000000000001")
	c, err := Load("https://player.test", "", "", "")
	if err != nil || c.Fixture || !c.PilotUsers["100000000000000001"] || c.AuthorizeURL != "https://discord.com/oauth2/authorize" {
		t.Fatal("real private pilot unavailable")
	}
}

func TestSimulatorCannotRunInProduction(t *testing.T) {
	t.Setenv("DISCORD_MODE", "simulator")
	t.Setenv("SCREEN_SHARE_ENV", "production")
	if _, err := Load("http://localhost:5173", "devkey", "secret", ""); err == nil {
		t.Fatal("production simulator accepted")
	}
	t.Setenv("SCREEN_SHARE_ENV", "development")
	if _, err := Load("https://live.example", "devkey", "secret", ""); err == nil {
		t.Fatal("non-loopback simulator accepted")
	}
	t.Setenv("DISCORD_MODE", "discord")
	if _, err := Load("https://live.example", "devkey", "secret", ""); err == nil {
		t.Fatal("public profile accepted dev credentials")
	}
}

func TestDiscordOAuthSecretCannotSignMedia(t *testing.T) {
	t.Setenv("DISCORD_MODE", "discord")
	t.Setenv("SCREEN_SHARE_ENV", "production")
	t.Setenv("DISCORD_CLIENT_ID", "1234")
	t.Setenv("DISCORD_CHANNELS", "12/34")
	t.Setenv("DISCORD_VOICE_URL", "http://localhost:8091")
	for i, key := range []string{"DISCORD_ROOM_KEY", "DISCORD_VOICE_KEY", "DISCORD_ADMISSION_KEY", "DISCORD_CLIENT_SECRET"} {
		t.Setenv(key, strings.Repeat(string(rune('a'+i)), 32))
	}
	const origin = "https://private.test"
	if _, err := Load(origin, "livekit-private", strings.Repeat("d", 32), ""); err == nil {
		t.Fatal("reused OAuth signing secret accepted")
	}
	if _, err := Load(origin, "livekit-private", strings.Repeat("e", 32), ""); err != nil {
		t.Fatal(err)
	}
	for _, env := range []string{"", "development", "prodution"} {
		t.Setenv("SCREEN_SHARE_ENV", env)
		if _, err := Load(origin, "livekit-private", strings.Repeat("e", 32), ""); err == nil || PrivateProfile() {
			t.Fatal("real provider accepted outside its explicit profile")
		}
	}
	t.Setenv("DISCORD_MODE", "")
	if _, err := Load(origin, "livekit-private", strings.Repeat("e", 32), ""); err == nil {
		t.Fatal("unknown environment selected local mode")
	}
}

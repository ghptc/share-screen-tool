package config

import (
	"os"
	"testing"
)

func TestLoad(t *testing.T) {
	t.Setenv("LOCAL_ADMIN_KEY", "test-operator-key-at-least-32-characters")
	t.Setenv("BACKEND_ADDR", "")
	t.Setenv("LIVEKIT_HTTP_URL", "")
	c, err := Load()
	if err != nil || c.Addr != "127.0.0.1:8080" || c.LiveKitURL != "http://127.0.0.1:7880" {
		t.Fatalf("unexpected defaults: %+v, %v", c, err)
	}
	t.Setenv("BACKEND_ADDR", "127.0.0.1:9000")
	t.Setenv("LIVEKIT_HTTP_URL", "http://livekit:7880")
	c, err = Load()
	if err != nil || c.Addr != "127.0.0.1:9000" || c.LiveKitURL != "http://livekit:7880" {
		t.Fatalf("unexpected overrides: %+v, %v", c, err)
	}
}

func TestInvalidConfig(t *testing.T) {
	for _, v := range []string{"ws://localhost:7880", "http://", "http://user:secret@localhost:7880", "http://localhost:7880/path", "http://localhost:7880?secret=x"} {
		t.Run(v, func(t *testing.T) {
			t.Setenv("BACKEND_ADDR", "127.0.0.1:8080")
			t.Setenv("LIVEKIT_HTTP_URL", v)
			if _, err := Load(); err == nil {
				t.Fatal("expected invalid URL to fail")
			}
		})
	}
	t.Setenv("BACKEND_ADDR", "invalid")
	if _, err := Load(); err == nil {
		t.Fatal("expected invalid address to fail")
	}
}

func TestRoomConfig(t *testing.T) {
	t.Setenv("BACKEND_ADDR", "")
	t.Setenv("LIVEKIT_HTTP_URL", "")
	t.Setenv("LOCAL_ADMIN_KEY", "")
	if _, err := Load(); err == nil {
		t.Fatal("missing operator key accepted")
	}
	t.Setenv("LOCAL_ADMIN_KEY", "test-operator-key-at-least-32-characters")
	for _, key := range []string{"LIVEKIT_WS_URL", "APP_ORIGIN"} {
		t.Run(key, func(t *testing.T) {
			t.Setenv(key, "https://user:secret@localhost/path")
			if _, err := Load(); err == nil {
				t.Fatal("invalid origin accepted")
			}
		})
	}
}

func TestPlayerOnlyOnConfiguredWorkstation(t *testing.T) {
	const admin = "a-local-operator-key-of-at-least-32-characters"
	const player = "another-local-player-key-of-at-least-32-characters"
	t.Setenv("LOCAL_ADMIN_KEY", admin)
	for _, tc := range []struct {
		key, origin string
		allowed     bool
	}{
		{"", "https://rooms.example", true}, {player, "http://localhost:5173", true},
		{admin, "http://localhost:5173", false}, {"short", "http://localhost:5173", false},
		{player, "https://rooms.example", false}, {player, "http://localhost.example", false},
	} {
		t.Setenv("LOCAL_PLAYER_KEY", tc.key)
		t.Setenv("APP_ORIGIN", tc.origin)
		_, err := Load()
		if (err == nil) != tc.allowed {
			t.Errorf("unexpected player activation at %s", tc.origin)
		}
	}
}

func TestRealDiscordRequiresSecureMediaAndHasNoLocalOperator(t *testing.T) {
	t.Setenv("LOCAL_ADMIN_KEY", "")
	t.Setenv("DISCORD_MODE", "discord")
	t.Setenv("LIVEKIT_WS_URL", "ws://media.test")
	if _, err := Load(); err == nil {
		t.Fatal("insecure native media URL accepted")
	}
	t.Setenv("LIVEKIT_WS_URL", "wss://media.test")
	if _, err := Load(); err != nil {
		t.Fatal(err)
	}
}

func TestServiceEnvironmentAliases(t *testing.T) {
	for _, suffix := range []string{"ENV", "MEDIA_TRANSPORT", "SFU_STATE_DIR"} {
		t.Run(suffix, func(t *testing.T) {
			old, current := "WHITERUN_"+suffix, "SCREEN_SHARE_"+suffix
			t.Setenv(old, "existing-value")
			t.Setenv(current, "")
			if err := os.Unsetenv(current); err != nil {
				t.Fatal(err)
			}
			if err := ApplyLegacyEnvironment(suffix); err != nil || os.Getenv(current) != "existing-value" {
				t.Fatal("legacy setting not inherited")
			}
			if err := ApplyLegacyEnvironment(suffix); err != nil {
				t.Fatal("matching aliases rejected")
			}
			for _, value := range []string{"", "different"} {
				t.Setenv(current, value)
				if err := ApplyLegacyEnvironment(suffix); err == nil {
					t.Fatal("ambiguous settings accepted")
				}
			}
			if err := os.Unsetenv(old); err != nil {
				t.Fatal(err)
			}
			if err := ApplyLegacyEnvironment(suffix); err != nil || os.Getenv(current) != "different" {
				t.Fatal("canonical setting not retained")
			}
		})
	}
}

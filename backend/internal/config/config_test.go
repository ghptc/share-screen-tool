package config

import "testing"

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

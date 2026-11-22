package discord

import "testing"

func TestSimulatorCannotRunInProduction(t *testing.T) {
	t.Setenv("DISCORD_MODE", "simulator")
	t.Setenv("WHITERUN_ENV", "production")
	if _, err := Load("http://localhost:5173", "devkey", "secret", ""); err == nil {
		t.Fatal("production simulator accepted")
	}
	t.Setenv("WHITERUN_ENV", "development")
	if _, err := Load("https://live.example", "devkey", "secret", ""); err == nil {
		t.Fatal("non-loopback simulator accepted")
	}
	t.Setenv("DISCORD_MODE", "discord")
	if _, err := Load("https://live.example", "devkey", "secret", ""); err == nil {
		t.Fatal("public profile accepted dev credentials")
	}
}

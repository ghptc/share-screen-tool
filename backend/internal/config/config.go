package config

import (
	"fmt"
	"net"
	"net/url"
	"os"
	"strings"
)

type Config struct {
	Addr           string
	LiveKitURL     string
	APIKey         string
	APISecret      string
	AdminKey       string
	LocalPlayerKey string
	WSURL          string
	AppOrigin      string
}

func Load() (Config, error) {
	c := Config{Addr: value("BACKEND_ADDR", "127.0.0.1:8080"), LiveKitURL: value("LIVEKIT_HTTP_URL", "http://127.0.0.1:7880")}
	if _, _, err := net.SplitHostPort(c.Addr); err != nil {
		return Config{}, fmt.Errorf("BACKEND_ADDR: %w", err)
	}
	u, err := url.Parse(c.LiveKitURL)
	if err != nil || u.Hostname() == "" || (u.Scheme != "http" && u.Scheme != "https") || u.User != nil || u.RawQuery != "" || u.Fragment != "" || (u.Path != "" && u.Path != "/") {
		return Config{}, fmt.Errorf("LIVEKIT_HTTP_URL must be an HTTP(S) origin without credentials, query, or path")
	}
	c.APIKey = value("LIVEKIT_API_KEY", "devkey")
	c.APISecret = value("LIVEKIT_API_SECRET", "secret")
	c.AdminKey = os.Getenv("LOCAL_ADMIN_KEY")
	c.WSURL = value("LIVEKIT_WS_URL", "ws://127.0.0.1:7880")
	c.AppOrigin = value("APP_ORIGIN", "http://localhost:5173")
	if os.Getenv("DISCORD_MODE") != "discord" && (len(c.AdminKey) < 32 || strings.TrimSpace(c.AdminKey) != c.AdminKey) {
		return Config{}, fmt.Errorf("LOCAL_ADMIN_KEY must contain at least 32 characters with no surrounding whitespace")
	}
	for _, v := range []struct {
		name, value string
		websocket   bool
	}{{"LIVEKIT_WS_URL", c.WSURL, true}, {"APP_ORIGIN", c.AppOrigin, false}} {
		u, err := url.Parse(v.value)
		schemeOK := err == nil && ((v.websocket && (u.Scheme == "ws" || u.Scheme == "wss")) || (!v.websocket && (u.Scheme == "http" || u.Scheme == "https")))
		if !schemeOK || u.Hostname() == "" || u.User != nil || u.Path != "" || u.RawQuery != "" || u.Fragment != "" {
			return Config{}, fmt.Errorf("%s must be a valid origin", v.name)
		}
	}
	if os.Getenv("WHITERUN_MEDIA_TRANSPORT") == "cloudflare-private" {
		c.APIKey, c.APISecret = "", ""
	} else if os.Getenv("DISCORD_MODE") == "discord" && !strings.HasPrefix(c.WSURL, "wss://") {
		return Config{}, fmt.Errorf("Discord native media requires a TLS-protected LIVEKIT_WS_URL")
	}
	c.LocalPlayerKey = os.Getenv("LOCAL_PLAYER_KEY")
	if c.LocalPlayerKey != "" {
		origin, _ := url.Parse(c.AppOrigin)
		if len(c.LocalPlayerKey) < 32 || strings.TrimSpace(c.LocalPlayerKey) != c.LocalPlayerKey || c.LocalPlayerKey == c.AdminKey || origin.Scheme != "http" || origin.Hostname() != "localhost" {
			return Config{}, fmt.Errorf("local player requires a separate 32-character key and an http://localhost origin")
		}
	}
	return c, nil
}

func value(key, fallback string) string {
	if v := os.Getenv(key); v != "" {
		return v
	}
	return fallback
}

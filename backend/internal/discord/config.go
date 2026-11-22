package discord

import (
	"errors"
	"net/url"
	"os"
	"strings"
)

type Config struct {
	OAuthConfig
	Dir                              *Directory
	VoiceURL, VoiceKey, AdmissionKey string
	Fixture                          bool
	Blocked                          map[string]bool
	PilotUsers                       map[string]bool
}

// The simulator is restricted to an explicitly selected workstation profile.
// Production provider origins cannot be overridden through the environment.
func Load(origin, lkKey, lkSecret, playerKey string) (*Config, error) {
	mode := os.Getenv("DISCORD_MODE")
	env := os.Getenv("WHITERUN_ENV")
	if mode == "" && (env == "" || env == "development") {
		return nil, nil
	}
	mock := mode == "simulator"
	u, err := url.Parse(origin)
	if err != nil || u.Hostname() == "" || u.RawQuery != "" || u.Fragment != "" || u.User != nil || u.Path != "" {
		return nil, errors.New("invalid Discord origin")
	}
	if (!mock && !PrivateProfile()) || (mock && (env != "development" || u.Scheme != "http" || u.Hostname() != "localhost")) {
		return nil, errors.New("invalid Discord mode for this deployment")
	}
	pilot := os.Getenv("WHITERUN_MEDIA_TRANSPORT") == "cloudflare-private"
	if !mock && (u.Scheme != "https" || playerKey != "" || (!pilot && (lkKey == "devkey" || len(lkSecret) < 32))) {
		return nil, errors.New("Discord requires HTTPS, private LiveKit keys and the workstation gateway disabled")
	}
	dir, err := NewDirectory(os.Getenv("DISCORD_ROOM_KEY"), os.Getenv("DISCORD_CHANNELS"))
	if err != nil {
		return nil, err
	}
	c := &Config{Dir: dir, Fixture: mock, Blocked: map[string]bool{}, VoiceKey: os.Getenv("DISCORD_VOICE_KEY"), AdmissionKey: os.Getenv("DISCORD_ADMISSION_KEY"), VoiceURL: os.Getenv("DISCORD_VOICE_URL"),
		OAuthConfig: OAuthConfig{Origin: origin, ClientID: os.Getenv("DISCORD_CLIENT_ID"), Secret: os.Getenv("DISCORD_CLIENT_SECRET"), AuthorizeURL: "https://discord.com/oauth2/authorize", TokenURL: "https://discord.com/api/v10/oauth2/token", UserURL: "https://discord.com/api/v10/users/@me"}}
	for _, id := range strings.Split(os.Getenv("DISCORD_DENIED_USERS"), ",") {
		c.Blocked[strings.TrimSpace(id)] = true
	}
	if pilot {
		if mock || !PrivateProfile() {
			return nil, errors.New("private Cloudflare pilot requires real Discord")
		}
		c.PilotUsers = make(map[string]bool)
		for _, id := range strings.Split(os.Getenv("DISCORD_PILOT_USERS"), ",") {
			id = strings.TrimSpace(id)
			if len(id) < 17 || !snowflake.MatchString(id) {
				return nil, errors.New("DISCORD_PILOT_USERS requires explicit Discord user IDs")
			}
			c.PilotUsers[id] = true
		}
	}
	if mock {
		// Public authorization step goes through the localhost browser origin.
		c.AuthorizeURL = origin + "/api/fixture/authorize"
		c.TokenURL = c.VoiceURL + "/token"
		c.UserURL = c.VoiceURL + "/user"
	}
	if c.ClientID == "" || c.Secret == "" || c.VoiceURL == "" {
		return nil, errors.New("Discord provider configuration is incomplete")
	}
	v, err := url.Parse(c.VoiceURL)
	if err != nil || (v.Scheme != "https" && v.Scheme != "http") || v.Host == "" || v.User != nil || v.Path != "" || v.RawQuery != "" || v.Fragment != "" {
		return nil, errors.New("invalid private voice service URL")
	}
	mappingKey := os.Getenv("DISCORD_ROOM_KEY")
	keys := []string{c.Secret, c.VoiceKey, mappingKey}
	if pilot {
		keys = append(keys, os.Getenv("CLOUDFLARE_SFU_APP_SECRET"))
	} else {
		if len(c.AdmissionKey) < 32 {
			return nil, errors.New("DISCORD_ADMISSION_KEY requires at least 32 characters")
		}
		keys = append(keys, lkSecret, c.AdmissionKey)
	}
	if len(c.VoiceKey) < 32 || !IndependentCredentials(keys...) {
		return nil, errors.New("use independent credentials for OAuth, media, room mapping and voice queries")
	}
	return c, nil
}

func PrivateProfile() bool {
	return os.Getenv("WHITERUN_ENV") == "production" && os.Getenv("DISCORD_MODE") == "discord"
}

// IndependentCredentials protects against accidentally giving an unrelated
// service the same secret as a more privileged service.
func IndependentCredentials(values ...string) bool {
	seen := make(map[string]bool, len(values))
	for _, value := range values {
		if value == "" || seen[value] {
			return false
		}
		seen[value] = true
	}
	return true
}

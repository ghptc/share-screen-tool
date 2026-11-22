package main

import (
	"github.com/ghptc/whiterun-live/backend/internal/discord"
	"log"
	"net"
	"net/http"
	"net/url"
	"os"
	"time"
)

func main() {
	origin := os.Getenv("APP_ORIGIN")
	u, e := url.Parse(origin)
	dir, err := discord.NewDirectory(os.Getenv("DISCORD_ROOM_KEY"), os.Getenv("DISCORD_CHANNELS"))
	if os.Getenv("WHITERUN_ENV") != "development" || os.Getenv("DISCORD_MODE") != "simulator" || err != nil || e != nil || u.Scheme != "http" || u.Hostname() != "localhost" || u.User != nil || u.Path != "" || u.RawQuery != "" || u.Fragment != "" {
		log.Fatal("development simulator configuration required")
	}
	c := &discord.Config{Fixture: true, Dir: dir, VoiceKey: os.Getenv("DISCORD_VOICE_KEY"), OAuthConfig: discord.OAuthConfig{Origin: origin, ClientID: os.Getenv("DISCORD_CLIENT_ID"), Secret: os.Getenv("DISCORD_CLIENT_SECRET")}}
	key := os.Getenv("DISCORD_FIXTURE_KEY")
	if len(key) < 32 || !discord.IndependentCredentials(key, c.VoiceKey, c.Secret, os.Getenv("DISCORD_ROOM_KEY")) || len(c.VoiceKey) < 32 || len(c.Secret) < 32 {
		log.Fatal("independent fixture control key required")
	}
	state := discord.FixtureState{User: "1001", Guild: "2001", Channel: "3001", Online: true}
	addr := ":8091" // Container listener for the existing development Compose network.
	if local := os.Getenv("DISCORD_FIXTURE_ADDR"); local != "" {
		host, _, err := net.SplitHostPort(local)
		if err != nil || !net.ParseIP(host).IsLoopback() {
			log.Fatal("DISCORD_FIXTURE_ADDR must be a loopback listener")
		}
		addr = local
	}
	s := http.Server{Addr: addr, Handler: discord.Simulator(c, key, state), ReadTimeout: 4 * time.Second, WriteTimeout: 5 * time.Second, ReadHeaderTimeout: 3 * time.Second}
	log.Fatal(s.ListenAndServe())
}

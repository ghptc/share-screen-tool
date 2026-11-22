// The bot has Discord Gateway and command privileges. It never signs media tokens.
package main

import (
	"context"
	"errors"
	"log"
	"net/http"
	"net/url"
	"os"
	"os/signal"
	"strings"
	"sync"
	"syscall"
	"time"

	dg "github.com/bwmarrin/discordgo"
	"github.com/ghptc/whiterun-live/backend/internal/discord"
)

func main() {
	if !discord.PrivateProfile() {
		log.Fatal("real Discord bot requires WHITERUN_ENV=production and DISCORD_MODE=discord")
	}
	dir, err := discord.NewDirectory(os.Getenv("DISCORD_ROOM_KEY"), os.Getenv("DISCORD_CHANNELS"))
	if err != nil {
		log.Fatal(err)
	}
	token, key, origin := os.Getenv("DISCORD_BOT_TOKEN"), os.Getenv("DISCORD_VOICE_KEY"), os.Getenv("APP_ORIGIN")
	u, err := url.Parse(origin)
	if len(key) < 32 || !discord.IndependentCredentials(token, key, os.Getenv("DISCORD_ROOM_KEY")) || err != nil || u.Host == "" || u.User != nil || u.Scheme != "https" || u.Path != "" || u.RawQuery != "" || u.Fragment != "" {
		log.Fatal("configure bot credential, private voice key and HTTPS player origin")
	}
	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()
	var current *discord.Gateway
	var mu sync.RWMutex
	var session *dg.Session
	lookup := func(guild, user string) (discord.Presence, bool) {
		mu.RLock()
		s, gateway := session, current
		mu.RUnlock()
		if s == nil {
			return discord.Presence{}, false
		}
		s.RLock()
		ack := s.LastHeartbeatAck
		s.RUnlock()
		return gateway.Lookup(guild, user, ack)
	}
	addr := os.Getenv("DISCORD_VOICE_ADDR")
	if addr == "" {
		addr = "127.0.0.1:8091"
	}
	server := http.Server{Addr: addr, Handler: discord.VoiceHandler(key, lookup), ReadTimeout: 4 * time.Second, WriteTimeout: 4 * time.Second, ReadHeaderTimeout: 3 * time.Second}
	go func() {
		if err := server.ListenAndServe(); err != nil && !errors.Is(err, http.ErrServerClosed) {
			log.Print("voice listener failed")
			stop()
		}
	}()
	defer server.Close()
	for ctx.Err() == nil {
		s, err := dg.New("Bot " + token)
		if err != nil {
			log.Fatal("invalid bot configuration")
		}
		s.Identify.Intents = dg.IntentsGuilds | dg.IntentsGuildVoiceStates
		// SDK diagnostics can include raw interaction payloads. Report failures
		// here without the provider's payload, request URL or credentials.
		s.LogLevel = -1
		gateway := new(discord.Gateway)
		s.SyncEvents = true
		s.ShouldReconnectOnError = false
		s.StateEnabled = false
		offline := make(chan struct{})
		var once sync.Once
		failed := func() { once.Do(func() { gateway.Offline(); close(offline) }) }
		s.AddHandler(func(_ *dg.Session, _ *dg.Disconnect) { failed() })
		s.AddHandler(func(s *dg.Session, e *dg.Event) {
			if !gateway.Observe(e) {
				failed()
				return
			}
			if cmd, ok := e.Struct.(*dg.InteractionCreate); ok {
				go func() {
					reply := liveCommand(cmd.Interaction, dir, origin, lookup)
					if reply == nil {
						return
					}
					if err := s.InteractionRespond(cmd.Interaction, reply); err != nil {
						log.Print("command response failed")
					}
				}()
			}
		})
		mu.Lock()
		session, current = s, gateway
		mu.Unlock()
		if err = s.Open(); err == nil {
			app, err := s.User("@me")
			if err == nil {
				for _, g := range dir.Guilds() {
					if _, e := s.ApplicationCommandCreate(app.ID, g, &dg.ApplicationCommand{Name: "live", Description: "Watch or share in your current voice channel"}); e != nil {
						log.Print("guild command registration failed")
					}
				}
			}
			select {
			case <-ctx.Done():
			case <-offline:
			}
		} else {
			log.Print("Discord Gateway connection failed")
		}
		gateway.Offline()
		mu.Lock()
		session = nil
		mu.Unlock()
		s.Close()
		select {
		case <-ctx.Done():
		case <-time.After(5 * time.Second):
		}
	}
}

func liveCommand(i *dg.Interaction, dir *discord.Directory, origin string, lookup func(string, string) (discord.Presence, bool)) *dg.InteractionResponse {
	if i == nil || i.Type != dg.InteractionApplicationCommand {
		return nil
	}
	command, ok := i.Data.(dg.ApplicationCommandInteractionData)
	if !ok || command.Name != "live" {
		return nil
	}
	var presence discord.Presence
	var present bool
	if i.GuildID != "" && i.Member != nil && i.Member.User != nil {
		presence, present = lookup(i.GuildID, i.Member.User.ID)
	}
	link := discord.LiveReply(dir, origin, i.GuildID, presence, present)
	data := &dg.InteractionResponseData{Content: link, AllowedMentions: &dg.MessageAllowedMentions{}}
	if !strings.HasPrefix(link, "Watch or share:") {
		data.Flags = dg.MessageFlagsEphemeral
	}
	return &dg.InteractionResponse{Type: dg.InteractionResponseChannelMessageWithSource, Data: data}
}

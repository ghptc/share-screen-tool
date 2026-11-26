package discord

import (
	"crypto/rand"
	"crypto/sha256"
	"crypto/subtle"
	"encoding/json"
	"net/http"
	"sync"
	"time"

	dg "github.com/bwmarrin/discordgo"
)

type Presence struct {
	Channel string
	Epoch   string
}
type guildState struct {
	channels map[string]bool
	users    map[string]Presence
}
type Gateway struct {
	mu        sync.Mutex
	seq       int64
	ready     bool
	replaying bool
	guilds    map[string]*guildState
}

// A resumable disconnect keeps the sequence cursor but fences every lookup
// until Discord finishes replaying the intervening dispatches.
func (g *Gateway) Suspend() { g.mu.Lock(); defer g.mu.Unlock(); g.replaying = true }
func (g *Gateway) Offline() { g.mu.Lock(); defer g.mu.Unlock(); g.ready = false; g.guilds = nil }
func (g *Gateway) Observe(e *dg.Event) bool {
	g.mu.Lock()
	defer g.mu.Unlock()
	if e.Type == "READY" {
		g.seq = e.Sequence
		g.ready = true
		g.replaying = false
		g.guilds = map[string]*guildState{}
		return true
	}
	if !g.ready || e.Sequence != g.seq+1 {
		g.ready = false
		g.guilds = nil
		return false
	}
	g.seq = e.Sequence
	if e.Type == "RESUMED" {
		g.replaying = false
	}
	// discordgo can dispatch a partially decoded event after a JSON error.
	// A malformed membership transition invalidates the complete snapshot.
	if e.RawData != nil {
		switch e.Type {
		case "GUILD_CREATE", "GUILD_DELETE", "CHANNEL_CREATE", "CHANNEL_UPDATE", "CHANNEL_DELETE", "VOICE_STATE_UPDATE":
			if e.Struct == nil || json.Unmarshal(e.RawData, e.Struct) != nil {
				g.ready = false
				g.guilds = nil
				return false
			}
		}
	}
	switch v := e.Struct.(type) {
	case *dg.GuildCreate:
		if v.Guild == nil || v.ID == "" {
			g.ready = false
			return false
		}
		delete(g.guilds, v.ID)
		if v.Unavailable || v.VoiceStates == nil || v.Channels == nil {
			return true
		}
		s := &guildState{map[string]bool{}, map[string]Presence{}}
		for _, ch := range v.Channels {
			if ch == nil || ch.ID == "" {
				return true
			}
			s.channels[ch.ID] = ch.Type == dg.ChannelTypeGuildVoice
		}
		for _, p := range v.VoiceStates {
			if p == nil || p.UserID == "" || (p.GuildID != "" && p.GuildID != v.ID) {
				return true
			}
			if _, duplicate := s.users[p.UserID]; duplicate {
				return true
			}
			s.users[p.UserID] = Presence{p.ChannelID, rand.Text()}
		}
		g.guilds[v.ID] = s
	case *dg.GuildDelete:
		if v.Guild == nil || v.ID == "" {
			g.ready = false
			return false
		}
		delete(g.guilds, v.ID)
	case *dg.ChannelCreate:
		if v.Channel == nil {
			g.ready = false
			return false
		}
		if s := g.guilds[v.GuildID]; s != nil {
			s.channels[v.ID] = v.Type == dg.ChannelTypeGuildVoice
		}
	case *dg.ChannelUpdate:
		if v.Channel == nil {
			g.ready = false
			return false
		}
		if s := g.guilds[v.GuildID]; s != nil {
			s.channels[v.ID] = v.Type == dg.ChannelTypeGuildVoice
		}
	case *dg.ChannelDelete:
		if v.Channel == nil {
			g.ready = false
			return false
		}
		if s := g.guilds[v.GuildID]; s != nil {
			delete(s.channels, v.ID)
		}
	case *dg.VoiceStateUpdate:
		if v.VoiceState == nil || v.UserID == "" || v.GuildID == "" {
			g.ready = false
			return false
		}
		if s := g.guilds[v.GuildID]; s != nil {
			if v.ChannelID == "" {
				delete(s.users, v.UserID)
			} else if s.users[v.UserID].Channel != v.ChannelID {
				s.users[v.UserID] = Presence{v.ChannelID, rand.Text()}
			}
		}
	}
	return true
}

// Lookup returns known=false until the Gateway can prove membership or absence.
// An empty presence with known=true is a confirmed absence.
func (g *Gateway) Lookup(guild, user string, lastAck time.Time) (Presence, bool) {
	g.mu.Lock()
	defer g.mu.Unlock()
	s := g.guilds[guild]
	if !g.ready || g.replaying || s == nil || time.Since(lastAck) > 65*time.Second {
		return Presence{}, false
	}
	p, ok := s.users[user]
	if !ok || !s.channels[p.Channel] {
		return Presence{}, true
	}
	return p, true
}
func AuthorizedService(key, supplied string) bool {
	a, b := sha256.Sum256([]byte("Bearer "+key)), sha256.Sum256([]byte(supplied))
	return len(key) >= 32 && subtle.ConstantTimeCompare(a[:], b[:]) == 1
}
func VoiceHandler(key string, lookup func(string, string) (Presence, bool)) http.Handler {
	mux := http.NewServeMux()
	mux.HandleFunc("POST /voice", func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Cache-Control", "no-store")
		if !AuthorizedService(key, r.Header.Get("Authorization")) {
			http.Error(w, "Forbidden", 403)
			return
		}
		var q struct{ Guild, User string }
		if json.NewDecoder(http.MaxBytesReader(w, r.Body, 1024)).Decode(&q) != nil {
			http.Error(w, "Invalid query", 400)
			return
		}
		p, known := lookup(q.Guild, q.User)
		if !known {
			http.Error(w, "Voice authority unavailable", 503)
			return
		}
		if p.Channel == "" {
			w.WriteHeader(http.StatusNoContent) // Confirmed absent in a synchronized snapshot.
			return
		}
		w.Header().Set("Content-Type", "application/json")
		json.NewEncoder(w).Encode(p)
	})
	return mux
}
func LiveReply(directory *Directory, origin, guild string, p Presence, present bool) string {
	if ref, ok := directory.Reference(Channel{guild, p.Channel}); ok && present {
		return "Watch or share: " + origin + "/r/" + ref
	}
	return "Connect to a supported voice channel to use /live."
}

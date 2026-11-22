package discord

import (
	dg "github.com/bwmarrin/discordgo"
	"strings"
	"testing"
	"time"
)

func TestVoiceCommandRequiresFreshChannel(t *testing.T) {
	var g Gateway
	g.Observe(&dg.Event{Type: "READY", Sequence: 1})
	g.Observe(&dg.Event{Sequence: 2, Struct: &dg.GuildCreate{Guild: &dg.Guild{ID: "11", Channels: []*dg.Channel{{ID: "22", Type: dg.ChannelTypeGuildVoice}}, VoiceStates: []*dg.VoiceState{{UserID: "33", ChannelID: "22"}}}}})
	dir, _ := NewDirectory(strings.Repeat("x", 32), "11/22")
	p, ok := g.Lookup("11", "33", time.Now())
	reply := LiveReply(dir, "https://example.test", "11", p, ok)
	if !ok || !strings.HasPrefix(reply, "Watch or share: https://example.test/r/") {
		t.Fatal("voice command failed")
	}
	if _, ok := g.Lookup("11", "33", time.Now().Add(-time.Minute*2)); ok {
		t.Fatal("stale Gateway accepted")
	}
	g.Observe(&dg.Event{Sequence: 3, Struct: &dg.VoiceStateUpdate{VoiceState: &dg.VoiceState{GuildID: "11", UserID: "33"}}})
	if _, ok := g.Lookup("11", "33", time.Now()); ok {
		t.Fatal("departure ignored")
	}
	if g.Observe(&dg.Event{Sequence: 5}) {
		t.Fatal("sequence gap accepted")
	}
	if strings.Contains(LiveReply(dir, "https://example.test", "11", p, false), "/r/") {
		t.Fatal("unauthorized discovery")
	}
}

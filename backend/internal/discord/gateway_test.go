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
	if p, known := g.Lookup("11", "33", time.Now()); !known || p.Channel != "" {
		t.Fatal("departure ignored")
	}
	if g.Observe(&dg.Event{Sequence: 5}) {
		t.Fatal("sequence gap accepted")
	}
	if strings.Contains(LiveReply(dir, "https://example.test", "11", p, false), "/r/") {
		t.Fatal("unauthorized discovery")
	}
}

func TestFailClosedOnOfflineGapAndUnavailable(t *testing.T) {
	var g Gateway
	snapshot := func(seq int64) {
		g.Observe(&dg.Event{Sequence: seq, Struct: &dg.GuildCreate{Guild: &dg.Guild{ID: "11", Channels: []*dg.Channel{{ID: "22", Type: dg.ChannelTypeGuildVoice}}, VoiceStates: []*dg.VoiceState{{UserID: "33", ChannelID: "22"}}}}})
	}
	g.Observe(&dg.Event{Type: "READY", Sequence: 1})
	snapshot(2)
	first, ok := g.Lookup("11", "33", time.Now())
	if !ok {
		t.Fatal("snapshot missing")
	}
	g.Offline()
	if _, ok := g.Lookup("11", "33", time.Now()); ok {
		t.Fatal("disconnected state accepted")
	}
	g.Observe(&dg.Event{Type: "READY", Sequence: 1})
	if _, ok := g.Lookup("11", "33", time.Now()); ok {
		t.Fatal("ready without guild snapshot accepted")
	}
	snapshot(2)
	second, ok := g.Lookup("11", "33", time.Now())
	if !ok || first.Epoch == second.Epoch {
		t.Fatal("resumed old channel admission")
	}
	g.Observe(&dg.Event{Sequence: 3, Struct: &dg.GuildDelete{Guild: &dg.Guild{ID: "11", Unavailable: true}}})
	if _, ok := g.Lookup("11", "33", time.Now()); ok {
		t.Fatal("unavailable guild accepted")
	}
}

func TestMalformedVoiceTransitionInvalidatesSnapshot(t *testing.T) {
	var g Gateway
	g.Observe(&dg.Event{Type: "READY", Sequence: 1})
	g.Observe(&dg.Event{Sequence: 2, Struct: &dg.GuildCreate{Guild: &dg.Guild{ID: "11", Channels: []*dg.Channel{{ID: "22", Type: dg.ChannelTypeGuildVoice}}, VoiceStates: []*dg.VoiceState{{UserID: "33", ChannelID: "22"}}}}})
	if g.Observe(&dg.Event{Type: "VOICE_STATE_UPDATE", Sequence: 3, RawData: []byte("null transition"), Struct: &dg.VoiceStateUpdate{}}) {
		t.Fatal("malformed transition accepted")
	}
	if _, ok := g.Lookup("11", "33", time.Now()); ok {
		t.Fatal("stale voice snapshot retained")
	}
}

func TestResumeRequiresCompleteReplayAndPreservesObservedDeparture(t *testing.T) {
	var g Gateway
	g.Observe(&dg.Event{Type: "READY", Sequence: 1})
	g.Observe(&dg.Event{Sequence: 2, Struct: &dg.GuildCreate{Guild: &dg.Guild{ID: "11", Channels: []*dg.Channel{{ID: "22", Type: dg.ChannelTypeGuildVoice}}, VoiceStates: []*dg.VoiceState{{UserID: "33", ChannelID: "22"}}}}})
	first, _ := g.Lookup("11", "33", time.Now())
	g.Suspend()
	if _, known := g.Lookup("11", "33", time.Now()); known {
		t.Fatal("stale snapshot available")
	}
	g.Observe(&dg.Event{Type: "RESUMED", Sequence: 3})
	if p, ok := g.Lookup("11", "33", time.Now()); !ok || p != first {
		t.Fatal("continuous membership lost")
	}
	g.Suspend()
	for i, ch := range []string{"", "22"} {
		if !g.Observe(&dg.Event{Sequence: int64(4 + i), Struct: &dg.VoiceStateUpdate{VoiceState: &dg.VoiceState{GuildID: "11", UserID: "33", ChannelID: ch}}}) {
			t.Fatal("replay failed")
		}
		if _, known := g.Lookup("11", "33", time.Now()); known {
			t.Fatal("partial replay visible")
		}
	}
	g.Observe(&dg.Event{Type: "RESUMED", Sequence: 6})
	if p, ok := g.Lookup("11", "33", time.Now()); !ok || p.Epoch == first.Epoch {
		t.Fatal("departure restored old admission")
	}
	g.Suspend()
	if g.Observe(&dg.Event{Type: "RESUMED", Sequence: 8}) {
		t.Fatal("accepted sequence gap")
	}
}

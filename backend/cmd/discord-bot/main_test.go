package main

import (
	"encoding/json"
	"strings"
	"testing"

	dg "github.com/bwmarrin/discordgo"
	"github.com/ghptc/whiterun-live/backend/internal/discord"
)

func TestLiveCommandUsesInvokersVoiceAndRejectsOutsideGuild(t *testing.T) {
	dir, err := discord.NewDirectory(strings.Repeat("r", 32), "11/22")
	if err != nil {
		t.Fatal(err)
	}
	// The text context differs from the voice channel. Only the authority can
	// resolve the invoking member to the correct room.
	var event dg.InteractionCreate
	if err := json.Unmarshal([]byte(`{"type":2,"guild_id":"11","channel_id":"77","member":{"user":{"id":"33"}},"data":{"type":1,"name":"live"}}`), &event); err != nil {
		t.Fatal(err)
	}
	present := true
	lookup := func(guild, user string) (discord.Presence, bool) {
		if guild != "11" || user != "33" {
			t.Fatal("queried incorrect membership")
		}
		return discord.Presence{Channel: "22", Epoch: "current"}, present
	}
	ref, _ := dir.Reference(discord.Channel{Guild: "11", Voice: "22"})
	reply := liveCommand(event.Interaction, dir, "https://player.test", lookup)
	if reply == nil || reply.Data.Content != "Watch or share: https://player.test/r/"+ref || reply.Data.Flags != 0 {
		t.Fatal("missing public room reference")
	}
	present = false
	for _, guild := range []string{"11", ""} {
		event.GuildID = guild
		reply := liveCommand(event.Interaction, dir, "https://player.test", lookup)
		if reply == nil || reply.Data.Flags != dg.MessageFlagsEphemeral || strings.Contains(reply.Data.Content, "/r/") {
			t.Fatal("channel information disclosed on denial")
		}
	}
	event.Data = dg.ApplicationCommandInteractionData{Name: "other"}
	if liveCommand(event.Interaction, dir, "https://player.test", lookup) != nil {
		t.Fatal("handled a different command")
	}
}

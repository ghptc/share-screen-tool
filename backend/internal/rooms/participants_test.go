package rooms

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/ghptc/whiterun-live/backend/internal/discord"
)

const rosterVideo = "v=0\r\no=- 1 1 IN IP4 127.0.0.1\r\ns=-\r\nt=0 0\r\nm=video 9 UDP/TLS/RTP/SAVPF 96\r\na=mid:0\r\na=sendonly\r\n"

func TestRoomParticipantVisibility(t *testing.T) {
	f := newCFFixture(t, "https://player.test", &fakeMedia{})
	now := time.Now()
	f.a.now = func() time.Time { return now }
	type member struct {
		cookie *http.Cookie
		peer   string
	}
	join := func(f *cfFixture, user, channel string) member {
		cookie := f.login(t, user)
		f.voice(t, user, channel)
		code, body := f.post(t, cookie, "tab", f.ref, "join", cfInput{})
		if code != 200 {
			t.Fatalf("join: %d", code)
		}
		return member{cookie, body["identity"].(string)}
	}
	alice := join(f, "100000000000000001", "22")
	bob := join(f, "100000000000000002", "22")
	bobTab := join(f, "100000000000000002", "22")
	viewer := join(f, "100000000000000003", "22")
	secondTab := join(f, "100000000000000003", "22")
	other := *f
	other.ref, _ = f.cfg.Dir.Reference(discord.Channel{Guild: "11", Voice: "23"})
	join(&other, "100000000000000004", "23")
	f.voice(t, "100000000000000005", "22") // In voice, without an authenticated room visit.

	post := func(m member, op string, input cfInput) map[string]any {
		t.Helper()
		code, body := f.post(t, m.cookie, m.peer, f.ref, op, input)
		if code != 200 {
			t.Fatalf("%s: %d", op, code)
		}
		return body
	}
	roster := func(count, sharing int) {
		t.Helper()
		body := post(viewer, "state", cfInput{})
		list := body["participants"].([]any)
		if len(list) != count {
			t.Fatalf("participants %d, want %d", len(list), count)
		}
		keys := make(map[string]bool)
		var screens int
		for _, item := range list {
			p := item.(map[string]any)
			key := p["key"].(string)
			if len(key) != 43 || keys[key] || p["name"] != "Fixture member" || len(p) != 3 {
				t.Fatalf("unexpected public participant fields: %v", p)
			}
			keys[key] = true
			if p["sharing"] == true {
				screens++
			}
		}
		data, _ := json.Marshal(list)
		for _, private := range []string{"10000000000000000", f.ref, alice.peer, viewer.cookie.Value} {
			if strings.Contains(string(data), private) {
				t.Fatal("private identifier in roster")
			}
		}
		if screens != sharing {
			t.Fatalf("sharing %d, want %d", screens, sharing)
		}
	}
	roster(3, 0)
	publish := func(m member) string {
		return post(m, "publish", cfInput{Mid: "0", SDP: rosterVideo})["handle"].(string)
	}
	first, second := publish(alice), publish(bob)
	roster(3, 0) // Reservations do not count.
	post(alice, "ready", cfInput{Handle: first})
	post(bob, "ready", cfInput{Handle: second})
	post(secondTab, "subscribe", cfInput{Publication: first})
	roster(3, 2)
	post(alice, "close", cfInput{Handle: first})
	roster(3, 1)
	f.voice(t, "100000000000000002", "23")
	if _, ok := f.a.validDiscord(t.Context(), "dc-"+f.ref, bob.peer); ok {
		t.Fatal("departed publisher admitted")
	}
	if code, _ := f.post(t, bobTab.cookie, bobTab.peer, f.ref, "state", cfInput{}); code != 401 {
		t.Fatal("another tab retained departed membership")
	}
	roster(2, 0)
	now = now.Add(presenceLifetime)
	// A fresh voice proof alone must not keep a disconnected tab on the strip.
	if _, ok := f.a.validDiscord(t.Context(), "dc-"+f.ref, alice.peer); !ok {
		t.Fatal("voice membership lost")
	}
	roster(1, 0)
	post(alice, "state", cfInput{})
	roster(2, 0)
}

func TestVoiceAuthorityInterruptionPreservesOnlyTheRoomAdmission(t *testing.T) {
	media := &fakeMedia{}
	f := newCFFixture(t, "https://player.test", media)
	cookie := f.login(t, "33")
	_, joined := f.post(t, cookie, "tab", f.ref, "join", cfInput{})
	peer := joined["identity"].(string)
	_, pub := f.post(t, cookie, peer, f.ref, "publish", cfInput{Mid: "0", SDP: rosterVideo})
	f.post(t, cookie, peer, f.ref, "ready", cfInput{Handle: pub["handle"].(string)})
	outage := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { w.WriteHeader(503) }))
	defer outage.Close()
	healthy := f.cfg.VoiceURL
	f.cfg.VoiceURL = outage.URL
	for _, op := range []string{"state", "publish"} {
		if code, _ := f.post(t, cookie, peer, f.ref, op, cfInput{}); code != 503 {
			t.Fatalf("unavailable %s: %d", op, code)
		}
	}
	f.a.sweepCloudflare(t.Context(), false)
	if media.closed != 1 {
		t.Fatal("suspended screen still active")
	}
	f.cfg.VoiceURL = healthy
	if code, again := f.post(t, cookie, "tab", f.ref, "join", cfInput{}); code != 200 || again["identity"] != peer || again["expiresAt"] != joined["expiresAt"] {
		t.Fatal("temporary outage consumed or renewed the room grant")
	}
	if code, body := f.post(t, cookie, peer, f.ref, "state", cfInput{}); code != 200 || len(body["owned"].([]any)) != 0 {
		t.Fatal("watch-only recovery failed")
	}
	// Even if both moves occurred between checks, the bot changed the epoch.
	f.voice(t, "33", "23")
	f.voice(t, "33", "22")
	if code, _ := f.post(t, cookie, "tab", f.ref, "join", cfInput{}); code != 403 {
		t.Fatal("re-entry restored a broken membership")
	}
	if code, _ := f.post(t, cookie, peer, f.ref, "state", cfInput{}); code != 401 {
		t.Fatal("old session survived confirmed departure")
	}
}

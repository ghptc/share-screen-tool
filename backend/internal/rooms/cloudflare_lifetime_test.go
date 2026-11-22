package rooms

import (
	"context"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"
	"time"
)

func TestFixedRoomLifetime(t *testing.T) {
	media := &fakeMedia{}
	f := newCFFixture(t, "https://player.test", media)
	now := time.Now().UTC().Truncate(time.Second)
	f.a.now = func() time.Time { return now }
	cookie := f.login(t, "33")
	now = now.Add(90 * time.Second) // Admission, rather than OAuth callback, starts the clock.
	start := now
	const clients = 8
	var wg sync.WaitGroup
	result := make(chan map[string]any, clients)
	for range clients {
		wg.Add(1)
		go func() {
			defer wg.Done()
			code, body := f.post(t, cookie, "tab", f.ref, "join", cfInput{})
			if code != 200 {
				t.Errorf("admission %d", code)
			}
			result <- body
		}()
	}
	wg.Wait()
	close(result)
	var peer string
	for body := range result {
		id, _ := body["identity"].(string)
		if id == "" || (peer != "" && id != peer) {
			t.Fatal("retry duplicated the participant")
		}
		peer = id
		exp, err := time.Parse(time.RFC3339Nano, body["expiresAt"].(string))
		if err != nil || exp.Sub(now) != 36000*time.Second {
			t.Fatal("incorrect deadline")
		}
	}
	viewer := f.login(t, "34")
	_, view := f.post(t, viewer, "watch", f.ref, "join", cfInput{})
	video := "v=0\r\no=- 1 1 IN IP4 127.0.0.1\r\ns=-\r\nt=0 0\r\nm=video 9 UDP/TLS/RTP/SAVPF 96\r\na=mid:0\r\na=sendonly\r\n"
	code, pub := f.post(t, cookie, peer, f.ref, "publish", cfInput{Mid: "0", SDP: video})
	if code != 200 {
		t.Fatal("screen rejected")
	}
	handle := pub["handle"].(string)
	f.post(t, cookie, peer, f.ref, "ready", cfInput{Handle: handle})
	if code, _ := f.post(t, viewer, view["identity"].(string), f.ref, "subscribe", cfInput{Publication: handle}); code != 200 {
		t.Fatal("subscription rejected")
	}
	now = start.Add(10*time.Hour - time.Nanosecond)
	code, again := f.post(t, cookie, "tab", f.ref, "join", cfInput{})
	if code != 200 || again["identity"] != peer || again["expiresAt"] != start.Add(10*time.Hour).Format(time.RFC3339Nano) {
		t.Fatal("late retry changed the grant")
	}
	now = now.Add(time.Nanosecond)
	for _, op := range []string{"state", "ready", "join"} {
		if code, _ := f.post(t, cookie, peer, f.ref, op, cfInput{Handle: handle}); code != 401 {
			t.Fatalf("expired %s returned %d", op, code)
		}
	}
	// The independent server monitor enforces even with no browser request.
	f.a.validDiscord(context.Background(), "dc-"+f.ref, peer)
	f.a.sweepCloudflare(t.Context(), false)
	if len(f.a.prototype.tracks) != 0 || media.closed != 2 {
		t.Fatal("provider tracks or slots held after expiry")
	}
	fresh := f.login(t, "33")
	f.voice(t, "33", "23")
	if code, _ := f.post(t, fresh, "tab", f.ref, "join", cfInput{}); code != http.StatusForbidden {
		t.Fatal("wrong channel admitted")
	}
	f.voice(t, "33", "22")
	code, b := f.post(t, fresh, "new-tab", f.ref, "join", cfInput{})
	if code != 200 || b["identity"] == peer || b["expiresAt"] != now.Add(10*time.Hour).Format(time.RFC3339Nano) {
		t.Fatal("fresh admission failed")
	}
	if code, _ := f.post(t, cookie, peer, f.ref, "state", cfInput{}); code != 401 {
		t.Fatal("fresh admission revived expired cookie")
	}
}

func TestPilotRequiresBothIdentityAndCurrentVoice(t *testing.T) {
	f := newCFFixture(t, "https://player.test", &fakeMedia{})
	f.cfg.PilotUsers = map[string]bool{"33": true}
	other := f.login(t, "34")
	if code, _ := f.post(t, other, "other", f.ref, "join", cfInput{}); code != 403 {
		t.Fatal("correct channel alone admitted non-tester")
	}
	tester := f.login(t, "33")
	code, joined := f.post(t, tester, "tab", f.ref, "join", cfInput{})
	if code != 200 {
		t.Fatal("tester in correct channel denied")
	}
	f.voice(t, "33", "23")
	if code, _ = f.post(t, tester, joined["identity"].(string), f.ref, "state", cfInput{}); code != 403 {
		t.Fatal("pilot retained authorization after leaving voice")
	}
}

func TestRoomStateWaitRevocation(t *testing.T) {
	f := newCFFixture(t, "https://player.test", &fakeMedia{})
	cookie := f.login(t, "33")
	_, entry := f.post(t, cookie, "entry", f.ref, "join", cfInput{})
	id := entry["identity"].(string)
	_, snapshot := f.post(t, cookie, id, f.ref, "state", cfInput{})
	input := cfInput{Version: snapshot["version"].(string), IdleWait: true}
	result := make(chan int, 1)
	go func() { code, _ := f.post(t, cookie, id, f.ref, "state", input); result <- code }()
	for until := time.Now().Add(time.Second); ; {
		g := f.a.prototype
		g.mu.Lock()
		waiting := g.waiting[id]
		g.mu.Unlock()
		if waiting {
			break
		}
		if time.Now().After(until) {
			t.Fatal("state request did not wait")
		}
		time.Sleep(time.Millisecond)
	}
	if code, _ := f.post(t, cookie, id, f.ref, "state", input); code != 409 {
		t.Fatal("second waiter admitted")
	}
	f.voice(t, "33", "23")
	if _, ok := f.a.validDiscord(t.Context(), "dc-"+f.ref, id); ok {
		t.Fatal("departure missed")
	}
	select {
	case code := <-result:
		if code != 403 {
			t.Fatalf("departed waiter returned %d", code)
		}
	case <-time.After(time.Second):
		t.Fatal("departure failed to wake waiter")
	}
	f.voice(t, "33", "22")
	if code, _ := f.post(t, cookie, id, f.ref, "state", cfInput{}); code != 401 {
		t.Fatal("return to channel restored revoked login")
	}
}

func TestQuietRoomStateRequestBudget(t *testing.T) {
	f := newCFFixture(t, "https://player.test", &fakeMedia{})
	cookie := f.login(t, "33")
	_, entry := f.post(t, cookie, "tab", f.ref, "join", cfInput{})
	id := entry["identity"].(string)
	_, snapshot := f.post(t, cookie, id, f.ref, "state", cfInput{})
	begin := time.Now()
	code, after := f.post(t, cookie, id, f.ref, "state", cfInput{Version: snapshot["version"].(string), IdleWait: true})
	elapsed := time.Since(begin)
	if code != 200 || after["version"] != snapshot["version"] || elapsed < idleStateWait {
		t.Fatal("idle room returned early")
	}
	_, same := f.post(t, cookie, "tab", f.ref, "join", cfInput{})
	if entry["expiresAt"] != same["expiresAt"] {
		t.Fatal("state requests renewed access")
	}
	t.Logf("one unchanged state reply after %s; expiration unchanged", elapsed.Round(time.Millisecond))
}

func TestFreshNavigationRequiresFreshOAuth(t *testing.T) {
	f := newCFFixture(t, "https://player.test", &fakeMedia{})
	now := time.Now().UTC()
	f.a.now = func() time.Time { return now }
	login := f.login(t, "33")
	join := func(entry string, cookies ...*http.Cookie) *httptest.ResponseRecorder {
		r := httptest.NewRequest("POST", "/discord/"+f.ref+"/join", strings.NewReader("{}"))
		r.Header.Set("Origin", f.cfg.Origin)
		r.Header.Set("Content-Type", "application/json")
		r.Header.Set("X-Whiterun-Entry", entry)
		for _, c := range cookies {
			r.AddCookie(c)
		}
		res := httptest.NewRecorder()
		f.api.ServeHTTP(res, r)
		return res
	}
	first := join("old-tab", login)
	if first.Code != 200 {
		t.Fatal("admission failed")
	}
	grant := first.Result().Cookies()[0]
	if !grant.HttpOnly || !grant.Secure || grant.MaxAge != 36000 || grant.SameSite != http.SameSiteStrictMode {
		t.Fatal("unsafe room credential")
	}
	now = now.Add(4 * time.Hour)
	if join("new-tab", grant, login).Code != 401 {
		t.Fatal("new visit reused the previous Discord login")
	}
	next := f.login(t, "33")
	newRoom := join("new-tab", next)
	if newRoom.Code != 200 || newRoom.Result().Cookies()[0].MaxAge != 36000 {
		t.Fatal("fresh re-entry failed")
	}
	old := join("old-tab", next, grant)
	if old.Code != 200 || old.Result().Cookies()[0].MaxAge != 6*3600 {
		t.Fatal("other tab changed original deadline")
	}
	now = now.Add(6 * time.Hour)
	if join("old-tab", grant).Code != 401 {
		t.Fatal("expired room cookie accepted")
	}
	if join("new-tab", newRoom.Result().Cookies()[0]).Code != 200 {
		t.Fatal("expired unrelated room session")
	}
}

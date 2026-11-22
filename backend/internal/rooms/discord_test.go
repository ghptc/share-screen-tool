package rooms

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"net/url"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"github.com/ghptc/whiterun-live/backend/internal/discord"
	"github.com/livekit/protocol/auth"
)

func TestDiscordScopedRoomExchange(t *testing.T) {
	dir, _ := discord.NewDirectory(strings.Repeat("m", 32), "11/22,11/23,12/22")
	voiceKey := strings.Repeat("v", 32)
	opt := discord.OAuthConfig{Origin: "https://player.test", ClientID: "fixture", Secret: "secret"}
	c := &discord.Config{Dir: dir, OAuthConfig: opt, VoiceKey: voiceKey, AdmissionKey: strings.Repeat("s", 32), Fixture: true}
	controller := strings.Repeat("f", 32)
	provider := httptest.NewServer(discord.Simulator(c, controller, discord.FixtureState{User: "33", Guild: "11", Channel: "22", Online: true}))
	defer provider.Close()
	c.VoiceURL = provider.URL
	c.AuthorizeURL = provider.URL + "/authorize"
	c.TokenURL = provider.URL + "/token"
	c.UserURL = provider.URL + "/user"
	var upstreamJWT string
	sfu := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		upstreamJWT = strings.TrimPrefix(r.Header.Get("Authorization"), "Bearer ")
		if r.Header.Get("Cookie") != "" || r.URL.Query().Has("access_token") {
			t.Error("leaked browser secret upstream")
		}
	}))
	defer sfu.Close()
	a := New(Config{APIKey: "test", APISecret: "server-only", AppOrigin: opt.Origin, HTTPURL: sfu.URL})
	mux := http.NewServeMux()
	a.RegisterDiscord(mux, c)
	ref, _ := dir.Reference(discord.Channel{Guild: "11", Voice: "22"})
	start := httptest.NewRecorder()
	mux.ServeHTTP(start, httptest.NewRequest("GET", "/discord/auth/"+ref, nil))
	client := http.Client{CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }}
	authRes, err := client.Get(start.Header().Get("Location"))
	if err != nil {
		t.Fatal(err)
	}
	authRes.Body.Close()
	callback, _ := url.Parse(authRes.Header.Get("Location"))
	req := httptest.NewRequest("GET", "/discord/callback?"+callback.RawQuery, nil)
	req.AddCookie(start.Result().Cookies()[0])
	end := httptest.NewRecorder()
	mux.ServeHTTP(end, req)
	if end.Code != 303 {
		t.Fatalf("OAuth %d", end.Code)
	}
	session := end.Result().Cookies()[1]
	post := func(path string, cookie *http.Cookie) *httptest.ResponseRecorder {
		r := httptest.NewRequest("POST", path, strings.NewReader("{}"))
		r.Header.Set("Origin", opt.Origin)
		r.Header.Set("Content-Type", "application/json")
		if cookie != nil {
			r.AddCookie(cookie)
		}
		w := httptest.NewRecorder()
		mux.ServeHTTP(w, r)
		return w
	}
	if post("/discord/"+ref+"/join", nil).Code != 401 {
		t.Fatal("copied link authorized")
	}
	for _, ch := range []discord.Channel{{Guild: "11", Voice: "23"}, {Guild: "12", Voice: "22"}} {
		other, _ := dir.Reference(ch)
		if post("/discord/"+other+"/join", session).Code != 403 {
			t.Fatal("wrong channel authorized")
		}
	}
	join := post("/discord/"+ref+"/join", session)
	if join.Code != 200 {
		t.Fatalf("join %d", join.Code)
	}
	var result struct{ Token, Identity string }
	json.Unmarshal(join.Body.Bytes(), &result)
	if result.Token != "session" {
		t.Fatal("bearer returned to browser")
	}
	signal := func() *httptest.ResponseRecorder {
		r := httptest.NewRequest("GET", "/discord/signal/"+result.Identity+"/rtc/validate?access_token=session", nil)
		r.AddCookie(session)
		r.Header.Set("Origin", opt.Origin)
		w := httptest.NewRecorder()
		mux.ServeHTTP(w, r)
		return w
	}
	if signal().Code != 200 {
		t.Fatal("signal exchange denied authorized user")
	}
	v, err := auth.ParseAPIToken(upstreamJWT)
	if err != nil {
		t.Fatal(err)
	}
	registered, claims, err := v.Verify("server-only")
	if err != nil || registered.Subject != result.Identity || registered.ExpiresAt.Time.Sub(registered.IssuedAt.Time) != 45*time.Second || claims.Video.Room != "dc-"+ref || claims.Video.GetCanPublish() || !claims.Video.GetCanSubscribe() || claims.Video.GetCanPublishData() || claims.Video.RoomAdmin || claims.Video.RoomRecord {
		t.Fatal("overbroad initial exchange")
	}
	// A canceled requesting socket cannot supply membership evidence for any
	// subsequent request. The next request must independently verify the user.
	canceled, cancel := context.WithCancel(t.Context())
	cancel()
	if _, ok := a.validDiscord(canceled, "dc-"+ref, result.Identity); ok {
		t.Fatal("canceled check authorized")
	}
	if signal().Code != 200 {
		t.Fatal("one canceled check destroyed the verified application session")
	}
	// The same cached, still-signed identity must fail the protected admission
	// endpoint after departure and stay invalid after returning to the channel.
	admit := func(key string) int {
		r := httptest.NewRequest("POST", "/internal/discord/admit", strings.NewReader(`{"Room":"dc-`+ref+`","Identity":"`+registered.Subject+`"}`))
		r.Header.Set("Authorization", "Bearer "+key)
		w := httptest.NewRecorder()
		mux.ServeHTTP(w, r)
		return w.Code
	}
	if admit("wrong") != 403 || admit(c.AdmissionKey) != 200 {
		t.Fatal("admission service boundary")
	}
	for _, voice := range []string{"", "22"} {
		r, _ := http.NewRequest("POST", provider.URL+"/scenario", strings.NewReader(`{"User":"33","Guild":"11","Channel":"`+voice+`","Online":true}`))
		r.Header.Set("Authorization", "Bearer "+controller)
		res, err := client.Do(r)
		if err != nil {
			t.Fatal(err)
		}
		res.Body.Close()
		if admit(c.AdmissionKey) != 403 || signal().Code == 200 {
			t.Fatal("old session recovered after departure")
		}
	}
	// Fresh processes inherit the stable room directory, never old app sessions.
	restarted := New(Config{})
	next := http.NewServeMux()
	restarted.RegisterDiscord(next, c)
	if _, ok := restarted.discord.oauth.Session(session.Value); ok {
		t.Fatal("session survived restart")
	}
}

func TestFreshVoiceLookupAfterReusedConnectionCloses(t *testing.T) {
	var attempts atomic.Int32
	authority := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if attempts.Add(1) == 2 {
			conn, _, err := http.NewResponseController(w).Hijack()
			if err != nil {
				t.Error(err)
				return
			}
			conn.Close()
			return
		}
		json.NewEncoder(w).Encode(discord.Presence{Channel: "22", Epoch: "active"})
	}))
	defer authority.Close()
	dir, _ := discord.NewDirectory(strings.Repeat("q", 32), "11/22")
	ref, _ := dir.Reference(discord.Channel{Guild: "11", Voice: "22"})
	d := channelAccess{c: &discord.Config{Dir: dir, VoiceURL: authority.URL}, client: authority.Client()}
	for i := 0; i < 2; i++ {
		if got := d.epoch(t.Context(), ref, "33"); got != "active" {
			t.Fatal("fresh authority did not verify membership after an idle connection closed")
		}
	}
	if attempts.Load() != 3 {
		t.Fatal("a fresh response was required")
	}
}

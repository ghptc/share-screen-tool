package rooms

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/json"
	"errors"
	"github.com/ghptc/whiterun-live/backend/internal/cloudsfu"
	"github.com/ghptc/whiterun-live/backend/internal/discord"
	"net/http"
	"net/http/httptest"
	"net/url"
	"strconv"
	"strings"
	"sync"
	"testing"
	"time"
)

type fakeMedia struct {
	mu            sync.Mutex
	count, closed int
	badClose      bool
}

func (f *fakeMedia) NewSession(context.Context) (string, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.count++
	return strconv.Itoa(f.count), nil
}
func (f *fakeMedia) Publish(context.Context, string, string, string, string) (string, error) {
	return "provider answer", nil
}
func (f *fakeMedia) Subscribe(context.Context, string, string, string) (string, string, error) {
	return "0", "provider offer", nil
}
func (f *fakeMedia) Answer(context.Context, string, string) error { return nil }
func (f *fakeMedia) Close(context.Context, string, string) error {
	f.mu.Lock()
	defer f.mu.Unlock()
	if f.badClose {
		return errors.New("unavailable")
	}
	f.closed++
	return nil
}

type cfFixture struct {
	a               *API
	api             *http.ServeMux
	cfg             *discord.Config
	ref, controller string
}

func newCFFixture(t *testing.T, origin string, media cloudsfu.Media) *cfFixture {
	t.Helper()
	dir, _ := discord.NewDirectory(strings.Repeat("m", 32), "11/22,11/23,12/22")
	cfg := &discord.Config{Fixture: true, Dir: dir, OAuthConfig: discord.OAuthConfig{Origin: origin, ClientID: "fixture", Secret: "fixture-only"}, VoiceKey: strings.Repeat("v", 32)}
	controller := randomID(32)
	provider := httptest.NewServer(discord.Simulator(cfg, controller, discord.FixtureState{}))
	t.Cleanup(provider.Close)
	cfg.VoiceURL = provider.URL
	cfg.AuthorizeURL = provider.URL + "/authorize"
	cfg.TokenURL = provider.URL + "/token"
	cfg.UserURL = provider.URL + "/user"
	a := New(Config{AppOrigin: origin})
	a.EnableCloudflarePrototype(media)
	m := http.NewServeMux()
	a.RegisterDiscord(m, cfg)
	ref, _ := dir.Reference(discord.Channel{Guild: "11", Voice: "22"})
	return &cfFixture{a, m, cfg, ref, controller}
}
func (f *cfFixture) voice(t *testing.T, user, channel string) {
	t.Helper()
	body, _ := json.Marshal(discord.FixtureState{User: user, Guild: "11", Channel: channel, Online: true})
	req, _ := http.NewRequest("POST", f.cfg.VoiceURL+"/scenario", bytes.NewReader(body))
	req.Header.Set("Authorization", "Bearer "+f.controller)
	res, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	res.Body.Close()
	if res.StatusCode != 204 {
		t.Fatal("voice fixture failed")
	}
}
func (f *cfFixture) login(t *testing.T, user string) *http.Cookie {
	t.Helper()
	f.voice(t, user, "22")
	begin := httptest.NewRecorder()
	f.api.ServeHTTP(begin, httptest.NewRequest("GET", "/discord/auth/"+f.ref, nil))
	client := &http.Client{CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }}
	provider, err := client.Get(begin.Header().Get("Location"))
	if err != nil {
		t.Fatal("OAuth start failed")
	}
	provider.Body.Close()
	callback, _ := url.Parse(provider.Header.Get("Location"))
	req := httptest.NewRequest("GET", "/discord/callback?"+callback.RawQuery, nil)
	req.AddCookie(begin.Result().Cookies()[0])
	end := httptest.NewRecorder()
	f.api.ServeHTTP(end, req)
	for _, c := range end.Result().Cookies() {
		if c.Name == "__Host-wl-session" && c.HttpOnly && c.Secure {
			return c
		}
	}
	t.Fatal("OAuth completion failed")
	return nil
}
func (f *cfFixture) post(t *testing.T, c *http.Cookie, id, ref, op string, in cfInput) (int, map[string]any) {
	t.Helper()
	b, _ := json.Marshal(in)
	if op == "join" {
		b = []byte("{}")
	} else {
		op = "media/" + op
	}
	r := httptest.NewRequest("POST", "/discord/"+ref+"/"+op, bytes.NewReader(b))
	r.Header.Set("Origin", f.cfg.Origin)
	r.Header.Set("Content-Type", "application/json")
	r.Header.Set("X-Whiterun-Peer", id)
	if op == "join" {
		r.Header.Set("X-Whiterun-Entry", id)
	}
	if c != nil {
		r.AddCookie(c)
	}
	w := httptest.NewRecorder()
	f.api.ServeHTTP(w, r)
	out := map[string]any{}
	json.Unmarshal(w.Body.Bytes(), &out)
	return w.Code, out
}
func TestCloudflareDiscordAdmission(t *testing.T) {
	media := &fakeMedia{}
	f := newCFFixture(t, "https://player.test", media)
	if code, _ := f.post(t, nil, "", f.ref, "join", cfInput{}); code != 401 {
		t.Fatal("copied link granted admission")
	}
	alice := f.login(t, "33")
	bob := f.login(t, "34")
	other, _ := f.cfg.Dir.Reference(discord.Channel{Guild: "11", Voice: "23"})
	if code, _ := f.post(t, alice, "", other, "join", cfInput{}); code != 403 {
		t.Fatal("wrong channel admitted")
	}
	_, a := f.post(t, alice, "", f.ref, "join", cfInput{})
	_, b := f.post(t, bob, "", f.ref, "join", cfInput{})
	aid, bid := a["identity"].(string), b["identity"].(string)
	if code, _ := f.post(t, bob, aid, f.ref, "state", cfInput{}); code != 403 {
		t.Fatal("other session used peer")
	}
	if code, _ := f.post(t, bob, bid, other, "state", cfInput{}); code != 403 {
		t.Fatal("room changed")
	}
	sdp := "v=0\r\no=- 1 1 IN IP4 127.0.0.1\r\ns=-\r\nt=0 0\r\nm=video 9 UDP/TLS/RTP/SAVPF 96\r\na=mid:0\r\na=sendonly\r\n"
	if code, _ := f.post(t, alice, aid, f.ref, "publish", cfInput{Mid: "0", SDP: sdp + "m=audio 9 RTP/AVP 96\r\n"}); code != 400 {
		t.Fatal("extra media allowed")
	}
	code, p := f.post(t, alice, aid, f.ref, "publish", cfInput{Mid: "0", SDP: sdp})
	if code != 200 {
		t.Fatalf("publication %d", code)
	}
	handle := p["handle"].(string)
	if p["sessionId"] != nil {
		t.Fatal("provider session exposed")
	}
	f.post(t, alice, aid, f.ref, "ready", cfInput{Handle: handle})
	if code, _ := f.post(t, alice, aid, f.ref, "subscribe", cfInput{Publication: handle}); code != 404 {
		t.Fatal("self subscription")
	}
	if code, _ := f.post(t, bob, bid, f.ref, "subscribe", cfInput{Publication: "guessed"}); code != 404 {
		t.Fatal("foreign publication")
	}
	if code, _ := f.post(t, bob, bid, f.ref, "subscribe", cfInput{Publication: handle}); code != 200 {
		t.Fatalf("viewer %d", code)
	}
	f.voice(t, "33", "23")
	if code, _ := f.post(t, alice, aid, f.ref, "state", cfInput{}); code != 403 {
		t.Fatal("departure authorized")
	}
	f.a.sweepCloudflare(t.Context(), false)
	if media.closed != 2 {
		t.Fatalf("provider closed %d of two media paths", media.closed)
	}
	f.voice(t, "33", "22")
	if code, _ := f.post(t, alice, aid, f.ref, "state", cfInput{}); code != 401 {
		t.Fatal("cached session recovered")
	}
}
func TestCloudflarePublisherLimitAndCleanup(t *testing.T) {
	f := newCFFixture(t, "https://player.test", &fakeMedia{badClose: true})
	g := f.a.prototype
	var wg sync.WaitGroup
	codes := make(chan int, 8)
	for n := range 8 {
		wg.Add(1)
		go func() {
			defer wg.Done()
			id := strconv.Itoa(n)
			p, code := g.reserve(roomAccess{ref: "room", user: id}, id, "", time.Now(), nil)
			if p != nil {
				p.session = id
				p.mid = "0"
				p.operation.Unlock()
			}
			codes <- code
		}()
	}
	wg.Wait()
	close(codes)
	count := 0
	for c := range codes {
		if c == 200 {
			count++
		} else if c != 409 {
			t.Fatal("unexpected status")
		}
	}
	if count != 4 {
		t.Fatalf("reserved %d", count)
	}
	f.a.sweepCloudflare(t.Context(), true)
	if len(g.tracks) != 4 {
		t.Fatal("failed provider closure prematurely freed slots")
	}
	m := g.media.(*fakeMedia)
	m.badClose = false
	f.a.sweepCloudflare(t.Context(), true)
	if len(g.tracks) != 0 || m.closed != 4 {
		t.Fatal("retry failed")
	}
}

func TestCloudflareViewersHaveIndependentHeartbeatBudgets(t *testing.T) {
	f := newCFFixture(t, "https://player.test", &fakeMedia{})
	cookies := make([]*http.Cookie, 8)
	ids := make([]string, 8)
	for i := range ids {
		cookies[i] = f.login(t, "33")
		code, body := f.post(t, cookies[i], strconv.Itoa(i), f.ref, "join", cfInput{})
		if code != 200 {
			t.Fatal(code)
		}
		ids[i] = body["identity"].(string)
	}
	for range 4 {
		for i, id := range ids {
			if code, _ := f.post(t, cookies[i], id, f.ref, "state", cfInput{}); code != 200 {
				t.Fatalf("viewer heartbeat %d", code)
			}
		}
	}
}

func TestCloudflareAudioIsBoundToScreenAndLease(t *testing.T) {
	f := newCFFixture(t, "https://player.test", &fakeMedia{})
	g := f.a.prototype
	owner := roomAccess{ref: "shared", user: "owner"}
	var screen *cfTrack
	for i := range 4 {
		b, id := owner, "owner-peer"
		if i > 0 {
			b.user, id = strconv.Itoa(i), strconv.Itoa(i)
		}
		v, code := g.reserve(b, id, "", time.Now(), nil)
		if code != 200 {
			t.Fatal("expected free screen slot")
		}
		v.ready = true
		v.operation.Unlock()
		if i == 0 {
			screen = v
		}
	}
	helper := nativeSession{ID: "test-helper", Screen: screen.handle}
	if _, code := g.reserve(owner, "other-peer", "", time.Now(), &helper); code != 403 {
		t.Fatal("other peer authorized helper")
	}
	a, code := g.reserve(owner, "owner-peer", "", time.Now(), &helper)
	if code != 200 {
		t.Fatal("four screen slots blocked attached helper")
	}
	a.ready = true
	a.operation.Unlock()
	if _, code = g.reserve(owner, "owner-peer", "", time.Now(), &helper); code != 409 {
		t.Fatal("duplicate helper")
	}
	if _, code = g.reserve(owner, "owner-peer", a.handle, time.Now(), nil); code != 404 {
		t.Fatal("self subscription")
	}
	viewer := roomAccess{ref: "shared", user: "viewer"}
	if _, code = g.reserve(viewer, "viewer", "", time.Now(), nil); code != 409 {
		t.Fatal("fifth publisher")
	}
	rx, code := g.reserve(viewer, "viewer", a.handle, time.Now(), nil)
	if code != 200 || !rx.audio {
		t.Fatal("viewer did not receive screen audio")
	}
	rx.operation.Unlock()
	viewer.ref = "different"
	if _, code = g.reserve(viewer, "viewer", a.handle, time.Now(), nil); code != 404 {
		t.Fatal("cross-room audio")
	}
	g.mu.Lock()
	g.retireLocked(screen)
	g.mu.Unlock()
	if !rx.closing || !a.closing {
		t.Fatal("screen retirement missed its audio")
	}
}

func TestCloudflareNativeOfferPermissions(t *testing.T) {
	f := newCFFixture(t, "https://player.test", &fakeMedia{})
	c := f.login(t, "33")
	_, grant := f.post(t, c, "", f.ref, "join", cfInput{})
	id := grant["identity"].(string)
	base := "v=0\r\no=- 1 1 IN IP4 127.0.0.1\r\ns=-\r\nt=0 0\r\n"
	audio := base + "m=audio 9 UDP/TLS/RTP/SAVPF 111\r\na=rtpmap:111 opus/48000/2\r\na=mid:0\r\na=sendonly\r\n"
	video := base + "m=video 9 UDP/TLS/RTP/SAVPF 96\r\na=mid:0\r\na=sendonly\r\n"
	if code, _ := f.post(t, c, id, f.ref, "publish", cfInput{SDP: audio, Mid: "0"}); code != 400 {
		t.Fatal("browser offered an audio publication")
	}
	_, pub := f.post(t, c, id, f.ref, "publish", cfInput{SDP: video, Mid: "0"})
	handle := pub["handle"].(string)
	f.post(t, c, id, f.ref, "ready", cfInput{Handle: handle})
	lease := randomID(32)
	s := &nativeSession{Owner: nativeOwner{Room: "dc-" + f.ref, Identity: id, Expires: time.Now().Add(time.Minute)}, ID: "helper", Screen: handle, LeaseHash: sha256.Sum256([]byte(lease)), Expires: time.Now().Add(time.Minute), Watching: true, Claimed: true}
	f.a.nativeSessions[s.ID] = s
	publish := func(credential, offer string) int {
		body, _ := json.Marshal(cfInput{SDP: offer, Mid: "0"})
		req := httptest.NewRequest("POST", "/native-audio/helper/publish", bytes.NewReader(body))
		req.Header.Set("Authorization", "Bearer "+credential)
		req.Header.Set("Content-Type", "application/json")
		res := httptest.NewRecorder()
		f.api.ServeHTTP(res, req)
		return res.Code
	}
	if publish("other", audio) != 403 || publish(lease, video) != 400 || publish(lease, strings.Replace(audio, "opus/48000/2", "PCMU/8000", 1)) != 400 || publish(lease, audio) != 200 {
		t.Fatal("incorrect native offer restrictions")
	}
	f.voice(t, "33", "23")
	if publish(lease, audio) != 403 || !s.Revoked {
		t.Fatal("withdrawn voice membership authorized helper")
	}
}

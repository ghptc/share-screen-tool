package discord

import (
	"crypto/sha256"
	"encoding/base64"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"net/url"
	"strings"
	"testing"
	"time"
)

func TestOAuthTransaction(t *testing.T) {
	d, _ := NewDirectory(strings.Repeat("m", 32), "12/34")
	ref, _ := d.Reference(Channel{"12", "34"})
	var challenge string
	provider := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch r.URL.Path {
		case "/token":
			id, secret, _ := r.BasicAuth()
			h := sha256.Sum256([]byte(r.FormValue("code_verifier")))
			if id != "client" || secret != "private" || base64.RawURLEncoding.EncodeToString(h[:]) != challenge || r.FormValue("redirect_uri") != "https://screen-share-player.gabrielhpittacosta.workers.dev/api/discord/callback" {
				http.Error(w, "Invalid", 403)
				return
			}
			fmt.Fprint(w, `{"access_token":"mock","token_type":"Bearer"}`)
		case "/user":
			if r.Header.Get("Authorization") != "Bearer mock" {
				http.Error(w, "Invalid", 403)
				return
			}
			fmt.Fprint(w, `{"id":"456","username":"test-user","global_name":"Test Member"}`)
		}
	}))
	defer provider.Close()
	o := NewOAuth(OAuthConfig{"https://screen-share-player.gabrielhpittacosta.workers.dev", "client", "private", provider.URL, provider.URL + "/token", provider.URL + "/user"}, d)
	mux := http.NewServeMux()
	o.Register(mux)
	for _, valid := range []bool{false, true} {
		rec := httptest.NewRecorder()
		mux.ServeHTTP(rec, httptest.NewRequest("GET", "/discord/auth/"+ref, nil))
		loc, _ := url.Parse(rec.Header().Get("Location"))
		if loc.Query().Get("redirect_uri") != "https://screen-share-player.gabrielhpittacosta.workers.dev/api/discord/callback" {
			t.Fatal("wrong hosted redirect URI")
		}
		state := loc.Query().Get("state")
		challenge = loc.Query().Get("code_challenge")
		if !valid {
			state = "invalid"
		}
		r := httptest.NewRequest("GET", "/discord/callback?code=once&state="+state, nil)
		r.AddCookie(rec.Result().Cookies()[0])
		out := httptest.NewRecorder()
		mux.ServeHTTP(out, r)
		if !valid {
			if out.Code != 403 {
				t.Fatal("invalid state accepted")
			}
			continue
		}
		if out.Code != 303 || out.Header().Get("Location") != "/r/"+ref {
			t.Fatal("exchange failed")
		}
		c := out.Result().Cookies()[1]
		if !c.HttpOnly || !c.Secure || c.SameSite != http.SameSiteStrictMode {
			t.Fatal("unsafe session")
		}
		if s, ok := o.Session(c.Value); !ok || s.User != "456" || s.DisplayName != "Test Member" {
			t.Fatal("identity mismatch")
		}
		again := httptest.NewRecorder()
		mux.ServeHTTP(again, r)
		if again.Code != 403 {
			t.Fatal("reused oauth state")
		}
		o.now = func() time.Time { return time.Now().Add(2 * time.Hour) }
		if _, ok := o.Session(c.Value); ok {
			t.Fatal("expired session")
		}
	}
}

func TestExpiredTransactionRequiresFreshDiscordLogin(t *testing.T) {
	dir, err := NewDirectory(strings.Repeat("m", 32), "12/34")
	if err != nil {
		t.Fatal(err)
	}
	ref, _ := dir.Reference(Channel{"12", "34"})
	o := NewOAuth(OAuthConfig{Origin: "https://player.test", AuthorizeURL: "https://discord.test/authorize"}, dir)
	mux := http.NewServeMux()
	o.Register(mux)
	start := httptest.NewRecorder()
	mux.ServeHTTP(start, httptest.NewRequest("GET", "/discord/auth/"+ref, nil))
	location, _ := url.Parse(start.Header().Get("Location"))
	o.now = func() time.Time { return time.Now().Add(6 * time.Minute) }
	callback := httptest.NewRequest("GET", "/discord/callback?code=expired&state="+location.Query().Get("state"), nil)
	callback.AddCookie(start.Result().Cookies()[0])
	result := httptest.NewRecorder()
	mux.ServeHTTP(result, callback)
	if result.Code != http.StatusForbidden || len(o.sessions) != 0 {
		t.Fatal("expired login resulted in an application session")
	}
}

type avatarTransport func(*http.Request) (*http.Response, error)

func (f avatarTransport) RoundTrip(r *http.Request) (*http.Response, error) { return f(r) }

func TestRoomAvatarHidesDiscordIdentifiers(t *testing.T) {
	hash := strings.Repeat("a", 32)
	png := "\x89PNG\r\n\x1a\nfixture"
	body := png
	var requests int
	o := NewRoomOAuth(OAuthConfig{}, nil, time.Now)
	o.http.Transport = avatarTransport(func(r *http.Request) (*http.Response, error) {
		requests++
		if r.URL.String() != "https://cdn.discordapp.com/avatars/456/"+hash+".png?size=32" || r.Header.Get("Authorization") != "" {
			t.Fatal("untrusted or credentialed avatar request")
		}
		return &http.Response{StatusCode: 200, Body: io.NopCloser(strings.NewReader(body))}, nil
	})
	for _, avatar := range []string{"", "../../outside"} {
		if o.avatar(t.Context(), discordUser{ID: "456", Avatar: avatar}) != "" {
			t.Fatal("unsafe avatar accepted")
		}
	}
	if requests != 0 {
		t.Fatal("untrusted avatar requested")
	}
	user := discordUser{ID: "456", Avatar: hash}
	if got := o.avatar(t.Context(), user); got != "data:image/png;base64,"+base64.StdEncoding.EncodeToString([]byte(png)) {
		t.Fatal("private avatar fallback")
	}
	body += strings.Repeat("x", 8192)
	if o.avatar(t.Context(), user) != "" {
		t.Fatal("oversized avatar accepted")
	}
}

package discord

import (
	"context"
	"crypto/rand"
	"crypto/sha256"
	"crypto/subtle"
	"encoding/base64"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"net/url"
	"strings"
	"sync"
	"time"
)

type OAuthConfig struct{ Origin, ClientID, Secret, AuthorizeURL, TokenURL, UserURL string }
type Session struct {
	ID, User string
	Until    time.Time
}
type transaction struct {
	state, verifier, ref string
	until                time.Time
}
type OAuth struct {
	cfg       OAuthConfig
	directory *Directory
	mu        sync.Mutex
	pending   map[string]transaction
	sessions  map[string]Session
	http      *http.Client
	now       func() time.Time
}

func NewOAuth(c OAuthConfig, d *Directory) *OAuth {
	return &OAuth{cfg: c, directory: d, pending: map[string]transaction{}, sessions: map[string]Session{}, now: time.Now,
		http: &http.Client{Timeout: 4 * time.Second, CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }}}
}
func (o *OAuth) Register(m *http.ServeMux) {
	m.HandleFunc("GET /discord/auth/{ref}", o.begin)
	m.HandleFunc("GET /discord/callback", o.callback)
}
func cookie(w http.ResponseWriter, name, value string, age int, site http.SameSite) {
	http.SetCookie(w, &http.Cookie{Name: "__Host-wl-" + name, Value: value, Path: "/", HttpOnly: true, Secure: true, SameSite: site, MaxAge: age})
}
func private(w http.ResponseWriter) {
	w.Header().Set("Cache-Control", "no-store")
	w.Header().Set("Referrer-Policy", "no-referrer")
}
func (o *OAuth) begin(w http.ResponseWriter, r *http.Request) {
	private(w)
	ref := r.PathValue("ref")
	if _, ok := o.directory.Lookup(ref); !ok {
		http.NotFound(w, r)
		return
	}
	now := o.now()
	v := transaction{state: rand.Text(), verifier: rand.Text() + rand.Text(), ref: ref, until: now.Add(5 * time.Minute)}
	browser := rand.Text()
	o.mu.Lock()
	for k, v := range o.pending {
		if !now.Before(v.until) {
			delete(o.pending, k)
		}
	}
	if len(o.pending) >= 4096 {
		o.mu.Unlock()
		http.Error(w, "Login busy", 429)
		return
	}
	o.pending[browser] = v
	o.mu.Unlock()
	challenge := sha256.Sum256([]byte(v.verifier))
	params := url.Values{"client_id": {o.cfg.ClientID}, "response_type": {"code"}, "scope": {"identify"}, "state": {v.state}, "redirect_uri": {o.cfg.Origin + "/api/discord/callback"}, "code_challenge_method": {"S256"}, "code_challenge": {base64.RawURLEncoding.EncodeToString(challenge[:])}}
	cookie(w, "login", browser, 300, http.SameSiteLaxMode)
	http.Redirect(w, r, o.cfg.AuthorizeURL+"?"+params.Encode(), http.StatusSeeOther)
}
func (o *OAuth) identity(ctx context.Context, code, verifier string) (string, error) {
	form := url.Values{"grant_type": {"authorization_code"}, "code": {code}, "redirect_uri": {o.cfg.Origin + "/api/discord/callback"}, "code_verifier": {verifier}}
	req, err := http.NewRequestWithContext(ctx, "POST", o.cfg.TokenURL, strings.NewReader(form.Encode()))
	if err != nil {
		return "", err
	}
	req.SetBasicAuth(o.cfg.ClientID, o.cfg.Secret)
	req.Header.Set("Content-Type", "application/x-www-form-urlencoded")
	res, err := o.http.Do(req)
	if err != nil {
		return "", err
	}
	defer res.Body.Close()
	var t struct {
		Token string `json:"access_token"`
		Type  string `json:"token_type"`
	}
	if res.StatusCode != 200 || json.NewDecoder(io.LimitReader(res.Body, 32768)).Decode(&t) != nil || t.Token == "" || !strings.EqualFold(t.Type, "bearer") {
		return "", errors.New("authorization exchange failed")
	}
	req, err = http.NewRequestWithContext(ctx, "GET", o.cfg.UserURL, nil)
	if err != nil {
		return "", err
	}
	req.Header.Set("Authorization", "Bearer "+t.Token)
	res, err = o.http.Do(req)
	if err != nil {
		return "", err
	}
	defer res.Body.Close()
	var user struct{ ID string }
	if res.StatusCode != 200 || json.NewDecoder(io.LimitReader(res.Body, 32768)).Decode(&user) != nil || !snowflake.MatchString(user.ID) {
		return "", errors.New("identity unavailable")
	}
	return user.ID, nil
}
func (o *OAuth) callback(w http.ResponseWriter, r *http.Request) {
	private(w)
	c, err := r.Cookie("__Host-wl-login")
	if err != nil {
		http.Error(w, "Login expired", 403)
		return
	}
	o.mu.Lock()
	v, ok := o.pending[c.Value]
	delete(o.pending, c.Value)
	o.mu.Unlock()
	cookie(w, "login", "", -1, http.SameSiteLaxMode)
	q := r.URL.Query()
	if !ok || !o.now().Before(v.until) || len(q["state"]) != 1 || subtle.ConstantTimeCompare([]byte(v.state), []byte(q.Get("state"))) != 1 || len(q["code"]) != 1 || q.Get("code") == "" {
		http.Error(w, "Login expired", 403)
		return
	}
	user, err := o.identity(r.Context(), q.Get("code"), v.verifier)
	if err != nil {
		http.Error(w, "Discord login unavailable", 403)
		return
	}
	id := rand.Text() + rand.Text()
	now := o.now()
	o.mu.Lock()
	for k, s := range o.sessions {
		if !now.Before(s.Until) {
			delete(o.sessions, k)
		}
	}
	if len(o.sessions) >= 8192 {
		o.mu.Unlock()
		http.Error(w, "Login busy", 429)
		return
	}
	o.sessions[id] = Session{id, user, now.Add(time.Hour)}
	o.mu.Unlock()
	cookie(w, "session", id, 3600, http.SameSiteStrictMode)
	http.Redirect(w, r, "/r/"+v.ref, http.StatusSeeOther)
}
func (o *OAuth) Current(r *http.Request) (Session, bool) {
	c, err := r.Cookie("__Host-wl-session")
	if err != nil {
		return Session{}, false
	}
	return o.Session(c.Value)
}
func (o *OAuth) Session(id string) (Session, bool) {
	o.mu.Lock()
	defer o.mu.Unlock()
	s, ok := o.sessions[id]
	if !ok || !o.now().Before(s.Until) {
		delete(o.sessions, id)
		return Session{}, false
	}
	return s, true
}
func (o *OAuth) Revoke(id string) { o.mu.Lock(); delete(o.sessions, id); o.mu.Unlock() }

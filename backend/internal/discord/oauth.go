package discord

import (
	"bytes"
	"context"
	"crypto/rand"
	"crypto/sha256"
	"crypto/subtle"
	"encoding/base64"
	"encoding/json"
	"io"
	"log/slog"
	"net/http"
	"net/url"
	"regexp"
	"strings"
	"sync"
	"time"
)

type OAuthConfig struct{ Origin, ClientID, Secret, AuthorizeURL, TokenURL, UserURL string }
type Session struct {
	ID, User, DisplayName, Avatar string
	Room, Epoch, Entry            string // Cloudflare room admission, pinned once per OAuth login.
	Until                         time.Time
	Correlation                   string
	proof                         *identityProof
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
	roomLogin bool
	now       func() time.Time
}

func NewOAuth(c OAuthConfig, d *Directory) *OAuth {
	return &OAuth{cfg: c, directory: d, pending: map[string]transaction{}, sessions: map[string]Session{}, now: time.Now,
		http: &http.Client{Timeout: 4 * time.Second, CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }}}
}

const RoomLifetime = 36000 * time.Second

// NewRoomOAuth scopes a login to the room where its authorization flow began.
// The existing LiveKit profile keeps its one-hour application sessions.
func NewRoomOAuth(c OAuthConfig, d *Directory, now func() time.Time) *OAuth {
	o := NewOAuth(c, d)
	o.now, o.roomLogin = now, true
	return o
}

// AdmitRoom starts the fixed lease exactly once, after a live voice proof.
// An expired credential or changed voice epoch can never restart the clock.
func (o *OAuth) AdmitRoom(id, ref, epoch, entry string) (Session, bool) {
	o.mu.Lock()
	defer o.mu.Unlock()
	s, ok := o.sessions[id]
	now := o.now()
	if !ok || !o.roomLogin || s.Room != ref || epoch == "" || !now.Before(s.Until) {
		return Session{}, false
	}
	if s.Epoch == "" {
		s.Epoch, s.Entry, s.Until = epoch, entry, now.Add(RoomLifetime)
		o.sessions[id] = s
	}
	return s, s.Epoch == epoch && s.Entry == entry
}

func roomCookieName(entry string) string {
	digest := sha256.Sum256([]byte(entry))
	return "room-" + base64.RawURLEncoding.EncodeToString(digest[:16])
}

// Tab credentials survive a fresh OAuth login in another tab. An already
// consumed login may retry its original admission, never start a new one.
func (o *OAuth) RoomEntry(r *http.Request, entry string) (Session, bool) {
	if c, e := r.Cookie("__Host-wl-" + roomCookieName(entry)); e == nil {
		if s, ok := o.Session(c.Value); ok && s.Epoch != "" && s.Entry == entry {
			return s, true
		}
	}
	s, ok := o.Current(r)
	return s, ok && (s.Epoch == "" || s.Entry == entry)
}

func (o *OAuth) WriteRoomCookie(w http.ResponseWriter, s Session) {
	seconds := int((s.Until.Sub(o.now()) + time.Second - 1) / time.Second)
	if seconds > 0 {
		cookie(w, roomCookieName(s.Entry), s.ID, seconds, http.SameSiteStrictMode)
	}
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

type discordUser struct {
	ID, Username, Avatar string
	GlobalName           string `json:"global_name"`
}

var avatarHash = regexp.MustCompile(`^(a_)?[0-9a-f]{32}$`)

// Fetch a small static image once. The Discord user ID and CDN path stay private.
func (o *OAuth) avatar(ctx context.Context, user discordUser) string {
	if !avatarHash.MatchString(user.Avatar) {
		return ""
	}
	req, err := http.NewRequestWithContext(ctx, "GET", "https://cdn.discordapp.com/avatars/"+user.ID+"/"+user.Avatar+".png?size=32", nil)
	if err != nil {
		return ""
	}
	res, err := o.http.Do(req)
	if err != nil {
		return ""
	}
	defer res.Body.Close()
	if res.StatusCode != 200 {
		return ""
	}
	const limit = 8192
	data, err := io.ReadAll(io.LimitReader(res.Body, limit+1))
	if err != nil || len(data) > limit || !bytes.HasPrefix(data, []byte("\x89PNG\r\n\x1a\n")) {
		return ""
	}
	return "data:image/png;base64," + base64.StdEncoding.EncodeToString(data)
}

// Only room sessions retain provider credentials. The per-login lock also
// protects refresh-token rotation across the watchdog and browser requests.
type oauthTokens struct {
	Access  string `json:"access_token"`
	Refresh string `json:"refresh_token"`
	Type    string `json:"token_type"`
	Seconds int64  `json:"expires_in"`
}
type identityProof struct {
	mu                                           sync.Mutex
	tokens                                       oauthTokens
	accessUntil, checkAt, verifiedUntil, retryAt time.Time
	backoff                                      time.Duration
}

func (o *OAuth) exchange(ctx context.Context, form url.Values) (oauthTokens, int) {
	req, err := http.NewRequestWithContext(ctx, "POST", o.cfg.TokenURL, strings.NewReader(form.Encode()))
	if err != nil {
		return oauthTokens{}, 503
	}
	req.SetBasicAuth(o.cfg.ClientID, o.cfg.Secret)
	req.Header.Set("Content-Type", "application/x-www-form-urlencoded")
	res, err := o.http.Do(req)
	if err != nil {
		return oauthTokens{}, 503
	}
	defer res.Body.Close()
	dec := json.NewDecoder(io.LimitReader(res.Body, 32768))
	if res.StatusCode != 200 {
		var failure struct {
			Code string `json:"error"`
		}
		if dec.Decode(&failure) == nil && (failure.Code == "invalid_grant" || failure.Code == "access_denied") {
			return oauthTokens{}, 403
		}
		return oauthTokens{}, 503
	}
	var t oauthTokens
	if dec.Decode(&t) != nil || t.Access == "" || !strings.EqualFold(t.Type, "bearer") {
		return oauthTokens{}, 503
	}
	return t, 200
}

func (o *OAuth) user(ctx context.Context, access string) (discordUser, int) {
	req, err := http.NewRequestWithContext(ctx, "GET", o.cfg.UserURL, nil)
	if err != nil {
		return discordUser{}, 503
	}
	req.Header.Set("Authorization", "Bearer "+access)
	res, err := o.http.Do(req)
	if err != nil {
		return discordUser{}, 503
	}
	defer res.Body.Close()
	if res.StatusCode == 401 || res.StatusCode == 403 {
		return discordUser{}, res.StatusCode
	}
	var u discordUser
	if res.StatusCode != 200 || json.NewDecoder(io.LimitReader(res.Body, 32768)).Decode(&u) != nil || !snowflake.MatchString(u.ID) {
		return discordUser{}, 503
	}
	return u, 200
}

const identityLifetime = 15 * time.Minute

func (p *identityProof) install(t oauthTokens, now time.Time) {
	if t.Refresh == "" {
		t.Refresh = p.tokens.Refresh
	}
	p.tokens = t
	p.accessUntil = time.Time{}
	if t.Seconds > 0 && t.Seconds <= int64((365*24*time.Hour)/time.Second) {
		ttl := time.Duration(t.Seconds) * time.Second
		p.accessUntil = now.Add(ttl)
	}
}

func (p *identityProof) verified(now time.Time) {
	p.verifiedUntil = now.Add(identityLifetime)
	if !p.accessUntil.IsZero() && p.accessUntil.Before(p.verifiedUntil) {
		p.verifiedUntil = p.accessUntil
	}
	ttl := p.verifiedUntil.Sub(now)
	p.checkAt = p.verifiedUntil.Add(-min(time.Minute, ttl/10))
}
func (p *identityProof) duringOutage(now time.Time) int {
	if now.Before(p.verifiedUntil) {
		return 200
	}
	return 503
}

func (o *OAuth) verifyIdentity(ctx context.Context, s Session, p *identityProof) int {
	due := !p.accessUntil.IsZero() && !p.accessUntil.After(o.now().Add(time.Minute)) && p.tokens.Refresh != ""
	if !due {
		u, status := o.user(ctx, p.tokens.Access)
		if status == 200 && u.ID != s.User {
			return 403
		}
		if status != 401 {
			return status
		}
		// Discord explicitly rejected this access token. Only a validated
		// replacement can authorize another request.
		p.verifiedUntil = time.Time{}
	}
	if p.tokens.Refresh == "" {
		return 403
	}
	// Complete rotation even if the polling tab closed during this request.
	// o.http has its own bounded timeout.
	requestedAt := o.now()
	t, status := o.exchange(context.WithoutCancel(ctx), url.Values{"grant_type": {"refresh_token"}, "refresh_token": {p.tokens.Refresh}})
	if status != 200 {
		return status
	}
	p.install(t, requestedAt)
	u, status := o.user(ctx, t.Access)
	if status == 401 || (status == 200 && u.ID != s.User) {
		return 403
	}
	return status
}

// RenewIdentity revalidates a short identity lease within the fixed admission.
// Callers independently require a fresh voice proof for every operation.
func (o *OAuth) RenewIdentity(ctx context.Context, s Session) int {
	p := s.proof
	if p == nil {
		return 401
	}
	p.mu.Lock()
	defer p.mu.Unlock()
	if _, ok := o.Session(s.ID); !ok {
		return 401
	}
	now := o.now()
	if now.Before(p.retryAt) {
		return p.duringOutage(now)
	}
	if now.Before(p.checkAt) {
		return 200
	}
	status := o.verifyIdentity(ctx, s, p)
	now = o.now()
	switch status {
	case 200:
		p.verified(now)
		p.backoff = 0
		p.retryAt = time.Time{}
	case 503:
		p.backoff = min(30*time.Second, max(time.Second, 2*p.backoff))
		p.retryAt = now.Add(p.backoff)
	default:
		o.Revoke(s.ID)
	}
	reason := map[int]string{200: "identity_renewed", 503: "identity_unavailable", 403: "identity_revoked"}[status]
	slog.Info("room_identity", "session_correlation", s.Correlation, "reason", reason, "status", status)
	if status == 503 {
		return p.duringOutage(now)
	}
	return status
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
	requestedAt := o.now()
	tokens, status := o.exchange(r.Context(), url.Values{"grant_type": {"authorization_code"}, "code": {q.Get("code")}, "redirect_uri": {o.cfg.Origin + "/api/discord/callback"}, "code_verifier": {v.verifier}})
	var user discordUser
	if status == 200 {
		user, status = o.user(r.Context(), tokens.Access)
	}
	if status != 200 {
		http.Error(w, "Discord login unavailable", status)
		return
	}
	name := user.GlobalName
	if name == "" {
		name = user.Username
	}
	if name == "" {
		name = "Discord member"
	}
	var avatar string
	if o.roomLogin {
		avatar = o.avatar(r.Context(), user)
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
	session := Session{ID: id, User: user.ID, DisplayName: name, Avatar: avatar, Until: now.Add(time.Hour)}
	if o.roomLogin {
		session.Correlation = rand.Text()
		session.proof = &identityProof{}
		session.proof.install(tokens, requestedAt)
		session.proof.verified(now)
		session.Room = v.ref
		session.Until = now.Add(5 * time.Minute)
	}
	o.sessions[id] = session
	o.mu.Unlock()
	cookie(w, "session", id, int(session.Until.Sub(now)/time.Second), http.SameSiteStrictMode)
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

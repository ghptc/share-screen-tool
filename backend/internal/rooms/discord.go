package rooms

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"net/http/httputil"
	"net/url"
	"strings"
	"sync"
	"time"

	"github.com/ghptc/whiterun-live/backend/internal/discord"
	"github.com/livekit/protocol/auth"
	"github.com/livekit/protocol/livekit"
	"github.com/twitchtv/twirp"
)

const discordTTL = 45 * time.Second

type roomAccess struct {
	controlHash                     [32]byte
	session, ref, user, epoch, name string
	until                           time.Time
	publishing                      bool
	started                         time.Time
}
type channelAccess struct {
	c        *discord.Config
	oauth    *discord.OAuth
	updateMu sync.Mutex
	mu       sync.Mutex
	active   map[string]roomAccess
	client   *http.Client
}

func (a *API) RegisterDiscord(m *http.ServeMux, c *discord.Config) {
	d := &channelAccess{c: c, oauth: discord.NewOAuth(c.OAuthConfig, c.Dir), active: map[string]roomAccess{}, client: &http.Client{Timeout: 2 * time.Second, CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }}}
	a.discord = d
	d.oauth.Register(m)
	m.Handle("POST /discord/{ref}/join", a.guard(http.HandlerFunc(a.discordJoin)))
	m.Handle("POST /discord/{ref}/publish", a.guard(http.HandlerFunc(a.discordPublish)))
	m.Handle("POST /discord/{ref}/stop", a.guard(http.HandlerFunc(a.discordPublish)))
	m.HandleFunc("POST /internal/discord/admit", a.discordAdmit)
	m.HandleFunc("GET /discord/signal/{identity}/rtc", a.discordSignal)
	m.HandleFunc("GET /discord/signal/{identity}/rtc/{path...}", a.discordSignal)
	if c.Fixture {
		// Forward only the OAuth authorization endpoint to the private fixture.
		// The browser never selects a user or voice channel.
		m.HandleFunc("GET /fixture/authorize", func(w http.ResponseWriter, r *http.Request) {
			req, err := http.NewRequestWithContext(r.Context(), "GET", c.VoiceURL+"/authorize?"+r.URL.RawQuery, nil)
			if err != nil {
				fail(w, 400, "Invalid fixture authorization")
				return
			}
			res, err := d.client.Do(req)
			if err != nil {
				fail(w, 503, "Fixture unavailable")
				return
			}
			defer res.Body.Close()
			if res.StatusCode != 303 || !strings.HasPrefix(res.Header.Get("Location"), c.Origin+"/api/discord/callback?") {
				fail(w, 403, "Fixture authorization denied")
				return
			}
			w.Header().Set("Referrer-Policy", "no-referrer")
			w.Header().Set("Cache-Control", "no-store")
			http.Redirect(w, r, res.Header.Get("Location"), 303)
		})
	}
}
func (d *channelAccess) epoch(ctx context.Context, ref, user string) string {
	ch, ok := d.c.Dir.Lookup(ref)
	if !ok || d.c.Blocked[user] {
		return ""
	}
	body, _ := json.Marshal(map[string]string{"Guild": ch.Guild, "User": user})
	req, err := http.NewRequestWithContext(ctx, "POST", d.c.VoiceURL+"/voice", bytes.NewReader(body))
	if err != nil {
		return ""
	}
	// This POST is a read. If an idle connection closes, Go can retry on a
	// fresh connection within the same timeout and still require a live proof.
	req.Header["Idempotency-Key"] = []string{}
	req.Header.Set("Authorization", "Bearer "+d.c.VoiceKey)
	req.Header.Set("Content-Type", "application/json")
	res, err := d.client.Do(req)
	if err != nil {
		return ""
	}
	defer res.Body.Close()
	var p discord.Presence
	if res.StatusCode != 200 || json.NewDecoder(io.LimitReader(res.Body, 4096)).Decode(&p) != nil || p.Channel != ch.Voice {
		return ""
	}
	return p.Epoch
}
func (a *API) discordJoin(w http.ResponseWriter, r *http.Request) {
	d := a.discord
	if r.Header.Get("Origin") != d.c.Origin {
		fail(w, 403, "Origin not allowed")
		return
	}
	var empty struct{}
	if !decode(w, r, &empty) {
		return
	}
	ref := r.PathValue("ref")
	if _, ok := d.c.Dir.Lookup(ref); !ok {
		fail(w, 404, "Unknown room")
		return
	}
	s, ok := d.oauth.Current(r)
	if !ok {
		fail(w, 401, "Discord sign-in required")
		return
	}
	epoch := d.epoch(r.Context(), ref, s.User)
	if epoch == "" {
		fail(w, 403, "Connect to this Discord voice channel to watch")
		return
	}
	identity := "participant-" + randomID(18)
	control := randomID(32)
	room := "dc-" + ref
	d.mu.Lock()
	if len(d.active) >= 8192 {
		d.mu.Unlock()
		fail(w, 429, "Room session limit reached")
		return
	}
	d.active[identity] = roomAccess{controlHash: sha256.Sum256([]byte(control)), session: s.ID, ref: ref, user: s.User, epoch: epoch, name: "Screen " + randomID(3), until: s.Until}
	d.mu.Unlock()
	a.nativeMu.Lock()
	a.nativeOwners[sha256.Sum256([]byte(control))] = nativeOwner{room, identity, s.Until}
	a.nativeMu.Unlock()
	write(w, 200, map[string]any{"token": "session", "identity": identity, "roomId": room, "serverUrl": d.c.Origin + "/api/discord/signal/" + identity, "canPublish": true, "nativeAudioControl": control})
}

// Browsers authenticate the signaling socket with the application session. The
// SDK's query value is a constant; the real room JWT travels only in an upstream header.
func (a *API) discordSignal(w http.ResponseWriter, r *http.Request) {
	d := a.discord
	origin := r.Header.Get("Origin")
	if origin != d.c.Origin && !(origin == "" && r.Header.Get("Sec-Fetch-Site") == "same-origin") {
		fail(w, 403, "Origin denied")
		return
	}
	s, ok := d.oauth.Current(r)
	if !ok {
		fail(w, 401, "Discord session required")
		return
	}
	id := r.PathValue("identity")
	d.mu.Lock()
	b, ok := d.active[id]
	d.mu.Unlock()
	if !ok || b.session != s.ID {
		fail(w, 403, "Room authorization required")
		return
	}
	room := "dc-" + b.ref
	b, ok = a.validDiscord(r.Context(), room, id)
	if !ok {
		fail(w, 403, "Voice authorization ended")
		return
	}
	path := r.PathValue("path")
	switch path {
	case "", "v1", "validate", "v1/validate":
	default:
		http.NotFound(w, r)
		return
	}
	token, err := a.discordToken(room, id, b)
	if err != nil {
		fail(w, 500, "Authorization failed")
		return
	}
	upstream, err := url.Parse(a.cfg.HTTPURL)
	if err != nil {
		fail(w, 503, "LiveKit unavailable")
		return
	}
	proxy := httputil.ReverseProxy{Rewrite: func(pr *httputil.ProxyRequest) {
		pr.SetURL(upstream)
		pr.Out.URL.Path = "/rtc"
		if path != "" {
			pr.Out.URL.Path += "/" + path
		}
		pr.Out.URL.RawPath = ""
		q := pr.Out.URL.Query()
		q.Del("access_token")
		q.Del("publish")
		pr.Out.URL.RawQuery = q.Encode()
		pr.Out.Header.Del("Cookie")
		pr.Out.Header.Set("Authorization", "Bearer "+token)
	}}
	proxy.ServeHTTP(w, r)
}
func (a *API) discordToken(room, id string, b roomAccess) (string, error) {
	grant := &auth.VideoGrant{Room: room, RoomJoin: true}
	grant.SetCanPublish(b.publishing)
	grant.SetCanSubscribe(true)
	grant.SetCanPublishData(false)
	grant.SetCanUpdateOwnMetadata(false)
	grant.SetCanManageAgentSession(false)
	grant.SetCanSubscribeMetrics(false)
	if b.publishing {
		grant.SetCanPublishSources([]livekit.TrackSource{livekit.TrackSource_SCREEN_SHARE})
	}
	return auth.NewAccessToken(a.cfg.APIKey, a.cfg.APISecret).SetIdentity(id).SetName(b.name).SetVideoGrant(grant).SetValidFor(discordTTL).ToJWT()
}
func (a *API) validDiscord(ctx context.Context, room, id string) (roomAccess, bool) {
	d := a.discord
	if d == nil {
		return roomAccess{}, false
	}
	d.mu.Lock()
	b, ok := d.active[id]
	d.mu.Unlock()
	if !ok || room != "dc-"+b.ref {
		return roomAccess{}, false
	}
	_, sessionOK := d.oauth.Session(b.session)
	if !sessionOK || d.epoch(ctx, b.ref, b.user) != b.epoch {
		// A canceled client request has no authority to revoke another socket.
		// Deny this request. The independent SFU and API monitors keep checking.
		if sessionOK && ctx.Err() != nil {
			return roomAccess{}, false
		}
		d.mu.Lock()
		_, registered := d.active[id]
		delete(d.active, id)
		d.mu.Unlock()
		if registered {
			d.oauth.Revoke(b.session)
			a.nativeMu.Lock()
			delete(a.nativeOwners, b.controlHash)
			var helpers []string
			for sid, s := range a.nativeSessions {
				if s.Owner.Identity == id && s.Owner.Room == room && !s.Revoked {
					helpers = append(helpers, sid)
				}
			}
			a.nativeMu.Unlock()
			go func() {
				for _, sid := range helpers {
					a.revokeNative(sid)
				}
				c, cancel := context.WithTimeout(context.Background(), 4*time.Second)
				defer cancel()
				if admin, err := a.nativeContext(c, room); err == nil {
					_, _ = a.client.RemoveParticipant(admin, &livekit.RoomParticipantIdentity{Room: room, Identity: id})
				}
			}()
		}
		return roomAccess{}, false
	}
	d.mu.Lock()
	defer d.mu.Unlock()
	current, ok := d.active[id]
	return current, ok
}
func (a *API) discordPublish(w http.ResponseWriter, r *http.Request) {
	d := a.discord
	if r.Header.Get("Origin") != d.c.Origin {
		fail(w, 403, "Origin not allowed")
		return
	}
	var in struct{}
	if !decode(w, r, &in) {
		return
	}
	s, ok := d.oauth.Current(r)
	if !ok {
		fail(w, 401, "Discord sign-in required")
		return
	}
	a.nativeMu.Lock()
	owner := a.nativeOwners[bearerHash(r)]
	a.nativeMu.Unlock()
	d.updateMu.Lock()
	defer d.updateMu.Unlock()
	b, ok := a.validDiscord(r.Context(), owner.Room, owner.Identity)
	if !ok || s.ID != b.session || b.ref != r.PathValue("ref") {
		fail(w, 403, "Voice authorization ended")
		return
	}
	publish := strings.HasSuffix(r.URL.Path, "/publish")
	ctx, err := a.nativeContext(r.Context(), owner.Room)
	if err != nil {
		fail(w, 503, "LiveKit unavailable")
		return
	}
	permission := &livekit.ParticipantPermission{CanSubscribe: true, CanPublish: publish}
	if publish {
		permission.CanPublishSources = []livekit.TrackSource{livekit.TrackSource_SCREEN_SHARE}
	}
	if publish && b.publishing {
		// Retries of an existing upgrade cannot extend its unused reservation.
		write(w, 200, map[string]bool{"publishing": true})
		return
	}
	if publish {
		participants, err := a.client.ListParticipants(ctx, &livekit.ListParticipantsRequest{Room: owner.Room})
		if err != nil {
			fail(w, 503, "Room presence unavailable")
			return
		}
		occupied := map[string]bool{}
		for _, p := range participants.Participants {
			for _, track := range p.Tracks {
				if track.Type == livekit.TrackType_VIDEO && track.Source == livekit.TrackSource_SCREEN_SHARE {
					occupied[p.Identity] = true
				}
			}
		}
		d.mu.Lock()
		for id, res := range d.active {
			if res.ref == b.ref && res.publishing {
				occupied[id] = true
			}
		}
		d.mu.Unlock()
		if len(occupied) >= 4 && !occupied[owner.Identity] {
			fail(w, 409, "All four screens are in use. You can keep watching.")
			return
		}
	}
	d.mu.Lock()
	b, ok = d.active[owner.Identity]
	if ok {
		b.publishing = publish
		b.started = a.now()
		d.active[owner.Identity] = b
	}
	d.mu.Unlock()
	if !ok {
		fail(w, 403, "Voice authorization ended")
		return
	}
	_, err = a.client.UpdateParticipant(ctx, &livekit.UpdateParticipantRequest{Room: owner.Room, Identity: owner.Identity, Permission: permission})
	if err != nil {
		d.mu.Lock()
		if cur, ok := d.active[owner.Identity]; ok && cur == b {
			cur.publishing = false
			d.active[owner.Identity] = cur
		}
		d.mu.Unlock()
		fail(w, 409, "Participant unavailable")
		return
	}
	write(w, 200, map[string]bool{"publishing": publish})
}
func (a *API) discordAdmit(w http.ResponseWriter, r *http.Request) {
	if !discord.AuthorizedService(a.discord.c.AdmissionKey, r.Header.Get("Authorization")) {
		fail(w, 403, "Admission denied")
		return
	}
	var q struct{ Room, Identity string }
	if !decode(w, r, &q) {
		return
	}
	id := q.Identity
	helper := strings.HasPrefix(id, "native-audio-")
	if helper {
		a.nativeMu.Lock()
		s := a.nativeSessions[id]
		ok := s != nil && s.Owner.Room == q.Room && s.Watching && s.Claimed && !s.Revoked && a.now().Before(s.Expires)
		if ok {
			id = s.Owner.Identity
		}
		a.nativeMu.Unlock()
		if !ok {
			fail(w, 403, "Audio session ended")
			return
		}
	}
	b, ok := a.validDiscord(r.Context(), q.Room, id)
	if !ok {
		fail(w, 403, "Voice authorization ended")
		return
	}
	role := "viewer"
	if b.publishing {
		role = "screen"
	}
	if helper {
		if !b.publishing {
			fail(w, 403, "Screen authorization ended")
			return
		}
		role = "audio"
	}
	write(w, 200, map[string]string{"role": role})
}

// Periodically remove expired, orphaned and departed sessions, including sessions
// that fetched a JWT but never connected. An active participant is also checked by the SFU.
func (a *API) ReconcileDiscord(ctx context.Context) {
	ticker := time.NewTicker(3 * time.Second)
	defer ticker.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
		}
		d := a.discord
		d.mu.Lock()
		snapshot := make(map[string]roomAccess, len(d.active))
		for id, b := range d.active {
			snapshot[id] = b
		}
		d.mu.Unlock()
		for id, b := range snapshot {
			room := "dc-" + b.ref
			valid, ok := a.validDiscord(ctx, room, id)
			if !ok || !valid.publishing || a.now().Sub(valid.started) < 20*time.Second {
				continue
			}
			admin, err := a.nativeContext(ctx, room)
			if err != nil {
				continue
			}
			p, err := a.client.GetParticipant(admin, &livekit.RoomParticipantIdentity{Room: room, Identity: id})
			if err != nil {
				var upstream twirp.Error
				if errors.As(err, &upstream) && upstream.Code() == twirp.NotFound {
					d.mu.Lock()
					if cur, ok := d.active[id]; ok && cur == valid {
						cur.publishing = false
						d.active[id] = cur
					}
					d.mu.Unlock()
				}
				continue
			}
			screen := false
			for _, t := range p.Tracks {
				if t.Source == livekit.TrackSource_SCREEN_SHARE {
					screen = true
				}
			}
			if !screen {
				d.updateMu.Lock()
				d.mu.Lock()
				cur, ok := d.active[id]
				d.mu.Unlock()
				if ok && cur == valid {
					if _, err := a.client.UpdateParticipant(admin, &livekit.UpdateParticipantRequest{Room: room, Identity: id, Permission: &livekit.ParticipantPermission{CanSubscribe: true}}); err == nil {
						d.mu.Lock()
						if d.active[id] == cur {
							cur.publishing = false
							d.active[id] = cur
						}
						d.mu.Unlock()
					}
				}
				d.updateMu.Unlock()
			}
		}
	}
}

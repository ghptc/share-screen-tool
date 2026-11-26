package rooms

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/json"
	"errors"
	"io"
	"log/slog"
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
	"golang.org/x/time/rate"
)

const discordTTL = 45 * time.Second

type roomAccess struct {
	proofMu                             *sync.Mutex
	mediaRequests                       *rate.Limiter
	controlHash                         [32]byte
	session, ref, user, epoch, name     string
	displayName, avatar, participantKey string
	lastSeen, voiceChecked              time.Time
	correlation                         string
	entry                               string // idempotency key for one browser navigation
	until                               time.Time
	publishing                          bool
	started                             time.Time
}
type channelAccess struct {
	c        *discord.Config
	oauth    *discord.OAuth
	updateMu sync.Mutex
	mu       sync.Mutex
	active   map[string]roomAccess
	client   *http.Client
	probes   sync.Map // identity -> *atomic.Bool for the duration of a readiness request
}

func (a *API) RegisterDiscord(m *http.ServeMux, c *discord.Config) {
	d := &channelAccess{c: c, oauth: discord.NewOAuth(c.OAuthConfig, c.Dir), active: map[string]roomAccess{}, client: &http.Client{Timeout: 2 * time.Second, CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }}}
	if a.prototype != nil {
		d.oauth = discord.NewRoomOAuth(c.OAuthConfig, c.Dir, func() time.Time { return a.now() })
	}
	a.discord = d
	d.oauth.Register(m)
	m.Handle("POST /discord/{ref}/join", a.guard(http.HandlerFunc(a.discordJoin)))
	if a.prototype != nil {
		a.RegisterNative(m)
		m.Handle("POST /native-audio/{session}/ready", a.guard(http.HandlerFunc(a.leaseNative)))
		m.Handle("POST /native-audio/{session}/publish", a.guard(http.HandlerFunc(a.cfHelperPublish)))
		m.Handle("POST /discord/{ref}/media/{action}", a.guardRequests(http.HandlerFunc(a.cfSignal), false))
	} else {
		m.Handle("POST /discord/{ref}/publish", a.guard(http.HandlerFunc(a.discordPublish)))
		m.Handle("POST /discord/{ref}/stop", a.guard(http.HandlerFunc(a.discordPublish)))
		m.HandleFunc("POST /internal/discord/admit", a.discordAdmit)
		if !c.Fixture {
			m.HandleFunc("GET /readyz", a.discordReady)
		}
		m.HandleFunc("GET /discord/signal/{identity}/rtc", a.discordSignal)
		m.HandleFunc("GET /discord/signal/{identity}/rtc/{path...}", a.discordSignal)
	}
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
func (d *channelAccess) canPublish(user string) bool {
	return d.c.PilotUsers == nil || d.c.PilotUsers[user]
}

func (d *channelAccess) epoch(ctx context.Context, ref, user string) (string, int, string) {
	ch, ok := d.c.Dir.Lookup(ref)
	if !ok || d.c.Blocked[user] {
		return "", http.StatusForbidden, "room_denied"
	}
	body, _ := json.Marshal(map[string]string{"Guild": ch.Guild, "User": user})
	req, err := http.NewRequestWithContext(ctx, "POST", d.c.VoiceURL+"/voice", bytes.NewReader(body))
	if err != nil {
		return "", http.StatusServiceUnavailable, "voice_unavailable"
	}
	// This POST is a read. If an idle connection closes, Go can retry on a
	// fresh connection within the same timeout and still require a live proof.
	req.Header["Idempotency-Key"] = []string{}
	req.Header.Set("Authorization", "Bearer "+d.c.VoiceKey)
	req.Header.Set("Content-Type", "application/json")
	res, err := d.client.Do(req)
	if err != nil {
		return "", http.StatusServiceUnavailable, "voice_unavailable"
	}
	defer res.Body.Close()
	var p discord.Presence
	if res.StatusCode == http.StatusNoContent {
		return "", http.StatusForbidden, "voice_absent"
	}
	if res.StatusCode != 200 || json.NewDecoder(io.LimitReader(res.Body, 4096)).Decode(&p) != nil || p.Epoch == "" || p.Channel == "" {
		return "", http.StatusServiceUnavailable, "voice_unavailable"
	}
	if p.Channel != ch.Voice {
		return "", http.StatusForbidden, "voice_channel_changed"
	}
	return p.Epoch, http.StatusOK, ""
}
func (a *API) discordJoin(w http.ResponseWriter, r *http.Request) {
	d := a.discord
	if r.Header.Get("Origin") != d.c.Origin {
		fail(w, 403, "Origin not allowed")
		return
	}
	var input struct {
		ResumePeer string `json:"resumePeer,omitempty"`
	}
	if !decode(w, r, &input) {
		return
	}
	ref := r.PathValue("ref")
	if _, ok := d.c.Dir.Lookup(ref); !ok {
		fail(w, 404, "Unknown room")
		return
	}
	entry := r.Header.Get("X-Whiterun-Entry")
	var s discord.Session
	var ok bool
	if a.prototype != nil {
		if len(entry) > 64 {
			fail(w, 400, "Invalid room entry")
			return
		}
		s, ok = d.oauth.RoomEntry(r, entry)
		if ok {
			w.Header().Set("X-Session-Correlation", s.Correlation)
		}
	} else {
		s, ok = d.oauth.Current(r)
	}
	if !ok {
		roomAuthFailure(w, 401, "session_missing", "Discord sign-in required")
		return
	}
	if input.ResumePeer != "" && (a.prototype == nil || s.Epoch == "") {
		roomAuthFailure(w, 401, "session_missing", "Previous admission unavailable")
		return
	}
	if a.prototype != nil && s.Epoch != "" {
		d.mu.Lock()
		var peer string
		for id, b := range d.active {
			if b.session == s.ID && b.ref == ref && b.entry == entry {
				peer = id
				break
			}
		}
		d.mu.Unlock()
		if input.ResumePeer != "" && input.ResumePeer != peer {
			roomAuthFailure(w, 403, "peer_mismatch", "Previous admission unavailable")
			return
		}
		if peer != "" {
			if _, status, reason := a.checkDiscord(r.Context(), "dc-"+ref, peer); status != 200 {
				roomAuthFailure(w, status, reason, "Discord voice authorization required")
				return
			}
			a.cfJoined(w, s, peer, a.prototype.controlFor(peer))
			return
		}
	}
	epoch, status, reason := d.epoch(r.Context(), ref, s.User)
	if status != 200 {
		roomAuthFailure(w, status, reason, "Connect to this Discord voice channel to watch")
		return
	}
	if a.prototype != nil {
		if status := d.oauth.RenewIdentity(r.Context(), s); status != 200 {
			roomAuthFailure(w, status, identityReason(status), "Discord identity authorization required")
			return
		}
		if s, ok = d.oauth.AdmitRoom(s.ID, ref, epoch, entry); !ok {
			fail(w, 403, "Room authorization ended")
			return
		}
	}
	identity := "participant-" + randomID(18)
	control := randomID(32)
	if a.prototype != nil {
		control = a.prototype.controlFor(identity)
	}
	room := "dc-" + ref
	d.mu.Lock()
	if a.prototype != nil {
		if _, valid := d.oauth.Session(s.ID); !valid {
			d.mu.Unlock()
			fail(w, 403, "Room authorization ended")
			return
		}
		for peer, previous := range d.active {
			if previous.session == s.ID && previous.ref == ref && previous.entry == entry {
				d.mu.Unlock()
				a.cfJoined(w, s, peer, a.prototype.controlFor(peer))
				return
			}
		}
	}
	if len(d.active) >= 8192 {
		d.mu.Unlock()
		fail(w, 429, "Room session limit reached")
		return
	}
	access := roomAccess{proofMu: new(sync.Mutex), controlHash: sha256.Sum256([]byte(control)), session: s.ID, ref: ref, user: s.User, epoch: epoch, name: "Screen " + randomID(3), until: s.Until}
	if a.prototype != nil {
		access.mediaRequests = rate.NewLimiter(5, 20)
		access.correlation = s.Correlation
		slog.Info("room_access", "session_correlation", s.Correlation, "reason", "room_admitted", "status", 200)
		access.entry = entry
		access.displayName, access.avatar = s.DisplayName, s.Avatar
		access.participantKey = a.prototype.controlFor("roster:" + ref + ":" + s.User)
		access.lastSeen, access.voiceChecked = a.now(), a.now()
	}
	d.active[identity] = access
	d.mu.Unlock()
	a.nativeMu.Lock()
	a.nativeOwners[sha256.Sum256([]byte(control))] = nativeOwner{room, identity, s.Until}
	a.nativeMu.Unlock()
	if a.prototype != nil {
		a.prototype.mu.Lock()
		a.prototype.changedLocked()
		a.prototype.mu.Unlock()
		a.cfJoined(w, s, identity, control)
		return
	}
	write(w, 200, map[string]any{"token": "session", "identity": identity, "roomId": room, "serverUrl": d.c.Origin + "/api/discord/signal/" + identity, "canPublish": true, "nativeAudioControl": control})
}

func identityReason(status int) string {
	switch status {
	case 401:
		return "session_missing"
	case 403:
		return "identity_revoked"
	default:
		return "identity_unavailable"
	}
}
func authReason(status int) string {
	switch status {
	case 401:
		return "session_missing"
	case 403:
		return "authorization_denied"
	case 410:
		return "session_expired"
	case 429:
		return "rate_limited"
	default:
		return "authority_unavailable"
	}
}
func roomAuthFailure(w http.ResponseWriter, status int, reason, message string) {
	write(w, status, map[string]string{"error": message, "reason": reason})
}

func (a *API) cfJoined(w http.ResponseWriter, s discord.Session, id, control string) {
	w.Header().Set("X-Session-Correlation", s.Correlation)
	a.discord.oauth.WriteRoomCookie(w, s)
	write(w, 200, map[string]any{"transport": "cloudflare-prototype", "canPublish": a.discord.canPublish(s.User), "identity": id, "nativeAudioControl": control, "expiresAt": s.Until, "serverTime": a.now()})
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
	if !a.requireDiscordAdmission(w, r) {
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
	b, status, _ := a.checkDiscord(ctx, room, id)
	return b, status == http.StatusOK
}

func (a *API) checkDiscord(ctx context.Context, room, id string) (roomAccess, int, string) {
	d := a.discord
	if d == nil {
		return roomAccess{}, 403, "room_denied"
	}
	d.mu.Lock()
	b, ok := d.active[id]
	d.mu.Unlock()
	if !ok || room != "dc-"+b.ref {
		return roomAccess{}, 403, "room_denied"
	}

	// Serialize proofs for this peer so a delayed reply cannot restore stale access.
	b.proofMu.Lock()
	defer b.proofMu.Unlock()
	status := http.StatusUnauthorized
	reason := "session_missing"
	confirmedDeparture := false
	if session, ok := d.oauth.Session(b.session); ok {
		epoch, proof, voiceReason := d.epoch(ctx, b.ref, b.user)
		status = proof
		reason = voiceReason
		if proof == 200 && epoch != b.epoch {
			status = 403
			reason = "voice_epoch_changed"
		}
		confirmedDeparture = status == 403
		if status == 200 && a.prototype != nil {
			status = d.oauth.RenewIdentity(ctx, session)
			if status != 200 {
				reason = identityReason(status)
			}
		}
		if ctx.Err() != nil && status == 503 && a.now().Before(b.until) {
			return roomAccess{}, 503, reason
		}
	}
	if !a.now().Before(b.until) {
		status = 410
		reason = "session_expired"
	}

	d.mu.Lock()
	b, ok = d.active[id]
	if !ok {
		d.mu.Unlock()
		return roomAccess{}, 403, "room_denied"
	}
	if status == 200 {
		if a.prototype != nil {
			if b.voiceChecked.IsZero() {
				slog.Info("room_access", "session_correlation", b.correlation, "reason", "proof_restored", "status", 200)
			}
			b.voiceChecked = a.now()
			d.active[id] = b
		}
		d.mu.Unlock()
		return b, 200, ""
	}

	// An unavailable authority denies all media, but the fixed admission can
	// recover if a later proof still carries the original membership epoch.
	suspended := status == 503 && a.prototype != nil
	affected := map[string]roomAccess{id: b}
	if suspended {
		if b.voiceChecked.IsZero() {
			d.mu.Unlock()
			return roomAccess{}, 503, reason
		}
		b.voiceChecked = time.Time{}
		d.active[id] = b
	} else {
		if confirmedDeparture && a.prototype != nil {
			// All tabs admitted under this membership lost it together.
			for peer, other := range d.active {
				if other.ref == b.ref && other.user == b.user && other.epoch == b.epoch {
					affected[peer] = other
				}
			}
		}
		for peer, grant := range affected {
			delete(d.active, peer)
			d.oauth.Revoke(grant.session)
		}
	}
	d.mu.Unlock()
	if a.prototype != nil {
		slog.Info("room_access", "session_correlation", b.correlation, "reason", reason, "status", status)
	}
	for peer, grant := range affected {
		a.endDiscordMedia(room, peer, grant, suspended)
	}
	return roomAccess{}, status, reason
}

func (a *API) endDiscordMedia(room, id string, b roomAccess, suspended bool) {
	a.nativeMu.Lock()
	if !suspended {
		delete(a.nativeOwners, b.controlHash)
	}
	var helpers []string
	for sid, s := range a.nativeSessions {
		if s.Owner.Identity == id && s.Owner.Room == room && !s.Revoked {
			helpers = append(helpers, sid)
		}
	}
	a.nativeMu.Unlock()
	if g := a.prototype; g != nil {
		g.mu.Lock()
		g.changedLocked()
		for _, track := range g.tracks {
			if track.owner == id {
				g.retireLocked(track)
			}
		}
		g.mu.Unlock()
		for _, sid := range helpers {
			a.revokeNative(sid)
		}
	} else {
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
	if q.Room == admissionProbeRoom {
		a.recordAdmissionProbe(id)
		fail(w, 403, "Admission denied")
		return
	}
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
			if a.prototype != nil {
				c, cancel := context.WithTimeout(context.Background(), 8*time.Second)
				a.sweepCloudflare(c, true)
				cancel()
			}
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
		if a.prototype != nil {
			a.sweepCloudflare(ctx, false)
		}
	}
}

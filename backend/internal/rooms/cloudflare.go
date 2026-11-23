package rooms

import (
	"context"
	"crypto/hmac"
	"crypto/sha256"
	"encoding/base64"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"regexp"
	"strings"
	"sync"
	"time"

	"github.com/ghptc/whiterun-live/backend/internal/cloudsfu"
	"github.com/pion/sdp/v3"
)

// Each handle owns exactly one provider session and one media transceiver.
// The mutex on an allocation serializes provider mutations, including teardown.
type cfTrack struct {
	operation                              sync.Mutex
	handle, room, owner, user, publication string
	publisherKey                           string // public room-scoped roster key for a screen
	screen, helper                         string // parent screen and native lease for an audio publication
	audio                                  bool
	session, mid                           string // guarded by operation
	until, seen                            time.Time
	ready, closing, answered               bool // guarded by registry mutex
}
type cfRegistry struct {
	controlKey string
	mu         sync.Mutex
	tracks     map[string]*cfTrack
	change     chan struct{}
	waiting    map[string]bool
	media      cloudsfu.Media
}

func (a *API) EnableCloudflarePrototype(media cloudsfu.Media) {
	a.prototype = &cfRegistry{controlKey: randomID(32), tracks: map[string]*cfTrack{}, change: make(chan struct{}), waiting: map[string]bool{}, media: media}
}

// Reproduce the original join response on a retry without storing the bearer.
func (g *cfRegistry) controlFor(peer string) string {
	mac := hmac.New(sha256.New, []byte(g.controlKey))
	mac.Write([]byte(peer))
	return base64.RawURLEncoding.EncodeToString(mac.Sum(nil))
}

type cfInput struct {
	IdleWait    bool     `json:"idleWait,omitempty"`
	Version     string   `json:"version,omitempty"`
	Handles     []string `json:"handles,omitempty"`
	Publication string   `json:"publication"`
	Screen      string   `json:"screen,omitempty"`
	Handle      string   `json:"handle"`
	Mid         string   `json:"mid"`
	SDP         string   `json:"sdp"`
}

var midID = regexp.MustCompile(`^[A-Za-z0-9_-]{1,32}$`)

// Prevent SDP from adding an unaccounted m-line or changing a receiver into a publisher.
func singleMedia(raw, mid, direction, kind string) bool {
	var d sdp.SessionDescription
	if !midID.MatchString(mid) || d.Unmarshal([]byte(raw)) != nil || len(d.MediaDescriptions) != 1 {
		return false
	}
	m := d.MediaDescriptions[0]
	id, ok := m.Attribute("mid")
	if !ok || id != mid || m.MediaName.Media != kind || m.MediaName.Port.Value == 0 {
		return false
	}
	if kind == "audio" {
		// Screen audio negotiates one stereo-capable Opus payload.
		if len(m.MediaName.Formats) != 1 {
			return false
		}
		opus := false
		for _, a := range m.Attributes {
			if a.Key == "rtpmap" && strings.EqualFold(a.Value, m.MediaName.Formats[0]+" opus/48000/2") {
				opus = true
			}
		}
		if !opus {
			return false
		}
	}
	count := 0
	for _, attr := range m.Attributes {
		switch attr.Key {
		case "sendonly", "recvonly", "sendrecv", "inactive":
			if attr.Key != direction {
				return false
			}
			count++
		}
	}
	return count == 1
}
func (a *API) cfOwner(r *http.Request) (roomAccess, string, int) {
	d := a.discord
	if r.Header.Get("Origin") != d.c.Origin {
		return roomAccess{}, "", 403
	}
	id, ref := r.Header.Get("X-Whiterun-Peer"), r.PathValue("ref")
	d.mu.Lock()
	b, ok := d.active[id]
	d.mu.Unlock()
	s, authenticated := d.oauth.RoomEntry(r, b.entry)
	if !authenticated {
		return roomAccess{}, "", 401
	}
	if !ok || b.ref != ref || b.session != s.ID {
		return roomAccess{}, "", 403
	}
	if !b.mediaRequests.Allow() {
		return roomAccess{}, "", 429
	}
	b, status := a.checkDiscord(r.Context(), "dc-"+ref, id)
	return b, id, status
}
func (g *cfRegistry) reserve(b roomAccess, id string, in cfInput, now time.Time, helper *nativeSession) (*cfTrack, int) {
	g.mu.Lock()
	defer g.mu.Unlock()
	if len(g.tracks) >= 512 {
		return nil, 429
	}
	source, parent := in.Publication, in.Screen
	if helper != nil {
		parent = helper.Screen
	}
	if helper != nil || parent != "" {
		screen := g.tracks[parent]
		if screen == nil || screen.room != b.ref || screen.owner != id || screen.audio || screen.publication != "" || screen.closing || !screen.ready {
			if helper == nil {
				return nil, 404
			}
			return nil, 403
		}
	}
	if source != "" {
		pub := g.tracks[source]
		if pub == nil || !pub.ready || pub.closing || pub.publication != "" || pub.room != b.ref || pub.user == b.user {
			return nil, 404
		}
	}
	slots := 0
	for _, t := range g.tracks {
		if t.room != b.ref {
			continue
		}
		if parent != "" && t.screen == parent {
			return nil, 409
		}
		if t.publication == "" && !t.audio {
			slots++
			if parent == "" && source == "" && t.user == b.user {
				return nil, 409
			}
		}
		if source != "" && t.owner == id && t.publication == source {
			return nil, 409
		}
	}
	if parent == "" && source == "" && slots >= 4 {
		return nil, 409
	}
	t := &cfTrack{handle: randomID(18), room: b.ref, owner: id, user: b.user, publication: source, seen: now, until: b.until}
	if parent != "" {
		t.screen = parent
		if helper != nil {
			t.helper = helper.ID
		}
		t.audio = true
	} else if source != "" {
		t.audio = g.tracks[source].audio
		if deadline := g.tracks[source].until; deadline.Before(t.until) {
			t.until = deadline
		}
	} else {
		t.publisherKey = b.participantKey
	}
	// No other goroutine has a reference yet.
	t.operation.Lock()
	g.tracks[t.handle] = t
	g.changedLocked()
	return t, 200
}
func (g *cfRegistry) retireLocked(t *cfTrack) {
	if t.closing {
		return
	}
	t.closing = true
	g.changedLocked()
	if t.publication == "" {
		for _, s := range g.tracks {
			if s.publication == t.handle || s.screen == t.handle {
				g.retireLocked(s)
			}
		}
	}
}
func (g *cfRegistry) closeTrack(ctx context.Context, t *cfTrack) bool {
	t.operation.Lock()
	defer t.operation.Unlock()
	g.mu.Lock()
	exists := g.tracks[t.handle] == t && t.closing
	g.mu.Unlock()
	if !exists {
		return true
	}
	if t.session != "" && g.media.Close(ctx, t.session, t.mid) != nil {
		return false
	}
	g.mu.Lock()
	delete(g.tracks, t.handle)
	g.mu.Unlock()
	return true
}
func (a *API) cfNew(w http.ResponseWriter, r *http.Request, b roomAccess, id string, in cfInput, send bool, helper *nativeSession) {
	g := a.prototype
	if in.Screen != "" && (!send || helper != nil) {
		fail(w, 400, "Unexpected screen association")
		return
	}
	kind := "video"
	if helper != nil || in.Screen != "" {
		kind = "audio"
	}
	if (send && (in.Publication != "" || !singleMedia(in.SDP, in.Mid, "sendonly", kind))) || (!send && in.Publication == "") {
		fail(w, 400, "Expected one authorized media track")
		return
	}
	t, status := g.reserve(b, id, in, a.now(), helper)
	if status != 200 {
		fail(w, status, "Screen unavailable")
		return
	}
	defer t.operation.Unlock()
	// Complete an in-flight allocation even if the browser closes its HTTP request.
	ctx, cancel := context.WithTimeout(context.WithoutCancel(r.Context()), 16*time.Second)
	defer cancel()
	ctx = cloudsfu.WithAuthorizationExpiry(ctx, t.until)
	var desc string
	var err error
	var publisherSession string
	if !send {
		g.mu.Lock()
		p := g.tracks[in.Publication]
		g.mu.Unlock()
		if p != nil {
			if _, ok := a.validDiscord(ctx, "dc-"+b.ref, p.owner); ok {
				p.operation.Lock()
				publisherSession = p.session
				p.operation.Unlock()
			}
		}
		if publisherSession == "" {
			err = errors.New("publisher unavailable")
		}
	}
	if err == nil {
		t.session, err = g.media.NewSession(ctx)
	}
	if err == nil {
		if send {
			t.mid = in.Mid
			desc, err = g.media.Publish(ctx, t.session, t.handle, t.mid, in.SDP)
		} else {
			t.mid, desc, err = g.media.Subscribe(ctx, t.session, publisherSession, in.Publication)
		}
	}
	_, authorized := a.validDiscord(ctx, "dc-"+b.ref, id)
	if helper != nil {
		_, ok := a.cfHelper(r)
		authorized = authorized && ok
	}
	g.mu.Lock()
	if err != nil || !authorized || r.Context().Err() != nil {
		g.retireLocked(t)
	}
	closed := t.closing
	g.mu.Unlock()
	if closed {
		fail(w, 502, "Media negotiation ended")
		return
	}
	write(w, 200, map[string]string{"handle": t.handle, "sdp": desc})
}
func (a *API) cfSignal(w http.ResponseWriter, r *http.Request) {
	b, id, status := a.cfOwner(r)
	if status != 200 {
		fail(w, status, "Discord voice authorization required")
		return
	}
	var in cfInput
	d := json.NewDecoder(http.MaxBytesReader(w, r.Body, 96<<10))
	d.DisallowUnknownFields()
	if d.Decode(&in) != nil || d.Decode(new(any)) != io.EOF {
		fail(w, 400, "Invalid media request")
		return
	}
	op := r.PathValue("action")
	g := a.prototype
	switch op {
	case "publish", "subscribe":
		if op == "publish" && !a.discord.canPublish(b.user) {
			fail(w, 403, "Screen publishing permission required")
			return
		}
		a.cfNew(w, r, b, id, in, op == "publish", nil)
		return
	case "state":
		a.cfState(w, r, b, id, in)
		return
	case "answer", "ready", "close":
	default:
		http.NotFound(w, r)
		return
	}
	g.mu.Lock()
	t := g.tracks[in.Handle]
	owned := t != nil && t.owner == id && t.room == b.ref
	if !owned || (t.closing && op != "close") {
		g.mu.Unlock()
		fail(w, 404, "Track unavailable")
		return
	}
	if op == "close" {
		g.retireLocked(t)
		g.mu.Unlock()
		if !g.closeTrack(r.Context(), t) {
			fail(w, 503, "Closure pending")
			return
		}
		write(w, 200, struct{}{})
		return
	}
	g.mu.Unlock()
	t.operation.Lock()
	defer t.operation.Unlock()
	g.mu.Lock()
	if t.closing {
		g.mu.Unlock()
		fail(w, 404, "Track unavailable")
		return
	}
	if op == "ready" && t.publication == "" && t.helper == "" {
		t.ready = true
		g.changedLocked()
		t.seen = a.now()
		g.mu.Unlock()
		write(w, 200, struct{}{})
		return
	}
	kind := "video"
	if t.audio {
		kind = "audio"
	}
	ok := op == "answer" && t.publication != "" && !t.answered && singleMedia(in.SDP, t.mid, "recvonly", kind)
	g.mu.Unlock()
	if !ok {
		fail(w, 400, "Invalid track operation")
		return
	}
	err := g.media.Answer(r.Context(), t.session, in.SDP)
	g.mu.Lock()
	if err != nil {
		g.retireLocked(t)
	} else {
		t.answered = true
		t.seen = a.now()
	}
	closed := t.closing
	g.mu.Unlock()
	if closed {
		fail(w, 502, "Subscription ended")
		return
	}
	write(w, 200, struct{}{})
}
func (a *API) sweepCloudflare(ctx context.Context, shutdown bool) {
	g := a.prototype
	g.mu.Lock()
	var ending []*cfTrack
	for _, t := range g.tracks {
		a.discord.mu.Lock()
		_, ok := a.discord.active[t.owner]
		a.discord.mu.Unlock()
		if shutdown || !ok || (!t.until.IsZero() && !a.now().Before(t.until)) || a.now().Sub(t.seen) > 20*time.Second {
			g.retireLocked(t)
		}
	}
	for _, t := range g.tracks {
		if t.closing {
			ending = append(ending, t)
		}
	}
	g.mu.Unlock()
	// A stalled provider session must not delay other revocations.
	var wg sync.WaitGroup
	for _, t := range ending {
		wg.Add(1)
		go func() { defer wg.Done(); g.closeTrack(ctx, t) }()
	}
	wg.Wait()
}

// The native lease can publish only its own parent's single audio track.
func (a *API) cfHelper(r *http.Request) (nativeSession, bool) {
	a.nativeMu.Lock()
	defer a.nativeMu.Unlock()
	s := a.nativeSessions[r.PathValue("session")]
	if s == nil || !s.Claimed || !s.Watching || s.Revoked || !a.now().Before(s.Expires) || s.LeaseHash != bearerHash(r) {
		return nativeSession{}, false
	}
	return *s, true
}
func (a *API) cfHelperPublish(w http.ResponseWriter, r *http.Request) {
	s, ok := a.cfHelper(r)
	if !ok {
		fail(w, 403, "Audio authorization ended")
		return
	}
	b, ok := a.validDiscord(r.Context(), s.Owner.Room, s.Owner.Identity)
	if !ok {
		fail(w, 403, "Voice authorization ended")
		return
	}
	var in cfInput
	d := json.NewDecoder(http.MaxBytesReader(w, r.Body, 96<<10))
	d.DisallowUnknownFields()
	if d.Decode(&in) != nil || d.Decode(new(any)) != io.EOF {
		fail(w, 400, "Invalid audio offer")
		return
	}
	a.cfNew(w, r, b, s.Owner.Identity, in, true, &s)
}

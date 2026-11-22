package rooms

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"regexp"
	"slices"
	"sync"
	"time"

	"github.com/ghptc/whiterun-live/backend/internal/cloudsfu"
	"github.com/pion/sdp/v3"
)

// Each handle owns exactly one provider session and one video transceiver.
// The mutex on an allocation serializes provider mutations, including teardown.
type cfTrack struct {
	operation                              sync.Mutex
	handle, room, owner, user, publication string
	session, mid                           string // guarded by operation
	seen                                   time.Time
	ready, closing, answered               bool // guarded by registry mutex
}
type cfRegistry struct {
	mu     sync.Mutex
	tracks map[string]*cfTrack
	media  cloudsfu.Media
}

func (a *API) EnableCloudflarePrototype(media cloudsfu.Media) {
	a.prototype = &cfRegistry{tracks: map[string]*cfTrack{}, media: media}
}

type cfInput struct {
	Handles     []string `json:"handles,omitempty"`
	Publication string   `json:"publication"`
	Handle      string   `json:"handle"`
	Mid         string   `json:"mid"`
	SDP         string   `json:"sdp"`
}

var midID = regexp.MustCompile(`^[A-Za-z0-9_-]{1,32}$`)

// Prevent SDP from adding an unaccounted m-line or changing a receiver into a publisher.
func singleVideo(raw, mid, direction string) bool {
	var d sdp.SessionDescription
	if !midID.MatchString(mid) || d.Unmarshal([]byte(raw)) != nil || len(d.MediaDescriptions) != 1 {
		return false
	}
	m := d.MediaDescriptions[0]
	id, ok := m.Attribute("mid")
	if !ok || id != mid || m.MediaName.Media != "video" || m.MediaName.Port.Value == 0 {
		return false
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
	s, ok := d.oauth.Current(r)
	if !ok {
		return roomAccess{}, "", 401
	}
	id, ref := r.Header.Get("X-Whiterun-Peer"), r.PathValue("ref")
	d.mu.Lock()
	b, ok := d.active[id]
	d.mu.Unlock()
	if !ok || b.ref != ref || b.session != s.ID {
		return roomAccess{}, "", 403
	}
	b, ok = a.validDiscord(r.Context(), "dc-"+ref, id)
	if !ok {
		return roomAccess{}, "", 403
	}
	return b, id, 200
}
func (g *cfRegistry) reserve(b roomAccess, id, source string, now time.Time) (*cfTrack, int) {
	g.mu.Lock()
	defer g.mu.Unlock()
	if len(g.tracks) >= 512 {
		return nil, 429
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
		if t.publication == "" {
			slots++
			if source == "" && t.user == b.user {
				return nil, 409
			}
		}
		if source != "" && t.owner == id && t.publication == source {
			return nil, 409
		}
	}
	if source == "" && slots >= 4 {
		return nil, 409
	}
	t := &cfTrack{handle: randomID(18), room: b.ref, owner: id, user: b.user, publication: source, seen: now}
	// No other goroutine has a reference yet.
	t.operation.Lock()
	g.tracks[t.handle] = t
	return t, 200
}
func (g *cfRegistry) retireLocked(t *cfTrack) {
	t.closing = true
	if t.publication == "" {
		for _, s := range g.tracks {
			if s.publication == t.handle {
				s.closing = true
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
func (a *API) cfNew(w http.ResponseWriter, r *http.Request, b roomAccess, id string, in cfInput, send bool) {
	g := a.prototype
	if (send && (in.Publication != "" || !singleVideo(in.SDP, in.Mid, "sendonly"))) || (!send && in.Publication == "") {
		fail(w, 400, "Expected one screen track")
		return
	}
	t, status := g.reserve(b, id, in.Publication, a.now())
	if status != 200 {
		fail(w, status, "Screen unavailable")
		return
	}
	defer t.operation.Unlock()
	// Complete an in-flight allocation even if the browser closes its HTTP request.
	ctx, cancel := context.WithTimeout(context.WithoutCancel(r.Context()), 16*time.Second)
	defer cancel()
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
		a.cfNew(w, r, b, id, in, op == "publish")
		return
	case "state":
		g.mu.Lock()
		list := []string{}
		owned := []string{}
		for _, t := range g.tracks {
			if t.room == b.ref && !t.closing {
				if t.owner == id {
					owned = append(owned, t.handle)
				}
				if t.owner == id && (t.ready || t.answered) && slices.Contains(in.Handles, t.handle) {
					t.seen = a.now()
				}
				if t.publication == "" && t.ready && t.user != b.user {
					list = append(list, t.handle)
				}
			}
		}
		g.mu.Unlock()
		write(w, 200, map[string]any{"publications": list, "owned": owned})
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
	if op == "ready" && t.publication == "" {
		t.ready = true
		t.seen = a.now()
		g.mu.Unlock()
		write(w, 200, struct{}{})
		return
	}
	ok := op == "answer" && t.publication != "" && !t.answered && singleVideo(in.SDP, t.mid, "recvonly")
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
		if shutdown || !ok || a.now().Sub(t.seen) > 20*time.Second {
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

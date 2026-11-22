package rooms

import (
	"crypto/sha256"
	"encoding/base64"
	"encoding/json"
	"net/http"
	"slices"
	"time"
)

const stateWait = 12 * time.Second // Below the existing 20-second track liveness timeout.
const idleStateWait = time.Minute

type mediaState struct {
	Publications []string          `json:"publications"`
	Audio        map[string]string `json:"audio"`
	Owned        []string          `json:"owned"`
	Version      string            `json:"version,omitempty"`
}

func (g *cfRegistry) changedLocked() {
	close(g.change)
	g.change = make(chan struct{})
}

func (g *cfRegistry) snapshot(b roomAccess, id string, handles []string, received time.Time) (mediaState, <-chan struct{}) {
	g.mu.Lock()
	defer g.mu.Unlock()
	s := mediaState{Publications: []string{}, Audio: map[string]string{}, Owned: []string{}}
	for _, t := range g.tracks {
		if t.room != b.ref || t.closing {
			continue
		}
		if t.owner == id {
			s.Owned = append(s.Owned, t.handle)
			if !received.IsZero() && t.helper == "" && (t.ready || t.answered) && slices.Contains(handles, t.handle) {
				t.seen = received
			}
		}
		if t.publication == "" && t.ready && t.user != b.user {
			if t.audio {
				s.Audio[t.screen] = t.handle
			} else {
				s.Publications = append(s.Publications, t.handle)
			}
		}
	}
	slices.Sort(s.Owned)
	slices.Sort(s.Publications)
	data, _ := json.Marshal(s)
	hash := sha256.Sum256(data)
	s.Version = base64.RawURLEncoding.EncodeToString(hash[:16])
	return s, g.change
}

func (a *API) cfState(w http.ResponseWriter, r *http.Request, b roomAccess, id string, in cfInput) {
	g := a.prototype
	if len(in.Handles) > 512 || len(in.Version) > 32 {
		fail(w, 400, "Invalid state request")
		return
	}
	snapshot, changed := g.snapshot(b, id, in.Handles, a.now())
	if in.Version != snapshot.Version {
		write(w, 200, snapshot)
		return
	}
	g.mu.Lock()
	if g.waiting[id] {
		g.mu.Unlock()
		fail(w, 409, "State request already active")
		return
	}
	g.waiting[id] = true
	g.mu.Unlock()
	defer func() { g.mu.Lock(); delete(g.waiting, id); g.mu.Unlock() }()
	wait := stateWait
	if in.IdleWait && len(snapshot.Owned) == 0 {
		wait = idleStateWait
	}
	timeout := time.NewTimer(min(wait, b.until.Sub(a.now())))
	defer timeout.Stop()
	reconcile := time.NewTicker(2 * time.Second)
	defer reconcile.Stop()
	for {
		finished := false
		select {
		case <-r.Context().Done():
			return
		case <-timeout.C:
			finished = true
		case <-changed:
		case <-reconcile.C:
		}
		// A delayed response may straddle departure or the exact lease boundary.
		// Reconciliation uses the cached registry until a response is due.
		a.discord.mu.Lock()
		_, active := a.discord.active[id]
		a.discord.mu.Unlock()
		if !a.now().Before(b.until) {
			fail(w, 410, "Session expired")
			return
		}
		if !active {
			fail(w, 403, "Voice authorization ended")
			return
		}
		snapshot, changed = g.snapshot(b, id, nil, time.Time{})
		if finished || snapshot.Version != in.Version {
			if _, ok := a.validDiscord(r.Context(), "dc-"+b.ref, id); !ok {
				fail(w, 403, "Voice authorization ended")
				return
			}
			snapshot, _ = g.snapshot(b, id, nil, time.Time{})
			write(w, 200, snapshot)
			return
		}
	}
}

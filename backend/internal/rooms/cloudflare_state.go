package rooms

import (
	"cmp"
	"crypto/sha256"
	"encoding/base64"
	"encoding/json"
	"net/http"
	"slices"
	"time"
)

const stateWait = 12 * time.Second // Below the existing 20-second track liveness timeout.
const idleStateWait = time.Minute

// Allow an idle browser to finish its long poll plus a short reconnect margin.
const presenceLifetime = idleStateWait + 15*time.Second

type participant struct {
	Key     string `json:"key"`
	Name    string `json:"name"`
	Avatar  string `json:"avatar,omitempty"`
	Sharing bool   `json:"sharing"`
}

type mediaState struct {
	Participants []participant     `json:"participants"`
	Publications []string          `json:"publications"`
	Publishers   map[string]string `json:"publishers,omitempty"`
	Audio        map[string]string `json:"audio"`
	Owned        []string          `json:"owned"`
	Version      string            `json:"version,omitempty"`
}

func (g *cfRegistry) changedLocked() {
	close(g.change)
	g.change = make(chan struct{})
}

func (a *API) snapshot(b roomAccess, id string, handles []string, received time.Time) (mediaState, <-chan struct{}, int) {
	g := a.prototype
	g.mu.Lock()
	d := a.discord
	d.mu.Lock()
	now := a.now()
	requester, ok := d.active[id]
	status := http.StatusOK
	switch {
	case !now.Before(b.until):
		status = http.StatusGone
	case !ok:
		status = http.StatusForbidden
	case requester.voiceChecked.IsZero():
		status = http.StatusServiceUnavailable
	}
	if status != 200 {
		d.mu.Unlock()
		g.mu.Unlock()
		return mediaState{}, nil, status
	}
	if !received.IsZero() {
		requester.lastSeen = received
		d.active[id] = requester
	}
	publishers := make(map[string]bool)
	s := mediaState{Participants: []participant{}, Publications: []string{}, Publishers: map[string]string{}, Audio: map[string]string{}, Owned: []string{}}
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
		if t.publication == "" && t.ready && !t.audio {
			publishers[t.owner] = true
		}
		if t.publication == "" && t.ready && t.user != b.user {
			if t.audio {
				s.Audio[t.screen] = t.handle
			} else {
				s.Publications = append(s.Publications, t.handle)
				s.Publishers[t.handle] = t.publisherKey
			}
		}
	}
	// Merge tabs by verified identity. Choose a stable representative even when
	// separate OAuth logins have different profile snapshots.
	members := make(map[string]participant)
	profiles := make(map[string]string)
	for peer, grant := range d.active {
		if grant.ref != b.ref || !now.Before(grant.until) || now.Sub(grant.lastSeen) >= presenceLifetime || now.Sub(grant.voiceChecked) >= presenceLifetime {
			continue
		}
		key := grant.participantKey
		member, exists := members[key]
		if !exists || peer < profiles[key] {
			member.Key, member.Name, member.Avatar = key, grant.displayName, grant.avatar
			profiles[key] = peer
		}
		member.Sharing = member.Sharing || publishers[peer]
		members[key] = member
	}
	changed := g.change
	d.mu.Unlock()
	g.mu.Unlock()
	for _, p := range members {
		s.Participants = append(s.Participants, p)
	}
	slices.SortFunc(s.Participants, func(x, y participant) int {
		if n := cmp.Compare(x.Name, y.Name); n != 0 {
			return n
		}
		return cmp.Compare(x.Key, y.Key)
	})
	slices.Sort(s.Owned)
	slices.Sort(s.Publications)
	data, _ := json.Marshal(s)
	hash := sha256.Sum256(data)
	s.Version = base64.RawURLEncoding.EncodeToString(hash[:16])
	return s, changed, http.StatusOK
}

func (a *API) cfState(w http.ResponseWriter, r *http.Request, b roomAccess, id string, in cfInput) {
	g := a.prototype
	if len(in.Handles) > 512 || len(in.Version) > 32 {
		fail(w, 400, "Invalid state request")
		return
	}
	received := a.now()
	var snapshot mediaState
	var changed <-chan struct{}
	refresh := func(handles []string, seen time.Time) bool {
		var status int
		snapshot, changed, status = a.snapshot(b, id, handles, seen)
		if status != 200 {
			fail(w, status, "Room access unavailable")
		}
		return status == 200
	}
	if !refresh(in.Handles, received) {
		return
	}
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
			a.discord.mu.Lock()
			if cur, ok := a.discord.active[id]; ok && cur.lastSeen.Equal(received) {
				cur.lastSeen = time.Time{}
				a.discord.active[id] = cur
			}
			a.discord.mu.Unlock()
			g.mu.Lock()
			g.changedLocked()
			g.mu.Unlock()
			return
		case <-timeout.C:
			finished = true
		case <-changed:
		case <-reconcile.C:
		}
		// A delayed response may straddle departure or the exact lease boundary.
		// Reconciliation uses the cached registry until a response is due.
		if !refresh(nil, time.Time{}) {
			return
		}
		if finished || snapshot.Version != in.Version {
			if _, status := a.checkDiscord(r.Context(), "dc-"+b.ref, id); status != 200 {
				fail(w, status, "Voice authorization ended")
				return
			}
			if !refresh(nil, time.Time{}) {
				return
			}
			write(w, 200, snapshot)
			return
		}
	}
}

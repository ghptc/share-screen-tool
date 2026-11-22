package rooms

import (
	"context"
	"crypto/sha256"
	"encoding/json"
	"net/http"
	"strings"
	"time"

	"github.com/livekit/protocol/auth"
	"github.com/livekit/protocol/livekit"
)

type nativeOwner struct {
	Room, Identity string
	Expires        time.Time
}
type nativeSession struct {
	Owner                      nativeOwner
	ID, Screen                 string
	CodeHash, LeaseHash        [32]byte
	Expires                    time.Time
	Claimed, Revoked, Watching bool
}

func (a *API) registerNative(mux *http.ServeMux) {
	mux.Handle("POST /native-audio/sessions", a.guard(http.HandlerFunc(a.createNative)))
	mux.Handle("POST /native-audio/claim", a.guard(http.HandlerFunc(a.claimNative)))
	mux.Handle("POST /native-audio/{session}/watch", a.guard(http.HandlerFunc(a.watchOwner)))
	mux.Handle("POST /native-audio/{session}/lease", a.guard(http.HandlerFunc(a.leaseNative)))
	mux.Handle("POST /native-audio/{session}/stop", a.guard(http.HandlerFunc(a.stopNative)))
}

// Keep one authenticated HTTP response open while the owner tab is pairing
// or sharing. Closing the tab drops the response even during SFU resume grace.
func (a *API) watchOwner(w http.ResponseWriter, r *http.Request) {
	id := r.PathValue("session")
	a.nativeMu.Lock()
	s := a.nativeSessions[id]
	owner, ok := a.nativeOwners[bearerHash(r)]
	if !ok || s == nil || s.Owner != owner || s.Revoked || s.Watching || !a.now().Before(s.Expires) {
		a.nativeMu.Unlock()
		fail(w, 403, "Native audio owner session unavailable")
		return
	}
	s.Watching = true
	a.nativeMu.Unlock()
	defer a.revokeNative(id)

	w.Header().Set("Content-Type", "text/plain")
	w.Header().Set("X-Accel-Buffering", "no")
	controller := http.NewResponseController(w)
	ticker := time.NewTicker(2 * time.Second)
	defer ticker.Stop()
	for {
		// Bound each flush, including on a broken connection, without changing
		// the server's write timeout for other responses.
		if err := controller.SetWriteDeadline(time.Now().Add(5 * time.Second)); err != nil {
			return
		}
		if _, err := w.Write([]byte("active\n")); err != nil {
			return
		}
		if err := controller.Flush(); err != nil {
			return
		}
		select {
		case <-r.Context().Done():
			return
		case <-ticker.C:
			a.nativeMu.Lock()
			active := a.nativeSessions[id] == s && !s.Revoked
			a.nativeMu.Unlock()
			if !active {
				return
			}
		}
	}
}
func bearerHash(r *http.Request) [32]byte {
	return sha256.Sum256([]byte(strings.TrimPrefix(r.Header.Get("Authorization"), "Bearer ")))
}
func (a *API) nativeContext(ctx context.Context, room string) (context.Context, error) {
	token, err := auth.NewAccessToken(a.cfg.APIKey, a.cfg.APISecret).SetValidFor(time.Minute).SetVideoGrant(&auth.VideoGrant{Room: room, RoomAdmin: true}).ToJWT()
	if err != nil {
		return nil, err
	}
	return withBearer(ctx, token)
}
func (a *API) screenActive(ctx context.Context, owner nativeOwner, screen string) bool {
	if !a.now().Before(owner.Expires) {
		return false
	}
	ctx, err := a.nativeContext(ctx, owner.Room)
	if err != nil {
		return false
	}
	p, err := a.client.GetParticipant(ctx, &livekit.RoomParticipantIdentity{Room: owner.Room, Identity: owner.Identity})
	if err != nil {
		return false
	}
	for _, track := range p.Tracks {
		if track.Sid == screen && track.Type == livekit.TrackType_VIDEO && track.Source == livekit.TrackSource_SCREEN_SHARE {
			return true
		}
	}
	return false
}
func (a *API) createNative(w http.ResponseWriter, r *http.Request) {
	var input struct {
		Screen string `json:"screen"`
	}
	if !decode(w, r, &input) {
		return
	}
	a.nativeMu.Lock()
	owner, ok := a.nativeOwners[bearerHash(r)]
	a.nativeMu.Unlock()
	if !ok || !a.screenActive(r.Context(), owner, input.Screen) {
		fail(w, 403, "An active authorized screen publisher is required")
		return
	}
	a.nativeMu.Lock()
	for id, s := range a.nativeSessions {
		if s.Revoked || !a.now().Before(s.Expires) {
			delete(a.nativeSessions, id)
			continue
		}
		if s.Owner == owner {
			a.nativeMu.Unlock()
			fail(w, 409, "Stop the existing native audio session first")
			return
		}
	}
	if len(a.nativeSessions) >= maxRooms*64 {
		a.nativeMu.Unlock()
		fail(w, 429, "Native audio session limit reached")
		return
	}
	code := randomID(32)
	s := &nativeSession{Owner: owner, ID: "native-audio-" + randomID(18), Screen: input.Screen, CodeHash: sha256.Sum256([]byte(code)), Expires: a.now().Add(time.Minute)}
	a.nativeSessions[s.ID] = s
	a.nativeMu.Unlock()
	go a.watchNative(s.ID)
	write(w, 201, map[string]any{"session": s.ID, "code": code, "expiresAt": s.Expires})
}
func (a *API) claimNative(w http.ResponseWriter, r *http.Request) {
	var input struct {
		Code      string `json:"code"`
		LocalOnly bool   `json:"localOnly"`
	}
	if !decode(w, r, &input) {
		return
	}
	hash := sha256.Sum256([]byte(input.Code))
	a.nativeMu.Lock()
	var found *nativeSession
	for _, s := range a.nativeSessions {
		if !s.Revoked && s.Watching && !s.Claimed && a.now().Before(s.Expires) && s.CodeHash == hash {
			copy := *s
			found = &copy
			break
		}
	}
	a.nativeMu.Unlock()
	if found == nil || (input.LocalOnly && found.Owner.Room != localRoom) || !a.screenActive(r.Context(), found.Owner, found.Screen) {
		fail(w, 403, "Pairing code is invalid, expired, or its screen ended")
		return
	}
	lease := randomID(32)
	a.nativeMu.Lock()
	s := a.nativeSessions[found.ID]
	if s == nil || s.Revoked || s.Claimed || !a.now().Before(s.Expires) {
		a.nativeMu.Unlock()
		fail(w, 403, "Pairing code already used")
		return
	}
	s.Claimed = true
	s.LeaseHash = sha256.Sum256([]byte(lease))
	s.Expires = a.now().Add(10 * time.Second)
	a.nativeMu.Unlock()
	grant := &auth.VideoGrant{RoomJoin: true, Room: found.Owner.Room}
	grant.SetCanPublish(true)
	grant.SetCanPublishSources([]livekit.TrackSource{livekit.TrackSource_SCREEN_SHARE_AUDIO})
	grant.SetCanSubscribe(false)
	grant.SetCanPublishData(false)
	grant.SetCanUpdateOwnMetadata(false)
	grant.SetCanSubscribeMetrics(false)
	grant.SetCanManageAgentSession(false)
	metadata, _ := json.Marshal(map[string]string{"nativeAudioOwner": found.Owner.Identity, "nativeAudioScreen": found.Screen})
	token, err := auth.NewAccessToken(a.cfg.APIKey, a.cfg.APISecret).SetIdentity(found.ID).SetName("Native screen audio").SetMetadata(string(metadata)).SetValidFor(30 * time.Second).SetVideoGrant(grant).ToJWT()
	if err != nil {
		a.revokeNative(found.ID)
		fail(w, 500, "Could not authorize native audio")
		return
	}
	write(w, 200, map[string]any{"session": found.ID, "lease": lease, "token": token, "serverUrl": a.cfg.WSURL})
}
func (a *API) leaseNative(w http.ResponseWriter, r *http.Request) {
	a.nativeMu.Lock()
	s := a.nativeSessions[r.PathValue("session")]
	var copy nativeSession
	ok := s != nil && !s.Revoked && s.Claimed && s.LeaseHash == bearerHash(r) && a.now().Before(s.Expires)
	if ok {
		copy = *s
	}
	a.nativeMu.Unlock()
	if !ok || !a.screenActive(r.Context(), copy.Owner, copy.Screen) {
		fail(w, 403, "Native audio session ended")
		return
	}
	a.nativeMu.Lock()
	s = a.nativeSessions[copy.ID]
	if s == nil || s.Revoked {
		a.nativeMu.Unlock()
		fail(w, 403, "Native audio session ended")
		return
	}
	s.Expires = a.now().Add(10 * time.Second)
	a.nativeMu.Unlock()
	write(w, 200, map[string]bool{"active": true})
}
func (a *API) stopNative(w http.ResponseWriter, r *http.Request) {
	a.nativeMu.Lock()
	s := a.nativeSessions[r.PathValue("session")]
	owner, ownerOK := a.nativeOwners[bearerHash(r)]
	ok := s != nil && ((ownerOK && owner == s.Owner) || s.LeaseHash == bearerHash(r) && s.Claimed)
	a.nativeMu.Unlock()
	if !ok {
		fail(w, 403, "Native audio session is not authorized")
		return
	}
	a.revokeNative(r.PathValue("session"))
	write(w, 200, map[string]bool{"stopped": true})
}
func (a *API) revokeNative(id string) {
	a.nativeMu.Lock()
	s := a.nativeSessions[id]
	if s == nil || s.Revoked {
		a.nativeMu.Unlock()
		return
	}
	s.Revoked = true
	owner := s.Owner
	a.nativeMu.Unlock()
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	ctx, err := a.nativeContext(ctx, owner.Room)
	if err == nil {
		_, _ = a.client.RemoveParticipant(ctx, &livekit.RoomParticipantIdentity{Room: owner.Room, Identity: id})
	}
}
func (a *API) watchNative(id string) {
	ticker := time.NewTicker(time.Second)
	defer ticker.Stop()
	for range ticker.C {
		a.nativeMu.Lock()
		s := a.nativeSessions[id]
		if s == nil || s.Revoked {
			a.nativeMu.Unlock()
			return
		}
		copy := *s
		a.nativeMu.Unlock()
		ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
		active := a.screenActive(ctx, copy.Owner, copy.Screen)
		cancel()
		a.nativeMu.Lock()
		current := a.nativeSessions[id]
		expired := current == nil || !a.now().Before(current.Expires)
		a.nativeMu.Unlock()
		if !active || expired {
			a.revokeNative(id)
			return
		}
	}
}

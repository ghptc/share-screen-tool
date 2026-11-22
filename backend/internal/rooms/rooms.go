// Package rooms owns local invitation capabilities. LiveKit owns participant presence.
package rooms

import (
	"context"
	"crypto/rand"
	"crypto/sha256"
	"crypto/subtle"
	"encoding/base64"
	"encoding/json"
	"io"
	"mime"
	"net/http"
	"strings"
	"sync"
	"time"
	"unicode"
	"unicode/utf8"

	"github.com/livekit/protocol/auth"
	"github.com/livekit/protocol/livekit"
	"golang.org/x/time/rate"
)

const TokenTTL = 5 * time.Minute
const InviteTTL = 8 * time.Hour
const maxRooms = 100

type Config struct{ APIKey, APISecret, AdminKey, HTTPURL, WSURL, AppOrigin string }
type entry struct {
	ID, Title   string
	InviteHash  [32]byte
	PublishHash [32]byte
	Expires     time.Time
	Joins       *rate.Limiter
}
type API struct {
	cfg      Config
	mu       sync.Mutex
	rooms    map[string]entry
	client   livekit.RoomService
	now      func() time.Time
	requests *rate.Limiter
}

func New(cfg Config) *API {
	return &API{cfg: cfg, rooms: make(map[string]entry), client: livekit.NewRoomServiceProtobufClient(cfg.HTTPURL, &http.Client{Timeout: 5 * time.Second}), now: time.Now, requests: rate.NewLimiter(rate.Limit(5), 20)}
}

func (a *API) Register(mux *http.ServeMux) {
	mux.Handle("POST /rooms", a.guard(http.HandlerFunc(a.create)))
	mux.Handle("POST /rooms/{id}/join", a.guard(http.HandlerFunc(a.join)))
}

func (a *API) guard(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Cache-Control", "no-store")
		w.Header().Set("Referrer-Policy", "no-referrer")
		if origin := r.Header.Get("Origin"); origin != "" && origin != a.cfg.AppOrigin {
			fail(w, 403, "Origin not allowed")
			return
		}
		if !a.requests.Allow() {
			fail(w, 429, "Too many requests; try again shortly")
			return
		}
		media, _, err := mime.ParseMediaType(r.Header.Get("Content-Type"))
		if err != nil || media != "application/json" {
			fail(w, 415, "Content-Type must be application/json")
			return
		}
		next.ServeHTTP(w, r)
	})
}

func (a *API) create(w http.ResponseWriter, r *http.Request) {
	supplied := sha256.Sum256([]byte(strings.TrimPrefix(r.Header.Get("Authorization"), "Bearer ")))
	expected := sha256.Sum256([]byte(a.cfg.AdminKey))
	if !strings.HasPrefix(r.Header.Get("Authorization"), "Bearer ") || a.cfg.AdminKey == "" || subtle.ConstantTimeCompare(supplied[:], expected[:]) != 1 {
		fail(w, 401, "A valid local operator key is required")
		return
	}
	var input struct {
		Title string `json:"title"`
	}
	if !decode(w, r, &input) {
		return
	}
	input.Title = strings.TrimSpace(input.Title)
	if !validLabel(input.Title, 80) {
		fail(w, 400, "Room title must contain 1–80 characters without control characters")
		return
	}
	id, invite, publishKey := randomID(18), randomID(32), randomID(32)
	now := a.now()
	item := entry{ID: id, Title: input.Title, InviteHash: sha256.Sum256([]byte(invite)), PublishHash: sha256.Sum256([]byte(publishKey)), Expires: now.Add(InviteTTL), Joins: rate.NewLimiter(rate.Every(time.Second), 10)}
	// Reserve before the network call to keep capacity bounded under concurrent creation.
	a.mu.Lock()
	for key, room := range a.rooms {
		if !now.Before(room.Expires) {
			delete(a.rooms, key)
		}
	}
	if len(a.rooms) >= maxRooms {
		a.mu.Unlock()
		fail(w, 429, "Local room limit reached")
		return
	}
	a.rooms[id] = item
	a.mu.Unlock()
	token, err := auth.NewAccessToken(a.cfg.APIKey, a.cfg.APISecret).SetValidFor(time.Minute).SetVideoGrant(&auth.VideoGrant{RoomCreate: true}).ToJWT()
	if err == nil {
		var ctx context.Context
		ctx, err = withBearer(r.Context(), token)
		if err == nil {
			_, err = a.client.CreateRoom(ctx, &livekit.CreateRoomRequest{Name: id, EmptyTimeout: 300, DepartureTimeout: 20, MaxParticipants: 64})
		}
	}
	if err != nil {
		a.mu.Lock()
		delete(a.rooms, id)
		a.mu.Unlock()
		fail(w, 502, "LiveKit could not create the room; try again")
		return
	}
	write(w, 201, map[string]any{"id": id, "title": item.Title, "invite": invite, "publishKey": publishKey, "inviteExpiresAt": item.Expires})
}

func (a *API) join(w http.ResponseWriter, r *http.Request) {
	var input struct {
		Invite      string `json:"invite"`
		DisplayName string `json:"displayName"`
		PublishKey  string `json:"publishKey,omitempty"`
	}
	if !decode(w, r, &input) {
		return
	}
	hash := sha256.Sum256([]byte(input.Invite))
	a.mu.Lock()
	room, ok := a.rooms[r.PathValue("id")]
	authorized := ok && a.now().Before(room.Expires) && subtle.ConstantTimeCompare(hash[:], room.InviteHash[:]) == 1
	a.mu.Unlock()
	if !authorized {
		fail(w, 403, "Room invitation is invalid or expired")
		return
	}
	canPublish := false
	if input.PublishKey != "" {
		publishHash := sha256.Sum256([]byte(input.PublishKey))
		if subtle.ConstantTimeCompare(publishHash[:], room.PublishHash[:]) != 1 {
			fail(w, 403, "Room invitation is invalid or expired")
			return
		}
		canPublish = true
	}
	if !room.Joins.Allow() {
		fail(w, 429, "Too many joins; try again shortly")
		return
	}
	input.DisplayName = strings.TrimSpace(input.DisplayName)
	if !validLabel(input.DisplayName, 64) {
		fail(w, 400, "Display name must contain 1–64 characters without control characters")
		return
	}
	identity := "participant-" + randomID(18)
	grant := &auth.VideoGrant{RoomJoin: true, Room: room.ID}
	grant.SetCanPublish(canPublish)
	if canPublish {
		grant.SetCanPublishSources([]livekit.TrackSource{livekit.TrackSource_SCREEN_SHARE})
	}
	grant.SetCanPublishData(false)
	grant.SetCanSubscribe(true)
	grant.SetCanUpdateOwnMetadata(false)
	grant.SetCanSubscribeMetrics(false)
	grant.SetCanManageAgentSession(false)
	token, err := auth.NewAccessToken(a.cfg.APIKey, a.cfg.APISecret).SetIdentity(identity).SetName(input.DisplayName).SetValidFor(TokenTTL).SetVideoGrant(grant).ToJWT()
	if err != nil {
		fail(w, 500, "Could not authorize participant")
		return
	}
	write(w, 200, map[string]any{"token": token, "serverUrl": a.cfg.WSURL, "identity": identity, "displayName": input.DisplayName, "roomId": room.ID, "title": room.Title, "tokenExpiresAt": a.now().Add(TokenTTL), "canPublish": canPublish})
}

func randomID(bytes int) string {
	data := make([]byte, bytes)
	if _, err := rand.Read(data); err != nil {
		panic("operating system random source unavailable")
	}
	return base64.RawURLEncoding.EncodeToString(data)
}
func validLabel(value string, limit int) bool {
	if !utf8.ValidString(value) || utf8.RuneCountInString(value) < 1 || utf8.RuneCountInString(value) > limit {
		return false
	}
	for _, r := range value {
		if unicode.IsControl(r) {
			return false
		}
	}
	return true
}
func decode(w http.ResponseWriter, r *http.Request, out any) bool {
	r.Body = http.MaxBytesReader(w, r.Body, 4096)
	decoder := json.NewDecoder(r.Body)
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(out); err != nil {
		fail(w, 400, "Invalid request body")
		return false
	}
	if err := decoder.Decode(new(any)); err != io.EOF {
		fail(w, 400, "Expected one JSON object")
		return false
	}
	return true
}
func fail(w http.ResponseWriter, status int, message string) {
	write(w, status, map[string]string{"error": message})
}
func write(w http.ResponseWriter, status int, value any) {
	w.Header().Set("Content-Type", "application/json")
	w.Header().Set("Cache-Control", "no-store")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(value)
}

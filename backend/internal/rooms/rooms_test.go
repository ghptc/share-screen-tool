package rooms

import (
	"bytes"
	"context"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/golang-jwt/jwt/v5"
	"github.com/livekit/protocol/auth"
	"github.com/livekit/protocol/livekit"
	"golang.org/x/time/rate"
	"google.golang.org/protobuf/proto"
)

const testAdmin = "test-local-operator-key-at-least-32-characters"

func harness(t *testing.T, upstream string) (*API, string) {
	t.Helper()
	a := New(Config{APIKey: "devkey", APISecret: "secret", AdminKey: testAdmin, HTTPURL: upstream, WSURL: "ws://127.0.0.1:7880", AppOrigin: "http://localhost:5173"})
	a.requests = rate.NewLimiter(rate.Inf, 1000)
	mux := http.NewServeMux()
	a.Register(mux)
	server := httptest.NewServer(mux)
	t.Cleanup(server.Close)
	return a, server.URL
}
func fakeLiveKit(t *testing.T, status int) string {
	t.Helper()
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		verifier, err := auth.ParseAPIToken(strings.TrimPrefix(r.Header.Get("Authorization"), "Bearer "))
		if err != nil {
			t.Error(err)
			w.WriteHeader(401)
			return
		}
		_, claims, err := verifier.Verify("secret")
		if err != nil || claims.Video == nil || !claims.Video.RoomCreate || claims.Video.RoomJoin {
			t.Error("invalid server-only admin grant")
			w.WriteHeader(401)
			return
		}
		if status != 200 {
			w.WriteHeader(status)
			return
		}
		data, _ := io.ReadAll(r.Body)
		var input livekit.CreateRoomRequest
		if err := proto.Unmarshal(data, &input); err != nil || input.Name == "" || input.MaxParticipants != 64 {
			t.Error("invalid upstream CreateRoom request")
			w.WriteHeader(400)
			return
		}
		output, _ := proto.Marshal(&livekit.Room{Name: input.Name})
		w.Header().Set("Content-Type", "application/protobuf")
		_, _ = w.Write(output)
	}))
	t.Cleanup(server.Close)
	return server.URL
}
func call(t *testing.T, url, path, key string, body any) (int, map[string]any) {
	t.Helper()
	data, _ := json.Marshal(body)
	req, _ := http.NewRequest("POST", url+path, bytes.NewReader(data))
	req.Header.Set("Content-Type", "application/json")
	if key != "" {
		req.Header.Set("Authorization", "Bearer "+key)
	}
	res, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	defer res.Body.Close()
	if res.Header.Get("Cache-Control") != "no-store" {
		t.Error("credential response can be cached")
	}
	var result map[string]any
	if err := json.NewDecoder(res.Body).Decode(&result); err != nil {
		t.Fatal(err)
	}
	return res.StatusCode, result
}
func createRoom(t *testing.T, url string) map[string]any {
	t.Helper()
	code, room := call(t, url, "/rooms", testAdmin, map[string]string{"title": "Test room"})
	if code != 201 {
		t.Fatalf("create failed: %d %v", code, room)
	}
	return room
}
func TestRoomAuthorizationAndTokens(t *testing.T) {
	_, url := harness(t, fakeLiveKit(t, 200))
	for _, key := range []string{"", "wrong"} {
		code, _ := call(t, url, "/rooms", key, map[string]string{"title": "Forbidden"})
		if code != 401 {
			t.Fatalf("unauthorized create: %d", code)
		}
	}
	room := createRoom(t, url)
	other := createRoom(t, url)
	path := "/rooms/" + room["id"].(string) + "/join"
	for _, input := range []map[string]string{{"displayName": "Alice"}, {"displayName": "Alice", "invite": "wrong"}, {"displayName": "Alice", "invite": other["invite"].(string)}} {
		if code, _ := call(t, url, path, "", input); code != 403 {
			t.Fatalf("unauthorized join: %d", code)
		}
	}
	if code, _ := call(t, url, "/rooms/arbitrary/join", "", map[string]string{"displayName": "Alice", "invite": room["invite"].(string)}); code != 403 {
		t.Fatalf("arbitrary room: %d", code)
	}
	identities := map[string]bool{}
	for _, name := range []string{"Alice", "Bob"} {
		code, result := call(t, url, path, "", map[string]string{"displayName": name, "invite": room["invite"].(string)})
		if code != 200 {
			t.Fatalf("join failed: %d %v", code, result)
		}
		identity := result["identity"].(string)
		if identity == "" || identities[identity] {
			t.Fatal("identity missing or reused")
		}
		identities[identity] = true
		token := result["token"].(string)
		v, err := auth.ParseAPIToken(token)
		if err != nil {
			t.Fatal(err)
		}
		registered, grants, err := v.Verify("secret")
		if err != nil {
			t.Fatal(err)
		}
		g := grants.Video
		if registered.Subject != identity || registered.Issuer != "devkey" || grants.Name != name || registered.ExpiresAt.Time.Sub(registered.IssuedAt.Time) != TokenTTL {
			t.Fatal("incorrect identity, name or TTL")
		}
		if g == nil || !g.RoomJoin || g.Room != room["id"] || g.GetCanPublish() || g.GetCanPublishData() || !g.GetCanSubscribe() || g.GetCanUpdateOwnMetadata() || g.RoomAdmin || g.RoomCreate || g.RoomList || g.RoomRecord || len(g.CanPublishSources) > 0 {
			t.Fatal("overly broad room grants")
		}
		if _, _, err := v.Verify("wrong-secret"); err == nil {
			t.Fatal("wrong signing secret accepted")
		}
		_, err = jwt.Parse(token, func(*jwt.Token) (any, error) { return []byte("secret"), nil }, jwt.WithValidMethods([]string{"HS256"}), jwt.WithTimeFunc(func() time.Time { return time.Now().Add(TokenTTL + time.Second) }))
		if err == nil {
			t.Fatal("expired token accepted")
		}
		if _, exists := result["invite"]; exists {
			t.Fatal("join needlessly re-exposes invitation")
		}
	}
}
func TestValidationExpiryAndCapacity(t *testing.T) {
	a, url := harness(t, fakeLiveKit(t, 200))
	for _, title := range []string{"", strings.Repeat("a", 81), "invalid\nname"} {
		if code, _ := call(t, url, "/rooms", testAdmin, map[string]string{"title": title}); code != 400 {
			t.Fatalf("invalid title: %d", code)
		}
	}
	room := createRoom(t, url)
	path := "/rooms/" + room["id"].(string) + "/join"
	for _, name := range []string{"", strings.Repeat("a", 65), "bad\nname"} {
		if code, _ := call(t, url, path, "", map[string]string{"displayName": name, "invite": room["invite"].(string)}); code != 400 {
			t.Fatalf("invalid name: %d", code)
		}
	}
	if code, _ := call(t, url, path, "", map[string]string{"displayName": "Alice", "invite": room["invite"].(string), "identity": "impersonation"}); code != 400 {
		t.Fatal("client-supplied identity accepted")
	}
	a.mu.Lock()
	entry := a.rooms[room["id"].(string)]
	entry.Expires = time.Now().Add(-time.Second)
	a.rooms[entry.ID] = entry
	a.mu.Unlock()
	if code, _ := call(t, url, path, "", map[string]string{"displayName": "Alice", "invite": room["invite"].(string)}); code != 403 {
		t.Fatal("expired invitation accepted")
	}
	a.mu.Lock()
	for i := 0; i < maxRooms; i++ {
		id := randomID(18)
		a.rooms[id] = structEntry(id)
	}
	a.mu.Unlock()
	if code, _ := call(t, url, "/rooms", testAdmin, map[string]string{"title": "Full"}); code != 429 {
		t.Fatalf("capacity limit: %d", code)
	}
}
func structEntry(id string) entry { return entry{ID: id, Expires: time.Now().Add(time.Hour)} }
func TestUpstreamFailureDoesNotStoreRoom(t *testing.T) {
	a, url := harness(t, fakeLiveKit(t, 500))
	if code, _ := call(t, url, "/rooms", testAdmin, map[string]string{"title": "Failure"}); code != 502 {
		t.Fatalf("upstream failure: %d", code)
	}
	a.mu.Lock()
	defer a.mu.Unlock()
	if len(a.rooms) != 0 {
		t.Fatal("failed creation retained authorization")
	}
}
func TestRequestBoundaries(t *testing.T) {
	_, url := harness(t, fakeLiveKit(t, 200))
	for _, tc := range []struct {
		body, content, origin string
		want                  int
	}{
		{`{"title":"ok"}`, "text/plain", "", 415},
		{`{"title":"ok"}`, "application/json", "http://evil.example", 403},
		{`{"title":"ok"} {}`, "application/json", "", 400},
		{`{"title":"ok","room":"chosen"}`, "application/json", "", 400},
		{strings.Repeat("x", 5000), "application/json", "", 400},
	} {
		req, _ := http.NewRequest("POST", url+"/rooms", strings.NewReader(tc.body))
		req.Header.Set("Authorization", "Bearer "+testAdmin)
		req.Header.Set("Content-Type", tc.content)
		req.Header.Set("Origin", tc.origin)
		res, err := http.DefaultClient.Do(req)
		if err != nil {
			t.Fatal(err)
		}
		res.Body.Close()
		if res.StatusCode != tc.want {
			t.Fatalf("got %d want %d", res.StatusCode, tc.want)
		}
	}
}
func TestConcurrentJoinIdentities(t *testing.T) {
	a, url := harness(t, fakeLiveKit(t, 200))
	room := createRoom(t, url)
	id := room["id"].(string)
	a.mu.Lock()
	e := a.rooms[id]
	e.Joins = rate.NewLimiter(rate.Inf, 100)
	a.rooms[id] = e
	a.mu.Unlock()
	var wg sync.WaitGroup
	ids := make(chan string, 20)
	for i := 0; i < 20; i++ {
		wg.Go(func() {
			code, result := call(t, url, "/rooms/"+id+"/join", "", map[string]string{"invite": room["invite"].(string), "displayName": "Same name"})
			if code != 200 {
				t.Errorf("concurrent join: %d", code)
				return
			}
			ids <- result["identity"].(string)
		})
	}
	wg.Wait()
	close(ids)
	seen := map[string]bool{}
	for id := range ids {
		if seen[id] {
			t.Fatal("duplicate identity")
		}
		seen[id] = true
	}
	if len(seen) != 20 {
		t.Fatal("missing concurrent participants")
	}
}
func TestActualLiveKit(t *testing.T) {
	upstream := os.Getenv("LIVEKIT_INTEGRATION_URL")
	if upstream == "" {
		t.Skip("set LIVEKIT_INTEGRATION_URL for the isolated local development SFU")
	}
	a, url := harness(t, upstream)
	room := createRoom(t, url)
	id := room["id"].(string)
	admin, err := auth.NewAccessToken("devkey", "secret").SetValidFor(time.Minute).SetVideoGrant(&auth.VideoGrant{RoomCreate: true, RoomList: true}).ToJWT()
	if err != nil {
		t.Fatal(err)
	}
	ctx, err := withBearer(t.Context(), admin)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		cleanupCtx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		defer cancel()
		cleanupCtx, err = withBearer(cleanupCtx, admin)
		if err != nil {
			t.Error(err)
			return
		}
		if _, err := a.client.DeleteRoom(cleanupCtx, &livekit.DeleteRoomRequest{Room: id}); err != nil {
			t.Error(err)
		}
	})
	listed, err := a.client.ListRooms(ctx, &livekit.ListRoomsRequest{Names: []string{id}})
	if err != nil || len(listed.GetRooms()) != 1 {
		t.Fatalf("room was not created in real SFU: %v", err)
	}
	if code, _ := call(t, url, "/rooms/"+id+"/join", "", map[string]string{"displayName": "Integration guest", "invite": room["invite"].(string)}); code != 200 {
		t.Fatalf("real room join authorization: %d", code)
	}
}

func TestRateLimits(t *testing.T) {
	a, url := harness(t, fakeLiveKit(t, 200))
	room := createRoom(t, url)
	a.requests = rate.NewLimiter(0, 1)
	if code, _ := call(t, url, "/rooms", "", map[string]string{"title": "Denied"}); code != 401 {
		t.Fatalf("first unauthorized request: %d", code)
	}
	if code, _ := call(t, url, "/rooms", "", map[string]string{"title": "Limited"}); code != 429 {
		t.Fatalf("global request limit: %d", code)
	}
	a.requests = rate.NewLimiter(rate.Inf, 100)
	id := room["id"].(string)
	a.mu.Lock()
	e := a.rooms[id]
	e.Joins = rate.NewLimiter(0, 1)
	a.rooms[id] = e
	a.mu.Unlock()
	for i, want := range []int{200, 429} {
		if code, _ := call(t, url, "/rooms/"+id+"/join", "", map[string]string{"invite": room["invite"].(string), "displayName": "Guest"}); code != want {
			t.Fatalf("join %d got %d want %d", i, code, want)
		}
	}
}

func TestScreenPublisherCapability(t *testing.T) {
	_, url := harness(t, fakeLiveKit(t, 200))
	room := createRoom(t, url)
	other := createRoom(t, url)
	path := "/rooms/" + room["id"].(string) + "/join"
	for _, key := range []string{"wrong", other["publishKey"].(string), room["invite"].(string)} {
		if code, _ := call(t, url, path, "", map[string]string{"invite": room["invite"].(string), "displayName": "Impostor", "publishKey": key}); code != 403 {
			t.Fatalf("publisher escalation accepted: %d", code)
		}
	}
	if code, _ := call(t, url, path, "", map[string]any{"invite": room["invite"], "displayName": "Viewer", "canPublish": true}); code != 400 {
		t.Fatal("client-selected grants accepted")
	}
	code, result := call(t, url, path, "", map[string]string{"invite": room["invite"].(string), "displayName": "Publisher", "publishKey": room["publishKey"].(string)})
	if code != 200 || result["canPublish"] != true {
		t.Fatalf("publisher authorization failed: %d", code)
	}
	verifier, err := auth.ParseAPIToken(result["token"].(string))
	if err != nil {
		t.Fatal(err)
	}
	registered, claims, err := verifier.Verify("secret")
	if err != nil {
		t.Fatal(err)
	}
	g := claims.Video
	if !g.GetCanPublish() || len(g.CanPublishSources) != 2 || g.CanPublishSources[0] != "screen_share" || g.CanPublishSources[1] != "screen_share_audio" || g.GetCanPublishData() || g.GetCanUpdateOwnMetadata() || g.Room != room["id"] || g.RoomCreate || g.RoomAdmin || registered.ExpiresAt.Time.Sub(registered.IssuedAt.Time) != TokenTTL {
		t.Fatal("publisher grant exceeds screen-only room permission")
	}
	if _, ok := result["publishKey"]; ok {
		t.Fatal("join leaked publisher capability")
	}
	code, viewer := call(t, url, path, "", map[string]string{"invite": room["invite"].(string), "displayName": "Viewer"})
	if code != 200 || viewer["canPublish"] != false {
		t.Fatal("viewer invitation gained publishing permission")
	}
}

func TestLocalPlayerScope(t *testing.T) {
	const key = "separate-workstation-player-credential"
	a := New(Config{APIKey: "devkey", APISecret: "secret", AdminKey: testAdmin, LocalPlayerKey: key, WSURL: "ws://127.0.0.1:7880", AppOrigin: "http://localhost:5173"})
	mux := http.NewServeMux()
	a.Register(mux)
	server := httptest.NewServer(mux)
	defer server.Close()
	for _, credential := range []string{"", testAdmin} {
		if code, _ := call(t, server.URL, "/local/join", credential, struct{}{}); code != 403 {
			t.Fatalf("local join accepted invalid credential: %d", code)
		}
	}
	if code, _ := call(t, server.URL, "/rooms", key, map[string]string{"title": "example"}); code != 401 {
		t.Fatal("player credential allowed room administration")
	}
	if code, _ := call(t, server.URL, "/local/join", key, map[string]string{"room": "elsewhere"}); code != 400 {
		t.Fatal("caller could choose the room")
	}
	code, res := call(t, server.URL, "/local/join", key, struct{}{})
	if code != 200 {
		t.Fatalf("join failed: %d", code)
	}
	token, err := auth.ParseAPIToken(res["token"].(string))
	if err != nil {
		t.Fatal(err)
	}
	registered, claims, err := token.Verify("secret")
	if err != nil {
		t.Fatal(err)
	}
	g := claims.Video
	if g == nil || g.Room != localRoom || !g.RoomJoin || !g.GetCanSubscribe() || !g.GetCanPublish() || g.GetCanPublishData() || g.RoomAdmin || g.RoomCreate || g.RoomList || len(g.CanPublishSources) != 2 || g.CanPublishSources[0] != "screen_share" || g.CanPublishSources[1] != "screen_share_audio" || registered.ExpiresAt.Time.Sub(registered.IssuedAt.Time) != TokenTTL {
		t.Fatal("player grant exceeds the short-lived, room-scoped screen-sharing permissions")
	}
}

package rooms

import (
	"context"
	"crypto/sha256"
	"encoding/json"
	"github.com/livekit/protocol/auth"
	"github.com/livekit/protocol/livekit"
	"google.golang.org/protobuf/proto"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"
)

func nativeUpstream(t *testing.T) string {
	t.Helper()
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		verifier, err := auth.ParseAPIToken(strings.TrimPrefix(r.Header.Get("Authorization"), "Bearer "))
		if err != nil {
			t.Error(err)
			w.WriteHeader(401)
			return
		}
		_, claims, err := verifier.Verify("secret")
		if err != nil || !claims.Video.RoomAdmin {
			t.Error("missing scoped admin authorization")
			w.WriteHeader(401)
			return
		}
		if strings.HasSuffix(r.URL.Path, "GetParticipant") {
			var req livekit.RoomParticipantIdentity
			body := make([]byte, r.ContentLength)
			_, _ = r.Body.Read(body)
			_ = proto.Unmarshal(body, &req)
			if req.Identity != "owner" {
				w.WriteHeader(404)
				return
			}
			data, _ := proto.Marshal(&livekit.ParticipantInfo{Identity: "owner", Tracks: []*livekit.TrackInfo{{Sid: "screen", Type: livekit.TrackType_VIDEO, Source: livekit.TrackSource_SCREEN_SHARE}}})
			w.Header().Set("Content-Type", "application/protobuf")
			_, _ = w.Write(data)
			return
		}
		w.Header().Set("Content-Type", "application/protobuf")
		_, _ = w.Write(nil)
	}))
	t.Cleanup(server.Close)
	return server.URL
}
func openOwnerWatch(t *testing.T, url, control string) *http.Response {
	t.Helper()
	req, err := http.NewRequest("POST", url, strings.NewReader("{}"))
	if err != nil {
		t.Fatal(err)
	}
	req.Header.Set("Authorization", "Bearer "+control)
	req.Header.Set("Content-Type", "application/json")
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	if resp.StatusCode != 200 {
		resp.Body.Close()
		t.Fatalf("owner watch: %d", resp.StatusCode)
	}
	return resp
}

func TestNativeAuthorizationAndAssociation(t *testing.T) {
	a, url := harness(t, nativeUpstream(t))
	control := "publisher-control"
	a.nativeOwners[sha256.Sum256([]byte(control))] = nativeOwner{Room: "room", Identity: "owner", Expires: time.Now().Add(time.Hour)}
	for _, key := range []string{"", "viewer", "wrong"} {
		code, _ := call(t, url, "/native-audio/sessions", key, map[string]string{"screen": "screen"})
		if code != 403 {
			t.Fatalf("unauthorized session %d", code)
		}
	}
	code, _ := call(t, url, "/native-audio/sessions", control, map[string]string{"screen": "wrong-screen"})
	if code != 403 {
		t.Fatal("wrong screen accepted")
	}
	code, pair := call(t, url, "/native-audio/sessions", control, map[string]string{"screen": "screen"})
	if code != 201 {
		t.Fatalf("pair %d %v", code, pair)
	}
	defer a.revokeNative(pair["session"].(string))
	code, _ = call(t, url, "/native-audio/claim", "", map[string]string{"code": "wrong"})
	if code != 403 {
		t.Fatal("invalid code accepted")
	}
	path := "/native-audio/" + pair["session"].(string)
	code, _ = call(t, url, "/native-audio/claim", "", map[string]string{"code": pair["code"].(string)})
	if code != 403 {
		t.Fatal("claim accepted without a connected owner")
	}
	code, _ = call(t, url, path+"/watch", "viewer", struct{}{})
	if code != 403 {
		t.Fatal("unauthorized watch accepted")
	}
	watch := openOwnerWatch(t, url+path+"/watch", control)
	defer watch.Body.Close()
	if status, _ := call(t, url, "/native-audio/claim", "", map[string]any{"code": pair["code"], "localOnly": true}); status != 403 {
		t.Fatal("desktop launcher accepted an invitation room")
	}
	code, credentials := call(t, url, "/native-audio/claim", "", map[string]string{"code": pair["code"].(string)})
	if code != 200 {
		t.Fatalf("claim %d %v", code, credentials)
	}
	verifier, _ := auth.ParseAPIToken(credentials["token"].(string))
	_, claims, err := verifier.Verify("secret")
	if err != nil {
		t.Fatal(err)
	}
	g := claims.Video
	if claims.Identity == "owner" || g.Room != "room" || !g.GetCanPublish() || g.GetCanSubscribe() || g.GetCanPublishData() || g.GetCanUpdateOwnMetadata() || g.RoomAdmin || len(g.CanPublishSources) != 1 || g.CanPublishSources[0] != "screen_share_audio" {
		t.Fatal("invalid helper grants")
	}
	var metadata map[string]string
	_ = json.Unmarshal([]byte(claims.Metadata), &metadata)
	if metadata["nativeAudioOwner"] != "owner" || metadata["nativeAudioScreen"] != "screen" {
		t.Fatal("association missing")
	}
	code, _ = call(t, url, "/native-audio/claim", "", map[string]string{"code": pair["code"].(string)})
	if code != 403 {
		t.Fatal("pairing replay accepted")
	}
	code, _ = call(t, url, path+"/lease", "wrong", struct{}{})
	if code != 403 {
		t.Fatal("unauthorized lease")
	}
	code, _ = call(t, url, path+"/lease", credentials["lease"].(string), struct{}{})
	if code != 200 {
		t.Fatal("lease failed")
	}
	for _, phase := range []string{"waiting", "ready", "sharing", "waiting"} {
		code, _ := call(t, url, path+"/lease", credentials["lease"].(string), map[string]string{"phase": phase})
		if code != 200 {
			t.Fatalf("status heartbeat %s returned %d", phase, code)
		}
	}
	a.nativeMu.Lock()
	phase := a.nativeSessions[pair["session"].(string)].Phase
	a.nativeMu.Unlock()
	if phase != "sharing" {
		t.Fatalf("late heartbeat regressed owner status to %q", phase)
	}
	watch.Body.Close()
	deadline := time.Now().Add(2 * time.Second)
	for {
		a.nativeMu.Lock()
		revoked := a.nativeSessions[pair["session"].(string)].Revoked
		a.nativeMu.Unlock()
		if revoked {
			break
		}
		if time.Now().After(deadline) {
			t.Fatal("browser disconnect left helper authorized")
		}
		time.Sleep(5 * time.Millisecond)
	}
	code, _ = call(t, url, path+"/stop", control, struct{}{})
	if code != 200 {
		t.Fatal("stop failed")
	}
	code, _ = call(t, url, path+"/lease", credentials["lease"].(string), struct{}{})
	if code != 403 {
		t.Fatal("revoked lease accepted")
	}
}
func TestNativeExpiredSession(t *testing.T) {
	a, url := harness(t, nativeUpstream(t))
	a.nativeSessions["expired"] = &nativeSession{ID: "expired", CodeHash: sha256.Sum256([]byte("code")), Expires: time.Now().Add(-time.Second)}
	code, _ := call(t, url, "/native-audio/claim", "", map[string]string{"code": "code"})
	if code != 403 {
		t.Fatal("expired code accepted")
	}
	if a.screenActive(context.Background(), nativeOwner{Expires: time.Now().Add(-time.Second)}, "screen") {
		t.Fatal("expired owner accepted")
	}
}

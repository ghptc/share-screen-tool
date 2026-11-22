package cloudsfu

import (
	"context"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

func TestConnectionAPI(t *testing.T) {
	t.Setenv("CLOUDFLARE_SFU_APP_ID", strings.Repeat("a", 32))
	t.Setenv("CLOUDFLARE_SFU_APP_SECRET", strings.Repeat("b", 32))
	c, err := FromEnvironment()
	if err != nil {
		t.Fatal(err)
	}
	const good = "provider-session"
	type step struct {
		method, path   string
		input, message string
	}
	steps := []step{
		{"POST", "/new", "", "{\"sessionId\":\"provider-session\"}"},
		{"POST", "/" + good + "/tracks/new", `{"tracks":[{"location":"local","mid":"0","trackName":"screen"}],"sessionDescription":{"type":"offer","sdp":"send"}}`, `{"sessionDescription":{"type":"answer","sdp":"ack"},"tracks":[{"mid":"0"}]}`},
		{"POST", "/" + good + "/tracks/new", `{"tracks":[{"location":"remote","sessionId":"publisher","trackName":"screen"}]}`, `{"requiresImmediateRenegotiation":true,"sessionDescription":{"type":"offer","sdp":"receive"},"tracks":[{"mid":"7"}]}`},
		{"PUT", "/" + good + "/renegotiate", `{"sessionDescription":{"type":"answer","sdp":"reply"}}`, "{}"},
		{"GET", "/" + good, "", `{"tracks":[{"mid":"7","status":"active"}]}`},
		{"PUT", "/" + good + "/tracks/close", `{"force":true,"tracks":[{"mid":"7"}]}`, `{"tracks":[{"mid":"7"}]}`},
		{"POST", "/" + good + "/tracks/new", "", `{"tracks":[{"mid":"7","errorCode":"failed"}]}`},
	}
	n := 0
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if n >= len(steps) {
			t.Error("unexpected API call")
			return
		}
		s := steps[n]
		n++
		if r.Method != s.method || r.URL.Path != s.path || r.Header.Get("Authorization") != "Bearer "+strings.Repeat("b", 32) || r.Header.Get("Content-Type") != "application/json" {
			t.Error("wrong provider request")
		}
		if s.input != "" {
			var got, want any
			json.NewDecoder(r.Body).Decode(&got)
			json.Unmarshal([]byte(s.input), &want)
			a, _ := json.Marshal(got)
			b, _ := json.Marshal(want)
			if string(a) != string(b) {
				t.Error("wrong request body")
			}
		} else if n == 1 && r.ContentLength != 0 {
			t.Error("session creation must have no body")
		}
		w.Write([]byte(s.message))
	}))
	defer srv.Close()
	c.base = srv.URL
	ctx := context.Background()
	id, err := c.NewSession(ctx)
	if err != nil || id != good {
		t.Fatal("session")
	}
	if s, e := c.Publish(ctx, id, "screen", "0", "send"); e != nil || s != "ack" {
		t.Fatal("publish")
	}
	if m, s, e := c.Subscribe(ctx, id, "publisher", "screen"); e != nil || m != "7" || s != "receive" {
		t.Fatal("subscribe")
	}
	if err = c.Answer(ctx, id, "reply"); err != nil {
		t.Fatal(err)
	}
	if err = c.Close(ctx, id, ""); err != nil {
		t.Fatal(err)
	}
	if _, _, err = c.Subscribe(ctx, id, "publisher", "screen"); err == nil {
		t.Fatal("partial provider error accepted")
	}
	if n != len(steps) {
		t.Fatal("missing operations")
	}
}
func TestSecretBoundary(t *testing.T) {
	t.Setenv("CLOUDFLARE_SFU_APP_ID", "bad")
	t.Setenv("CLOUDFLARE_SFU_APP_SECRET", "")
	if _, err := FromEnvironment(); err == nil {
		t.Fatal("invalid app id accepted")
	}
	t.Setenv("CLOUDFLARE_SFU_APP_ID", strings.Repeat("a", 32))
	if _, err := FromEnvironment(); err == nil {
		t.Fatal("missing app secret accepted")
	}
	t.Setenv("CLOUDFLARE_SFU_APP_SECRET", strings.Repeat("b", 32))
	c, _ := FromEnvironment()
	dest := httptest.NewServer(http.HandlerFunc(func(http.ResponseWriter, *http.Request) { t.Error("followed provider redirect") }))
	defer dest.Close()
	first := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { http.Redirect(w, r, dest.URL, 307) }))
	defer first.Close()
	c.base = first.URL
	if _, err := c.NewSession(t.Context()); err != apiStatus(307) {
		t.Fatal("redirect accepted")
	}
}

func TestPrototypeProfile(t *testing.T) {
	t.Setenv("WHITERUN_MEDIA_TRANSPORT", "cloudflare-prototype")
	t.Setenv("WHITERUN_ENV", "production")
	t.Setenv("DISCORD_MODE", "discord")
	if _, err := PrototypeEnabled("127.0.0.1:8080", false); err == nil {
		t.Fatal("production enabled")
	}
	t.Setenv("WHITERUN_ENV", "development")
	t.Setenv("DISCORD_MODE", "simulator")
	if _, err := PrototypeEnabled("0.0.0.0:8080", true); err == nil {
		t.Fatal("nonloopback enabled")
	}
	if ok, err := PrototypeEnabled("127.0.0.1:8080", true); err != nil || !ok {
		t.Fatal("explicit prototype denied")
	}
}

func TestPrivatePilotProfile(t *testing.T) {
	t.Setenv("WHITERUN_MEDIA_TRANSPORT", "cloudflare-private")
	t.Setenv("DISCORD_MODE", "discord")
	t.Setenv("WHITERUN_ENV", "production")
	t.Setenv("DISCORD_PILOT_USERS", "")
	if _, err := PrototypeEnabled("127.0.0.1:8080", false); err == nil {
		t.Fatal("private pilot requires testers")
	}
	t.Setenv("DISCORD_PILOT_USERS", "100000000000000001")
	if ok, err := PrototypeEnabled("127.0.0.1:8080", false); err != nil || !ok {
		t.Fatal("private pilot refused")
	}
	if _, err := PrototypeEnabled("0.0.0.0:8080", false); err == nil {
		t.Fatal("public listener accepted")
	}
	if _, err := PrototypeEnabled("127.0.0.1:8080", true); err == nil {
		t.Fatal("fixture accepted")
	}
}

func TestCloseRequiresTerminalProviderEvidence(t *testing.T) {
	for _, tc := range []struct {
		name, mid string
		status    int
		response  string
		closed    bool
	}{
		{"already ended session", "0", 410, `{"errorCode":"session_error"}`, true},
		{"ended session during mid recovery", "", 410, `{"errorCode":"session_error"}`, true},
		{"ambiguous close failure", "0", 200, `{"tracks":[{"mid":"0","errorCode":"close_track_error"}]}`, false},
		{"session still connecting", "0", 425, `{"errorCode":"session_error"}`, false},
		{"missing app", "0", 404, `{"errorCode":"not_found"}`, false},
		{"missing app during mid recovery", "", 404, `{"errorCode":"not_found"}`, false},
		{"ambiguous gone", "0", 410, `{}`, false},
		{"malformed gone", "0", 410, `{"errorCode":"session_error"}truncated`, false},
		{"unavailable upstream", "0", 503, `{"errorCode":"session_error"}`, false},
		{"wrong mid", "0", 200, `{"tracks":[{"mid":"1","errorCode":"close_track_error"}]}`, false},
		{"request error", "0", 200, `{"errorCode":"close_track_error"}`, false},
		{"unresolved track", "0", 200, `{"tracks":[{"mid":"0","errorCode":"internal_error"}]}`, false},
	} {
		t.Run(tc.name, func(t *testing.T) {
			srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				verb := "PUT"
				if tc.mid == "" || (tc.name == "ambiguous close failure" && r.Method == "GET") {
					verb = "GET"
				}
				if r.Method != verb {
					t.Errorf("unexpected method %s", r.Method)
				}
				w.WriteHeader(tc.status)
				w.Write([]byte(tc.response))
			}))
			defer srv.Close()
			c := Client{base: srv.URL, http: srv.Client()}
			if err := c.Close(t.Context(), "test-session", tc.mid); (err == nil) != tc.closed {
				t.Fatalf("closed = %t, want %t", err == nil, tc.closed)
			}
		})
	}
}

func TestCheckAmbiguousCloseAgainstSession(t *testing.T) {
	for _, status := range []string{"active", "inactive"} {
		srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			if r.Method == "PUT" {
				io.WriteString(w, `{"tracks":[{"mid":"0","errorCode":"close_track_error"}]}`)
				return
			}
			io.WriteString(w, `{"tracks":[{"mid":"0","status":"`+status+`"}]}`)
		}))
		c := Client{base: srv.URL, http: srv.Client()}
		err := c.Close(t.Context(), "owned", "0")
		srv.Close()
		if (err == nil) != (status == "inactive") {
			t.Fatalf("incorrect closure for %s", status)
		}
	}
}

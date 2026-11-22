package httpapi

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"
)

func TestHealthAndRouting(t *testing.T) {
	handler := New("http://127.0.0.1:1")
	for _, tc := range []struct {
		method, path string
		status       int
	}{
		{"GET", "/healthz", 200}, {"GET", "/missing", 404}, {"POST", "/healthz", 405}, {"GET", "/healthz/extra", 404},
	} {
		rec := httptest.NewRecorder()
		handler.ServeHTTP(rec, httptest.NewRequest(tc.method, tc.path, nil))
		if rec.Code != tc.status {
			t.Fatalf("%s %s: got %d, want %d", tc.method, tc.path, rec.Code, tc.status)
		}
		if tc.status == 200 {
			var body map[string]string
			if err := json.Unmarshal(rec.Body.Bytes(), &body); err != nil || body["status"] != "ok" {
				t.Fatalf("invalid health response: %s", rec.Body.String())
			}
			if rec.Header().Get("Cache-Control") != "no-store" {
				t.Fatal("health must not be cached")
			}
		}
	}
}

func TestReadiness(t *testing.T) {
	for _, status := range []int{200, 500, 302} {
		t.Run(http.StatusText(status), func(t *testing.T) {
			upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { w.WriteHeader(status) }))
			defer upstream.Close()
			rec := httptest.NewRecorder()
			New(upstream.URL).ServeHTTP(rec, httptest.NewRequest("GET", "/readyz", nil))
			want := http.StatusServiceUnavailable
			if status == 200 {
				want = http.StatusOK
			}
			if rec.Code != want {
				t.Fatalf("got %d, want %d", rec.Code, want)
			}
		})
	}
	upstream := httptest.NewServer(http.NotFoundHandler())
	upstream.Close()
	rec := httptest.NewRecorder()
	New(upstream.URL).ServeHTTP(rec, httptest.NewRequest("GET", "/readyz", nil))
	if rec.Code != http.StatusServiceUnavailable {
		t.Fatalf("closed upstream: got %d", rec.Code)
	}
}

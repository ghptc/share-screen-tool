package httpapi

import (
	"encoding/json"
	"net/http"
	"time"
)

// LiveKit's root HTTP endpoint is a reachability probe, not a media test.
func New(liveKitURL string) http.Handler {
	client := &http.Client{Timeout: 2 * time.Second, CheckRedirect: func(_ *http.Request, _ []*http.Request) error { return http.ErrUseLastResponse }}
	mux := http.NewServeMux()
	mux.HandleFunc("GET /healthz", func(w http.ResponseWriter, r *http.Request) {
		respond(w, http.StatusOK, map[string]string{"status": "ok"})
	})
	mux.HandleFunc("GET /readyz", func(w http.ResponseWriter, r *http.Request) {
		req, err := http.NewRequestWithContext(r.Context(), http.MethodGet, liveKitURL, nil)
		if err != nil {
			respond(w, http.StatusServiceUnavailable, map[string]string{"status": "unavailable", "livekit": "unreachable"})
			return
		}
		res, err := client.Do(req)
		if err != nil {
			respond(w, http.StatusServiceUnavailable, map[string]string{"status": "unavailable", "livekit": "unreachable"})
			return
		}
		defer res.Body.Close()
		if res.StatusCode != http.StatusOK {
			respond(w, http.StatusServiceUnavailable, map[string]string{"status": "unavailable", "livekit": "unhealthy"})
			return
		}
		respond(w, http.StatusOK, map[string]string{"status": "ok", "livekit": "reachable"})
	})
	return mux
}

func respond(w http.ResponseWriter, status int, body map[string]string) {
	w.Header().Set("Content-Type", "application/json")
	w.Header().Set("Cache-Control", "no-store")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(body)
}

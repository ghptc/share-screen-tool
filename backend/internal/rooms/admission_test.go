package rooms

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/ghptc/whiterun-live/backend/internal/discord"
	"github.com/livekit/protocol/auth"
)

func TestPrivateReadinessRequiresAuthenticatedAdmissionDenial(t *testing.T) {
	const signingKey = "readiness-test-signing-key"
	const admissionKey = "admission-service-credential-for-readiness-tests"
	for _, tc := range []struct {
		name, callbackKey string
		wrongIdentity     bool
		status, want      int
	}{
		{"unpatched", "", false, 200, 503},
		{"unreachable authority", "", false, 403, 503},
		{"wrong service key", "unrelated", false, 403, 503},
		{"unrelated callback", admissionKey, true, 403, 503},
		{"ignored denial", admissionKey, false, 200, 503},
		{"enforced", admissionKey, false, 403, 200},
	} {
		t.Run(tc.name, func(t *testing.T) {
			mux := http.NewServeMux()
			sfu := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				if r.URL.RequestURI() != "/rtc/validate" {
					t.Error("unexpected validation URL")
				}
				parsed, err := auth.ParseAPIToken(strings.TrimPrefix(r.Header.Get("Authorization"), "Bearer "))
				if err != nil {
					t.Error("missing signed validation token")
					return
				}
				claim, grant, err := parsed.Verify(signingKey)
				if err != nil || grant.Video.Room != admissionProbeRoom || grant.Video.GetCanPublish() {
					t.Error("invalid probe grant")
					return
				}
				if tc.callbackKey != "" {
					id := claim.Subject
					if tc.wrongIdentity {
						id = "another-request"
					}
					body, _ := json.Marshal(map[string]string{"Room": admissionProbeRoom, "Identity": id})
					q := httptest.NewRequest("POST", "/internal/discord/admit", strings.NewReader(string(body)))
					q.Header.Set("Authorization", "Bearer "+tc.callbackKey)
					q.Header.Set("Content-Type", "application/json")
					response := httptest.NewRecorder()
					mux.ServeHTTP(response, q)
					if response.Code != 403 {
						t.Error("probe must always be denied")
					}
				}
				w.WriteHeader(tc.status)
			}))
			defer sfu.Close()
			a := New(Config{APIKey: "test", APISecret: signingKey, HTTPURL: sfu.URL})
			a.RegisterDiscord(mux, &discord.Config{AdmissionKey: admissionKey})
			w := httptest.NewRecorder()
			mux.ServeHTTP(w, httptest.NewRequest("GET", "/readyz", nil))
			if w.Code != tc.want {
				t.Fatalf("readiness status %d, want %d", w.Code, tc.want)
			}
		})
	}
}

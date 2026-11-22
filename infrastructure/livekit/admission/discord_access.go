// Admission for Discord-backed rooms, including refreshed tokens and resumes.
package service

import (
	"bytes"
	"context"
	"encoding/json"
	"io"
	"net/http"
	"os"
	"strings"
	"time"

	"github.com/livekit/protocol/auth"
	"github.com/livekit/protocol/livekit"
)

var voiceAdmissionHTTP = &http.Client{Timeout: 3 * time.Second, CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }}

func protectedRoom(room string) bool { return strings.HasPrefix(room, "dc-") }

func voiceAuthorized(ctx context.Context, room, identity string, grant *auth.VideoGrant) bool {
	key := os.Getenv("DISCORD_ADMISSION_KEY")
	if len(key) < 32 || grant == nil {
		return false
	}
	body, _ := json.Marshal(map[string]string{"Room": room, "Identity": identity})
	req, err := http.NewRequestWithContext(ctx, "POST", os.Getenv("DISCORD_ADMISSION_URL"), bytes.NewReader(body))
	if err != nil {
		return false
	}
	// Admission is a read-only query over a pooled private connection.
	req.Header["Idempotency-Key"] = []string{}
	req.Header.Set("Authorization", "Bearer "+key)
	req.Header.Set("Content-Type", "application/json")
	res, err := voiceAdmissionHTTP.Do(req)
	if err != nil {
		return false
	}
	defer res.Body.Close()
	var authz struct{ Role string }
	if res.StatusCode != 200 || json.NewDecoder(io.LimitReader(res.Body, 1024)).Decode(&authz) != nil {
		return false
	}
	switch authz.Role {
	case "viewer":
		return !grant.GetCanPublish()
	case "screen":
		return !grant.GetCanPublish() || (len(grant.CanPublishSources) == 1 && grant.GetCanPublishSource(livekit.TrackSource_SCREEN_SHARE))
	case "audio":
		return (!grant.GetCanSubscribe() && grant.GetCanPublish() && len(grant.CanPublishSources) == 1 && grant.GetCanPublishSource(livekit.TrackSource_SCREEN_SHARE_AUDIO))
	default:
		return false
	}
}

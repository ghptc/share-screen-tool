package rooms

import (
	"context"
	"net/http"
	"strings"
	"sync/atomic"
)

// This protected room name cannot be produced by the 32-character room directory.
const admissionProbeRoom = "dc-admission-check"

func (a *API) recordAdmissionProbe(id string) {
	if seen, ok := a.discord.probes.Load(id); ok {
		seen.(*atomic.Bool).Store(true)
	}
}

// Require an authenticated callback for this nonce AND the SFU's denial.
// A reachable stock SFU or a broken callback can satisfy at most one of these.
func (a *API) admissionVerified(ctx context.Context) bool {
	id := randomID(24)
	token, err := a.discordToken(admissionProbeRoom, id, roomAccess{})
	if err != nil {
		return false
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, strings.TrimRight(a.cfg.HTTPURL, "/")+"/rtc/validate", nil)
	if err != nil {
		return false
	}
	req.Header.Set("Authorization", "Bearer "+token)
	seen := new(atomic.Bool)
	a.discord.probes.Store(id, seen)
	defer a.discord.probes.Delete(id)
	res, err := a.discord.client.Do(req)
	if err != nil {
		return false
	}
	defer res.Body.Close()
	return res.StatusCode == http.StatusForbidden && seen.Load()
}

func (a *API) requireDiscordAdmission(w http.ResponseWriter, r *http.Request) bool {
	if a.discord == nil || a.discord.c.Fixture || a.admissionVerified(r.Context()) {
		return true
	}
	fail(w, http.StatusServiceUnavailable, "Discord media admission unavailable")
	return false
}

func (a *API) discordReady(w http.ResponseWriter, r *http.Request) {
	if a.requireDiscordAdmission(w, r) {
		write(w, http.StatusOK, map[string]string{"status": "ok", "discordAdmission": "verified"})
	}
}

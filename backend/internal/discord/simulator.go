// The fixture represents Discord behind the same OAuth and voice-authority
// boundaries as the real services. It never creates application sessions or grants.
package discord

import (
	"crypto/rand"
	"crypto/sha256"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"net/http"
	"net/url"
	"sync"
	"time"
)

type FixtureState struct {
	User, Guild, Channel string
	Online               bool
}
type fixtureCode struct {
	user, challenge string
	until           time.Time
}

func Simulator(c *Config, key string, initial FixtureState) http.Handler {
	m := http.NewServeMux()
	if !c.Fixture || len(key) < 32 {
		return m
	}
	var mu sync.Mutex
	state := initial
	type member struct {
		guild string
		p     Presence
	}
	voices := map[string]member{}
	if state.Online {
		voices[state.User] = member{state.Guild, Presence{state.Channel, rand.Text()}}
	}
	codes := map[string]fixtureCode{}
	tokens := map[string]fixtureCode{}
	m.Handle("/voice", VoiceHandler(c.VoiceKey, func(g, u string) (Presence, bool) {
		mu.Lock()
		defer mu.Unlock()
		v, ok := voices[u]
		return v.p, ok && state.Online && v.guild == g && v.p.Channel != ""
	}))
	m.HandleFunc("POST /scenario", func(w http.ResponseWriter, r *http.Request) {
		if !AuthorizedService(key, r.Header.Get("Authorization")) {
			http.Error(w, "Forbidden", 403)
			return
		}
		var next FixtureState
		if json.NewDecoder(http.MaxBytesReader(w, r.Body, 2048)).Decode(&next) != nil || !snowflake.MatchString(next.User) {
			http.Error(w, "Invalid scenario", 400)
			return
		}
		mu.Lock()
		defer mu.Unlock()
		if !next.Online {
			clear(voices)
		}
		prev := voices[next.User]
		if prev.guild != next.Guild || prev.p.Channel != next.Channel {
			voices[next.User] = member{next.Guild, Presence{next.Channel, rand.Text()}}
		}
		state = next
		w.WriteHeader(204)
	})
	m.HandleFunc("GET /live", func(w http.ResponseWriter, r *http.Request) {
		if !AuthorizedService(key, r.Header.Get("Authorization")) {
			http.Error(w, "Forbidden", 403)
			return
		}
		mu.Lock()
		defer mu.Unlock()
		v, ok := voices[state.User]
		fmt.Fprint(w, LiveReply(c.Dir, c.Origin, state.Guild, v.p, ok && state.Online))
	})
	m.HandleFunc("GET /authorize", func(w http.ResponseWriter, r *http.Request) {
		q := r.URL.Query()
		if q.Get("client_id") != c.ClientID || q.Get("redirect_uri") != c.Origin+"/api/discord/callback" || q.Get("response_type") != "code" || q.Get("scope") != "identify" || q.Get("code_challenge_method") != "S256" || len(q.Get("code_challenge")) != 43 {
			http.Error(w, "Invalid authorization", 400)
			return
		}
		mu.Lock()
		defer mu.Unlock()
		code := rand.Text()
		for k, v := range codes {
			if time.Now().After(v.until) {
				delete(codes, k)
			}
		}
		if len(codes) >= 2048 {
			http.Error(w, "Busy", 429)
			return
		}
		codes[code] = fixtureCode{state.User, q.Get("code_challenge"), time.Now().Add(time.Minute)}
		http.Redirect(w, r, q.Get("redirect_uri")+"?"+url.Values{"code": {code}, "state": {q.Get("state")}}.Encode(), 303)
	})
	m.HandleFunc("POST /token", func(w http.ResponseWriter, r *http.Request) {
		id, secret, _ := r.BasicAuth()
		mu.Lock()
		defer mu.Unlock()
		v, ok := codes[r.FormValue("code")]
		delete(codes, r.FormValue("code"))
		sum := sha256.Sum256([]byte(r.FormValue("code_verifier")))
		if !ok || time.Now().After(v.until) || id != c.ClientID || secret != c.Secret || v.challenge != base64.RawURLEncoding.EncodeToString(sum[:]) || r.FormValue("redirect_uri") != c.Origin+"/api/discord/callback" {
			http.Error(w, "Denied", 403)
			return
		}
		for k, t := range tokens {
			if time.Now().After(t.until) {
				delete(tokens, k)
			}
		}
		if len(tokens) >= 2048 {
			http.Error(w, "Busy", 429)
			return
		}
		token := rand.Text()
		tokens["Bearer "+token] = v
		json.NewEncoder(w).Encode(map[string]string{"access_token": token, "token_type": "Bearer"})
	})
	m.HandleFunc("GET /user", func(w http.ResponseWriter, r *http.Request) {
		mu.Lock()
		defer mu.Unlock()
		k := r.Header.Get("Authorization")
		v, ok := tokens[k]
		delete(tokens, k)
		if !ok || time.Now().After(v.until) {
			http.Error(w, "Denied", 403)
			return
		}
		json.NewEncoder(w).Encode(map[string]string{"id": v.user})
	})
	return m
}

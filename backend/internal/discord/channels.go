// Package discord provides the room directory shared by the bot and the backend.
// The mapping key grants neither Discord nor LiveKit access.
package discord

import (
	"crypto/hmac"
	"crypto/sha256"
	"encoding/base64"
	"errors"
	"regexp"
	"strings"
)

type Channel struct{ Guild, Voice string }
type Directory struct {
	byRef     map[string]Channel
	byChannel map[Channel]string
}

var snowflake = regexp.MustCompile("^[1-9][0-9]{0,19}$")

func NewDirectory(key, pairs string) (*Directory, error) {
	if len(key) < 32 {
		return nil, errors.New("DISCORD_ROOM_KEY requires at least 32 bytes")
	}
	d := &Directory{map[string]Channel{}, map[Channel]string{}}
	for _, pair := range strings.Split(pairs, ",") {
		g, v, ok := strings.Cut(strings.TrimSpace(pair), "/")
		if !ok || !snowflake.MatchString(g) || !snowflake.MatchString(v) {
			return nil, errors.New("DISCORD_CHANNELS requires guild/channel pairs")
		}
		c := Channel{g, v}
		mac := hmac.New(sha256.New, []byte(key))
		mac.Write([]byte("whiterun:discord:voice:v1/" + g + "/" + v))
		ref := base64.RawURLEncoding.EncodeToString(mac.Sum(nil)[:24])
		d.byRef[ref], d.byChannel[c] = c, ref
	}
	return d, nil
}
func (d *Directory) Lookup(ref string) (Channel, bool)  { c, ok := d.byRef[ref]; return c, ok }
func (d *Directory) Reference(c Channel) (string, bool) { ref, ok := d.byChannel[c]; return ref, ok }
func (d *Directory) Guilds() []string {
	seen := map[string]bool{}
	var result []string
	for c := range d.byChannel {
		if !seen[c.Guild] {
			result = append(result, c.Guild)
			seen[c.Guild] = true
		}
	}
	return result
}

// Package cloudsfu implements single-track sessions against the Cloudflare Realtime Connection API.
package cloudsfu

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"os"
	"regexp"
	"time"
)

type Media interface {
	NewSession(context.Context) (string, error)
	Publish(ctx context.Context, session, name, mid, offer string) (string, error)
	Subscribe(ctx context.Context, session, publisher, name string) (mid, offer string, err error)
	Answer(ctx context.Context, session, answer string) error
	Close(ctx context.Context, session, mid string) error
}

var resourceID = regexp.MustCompile(`^[a-zA-Z0-9_-]{1,128}$`)
var appID = regexp.MustCompile(`^[a-fA-F0-9]{32}$`)
var bearer = regexp.MustCompile(`^[a-zA-Z0-9_~.+/=-]{16,512}$`)
var errResponse = errors.New("unexpected SFU response")

type Client struct {
	base, secret string
	http         *http.Client
}

func FromEnvironment() (*Client, error) {
	id, secret := os.Getenv("CLOUDFLARE_SFU_APP_ID"), os.Getenv("CLOUDFLARE_SFU_APP_SECRET")
	if !appID.MatchString(id) {
		return nil, errors.New("missing or invalid CLOUDFLARE_SFU_APP_ID")
	}
	if !bearer.MatchString(secret) {
		return nil, errors.New("missing or invalid CLOUDFLARE_SFU_APP_SECRET")
	}
	return &Client{"https://rtc.live.cloudflare.com/v1/apps/" + id + "/sessions", secret, &http.Client{Timeout: 8 * time.Second, CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }}}, nil
}

type description struct {
	Type string `json:"type"`
	SDP  string `json:"sdp"`
}
type track struct {
	Location string `json:"location,omitempty"`
	Session  string `json:"sessionId,omitempty"`
	Name     string `json:"trackName,omitempty"`
	Mid      string `json:"mid,omitempty"`
	Error    string `json:"errorCode,omitempty"`
	Status   string `json:"status,omitempty"`
	Detail   string `json:"errorDescription,omitempty"`
}
type message struct {
	ID          string       `json:"sessionId,omitempty"`
	Description *description `json:"sessionDescription,omitempty"`
	Tracks      []track      `json:"tracks,omitempty"`
	Force       bool         `json:"force,omitempty"`
	Error       string       `json:"errorCode,omitempty"`
	Renegotiate bool         `json:"requiresImmediateRenegotiation,omitempty"`
}
type apiStatus int

func (s apiStatus) Error() string { return fmt.Sprintf("SFU HTTP %d", int(s)) }
func (c *Client) call(ctx context.Context, method, path string, input *message) (message, error) {
	var out message
	var body io.Reader
	if input != nil {
		b, err := json.Marshal(input)
		if err != nil {
			return out, err
		}
		body = bytes.NewReader(b)
	}
	req, err := http.NewRequestWithContext(ctx, method, c.base+path, body)
	if err != nil {
		return out, errResponse
	}
	req.Header.Set("Authorization", "Bearer "+c.secret)
	req.Header.Set("Content-Type", "application/json")
	res, err := c.http.Do(req)
	if err != nil {
		return out, errors.New("SFU connection failed")
	}
	defer res.Body.Close()
	if res.StatusCode/100 != 2 {
		return out, apiStatus(res.StatusCode)
	}
	if json.NewDecoder(io.LimitReader(res.Body, 256<<10)).Decode(&out) != nil || out.Error != "" {
		return out, errResponse
	}
	return out, nil
}
func (c *Client) NewSession(ctx context.Context) (string, error) {
	out, err := c.call(ctx, "POST", "/new", nil)
	if err != nil {
		return "", err
	}
	if !resourceID.MatchString(out.ID) {
		return "", errResponse
	}
	return out.ID, nil
}
func (c *Client) add(ctx context.Context, id string, input message, want string) (track, string, error) {
	if !resourceID.MatchString(id) {
		return track{}, "", errResponse
	}
	out, err := c.call(ctx, "POST", "/"+id+"/tracks/new", &input)
	if err != nil {
		return track{}, "", err
	}
	if len(out.Tracks) != 1 || out.Tracks[0].Error != "" || !resourceID.MatchString(out.Tracks[0].Mid) || out.Description == nil || out.Description.Type != want || out.Description.SDP == "" || (want == "offer") != out.Renegotiate {
		return track{}, "", errResponse
	}
	return out.Tracks[0], out.Description.SDP, nil
}
func (c *Client) Publish(ctx context.Context, id, name, mid, sdp string) (string, error) {
	result, answer, err := c.add(ctx, id, message{Description: &description{"offer", sdp}, Tracks: []track{{Location: "local", Mid: mid, Name: name}}}, "answer")
	if err == nil && result.Mid != mid {
		return "", errResponse
	}
	return answer, err
}
func (c *Client) Subscribe(ctx context.Context, id, publisher, name string) (string, string, error) {
	t, sdp, err := c.add(ctx, id, message{Tracks: []track{{Location: "remote", Session: publisher, Name: name}}}, "offer")
	return t.Mid, sdp, err
}
func (c *Client) Answer(ctx context.Context, id, sdp string) error {
	if !resourceID.MatchString(id) {
		return errResponse
	}
	_, err := c.call(ctx, "PUT", "/"+id+"/renegotiate", &message{Description: &description{"answer", sdp}})
	return err
}

// Each session belongs to one track. If a mutation lost its response, inspect the session to recover its mid.
func (c *Client) Close(ctx context.Context, id, mid string) error {
	if !resourceID.MatchString(id) {
		return errResponse
	}
	if mid == "" {
		out, err := c.call(ctx, "GET", "/"+id, nil)
		if err == apiStatus(404) {
			return nil
		}
		if err != nil {
			return err
		}
		if len(out.Tracks) != 1 {
			return errResponse
		}
		if out.Tracks[0].Status == "inactive" {
			return nil
		}
		mid = out.Tracks[0].Mid
	}
	if !resourceID.MatchString(mid) {
		return errResponse
	}
	out, err := c.call(ctx, "PUT", "/"+id+"/tracks/close", &message{Tracks: []track{{Mid: mid}}, Force: true})
	if err == apiStatus(404) {
		return nil
	}
	if err != nil {
		return err
	}
	if len(out.Tracks) == 1 && out.Tracks[0].Mid == mid && out.Tracks[0].Error == "close_track_error" && out.Tracks[0].Detail == "Track doesn't exist or was already closed" {
		return nil
	}
	if len(out.Tracks) != 1 || out.Tracks[0].Mid != mid || out.Tracks[0].Error != "" {
		return errResponse
	}
	return nil
}

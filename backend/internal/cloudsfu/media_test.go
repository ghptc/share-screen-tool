package cloudsfu

import (
	"context"
	"crypto/rand"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"os/exec"
	"slices"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/pion/rtcp"
	"github.com/pion/webrtc/v4"
)

// Loopback RTP forwarder for offline browser tests. The hosted test replaces
// this fixture with Client and runs the same publisher and subscriber code.
type relayPeer struct {
	pc    *webrtc.PeerConnection
	local *webrtc.TrackLocalStaticRTP
	ssrc  webrtc.SSRC
}
type relay struct {
	mu    sync.Mutex
	peers map[string]*relayPeer
}

func (r *relay) NewSession(context.Context) (string, error) {
	pc, err := webrtc.NewPeerConnection(webrtc.Configuration{})
	if err != nil {
		return "", err
	}
	id := rand.Text()
	r.mu.Lock()
	r.peers[id] = &relayPeer{pc: pc}
	r.mu.Unlock()
	return id, nil
}
func (r *relay) peer(id string) *relayPeer { r.mu.Lock(); defer r.mu.Unlock(); return r.peers[id] }
func gathered(ctx context.Context, pc *webrtc.PeerConnection, d webrtc.SessionDescription) (string, error) {
	done := webrtc.GatheringCompletePromise(pc)
	if err := pc.SetLocalDescription(d); err != nil {
		return "", err
	}
	select {
	case <-done:
		return pc.LocalDescription().SDP, nil
	case <-ctx.Done():
		return "", ctx.Err()
	}
}
func (r *relay) Publish(ctx context.Context, id, name, mid, offer string) (string, error) {
	p := r.peer(id)
	track, err := webrtc.NewTrackLocalStaticRTP(webrtc.RTPCodecCapability{MimeType: webrtc.MimeTypeVP8}, "video", "screen")
	if err != nil {
		return "", err
	}
	p.local = track
	p.pc.OnTrack(func(remote *webrtc.TrackRemote, _ *webrtc.RTPReceiver) {
		r.mu.Lock()
		p.ssrc = remote.SSRC()
		r.mu.Unlock()
		for {
			pkt, _, err := remote.ReadRTP()
			if err != nil {
				return
			}
			_ = track.WriteRTP(pkt)
		}
	})
	if err = p.pc.SetRemoteDescription(webrtc.SessionDescription{Type: webrtc.SDPTypeOffer, SDP: offer}); err != nil {
		return "", err
	}
	d, err := p.pc.CreateAnswer(nil)
	if err != nil {
		return "", err
	}
	return gathered(ctx, p.pc, d)
}
func (r *relay) Subscribe(ctx context.Context, id, source, name string) (string, string, error) {
	p, pub := r.peer(id), r.peer(source)
	sender, err := p.pc.AddTrack(pub.local)
	if err != nil {
		return "", "", err
	}
	go func() {
		for {
			if _, _, err := sender.ReadRTCP(); err != nil {
				return
			}
			r.mu.Lock()
			ssrc := pub.ssrc
			r.mu.Unlock()
			if ssrc != 0 {
				_ = pub.pc.WriteRTCP([]rtcp.Packet{&rtcp.PictureLossIndication{MediaSSRC: uint32(ssrc)}})
			}
		}
	}()
	d, err := p.pc.CreateOffer(nil)
	if err != nil {
		return "", "", err
	}
	sdp, err := gathered(ctx, p.pc, d)
	return p.pc.GetTransceivers()[0].Mid(), sdp, err
}
func (r *relay) Answer(ctx context.Context, id, sdp string) error {
	return r.peer(id).pc.SetRemoteDescription(webrtc.SessionDescription{Type: webrtc.SDPTypeAnswer, SDP: sdp})
}
func (r *relay) Close(ctx context.Context, id, mid string) error { return r.peer(id).pc.Close() }

func TestTwoBrowserMedia(t *testing.T) {
	mode := os.Getenv("WHITERUN_SFU_MEDIA_TEST")
	if mode == "" {
		t.Skip("set WHITERUN_SFU_MEDIA_TEST to loopback or cloudflare")
	}
	var media Media
	switch mode {
	case "cloudflare":
		c, err := FromEnvironment()
		if err != nil {
			t.Fatal(err)
		}
		media = c
	case "loopback":
		media = &relay{peers: map[string]*relayPeer{}}
	default:
		t.Fatal("unknown media test mode")
	}
	ctx, cancel := context.WithTimeout(context.Background(), 55*time.Second)
	defer cancel()
	type peer struct{ pub, recv, pmid, rmid string }
	var mu sync.Mutex
	var peers [2]peer
	keys := []string{rand.Text(), rand.Text()}
	defer func() {
		c, stop := context.WithTimeout(context.Background(), 12*time.Second)
		defer stop()
		for _, p := range peers {
			for _, track := range [][2]string{{p.recv, p.rmid}, {p.pub, p.pmid}} {
				if track[0] != "" {
					if err := media.Close(c, track[0], track[1]); err != nil {
						t.Errorf("track closure failed: %v", err)
					}
				}
			}
		}
	}()
	mux := http.NewServeMux()
	mux.HandleFunc("GET /{$}", func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "text/html")
		io.WriteString(w, "<!doctype html><body></body>")
	})
	mux.HandleFunc("GET /peer.js", func(w http.ResponseWriter, r *http.Request) { http.ServeFile(w, r, "peer.js") })
	mux.HandleFunc("POST /signal/{op}", func(w http.ResponseWriter, r *http.Request) {
		cookie, err := r.Cookie("test-peer")
		if err != nil || r.Header.Get("Origin") != "http://"+r.Host {
			http.Error(w, "denied", 403)
			return
		}
		i := slices.Index(keys, cookie.Value)
		if i < 0 {
			http.Error(w, "denied", 403)
			return
		}
		var in struct{ Mid, Sdp string }
		if json.NewDecoder(http.MaxBytesReader(w, r.Body, 96<<10)).Decode(&in) != nil {
			http.Error(w, "input", 400)
			return
		}
		mu.Lock()
		defer mu.Unlock()
		p := &peers[i]
		other := &peers[1-i]
		var sdp string
		switch r.PathValue("op") {
		case "publish":
			if p.pub != "" {
				err = errors.New("duplicate")
				break
			}
			p.pub, err = media.NewSession(ctx)
			p.pmid = in.Mid
			if err == nil {
				sdp, err = media.Publish(ctx, p.pub, "screen", in.Mid, in.Sdp)
			}
		case "subscribe":
			if p.recv != "" || other.pub == "" {
				err = errors.New("publication unavailable")
				break
			}
			p.recv, err = media.NewSession(ctx)
			if err == nil {
				p.rmid, sdp, err = media.Subscribe(ctx, p.recv, other.pub, "screen")
			}
		case "answer":
			if p.recv == "" {
				err = errors.New("subscription unavailable")
				break
			}
			err = media.Answer(ctx, p.recv, in.Sdp)
		default:
			http.NotFound(w, r)
			return
		}
		if err != nil {
			t.Errorf("%s failed (%T): %s", r.PathValue("op"), err, safeError(err))
			http.Error(w, "signaling failed", 502)
			return
		}
		json.NewEncoder(w).Encode(map[string]string{"sdp": sdp, "handle": "track"})
	})
	server := httptest.NewServer(mux)
	defer server.Close()
	cmd := exec.CommandContext(ctx, "node", "../../../frontend/smoke/sfu-media.mjs")
	// Browser and JS runner inherit no application or provider credentials.
	for _, name := range []string{"HOME", "PATH", "LANG", "XDG_RUNTIME_DIR", "DISPLAY", "WAYLAND_DISPLAY", "PLAYWRIGHT_BROWSERS_PATH", "E2E_BROWSER"} {
		if v := os.Getenv(name); v != "" {
			cmd.Env = append(cmd.Env, name+"="+v)
		}
	}
	data, _ := json.Marshal(map[string]any{"origin": server.URL, "keys": keys, "hosted": mode == "cloudflare"})
	cmd.Stdin = strings.NewReader(string(data))
	output, err := cmd.Output()
	if err != nil {
		t.Fatalf("browser media test failed: %s", output)
	}
	t.Logf("%s %s", mode, output)
}
func safeError(err error) string {
	var status apiStatus
	if errors.As(err, &status) {
		return status.Error()
	}
	return "negotiation or connectivity failure"
}

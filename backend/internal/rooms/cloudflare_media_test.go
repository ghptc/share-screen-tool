package rooms

import (
	"bufio"
	"context"
	"crypto/rand"
	"encoding/json"
	"io"
	"log"
	"net/http"
	"net/http/httptest"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/ghptc/whiterun-live/backend/internal/cloudsfu"
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
	var media cloudsfu.Media
	switch mode {
	case "cloudflare":
		c, err := cloudsfu.FromEnvironment()
		if err != nil {
			t.Fatal(err)
		}
		media = c
	case "loopback":
		media = &relay{peers: map[string]*relayPeer{}}
	default:
		t.Fatal("unknown media test mode")
	}
	ctx, cancel := context.WithTimeout(context.Background(), 90*time.Second)
	defer cancel()
	mux := http.NewServeMux()
	server := httptest.NewUnstartedServer(mux)
	origin := "https://" + server.Listener.Addr().String()
	fixture := newCFFixture(t, origin, media)
	expiry := os.Getenv("WHITERUN_SFU_BROWSER_EXPIRY") == "1"
	var offset atomic.Int64
	if expiry {
		fixture.a.now = func() time.Time { return time.Now().Add(time.Duration(offset.Load())) }
	}
	mux.Handle("/api/", http.StripPrefix("/api", fixture.api))
	browserTag := "sfu-audio-" + rand.Text()
	var links []func(bool) int
	if helper := os.Getenv("WHITERUN_SFU_TEST_HELPER"); helper != "" {
		if mode != "cloudflare" {
			t.Fatal("hosted audio requires Cloudflare")
		}
		desktops := map[string]*http.ServeMux{}
		for i, tones := range [][2]float64{{750, 1500}, {1000, 2000}} {
			desktop := http.NewServeMux()
			desktops[strconv.Itoa(33+i)] = desktop
			check := hostedDesktop(t, ctx, desktop, fixture, helper, browserTag+"-"+strconv.Itoa(i), tones)
			if check(false) != 0 {
				t.Fatal("capture active before consent")
			}
			links = append(links, check)
		}
		mux.HandleFunc("/player/", func(w http.ResponseWriter, r *http.Request) {
			session, ok := fixture.a.discord.oauth.Current(r)
			if !ok || desktops[session.User] == nil {
				http.Error(w, "Forbidden", 403)
				return
			}
			desktops[session.User].ServeHTTP(w, r)
		})
	}
	dist := "../../../frontend/dist"
	if _, err := os.Stat(filepath.Join(dist, "index.html")); err != nil {
		t.Fatal("build the frontend before running the browser test")
	}
	mux.Handle("GET /assets/", http.FileServer(http.Dir(dist)))
	mux.HandleFunc("GET /r/{ref}", func(w http.ResponseWriter, r *http.Request) { http.ServeFile(w, r, filepath.Join(dist, "index.html")) })
	server.Config.ErrorLog = log.New(io.Discard, "", 0) // Chromium probes the disposable test certificate before using the trusted test context.
	server.StartTLS()
	defer server.Close()
	// Each cookie comes from a completed authorization-code exchange. No admission bypass.
	cookies := []string{fixture.login(t, "33").Value, fixture.login(t, "34").Value}
	monitorCtx, stop := context.WithCancel(ctx)
	done := make(chan struct{})
	go func() { defer close(done); fixture.a.ReconcileDiscord(monitorCtx) }()
	defer func() {
		stop()
		<-done
		fixture.a.prototype.mu.Lock()
		defer fixture.a.prototype.mu.Unlock()
		if len(fixture.a.prototype.tracks) != 0 {
			t.Error("provider closures remain pending")
		}
	}()
	cmd := exec.CommandContext(ctx, "node", "../../../frontend/smoke/sfu-media.mjs")
	// Browser and JS runner inherit no application or provider credentials.
	for _, name := range []string{"HOME", "PATH", "LANG", "XDG_RUNTIME_DIR", "DISPLAY", "WAYLAND_DISPLAY", "PLAYWRIGHT_BROWSERS_PATH", "E2E_BROWSER"} {
		if v := os.Getenv(name); v != "" {
			cmd.Env = append(cmd.Env, name+"="+v)
		}
	}
	data, _ := json.Marshal(map[string]any{"origin": server.URL, "cookies": cookies, "ref": fixture.ref, "hosted": mode == "cloudflare", "withAudio": links != nil, "browserTag": browserTag, "expiry": expiry})
	cmd.Stdin = strings.NewReader(string(data))
	stream, err := cmd.StdoutPipe()
	if err != nil {
		t.Fatal("browser output unavailable")
	}
	if err = cmd.Start(); err != nil {
		t.Fatal("browser runner unavailable")
	}
	scanner := bufio.NewScanner(stream)
	switched := false
	var report string
	for scanner.Scan() {
		line := scanner.Text()
		if line == "audio-received" && links != nil {
			for i, check := range links {
				if n := check(true); n != 2 {
					t.Errorf("expected two isolated PipeWire links on peer %d; observed %d", i, n)
				}
			}
		} else if expiry && line == "expire-video-grants" {
			offset.Store(int64(10 * time.Hour))
			switched = true
		} else if line == "switch-publisher-channel" {
			fixture.voice(t, "33", "23")
			switched = true
		} else {
			report = line
		}
	}
	if err = cmd.Wait(); err != nil || !switched {
		t.Fatalf("browser media test failed: %s", report)
	}
	for _, check := range links {
		for until := time.Now().Add(5 * time.Second); time.Now().Before(until) && check(false) != 0; {
			time.Sleep(100 * time.Millisecond)
		}
		if check(false) != 0 {
			t.Fatal("native capture survived departure")
		}
	}
	t.Logf("%s %s", mode, report)
}

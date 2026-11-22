package cloudsfu

import (
	"context"
	"encoding/binary"
	"encoding/json"
	"io"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"strings"
	"sync/atomic"
	"syscall"
	"testing"
	"time"

	"github.com/pion/webrtc/v4"
	"github.com/pion/webrtc/v4/pkg/media"
)

type deadlineAllocation struct {
	Session, Publisher, Mid, SDP string
	Until                        time.Time
}

// This test subprocess does signaling only. Both WebRTC endpoints belong to
// the test driver, so stopping the controller cannot stop their packet clocks.
func TestVideoDeadlineController(t *testing.T) {
	if os.Getenv("WHITERUN_VIDEO_CONTROLLER") != "1" {
		t.Skip("subprocess only")
	}
	c, err := FromEnvironment()
	if err != nil {
		t.Fatal(err)
	}
	guard, err := StartGuard(t.Context(), os.Getenv("WHITERUN_SFU_STATE_DIR"), c)
	if err != nil {
		t.Fatal(err)
	}
	defer guard.Stop()
	var a deadlineAllocation
	if json.NewDecoder(os.Stdin).Decode(&a) != nil {
		t.Fatal("missing test allocation")
	}
	a.Session, err = c.NewSession(t.Context())
	if err != nil {
		t.Fatal(err)
	}
	a.Until = time.Now().Add(12 * time.Second)
	ctx := WithAuthorizationExpiry(t.Context(), a.Until)
	if a.Publisher == "" {
		a.SDP, err = guard.Publish(ctx, a.Session, "video", a.Mid, a.SDP)
	} else {
		a.Mid, a.SDP, err = guard.Subscribe(ctx, a.Session, a.Publisher, "video")
	}
	if err != nil {
		t.Fatal("provider allocation failed")
	}
	if err = json.NewEncoder(os.Stdout).Encode(a); err != nil {
		t.Fatal("allocation reply failed")
	}
	_, _ = io.Copy(io.Discard, os.Stdin)
}

func TestHostedVideoDeadline(t *testing.T) {
	if os.Getenv("WHITERUN_VIDEO_DEADLINE_TEST") != "1" {
		t.Skip("opt-in hosted video only")
	}
	frame, err := exec.Command("ffmpeg", "-nostdin", "-v", "error", "-f", "lavfi", "-i", "color=blue:s=96x64:r=10", "-an", "-frames:v", "1", "-c:v", "libvpx", "-f", "ivf", "pipe:1").Output()
	if err != nil || len(frame) < 45 || string(frame[:4]) != "DKIF" || int(binary.LittleEndian.Uint32(frame[32:])) != len(frame)-44 {
		t.Fatal("VP8 fixture unavailable")
	}
	for _, role := range []string{"publisher", "subscriber", "host-outage"} {
		t.Run(role, func(t *testing.T) { hostedVideoDeadline(t, role, frame[44:]) })
	}
}

func hostedVideoDeadline(t *testing.T, role string, frame []byte) {
	ctx, cancel := context.WithTimeout(t.Context(), 45*time.Second)
	defer cancel()
	c, err := FromEnvironment()
	if err != nil {
		t.Fatal(err)
	}
	pcs := make([]*webrtc.PeerConnection, 2)
	for i := range pcs {
		pc, e := webrtc.NewPeerConnection(webrtc.Configuration{ICEServers: []webrtc.ICEServer{{URLs: []string{"stun:stun.cloudflare.com:3478"}}}})
		if e != nil {
			t.Fatal(e)
		}
		pcs[i] = pc
		defer pc.Close()
	}
	pub, sub := pcs[0], pcs[1]
	track, err := webrtc.NewTrackLocalStaticSample(webrtc.RTPCodecCapability{MimeType: webrtc.MimeTypeVP8, ClockRate: 90000}, "screen", "screen")
	if err != nil {
		t.Fatal(err)
	}
	tx, err := pub.AddTransceiverFromTrack(track, webrtc.RTPTransceiverInit{Direction: webrtc.RTPTransceiverDirectionSendonly})
	if err != nil {
		t.Fatal(err)
	}
	offer, err := pub.CreateOffer(nil)
	if err != nil {
		t.Fatal(err)
	}
	a := deadlineAllocation{SDP: gather(t, pub, offer), Mid: tx.Mid()}
	dir := t.TempDir()
	child := exec.CommandContext(ctx, os.Args[0], "-test.run=^TestVideoDeadlineController$")
	child.Env = append(os.Environ(), "WHITERUN_VIDEO_CONTROLLER=1", "WHITERUN_SFU_STATE_DIR="+dir)
	in, err := child.StdinPipe()
	if err != nil {
		t.Fatal(err)
	}
	out, err := child.StdoutPipe()
	if err != nil {
		t.Fatal(err)
	}
	if err = child.Start(); err != nil {
		t.Fatal(err)
	}
	defer func() { in.Close(); child.Process.Kill(); child.Wait() }()
	var owned deadlineAllocation
	allocate := func(req deadlineAllocation) deadlineAllocation {
		t.Helper()
		if json.NewEncoder(in).Encode(req) != nil || json.NewDecoder(out).Decode(&owned) != nil {
			t.Fatal("protected video allocation failed")
		}
		return owned
	}
	if role == "subscriber" {
		a.Session, err = c.NewSession(ctx)
		if err != nil {
			t.Fatal(err)
		}
		a.SDP, err = c.Publish(ctx, a.Session, "video", a.Mid, a.SDP)
		if err != nil {
			t.Fatal(err)
		}
	} else {
		a = allocate(a)
	}
	defer c.Close(context.Background(), a.Session, a.Mid)
	if pub.SetRemoteDescription(webrtc.SessionDescription{Type: webrtc.SDPTypeAnswer, SDP: a.SDP}) != nil {
		t.Fatal("publish answer failed")
	}
	go func() {
		tick := time.NewTicker(100 * time.Millisecond)
		defer tick.Stop()
		for {
			select {
			case <-ctx.Done():
				return
			case <-tick.C:
				_ = track.WriteSample(media.Sample{Data: frame, Duration: 100 * time.Millisecond})
			}
		}
	}()
	wait := func(ok func() bool) {
		t.Helper()
		for !ok() {
			select {
			case <-ctx.Done():
				t.Fatal("video check timed out")
			case <-time.After(40 * time.Millisecond):
			}
		}
	}
	wait(func() bool { return pub.ConnectionState() == webrtc.PeerConnectionStateConnected })
	var packets atomic.Int64
	sub.OnTrack(func(r *webrtc.TrackRemote, _ *webrtc.RTPReceiver) {
		if r.Kind() != webrtc.RTPCodecTypeVideo {
			return
		}
		for {
			if _, _, e := r.ReadRTP(); e != nil {
				return
			}
			packets.Add(1)
		}
	})
	rx := deadlineAllocation{Publisher: a.Session}
	if role == "subscriber" {
		rx = allocate(rx)
	} else {
		rx.Session, err = c.NewSession(ctx)
		if err != nil {
			t.Fatal(err)
		}
		rx.Mid, rx.SDP, err = c.Subscribe(ctx, rx.Session, a.Session, "video")
		if err != nil {
			t.Fatal(err)
		}
	}
	defer c.Close(context.Background(), rx.Session, rx.Mid)
	if sub.SetRemoteDescription(webrtc.SessionDescription{Type: webrtc.SDPTypeOffer, SDP: rx.SDP}) != nil {
		t.Fatal("subscribe offer failed")
	}
	answer, err := sub.CreateAnswer(nil)
	if err != nil {
		t.Fatal(err)
	}
	if c.Answer(ctx, rx.Session, gather(t, sub, answer)) != nil {
		t.Fatal("subscribe answer failed")
	}
	wait(func() bool { return packets.Load() >= 4 })
	if !time.Now().Before(owned.Until) {
		t.Fatal("setup exceeded test lease")
	}
	if err = child.Process.Signal(syscall.SIGSTOP); err != nil {
		t.Fatal(err)
	}
	if role == "host-outage" {
		// Identify only the detached watchdog launched by this test controller.
		files, _ := filepath.Glob("/proc/" + strconv.Itoa(child.Process.Pid) + "/task/*/children")
		var watcher *os.Process
		for _, file := range files {
			data, _ := os.ReadFile(file)
			for _, pid := range strings.Fields(string(data)) {
				args, _ := os.ReadFile("/proc/" + pid + "/cmdline")
				if !strings.Contains(string(args), "\x00sfu-watchdog\x00") {
					continue
				}
				n, e := strconv.Atoi(pid)
				if e == nil {
					watcher, _ = os.FindProcess(n)
				}
			}
		}
		if watcher == nil || watcher.Signal(syscall.SIGSTOP) != nil {
			t.Fatal("test watchdog unavailable")
		}
		defer watcher.Signal(syscall.SIGCONT)
		time.Sleep(time.Until(owned.Until.Add(300 * time.Millisecond)))
		before := packets.Load()
		time.Sleep(time.Second)
		delta := packets.Load() - before
		if delta < 5 {
			t.Fatal("unavailable-host experiment inconclusive")
		}
		t.Logf("both control processes suspended: %d video RTP packets received during one second after expiry", delta)
		if watcher.Signal(syscall.SIGCONT) != nil {
			t.Fatal("watchdog recovery failed")
		}
	}
	wait(func() bool {
		_, e := os.Stat(filepath.Join(dir, os.Getenv("CLOUDFLARE_SFU_APP_ID"), owned.Session+".track"))
		return os.IsNotExist(e)
	})
	state, e := c.call(ctx, "GET", "/"+owned.Session, nil)
	if e != errSessionGone && (e != nil || len(state.Tracks) != 1 || state.Tracks[0].Status != "inactive") {
		t.Fatal("provider did not confirm closure")
	}
	lag := time.Since(owned.Until)
	time.Sleep(350 * time.Millisecond)
	n := packets.Load()
	time.Sleep(time.Second)
	if packets.Load() != n {
		t.Fatal("video continued past confirmed closure")
	}
	t.Logf("provider closure confirmed %s after deadline; %d prior video packets, zero in final second while sender remained active", lag.Round(time.Millisecond), n)
}

func TestExpiryReaperRetainsUnconfirmedClosure(t *testing.T) {
	m := &recoveryMedia{fail: true}
	o, err := openOwner(t.TempDir(), strings.Repeat("a", 32), m)
	if err != nil {
		t.Fatal(err)
	}
	defer o.directory.Close()
	deadline := time.Now().Add(10 * time.Hour)
	for i, until := range []time.Time{deadline, deadline.Add(time.Hour)} {
		if err = o.save(strconv.Itoa(i), journalEntry{ownership{"0", "screen", "local"}, until}); err != nil {
			t.Fatal(err)
		}
	}
	if err = o.reap(t.Context(), deadline.Add(-time.Nanosecond)); err != nil {
		t.Fatal("closed before deadline")
	}
	if err = o.reap(t.Context(), deadline); err == nil {
		t.Fatal("provider outage treated as closure")
	}
	if _, err = os.Stat(filepath.Join(o.directory.Name(), "0.track")); err != nil {
		t.Fatal("pending revocation lost")
	}
	m.fail = false
	if err = o.reap(t.Context(), deadline); err != nil || m.closed != 1 {
		t.Fatal("recovery missed expired session")
	}
	if _, err = os.Stat(filepath.Join(o.directory.Name(), "1.track")); err != nil {
		t.Fatal("unrelated session interrupted")
	}
}

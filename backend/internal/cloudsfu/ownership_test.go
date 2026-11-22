package cloudsfu

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"github.com/pion/webrtc/v4"
	"github.com/pion/webrtc/v4/pkg/media"
)

func TestMain(m *testing.M) {
	if len(os.Args) == 3 && os.Args[1] == "sfu-watchdog" {
		if WatchController(os.Args[2]) != nil {
			os.Exit(1)
		}
		os.Exit(0)
	}
	os.Exit(m.Run())
}

type recoveryMedia struct {
	Media
	fail   bool
	closed int
}

func (f *recoveryMedia) Close(ctx context.Context, id, mid string) error {
	if f.fail {
		return errors.New("provider offline")
	}
	f.closed++
	return nil
}
func TestRecoverBeforeAdmission(t *testing.T) {
	dir := t.TempDir()
	app := strings.Repeat("a", 32)
	m := &recoveryMedia{fail: true}
	first, err := openOwner(dir, app, m)
	if err != nil {
		t.Fatal(err)
	}
	if _, err = openOwner(dir, app, m); err == nil {
		t.Fatal("second owner admitted")
	}
	if err = first.record("session", ownership{"0", "opaque", "local"}); err != nil {
		t.Fatal(err)
	}
	first.directory.Close()
	second, err := openOwner(dir, app, m)
	if err != nil {
		t.Fatal(err)
	}
	defer second.directory.Close()
	if second.recover(t.Context()) == nil {
		t.Fatal("unconfirmed closure discarded")
	}
	m.fail = false
	if err = second.recover(t.Context()); err != nil || m.closed != 1 {
		t.Fatal("recovery failed")
	}
	if err = second.recover(t.Context()); err != nil || m.closed != 1 {
		t.Fatal("closure not acknowledged durably")
	}
}

type crashSignal struct{ ID, Mid, SDP string }

func TestSFUControllerProcess(t *testing.T) {
	if os.Getenv("WHITERUN_TEST_CONTROLLER") != "1" {
		t.Skip("crash-test child")
	}
	c, err := FromEnvironment()
	if err != nil {
		t.Fatal(err)
	}
	g, err := StartGuard(t.Context(), os.Getenv("WHITERUN_SFU_STATE_DIR"), c)
	if err != nil {
		t.Fatal(err)
	}
	defer g.Stop()
	var s crashSignal
	if json.NewDecoder(os.Stdin).Decode(&s) != nil {
		t.Fatal("missing offer")
	}
	s.ID, err = g.NewSession(t.Context())
	if err != nil {
		t.Fatal(err)
	}
	s.SDP, err = g.Publish(t.Context(), s.ID, "generated", s.Mid, s.SDP)
	if err != nil {
		t.Fatal(err)
	}
	json.NewEncoder(os.Stdout).Encode(s)
	io.Copy(io.Discard, os.Stdin)
}
func gather(t *testing.T, pc *webrtc.PeerConnection, d webrtc.SessionDescription) string {
	t.Helper()
	done := webrtc.GatheringCompletePromise(pc)
	if pc.SetLocalDescription(d) != nil {
		t.Fatal("local description failed")
	}
	select {
	case <-done:
	case <-time.After(8 * time.Second):
		t.Fatal("ICE timeout")
	}
	return pc.LocalDescription().SDP
}
func TestHostedControllerCrash(t *testing.T) {
	if os.Getenv("WHITERUN_SFU_MEDIA_TEST") != "cloudflare" {
		t.Skip("hosted SFU opt-in")
	}
	ctx, cancel := context.WithTimeout(t.Context(), 50*time.Second)
	defer cancel()
	c, err := FromEnvironment()
	if err != nil {
		t.Fatal(err)
	}
	peer := func() *webrtc.PeerConnection {
		p, e := webrtc.NewPeerConnection(webrtc.Configuration{ICEServers: []webrtc.ICEServer{{URLs: []string{"stun:stun.cloudflare.com:3478"}}}})
		if e != nil {
			t.Fatal(e)
		}
		t.Cleanup(func() { p.Close() })
		return p
	}
	pub, sub := peer(), peer()
	track, err := webrtc.NewTrackLocalStaticSample(webrtc.RTPCodecCapability{MimeType: webrtc.MimeTypeOpus, ClockRate: 48000, Channels: 2}, "audio", "generated")
	if err != nil {
		t.Fatal(err)
	}
	tx, err := pub.AddTransceiverFromTrack(track, webrtc.RTPTransceiverInit{Direction: webrtc.RTPTransceiverDirectionSendonly})
	if err != nil {
		t.Fatal(err)
	}
	d, err := pub.CreateOffer(nil)
	if err != nil {
		t.Fatal(err)
	}
	offer := gather(t, pub, d)
	dir := t.TempDir()
	proc := exec.CommandContext(ctx, os.Args[0], "-test.run=^TestSFUControllerProcess$")
	proc.Env = append(os.Environ(), "WHITERUN_TEST_CONTROLLER=1", "WHITERUN_SFU_STATE_DIR="+dir)
	in, _ := proc.StdinPipe()
	out, _ := proc.StdoutPipe()
	if err = proc.Start(); err != nil {
		t.Fatal(err)
	}
	defer func() {
		in.Close()
		if proc.ProcessState == nil {
			proc.Process.Kill()
			proc.Wait()
		}
	}()
	if err = json.NewEncoder(in).Encode(crashSignal{Mid: tx.Mid(), SDP: offer}); err != nil {
		t.Fatal(err)
	}
	var s crashSignal
	if json.NewDecoder(out).Decode(&s) != nil {
		t.Fatal("protected allocation failed")
	}
	defer c.Close(context.Background(), s.ID, s.Mid)
	if pub.SetRemoteDescription(webrtc.SessionDescription{Type: webrtc.SDPTypeAnswer, SDP: s.SDP}) != nil {
		t.Fatal("publish answer failed")
	}
	go func() {
		tick := time.NewTicker(20 * time.Millisecond)
		defer tick.Stop()
		for {
			select {
			case <-ctx.Done():
				return
			case <-tick.C:
				_ = track.WriteSample(media.Sample{Data: []byte{0xf8, 0xff, 0xfe}, Duration: 20 * time.Millisecond})
			}
		}
	}()
	wait := func(f func() bool) {
		t.Helper()
		for !f() {
			select {
			case <-ctx.Done():
				t.Fatal("media check timed out")
			case <-time.After(50 * time.Millisecond):
			}
		}
	}
	wait(func() bool { return pub.ConnectionState() == webrtc.PeerConnectionStateConnected })
	var packets atomic.Int64
	sub.OnTrack(func(r *webrtc.TrackRemote, _ *webrtc.RTPReceiver) {
		for {
			if _, _, e := r.ReadRTP(); e != nil {
				return
			}
			packets.Add(1)
		}
	})
	id, err := c.NewSession(ctx)
	if err != nil {
		t.Fatal(err)
	}
	mid, remote, err := c.Subscribe(ctx, id, s.ID, "generated")
	defer c.Close(context.Background(), id, mid)
	if err != nil {
		t.Fatal(err)
	}
	if sub.SetRemoteDescription(webrtc.SessionDescription{Type: webrtc.SDPTypeOffer, SDP: remote}) != nil {
		t.Fatal("receive offer failed")
	}
	answer, err := sub.CreateAnswer(nil)
	if err != nil {
		t.Fatal(err)
	}
	if err = c.Answer(ctx, id, gather(t, sub, answer)); err != nil {
		t.Fatal(err)
	}
	wait(func() bool { return packets.Load() >= 15 })
	start := time.Now()
	if proc.Process.Kill() != nil {
		t.Fatal("could not terminate controller")
	}
	proc.Wait()
	wait(func() bool {
		_, e := os.Stat(filepath.Join(dir, os.Getenv("CLOUDFLARE_SFU_APP_ID"), s.ID+".track"))
		return os.IsNotExist(e)
	})
	state, err := c.call(ctx, "GET", "/"+s.ID, nil)
	if err != errSessionGone && (err != nil || len(state.Tracks) != 1 || state.Tracks[0].Status != "inactive") {
		t.Fatal("provider did not confirm inactive publication")
	}
	elapsed := time.Since(start)
	time.Sleep(400 * time.Millisecond)
	n := packets.Load()
	time.Sleep(1200 * time.Millisecond)
	if n != packets.Load() {
		t.Fatal("media continued after watchdog revocation")
	}
	t.Logf("SIGKILL to confirmed provider closure %s, %d packets received, zero subsequent packets for 1.2s while sender continued", elapsed.Round(time.Millisecond), n)
}

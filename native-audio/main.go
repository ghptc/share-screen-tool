// Whiterun's foreground PipeWire application audio publisher.
package main

import (
	"bytes"
	"context"
	"crypto/rand"
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"io"
	"net/http"
	"os"
	"os/exec"
	"os/signal"
	"strconv"
	"sync"
	"sync/atomic"
	"syscall"
	"time"

	"github.com/livekit/protocol/livekit"
	lksdk "github.com/livekit/server-sdk-go/v2"
	"github.com/pion/interceptor"
	"github.com/pion/rtcp"
	"github.com/pion/webrtc/v4"
	"golang.org/x/sys/unix"
)

type activityReader struct {
	io.Reader
	last   *atomic.Int64
	timing *timingLog
}

func (r *activityReader) Read(data []byte) (int, error) {
	var queued *int
	if r.timing != nil {
		queued = pendingPCM(r.Reader)
	}
	n, err := r.Reader.Read(data)
	if n > 0 {
		r.last.Store(time.Now().UnixNano())
		fields := map[string]any{"bytes": n}
		if queued != nil {
			fields["pipeQueuedBytesBeforeRead"] = *queued
			fields["pipeQueuedMsBeforeRead"] = float64(*queued) / (48000 * 2 * 2) * 1000
		}
		r.timing.emit("pcm_read", fields)
	}
	return n, err
}

// Only the kernel pipe queue is visible here, not PipeWire's internal buffers.
// Unsupported readers omit the metric; zero must mean a measured empty pipe.
func pendingPCM(reader io.Reader) *int {
	conn, ok := reader.(syscall.Conn)
	if !ok {
		return nil
	}
	raw, err := conn.SyscallConn()
	if err != nil {
		return nil
	}
	var count int
	var ioctlErr error
	if err := raw.Control(func(fd uintptr) {
		count, ioctlErr = unix.IoctlGetInt(int(fd), unix.TIOCINQ)
	}); err != nil || ioctlErr != nil {
		return nil
	}
	return &count
}

var client = &http.Client{Timeout: 5 * time.Second, CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }}

func post(ctx context.Context, base, path, key string, input, out any) error {
	data, _ := json.Marshal(input)
	req, err := http.NewRequestWithContext(ctx, "POST", base+path, bytes.NewReader(data))
	if err != nil {
		return err
	}
	req.Header.Set("Content-Type", "application/json")
	if key != "" {
		req.Header.Set("Authorization", "Bearer "+key)
	}
	res, err := client.Do(req)
	if err != nil {
		return errors.New("backend unavailable")
	}
	defer res.Body.Close()
	if res.StatusCode < 200 || res.StatusCode >= 300 {
		return fmt.Errorf("backend rejected request (%d); pair again while your screen is active", res.StatusCode)
	}
	if out != nil {
		return json.NewDecoder(io.LimitReader(res.Body, 16384)).Decode(out)
	}
	return nil
}
func main() {
	if err := run(); err != nil {
		fmt.Fprintln(os.Stderr, "Native audio:", err)
		os.Exit(1)
	}
}
func run() (runErr error) {
	launcher := flag.Bool("desktop-launcher", false, "Serve the private desktop activation socket")
	playerOrigin := flag.String("player-origin", "http://localhost:5173", "Local player origin for the desktop launcher")
	localCapture := flag.Bool("local-player-capture", false, "Accept only a local default-room capture claim")
	version := flag.Bool("version", false, "Print running executable identity without capture or pairing")
	timingPath := flag.String("timing-json", "", "Optional new metadata-only JSONL timing log (never audio); explicit capture consent still required")
	instance := flag.String("pipewire-instance", "", "Expected PipeWire core instance for a desktop selection")
	application := flag.Uint64("application", 0, "Explicit local application object.serial from --list-applications; preserves its normal headset playback")
	listApps := flag.Bool("list-applications", false, "List eligible stereo application streams; browser mixes are excluded")
	mixedMonitor := flag.Bool("allow-mixed-monitor", false, "Diagnostic-only consent: whole-monitor capture can retransmit remote playback")
	list := flag.Bool("list", false, "List PipeWire output sinks without capturing")
	sink := flag.String("sink", "", "Diagnostic monitor only: exact output node.name from --list")
	confirm := flag.Bool("start", false, "Explicitly consent to capturing the selected application or diagnostic monitor until Ctrl-C or screen/session stop")
	flag.Parse()
	if *launcher {
		return serveDesktop(*playerOrigin)
	}
	identity, err := executableIdentity()
	if err != nil {
		return fmt.Errorf("executable identity: %w", err)
	}
	if *version {
		return json.NewEncoder(os.Stdout).Encode(identity)
	}
	if *listApps {
		graph, err := readGraph(context.Background())
		if err != nil {
			return err
		}
		for _, n := range graph {
			if applicationAllowed(graph, n) {
				if _, err := stereoPorts(graph, n.ID, "output"); err == nil {
					fmt.Printf("%d\t%s\t%s\n", propID(n.Info.Props["object.serial"]), n.Info.Props["application.name"], n.Info.Props["node.name"])
				}
			}
		}
		return nil
	}
	var nodes []device
	if *list || *sink != "" {
		data, err := exec.Command("pw-dump").Output()
		if err != nil {
			return errors.New("PipeWire unavailable or pw-dump missing")
		}
		nodes, err = sinks(data)
		if err != nil {
			return err
		}
		if *list {
			for _, n := range nodes {
				fmt.Println(n.Info.Props["node.name"])
			}
			return nil
		}
	}
	if !*confirm || (*application == 0 && *sink == "") || (*application != 0 && *sink != "") {
		return errors.New("use --start --application <serial> from --list-applications; monitor diagnostics require --sink plus --allow-mixed-monitor")
	}
	var serial string
	var tap *applicationTap
	if *application != 0 {
		graph, err := readGraph(context.Background())
		if err != nil {
			return err
		}
		if *instance != "" && coreInstance(graph) != *instance {
			return errors.New("selected PipeWire instance ended")
		}
		selected, err := selectApplication(graph, *application)
		if err != nil {
			return err
		}
		if _, err := stereoPorts(graph, selected.ID, "output"); err != nil {
			return err
		}
		name := fmt.Sprintf("whiterun-capture-%x", rand.Text())
		tap = &applicationTap{core: *instance, sourceSerial: *application, sourceID: selected.ID, captureName: name}
		serial = strconv.FormatUint(*application, 10)
	} else {
		if !*mixedMonitor {
			return errors.New("whole-monitor capture includes remote playback; use --application for same-headset sharing, or explicitly opt into --allow-mixed-monitor for diagnostics")
		}
		serial, err = target(nodes, *sink)
		if err != nil {
			return err
		}
	}
	if _, err := exec.LookPath("pw-cat"); err != nil {
		return errors.New("required executable pw-cat is unavailable")
	}
	if !*localCapture {
		fmt.Fprintln(os.Stderr, "Paste the one-time pairing JSON from your active screen, then Enter:")
	}
	var pair struct {
		APIURL string `json:"apiUrl"`
		Code   string `json:"code"`
	}
	if err := json.NewDecoder(io.LimitReader(os.Stdin, 4096)).Decode(&pair); err != nil {
		return errors.New("invalid pairing JSON")
	}
	base, err := apiURL(pair.APIURL)
	if err != nil {
		return err
	}
	ctx, cancel := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer cancel()
	var credentials struct{ Session, Lease, Token, ServerURL string }
	if err := post(ctx, base, "/native-audio/claim", "", map[string]any{"code": pair.Code, "localOnly": *localCapture}, &credentials); err != nil {
		return err
	}
	pair.Code = ""
	defer func() {
		cleanup, c := context.WithTimeout(context.Background(), 5*time.Second)
		defer c()
		_ = post(cleanup, base, "/native-audio/"+credentials.Session+"/stop", credentials.Lease, struct{}{}, nil)
	}()
	timing, err := openTiming(*timingPath)
	if err != nil {
		return err
	}
	fmt.Fprintf(os.Stderr, "Helper PID %v SHA256 %v (libopus, 48000 Hz stereo)\n", identity["pid"], identity["sha256"])
	timing.emit("executable", identity)
	defer func() {
		if err := timing.close(); err != nil {
			runErr = errors.Join(runErr, fmt.Errorf("timing log close: %w", err))
		}
	}()
	options := []lksdk.ConnectOption{lksdk.WithAutoSubscribe(false)}
	if timing != nil {
		options = append(options, lksdk.WithInterceptors([]interceptor.Factory{timingFactory{log: timing}}), lksdk.WithIncludeDefaultInterceptors(true))
	}
	room, err := lksdk.ConnectToRoomWithToken(credentials.ServerURL, credentials.Token, &lksdk.RoomCallback{OnDisconnected: cancel}, options...)
	credentials.Token = ""
	if err != nil {
		return errors.New("could not connect to LiveKit")
	}
	defer room.Disconnect()
	properties := "node.dont-move=true node.dont-reconnect=true node.dont-fallback=true"
	if tap != nil {
		properties += " node.name=" + tap.captureName + " stream.dont-remix=true"
	} else {
		properties += " stream.capture.sink=true"
	}
	// Refuse fallback/reconnection to a different device. Sink removal ends this run.
	capture := exec.CommandContext(ctx, "pw-cat", "--record", "--raw", "--target", serial, "--rate", "48000", "--channels", "2", "--format", "s16", "--latency", "20ms", "--properties", properties, "-")
	capture.SysProcAttr = &syscall.SysProcAttr{Pdeathsig: syscall.SIGKILL}
	pcm, err := capture.StdoutPipe()
	if err != nil {
		return err
	}
	var lastPCM atomic.Int64
	lastPCM.Store(time.Now().UnixNano())
	input := &activityReader{Reader: pcm, last: &lastPCM, timing: timing}
	capture.Stderr = os.Stderr
	var startupExpired atomic.Bool
	startup := time.AfterFunc(8*time.Second, func() { startupExpired.Store(true); cancel() })
	defer startup.Stop()
	track, err := lksdk.NewLocalSampleTrack(webrtc.RTPCodecCapability{MimeType: webrtc.MimeTypeOpus, ClockRate: 48000, Channels: 2}, lksdk.WithRTCPHandler(func(packet rtcp.Packet) {
		if report, ok := packet.(*rtcp.ReceiverReport); ok {
			for _, r := range report.Reports {
				timing.emit("rtcp_receiver_report", map[string]any{"ssrc": r.SSRC, "fractionLost": r.FractionLost, "totalLost": r.TotalLost, "jitterSamples": r.Jitter, "lastSequence": r.LastSequenceNumber})
			}
		}
	}))
	if err != nil {
		return errors.New("Opus encoder did not initialize")
	}
	var streamOnce sync.Once
	bound := make(chan struct{})
	track.OnBind(func() {
		timing.emit("publication_bound", map[string]any{})
		streamOnce.Do(func() { close(bound) })
	})
	track.OnUnbind(func() { timing.emit("publication_unbound", map[string]any{}) })
	defer track.Close()
	pub, err := room.LocalParticipant.PublishTrack(track, &lksdk.TrackPublicationOptions{Name: "PipeWire selected audio", Source: livekit.TrackSource_SCREEN_SHARE_AUDIO})
	if err != nil {
		return errors.New("audio publication rejected")
	}
	defer room.LocalParticipant.UnpublishTrack(pub.SID())
	// Do not queue old desktop audio in an unread pipe during SDP/ICE negotiation.
	select {
	case <-bound:
	case <-ctx.Done():
		if startupExpired.Load() {
			return errors.New("audio publication did not bind within eight seconds")
		}
		return nil
	}
	startup.Stop()
	if err := capture.Start(); err != nil {
		return err
	}
	defer func() { _ = capture.Process.Kill(); _ = capture.Wait() }()
	if tap != nil {
		if err := tap.waitForLinks(ctx); err != nil {
			return err
		}
	}
	lastPCM.Store(time.Now().UnixNano())
	captureInfo := map[string]any{"pid": capture.Process.Pid, "mode": "mixed-monitor-diagnostic"}
	if tap != nil {
		captureInfo["mode"] = "isolated-application"
		captureInfo["sourceSerial"] = tap.sourceSerial
		captureInfo["captureSerial"] = tap.captureSerial
	}
	timing.emit("capture_started", captureInfo)
	var streamError error
	done := make(chan struct{})
	go func() {
		defer close(done)
		streamError = streamPCM(ctx, input, track, timing)
	}()
	defer func() {
		cancel()
		_ = pcm.Close()
		<-done
	}()
	if *localCapture {
		fmt.Fprintln(os.Stdout, "ready")
	}
	fmt.Fprintln(os.Stderr, "Publishing selected audio as Opus stereo 48 kHz / requested 128 kbps. Ctrl-C stops. This is not a measured network bitrate.")
	ticker := time.NewTicker(2 * time.Second)
	defer ticker.Stop()
	for {
		select {
		case <-ctx.Done():
			if startupExpired.Load() {
				return errors.New("audio publication did not bind within eight seconds")
			}
			return nil
		case <-done:
			if ctx.Err() != nil {
				if startupExpired.Load() {
					return errors.New("audio publication did not bind within eight seconds")
				}
				return nil
			}
			return fmt.Errorf("audio stream ended; list and select the source again to resume: %w", streamError)
		case <-ticker.C:
			if err := timing.check(); err != nil {
				return fmt.Errorf("timing log failed: %w", err)
			}

			if time.Since(time.Unix(0, lastPCM.Load())) > 5*time.Second {
				return errors.New("PipeWire capture stalled; start again explicitly after checking the device")
			}
			if err := post(ctx, base, "/native-audio/"+credentials.Session+"/lease", credentials.Lease, struct{}{}, nil); err != nil {
				return err
			}
			if tap != nil {
				if err := tap.verify(ctx); err != nil {
					return err
				}
				continue
			}
			inventory, err := exec.CommandContext(ctx, "pw-dump").Output()
			if err != nil {
				return errors.New("PipeWire became unavailable")
			}
			current, err := sinks(inventory)
			if err != nil {
				return err
			}
			actual, err := target(current, *sink)
			if err != nil || actual != serial {
				return errors.New("selected device changed or disappeared; choose a sink and start again explicitly")
			}
		}
	}
}

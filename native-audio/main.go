// Screen Share's foreground PipeWire application audio publisher.
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
	"strings"
	"sync/atomic"
	"syscall"
	"time"

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
	httpClient := client
	if strings.HasSuffix(path, "/publish") {
		slow := *client
		slow.Timeout = 14 * time.Second
		httpClient = &slow
	}
	res, err := httpClient.Do(req)
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

const (
	applicationDiscovery = "application discovery"
	initialLinks         = "initial FL/FR link verification"
	activeLinks          = "active FL/FR link verification"
)

var errTransportEnded = errors.New("media transport ended")

// Wait for child exit independently of graph polling or a blocked PCM read.
// Use our own pipe so exec.Wait cannot close a descriptor under the reader.
func startRecorder(cmd *exec.Cmd, cancel context.CancelCauseFunc) (*os.File, func(), error) {
	r, w, err := os.Pipe()
	if err != nil {
		return nil, nil, err
	}
	cmd.Stdout, cmd.Stderr = w, os.Stderr
	err = cmd.Start()
	w.Close()
	if err != nil {
		r.Close()
		return nil, nil, err
	}
	done := make(chan struct{})
	go func() {
		err := cmd.Wait()
		if err == nil {
			err = io.EOF
		}
		cancel(fmt.Errorf("selected audio recorder exited: %w", err))
		close(done)
	}()
	return r, func() {
		r.Close()
		_ = cmd.Process.Kill()
		<-done
	}, nil
}

// Callers return immediately so both a stop and a failed check release capture.
func stopAfterGraphError(phase string, err error) error {
	if errors.Is(err, context.Canceled) {
		fmt.Fprintf(os.Stderr, "Native audio: %s: session stopped\n", phase)
		return nil
	}
	return fmt.Errorf("%s: %w", phase, err)
}

func run() (runErr error) {
	launcher := flag.Bool("desktop-launcher", false, "Serve the local player's Unix socket or a hosted player's authenticated loopback listener")
	playerOrigin := flag.String("player-origin", "http://localhost:5173", "Exact player origin authorized by the desktop launcher")
	localCapture := flag.Bool("local-player-capture", false, "Accept only a default-room or Discord desktop launcher claim and acknowledge startup on stdout")
	version := flag.Bool("version", false, "Print running executable identity without capture or pairing")
	timingPath := flag.String("timing-json", "", "Optional new metadata-only JSONL timing log (never audio); explicit capture consent still required")
	instance := flag.String("pipewire-instance", "", "Expected PipeWire core instance for a desktop selection")
	additional := flag.String("additional-applications", "", "Additional explicitly authorized application serials on the selected core")
	application := flag.Uint64("application", 0, "Explicit local application object.serial from --list-applications; preserves its normal headset playback")
	listApps := flag.Bool("list-applications", false, "List eligible stereo application streams; browser mixes are excluded")
	mixedMonitor := flag.Bool("allow-mixed-monitor", false, "Diagnostic-only consent: whole-monitor capture can retransmit remote playback")
	list := flag.Bool("list", false, "List PipeWire output sinks without capturing")
	sink := flag.String("sink", "", "Diagnostic monitor only: exact output node.name from --list")
	confirm := flag.Bool("start", false, "Explicitly consent to capturing the selected application or diagnostic monitor until Ctrl-C or screen/session stop")
	flag.Parse()
	if *launcher {
		return serveDesktop(*playerOrigin, os.Getenv("WHITERUN_DESKTOP_SOCKET"))
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
			return stopAfterGraphError(applicationDiscovery, err)
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
			return stopAfterGraphError(applicationDiscovery, err)
		}
		core := coreInstance(graph)
		if core == "" || (*instance != "" && core != *instance) {
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
		// A manual pairing can wait at stdin while PipeWire restarts and reuses a serial.
		tap = &applicationTap{core: core, sourceSerial: *application, sourceID: selected.ID, captureName: name}
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
	var extraTaps []*applicationTap
	if *additional != "" {
		ids := strings.Split(*additional, ",")
		if tap == nil || *instance == "" || len(ids) > 7 {
			return errors.New("invalid additional application selection")
		}
		graph, err := readGraph(context.Background())
		if err != nil {
			return stopAfterGraphError(applicationDiscovery, err)
		}
		if coreInstance(graph) != *instance {
			return errors.New("selected PipeWire instance ended")
		}
		seen := map[uint64]bool{*application: true}
		for _, id := range ids {
			n, err := strconv.ParseUint(id, 10, 64)
			if err != nil || n == 0 || seen[n] {
				return errors.New("invalid additional application")
			}
			seen[n] = true
			node, err := selectApplication(graph, n)
			if err != nil {
				return err
			}
			if _, err = stereoPorts(graph, node.ID, "output"); err != nil {
				return err
			}
			extraTaps = append(extraTaps, &applicationTap{core: *instance, sourceSerial: n, sourceID: node.ID, captureName: fmt.Sprintf("whiterun-capture-%x", rand.Text())})
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
	signalCtx, stopSignals := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stopSignals()
	ctx, cancel := context.WithCancelCause(signalCtx)
	defer cancel(nil)
	claimedAt := time.Now()
	var credentials audioCredentials
	if err := post(ctx, base, "/native-audio/claim", "", map[string]any{"code": pair.Code, "localOnly": *localCapture}, &credentials); err != nil {
		return err
	}
	pair.Code = ""
	defer func() {
		cleanup, c := context.WithTimeout(context.Background(), 5*time.Second)
		defer c()
		_ = post(cleanup, base, "/native-audio/"+credentials.Session+"/stop", credentials.Lease, struct{}{}, nil)
	}()
	deadline := claimedAt.Add(applicationStartupLimit)
	startTimer := time.AfterFunc(time.Until(deadline), func() { cancel(errStartupExpired) })
	defer startTimer.Stop()
	var phase atomic.Value
	phase.Store("starting")
	path := "/native-audio/" + credentials.Session
	var lease helperLease
	lease.granted(claimedAt)
	renew := func(c context.Context) error {
		return post(c, base, path+"/lease", credentials.Lease, map[string]any{"phase": phase.Load()}, nil)
	}
	leaseDone := make(chan struct{})
	go func() {
		defer close(leaseDone)
		cancel(lease.supervise(ctx, renew))
	}()
	defer func() { cancel(nil); <-leaseDone }()
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
	properties := "node.dont-move=true node.dont-reconnect=true node.dont-fallback=true"
	if tap != nil {
		properties += " node.name=" + tap.captureName + " stream.dont-remix=true"
	} else {
		properties += " stream.capture.sink=true"
	}
	// Refuse fallback/reconnection to a different device. Sink removal ends this run.
	capture := exec.CommandContext(ctx, "pw-cat", "--record", "--raw", "--target", serial, "--rate", "48000", "--channels", "2", "--format", "s16", "--latency", "20ms", "--properties", properties, "-")
	capture.SysProcAttr = &syscall.SysProcAttr{Pdeathsig: syscall.SIGKILL}
	if credentials.Transport == "cloudflare" && tap == nil {
		return errors.New("Cloudflare audio requires an explicitly selected application")
	}
	writeSample, closeMedia, err := openAudioTransport(ctx, func() { cancel(errTransportEnded) }, base, credentials, timing)
	if err != nil {
		return err
	}
	defer closeMedia()
	if tap != nil {
		// Pairing and transport setup can outlive the selected PipeWire object.
		graph, err := readGraph(ctx)
		if err != nil {
			return err
		}
		for _, selected := range append(extraTaps, tap) {
			n, err := selectApplication(graph, selected.sourceSerial)
			if err != nil || n.ID != selected.sourceID || coreInstance(graph) != selected.core {
				return errors.New("selected application ended or changed; explicit reselection required")
			}
		}
	}
	pcm, stopCapture, err := startRecorder(capture, cancel)
	if err != nil {
		return err
	}
	defer stopCapture()
	var lastPCM atomic.Int64
	input := &activityReader{Reader: pcm, last: &lastPCM, timing: timing}
	var recorders []recordingInput
	if tap != nil {
		recorders = append(recorders, recordingInput{tap: tap, stdout: pcm})
	}
	if len(extraTaps) > 0 {
		inputs := []io.Reader{pcm}
		for _, extra := range extraTaps {
			args := append([]string(nil), capture.Args[1:]...)
			for i := range args {
				if i > 0 && args[i-1] == "--target" {
					args[i] = strconv.FormatUint(extra.sourceSerial, 10)
				}
				if i > 0 && args[i-1] == "--properties" {
					args[i] = strings.ReplaceAll(properties, tap.captureName, extra.captureName)
				}
			}
			cmd := exec.CommandContext(ctx, "pw-cat", args...)
			cmd.SysProcAttr = &syscall.SysProcAttr{Pdeathsig: syscall.SIGKILL}
			reader, stopExtra, err := startRecorder(cmd, cancel)
			if err != nil {
				return err
			}
			defer stopExtra()
			inputs = append(inputs, reader)
			recorders = append(recorders, recordingInput{tap: extra, stdout: reader})
		}
		input.Reader = &stereoMix{inputs: inputs}
	}
	if tap != nil {
		check := func(c context.Context) error {
			graph, err := readGraph(c)
			if err != nil {
				return err
			}
			return checkStartupGraph(graph, recorders)
		}
		if err := waitForApplication(ctx, check, func() {
			phase.Store("waiting")
			fmt.Fprintln(os.Stderr, "Waiting for the selected application to send audio (30-second startup limit).")
		}); err != nil {
			return stopAfterGraphError(initialLinks, err)
		}
	}
	phase.Store("ready")
	fmt.Fprintln(os.Stderr, "Audio input ready. Waiting for the first sample.")
	lastPCM.Store(time.Now().UnixNano())
	captureInfo := map[string]any{"pid": capture.Process.Pid, "mode": "mixed-monitor-diagnostic"}
	if tap != nil {
		captureInfo["mode"] = "isolated-application"
		captureInfo["sourceSerial"] = tap.sourceSerial
		captureInfo["captureSerial"] = tap.captureSerial
		captureInfo["linkStatesFLFR"] = tap.verifiedLinkStates
	}
	timing.emit("capture_started", captureInfo)
	// Freeze the admitted route for the first write and active checks. Each
	// verifier runs on a value copy, so simultaneous checks cannot repin it.
	admitted := make([]applicationTap, 0, len(recorders))
	waitingForIdleFrame := false
	for _, r := range recorders {
		admitted = append(admitted, *r.tap)
		waitingForIdleFrame = waitingForIdleFrame || r.idle || r.tap.verifiedIdle
	}
	verifyAdmitted := func() error {
		if len(admitted) == 0 {
			return nil
		}
		graph, err := readGraph(ctx)
		if err != nil {
			return err
		}
		for _, pinned := range admitted {
			if err := pinned.verifyGraph(graph); err != nil {
				return err
			}
		}
		return nil
	}
	checkFirst := func() error {
		if err := renew(ctx); err != nil {
			return err
		}
		return verifyAdmitted()
	}
	writeSample = startupWriter(ctx, &lease, deadline, startTimer, checkFirst, writeSample, func() error {
		if credentials.Transport == "cloudflare" {
			if err := post(ctx, base, path+"/ready", credentials.Lease, map[string]string{"phase": "sharing"}, nil); err != nil {
				return err
			}
		}
		phase.Store("sharing")
		if *localCapture {
			fmt.Fprintln(os.Stdout, "ready")
		}
		fmt.Fprintln(os.Stderr, "Sharing application audio.")
		return nil
	})
	var streamError error
	done := make(chan struct{})
	go func() {
		defer close(done)
		streamError = streamPCM(ctx, input, writeSample, timing)
	}()
	defer func() {
		cancel(nil)
		_ = pcm.Close()
		<-done
	}()
	ticker := time.NewTicker(2 * time.Second)
	defer ticker.Stop()
	for {
		select {
		case <-ctx.Done():
			return stopAfterGraphError("session", context.Cause(ctx))
		case <-done:
			if ctx.Err() != nil {
				return stopAfterGraphError("session", context.Cause(ctx))
			}
			return fmt.Errorf("audio stream ended; list and select the source again to resume: %w", streamError)
		case <-ticker.C:
			if err := timing.check(); err != nil {
				return fmt.Errorf("timing log failed: %w", err)
			}

			if (!waitingForIdleFrame || phase.Load() == "sharing") && time.Since(time.Unix(0, lastPCM.Load())) > 5*time.Second {
				return errors.New("PipeWire capture stalled; start again explicitly after checking the device")
			}
			if tap != nil {
				if err := verifyAdmitted(); err != nil {
					return stopAfterGraphError(activeLinks, err)
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

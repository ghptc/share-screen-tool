package main

import (
	"context"
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"io"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"syscall"
	"testing"
	"testing/synctest"
	"time"
)

// The only executable on PATH is the fixture. It never contacts PipeWire.
func mockGraphDump(t *testing.T, script string) string {
	t.Helper()
	dir := t.TempDir()
	if err := os.WriteFile(filepath.Join(dir, "pw-dump"), []byte("#!/bin/sh\n"+script+"\n"), 0700); err != nil {
		t.Fatal(err)
	}
	started := filepath.Join(dir, "started")
	t.Setenv("DUMP_STARTED", started)
	t.Setenv("PATH", dir)
	return started
}

const blockedDump = `: > "$DUMP_STARTED"
exec /bin/sleep 30`

func TestGraphReadDiscoveryTimeout(t *testing.T) {
	mockGraphDump(t, blockedDump)
	args, flags := os.Args, flag.CommandLine
	t.Cleanup(func() { os.Args, flag.CommandLine = args, flags })
	os.Args = []string{"helper", "--start", "--application", "103"}
	flag.CommandLine = flag.NewFlagSet("helper", flag.ContinueOnError)

	err := run()
	if !errors.Is(err, errDumpTimeout) || !errors.Is(err, context.DeadlineExceeded) ||
		err.Error() != "application discovery: pw-dump: context deadline exceeded (2s)" {
		t.Fatalf("unexpected preflight result: %v", err)
	}
}

func TestGraphReadCancelDuringLinkCheck(t *testing.T) {
	for _, tc := range []struct {
		name  string
		cause error
	}{
		{"intentional stop", context.Canceled},
		{"transport ended", errTransportEnded},
	} {
		t.Run(tc.name, func(t *testing.T) {
			started := mockGraphDump(t, blockedDump)
			ctx, cancel := context.WithCancelCause(t.Context())
			defer cancel(nil)
			done := make(chan error, 1)
			go func() { done <- new(applicationTap).waitForLinks(ctx, nil) }()
			for deadline := time.Now().Add(time.Second); ; {
				if _, err := os.Stat(started); err == nil {
					break
				}
				if time.Now().After(deadline) {
					t.Fatal("mock pw-dump did not start")
				}
				time.Sleep(time.Millisecond)
			}
			cancel(tc.cause)
			err := <-done
			if !errors.Is(err, tc.cause) {
				t.Fatalf("lost session cause: %v", err)
			}
			if tc.cause == context.Canceled {
				expectCleanGraphStop(t, initialLinks, err)
			} else if err = stopAfterGraphError(initialLinks, err); err == nil ||
				err.Error() != "initial FL/FR link verification: media transport ended" {
				t.Fatalf("transport loss reported incorrectly: %v", err)
			}
		})
	}
}

func TestGraphReadLinkDeadlineDuringDump(t *testing.T) {
	// The first result has the selected application but no matching capture node.
	// The second dump starts with less than its own 2s remaining in the 3s link budget.
	graph, err := json.Marshal(fixtureGraph(t))
	if err != nil {
		t.Fatal(err)
	}
	t.Setenv("DUMP_GRAPH", string(graph))
	started := mockGraphDump(t, `if [ ! -f "$DUMP_STARTED" ]; then
  : > "$DUMP_STARTED"
  /bin/sleep 1.4
  printf '%s' "$DUMP_GRAPH"
  exit 0
fi
: > "$DUMP_STARTED.blocked"
exec /bin/sleep 30`)
	tap := applicationTap{sourceSerial: 100, sourceID: 10, captureName: "pending-fixture"}
	err = tap.waitForLinks(t.Context(), nil)
	if !errors.Is(err, errLinkTimeout) || !errors.Is(err, context.DeadlineExceeded) {
		t.Fatalf("unexpected link result: %v", err)
	}
	if _, err := os.Stat(started + ".blocked"); err != nil {
		t.Fatal("link deadline did not interrupt the second dump")
	}
	err = stopAfterGraphError(initialLinks, err)
	if err == nil || err.Error() != "initial FL/FR link verification: waiting for stereo links: context deadline exceeded (3s) during pw-dump; last completed graph: capture node absent" {
		t.Fatal(err)
	}
}

func TestGraphReadLinkDeadlineReportsLatestSnapshot(t *testing.T) {
	g := fixtureGraph(t)
	for key, objects := range map[string][]graphObject{"FIRST": g[:4], "LATER": g[:6]} {
		data, err := json.Marshal(objects)
		if err != nil {
			t.Fatal(err)
		}
		t.Setenv(key, string(data))
	}
	mockGraphDump(t, `if [ ! -f "$DUMP_STARTED" ]; then
  : > "$DUMP_STARTED"
  printf '%s' "$FIRST"
else
  printf '%s' "$LATER"
fi`)
	tap := applicationTap{sourceSerial: 100, sourceID: 10, captureName: "whiterun-capture-test"}
	err := tap.waitForLinks(t.Context(), nil)
	if !errors.Is(err, errLinkTimeout) || !strings.HasSuffix(err.Error(), "last completed graph: capture ports have no incoming links") {
		t.Fatalf("expected latest observation at the link deadline, got %v", err)
	}
}

func TestGraphReadInitialDumpTimeoutHasNoTopology(t *testing.T) {
	mockGraphDump(t, blockedDump)
	err := new(applicationTap).waitForLinks(t.Context(), nil)
	if !errors.Is(err, errDumpTimeout) || errors.Is(err, errLinkTimeout) {
		t.Fatalf("expected a graph read timeout, got %v", err)
	}
	err = stopAfterGraphError(initialLinks, err)
	if err == nil || err.Error() != "initial FL/FR link verification: pw-dump: context deadline exceeded (2s)" {
		t.Fatal(err)
	}
}

// The real descriptor allows TIOCINQ. Any attempt to consume the fixture
// before verification fails the test immediately, even if the pipe is empty.
type unreadRecorder struct{ *os.File }

func (unreadRecorder) Read([]byte) (int, error) { panic("verification read recorder stdout") }

func mockRecorderStdout(t *testing.T, marker string) unreadRecorder {
	t.Helper()
	r, w, err := os.Pipe()
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		r.Close()
		w.Close()
	})
	if _, err := w.WriteString(marker); err != nil {
		t.Fatal(err)
	}
	return unreadRecorder{r}
}

func idleInitGraph(t *testing.T) []graphObject {
	t.Helper()
	g := fixtureGraph(t)
	g[0].Info.State, g[1].Info.State = "idle", "suspended"
	g[6].Info.State, g[7].Info.State = "init", "init"
	return g
}

func TestIdleApplicationStartupDiagnostic(t *testing.T) {
	const idleMessage = "The selected application stream was idle. Audio sharing didn't start."
	for _, tc := range []struct {
		name      string
		update    func([]graphObject)
		queue     string
		noPipe    bool
		wantIdle  bool
		wantLinks [2]string
		wantError string
	}{
		{name: "persistent idle and init", wantIdle: true},
		{name: "queued stdout", queue: "fixture bytes"},
		{name: "unmeasurable stdout", noPipe: true},
		{name: "source becomes running", update: func(g []graphObject) { g[0].Info.State = "running" }},
		{name: "recorder leaves suspended", update: func(g []graphObject) { g[1].Info.State = "idle" }},
		{name: "only one link remains init", update: func(g []graphObject) { g[6].Info.State = "paused" }},
		{name: "idle source with ready paused links", update: func(g []graphObject) {
			g[6].Info.State, g[7].Info.State = "paused", "paused"
		}, wantLinks: [2]string{"paused", "paused"}},
		{name: "idle source with ready active links", update: func(g []graphObject) {
			g[6].Info.State, g[7].Info.State = "active", "active"
		}, wantLinks: [2]string{"active", "active"}},
		{name: "foreign source after idle observation", update: func(g []graphObject) {
			g[7].Info.OutputNode = 99
		}, wantError: "unexpected source entered application capture"},
		{name: "source identity changed after idle observation", update: func(g []graphObject) {
			g[0].Info.Props["object.serial"] = float64(101)
		}, wantError: "selected application ended or changed; explicit reselection required"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			synctest.Test(t, func(t *testing.T) {
				var stdout io.Reader
				if !tc.noPipe {
					stdout = mockRecorderStdout(t, tc.queue)
				}

				g := idleInitGraph(t)
				tap := applicationTap{sourceSerial: 100, sourceID: 10, captureName: "whiterun-capture-test"}
				reads := 0
				start := time.Now()
				err := pollStereoLinks(t.Context(), stdout, func(context.Context) error {
					time.Sleep(time.Millisecond) // simulated graph read on the virtual clock
					reads++
					if reads == 2 && tc.update != nil {
						tc.update(g)
					}
					return tap.verifyGraph(g)
				})
				if reads < 2 || tap.verifiedLinkStates != tc.wantLinks {
					t.Fatalf("reads=%d, verified=%v, error=%v", reads, tap.verifiedLinkStates, err)
				}
				switch {
				case tc.wantLinks != [2]string{}:
					if err != nil || reads != 2 {
						t.Fatalf("ready links: %v after %d reads", err, reads)
					}
				case tc.wantError != "":
					if err == nil || err.Error() != tc.wantError || reads != 2 {
						t.Fatalf("expected immediate rejection, got %v after %d reads", err, reads)
					}
				default:
					if !errors.Is(err, errLinkTimeout) || time.Since(start) != 3*time.Second || strings.Contains(err.Error(), idleMessage) != tc.wantIdle {
						t.Fatalf("unexpected deadline diagnostic: %v", err)
					}
					if tc.wantIdle && err.Error() != idleMessage+"\nwaiting for stereo links: context deadline exceeded (3s); last completed graph: stereo link states (FL=init, FR=init); source=idle, recorder=suspended, source pulse.corked=unknown; recorder stdout queued bytes at timeout=0" {
						t.Fatalf("lost the underlying diagnostic: %v", err)
					}
				}
			})
		})
	}
}

func TestIdleObservationDoesNotMaskStopOrFailedGraphRead(t *testing.T) {
	const detail = "; last completed graph: stereo link states (FL=init, FR=init); source=idle, recorder=suspended, source pulse.corked=unknown; recorder stdout queued bytes at timeout=0"
	for _, tc := range []struct {
		name  string
		cause error
		want  string
	}{
		{"session canceled", context.Canceled, "context canceled"},
		{"transport ended", errTransportEnded, "media transport ended"},
		{"graph read timed out", errDumpTimeout, "pw-dump: context deadline exceeded (2s)" + detail},
		{"link deadline interrupted graph read", errLinkTimeout, "waiting for stereo links: context deadline exceeded (3s) during pw-dump" + detail},
	} {
		t.Run(tc.name, func(t *testing.T) {
			synctest.Test(t, func(t *testing.T) {
				ctx, cancel := context.WithCancelCause(t.Context())
				defer cancel(nil)
				g := idleInitGraph(t)
				tap := applicationTap{sourceSerial: 100, sourceID: 10, captureName: "whiterun-capture-test"}
				first := true
				err := pollStereoLinks(ctx, mockRecorderStdout(t, ""), func(wait context.Context) error {
					if first {
						first = false
						return tap.verifyGraph(g)
					}
					switch tc.cause {
					case errDumpTimeout:
						return errDumpTimeout
					case errLinkTimeout:
						<-wait.Done()
					default:
						cancel(tc.cause)
					}
					return context.Cause(wait)
				})
				if !errors.Is(err, tc.cause) || err.Error() != tc.want {
					t.Fatalf("unexpected diagnostic: %v", err)
				}
			})
		})
	}
}

func TestGraphReadInitBeforePCM(t *testing.T) {
	for _, tc := range []struct {
		name      string
		nextState string
		marker    string
	}{
		{"persistent init with empty stdout", "init", ""},
		{"persistent init with queued stdout", "init", "fixture"},
		{"init then paused with unread stdout", "paused", "fixture"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			g := fixtureGraph(t)
			g[0].Info.State, g[1].Info.State = "idle", "suspended"
			g[0].Info.Props["pulse.corked"] = true
			for _, step := range []struct{ key, state string }{{"INITIAL", "init"}, {"NEXT", tc.nextState}} {
				if step.state == "paused" {
					g[0].Info.State, g[1].Info.State = "running", "idle"
					g[0].Info.Props["pulse.corked"] = false
				}
				g[6].Info.State, g[7].Info.State = step.state, step.state
				data, err := json.Marshal(g)
				if err != nil {
					t.Fatal(err)
				}
				t.Setenv(step.key, string(data))
			}
			mockGraphDump(t, `if [ ! -f "$DUMP_STARTED" ]; then
  : > "$DUMP_STARTED"
  printf '%s' "$INITIAL"
else
  printf '%s' "$NEXT"
fi`)
			stdout := mockRecorderStdout(t, tc.marker)
			tap := applicationTap{sourceSerial: 100, sourceID: 10, captureName: "whiterun-capture-test"}
			err := tap.waitForLinks(t.Context(), stdout)
			if tc.nextState == "init" {
				want := fmt.Sprintf("stereo link states (FL=init, FR=init); source=idle, recorder=suspended, source pulse.corked=true; recorder stdout queued bytes at timeout=%d", len(tc.marker))
				if !errors.Is(err, errLinkTimeout) || !strings.HasSuffix(err.Error(), want) || tap.verifiedLinkStates != [2]string{} {
					t.Fatalf("expected unverified link timeout, got %v (%v)", err, tap.verifiedLinkStates)
				}
			} else if err != nil || tap.verifiedLinkStates != [2]string{"paused", "paused"} {
				t.Fatalf("expected verified paused links, got %v (%v)", err, tap.verifiedLinkStates)
			}
			if queued := pendingPCM(stdout); queued == nil || *queued != len(tc.marker) {
				t.Fatal("verification consumed the fixture")
			}
		})
	}
}

func TestGraphReadUnexpectedChildTermination(t *testing.T) {
	mockGraphDump(t, "kill -KILL $$")
	err := new(applicationTap).verify(t.Context())
	var exit *exec.ExitError
	if !errors.As(err, &exit) || exit.Sys().(syscall.WaitStatus).Signal() != syscall.SIGKILL {
		t.Fatalf("lost subprocess exit status: %v", err)
	}
	err = stopAfterGraphError(activeLinks, err)
	if err == nil || err.Error() != "active FL/FR link verification: pw-dump failed: signal: killed" {
		t.Fatal(err)
	}
}

func TestGraphReadCanceledBeforeStart(t *testing.T) {
	started := mockGraphDump(t, blockedDump)
	ctx, cancel := context.WithCancel(t.Context())
	cancel()
	err := new(applicationTap).verify(ctx)
	if !errors.Is(err, context.Canceled) {
		t.Fatalf("unexpected cancellation result: %v", err)
	}
	expectCleanGraphStop(t, activeLinks, err)
	if _, err := os.Stat(started); !errors.Is(err, os.ErrNotExist) {
		t.Fatal("canceled graph read invoked pw-dump")
	}
}

func expectCleanGraphStop(t *testing.T, phase string, err error) {
	t.Helper()
	output, e := os.CreateTemp(t.TempDir(), "stderr")
	if e != nil {
		t.Fatal(e)
	}
	defer output.Close()
	stderr := os.Stderr
	os.Stderr = output
	defer func() { os.Stderr = stderr }()
	if result := stopAfterGraphError(phase, err); result != nil {
		t.Fatalf("intentional stop returned %v", result)
	}
	got, e := os.ReadFile(output.Name())
	if e != nil || string(got) != "Native audio: "+phase+": session stopped\n" {
		t.Fatalf("unexpected stop diagnostic %q, read error %v", got, e)
	}
}

package main

import (
	"context"
	"encoding/json"
	"errors"
	"flag"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"syscall"
	"testing"
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
			go func() { done <- new(applicationTap).waitForLinks(ctx) }()
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
	err = tap.waitForLinks(t.Context())
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
	err := tap.waitForLinks(t.Context())
	if !errors.Is(err, errLinkTimeout) || !strings.HasSuffix(err.Error(), "last completed graph: capture ports have no incoming links") {
		t.Fatalf("expected latest observation at the link deadline, got %v", err)
	}
}

func TestGraphReadInitialDumpTimeoutHasNoTopology(t *testing.T) {
	mockGraphDump(t, blockedDump)
	err := new(applicationTap).waitForLinks(t.Context())
	if !errors.Is(err, errDumpTimeout) || errors.Is(err, errLinkTimeout) {
		t.Fatalf("expected a graph read timeout, got %v", err)
	}
	err = stopAfterGraphError(initialLinks, err)
	if err == nil || err.Error() != "initial FL/FR link verification: pw-dump: context deadline exceeded (2s)" {
		t.Fatal(err)
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

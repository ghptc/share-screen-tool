package main

import (
	"context"
	"errors"
	"io"
	"os/exec"
	"testing"
	"testing/synctest"
	"time"

	"github.com/pion/webrtc/v4/pkg/media"
)

func TestStartupRecorderExitCancelsSession(t *testing.T) {
	ctx, cancel := context.WithCancelCause(t.Context())
	defer cancel(nil)
	// The stand-in child exits without opening or writing any audio.
	_, stop, err := startRecorder(exec.CommandContext(ctx, "/bin/true"), cancel)
	if err != nil {
		t.Fatal(err)
	}
	defer stop()
	select {
	case <-ctx.Done():
		if !errors.Is(context.Cause(ctx), io.EOF) {
			t.Fatal(context.Cause(ctx))
		}
	case <-time.After(time.Second):
		t.Fatal("child exit failed to cancel the idle wait")
	}
}

func TestBoundedRecorderStartup(t *testing.T) {
	for _, scenario := range []string{"wake", "timeout", "stop", "replacement", "foreign", "recorder exit", "missing FR", "incomplete at attach"} {
		t.Run(scenario, func(t *testing.T) {
			synctest.Test(t, func(t *testing.T) {
				graph := startupGraph(t)
				tap := applicationTap{core: "9", sourceID: 10, sourceSerial: 103, captureName: "whiterun-capture-test"}
				inputs := []recordingInput{{tap: &tap, stdout: mockRecorderStdout(t, "")}}
				start := time.Now()
				ctx, cancel := context.WithTimeoutCause(t.Context(), applicationStartupLimit, errStartupExpired)
				defer cancel()
				if scenario == "incomplete at attach" {
					graph[7] = graphObject{}
				}
				if scenario == "stop" {
					time.AfterFunc(12*time.Second, cancel)
				}
				waits := 0
				err := waitForApplication(ctx, func(context.Context) error {
					if time.Since(start) >= 12*time.Second {
						switch scenario {
						case "wake":
							graph[6].Info.State, graph[7].Info.State = "paused", "active"
						case "replacement":
							graph[0].Info.Props["object.serial"] = float64(104)
						case "foreign":
							graph[7].Info.OutputNode = 99
						case "recorder exit":
							graph[1] = graphObject{}
						case "missing FR":
							graph[7] = graphObject{}
						}
					}
					return checkStartupGraph(graph, inputs)
				}, func() { waits++ })
				elapsed := time.Since(start)
				switch scenario {
				case "incomplete at attach":
					if !errors.Is(err, errLinkTimeout) || waits != 0 || elapsed != 3*time.Second {
						t.Fatal(err, waits, elapsed)
					}
				case "timeout":
					if !errors.Is(err, errStartupExpired) || waits != 1 || elapsed != 30*time.Second {
						t.Fatal(err, waits, elapsed)
					}
				case "wake":
					if err != nil || waits != 1 || tap.captureSerial != 200 || tap.verifiedLinkStates != [2]string{"paused", "active"} {
						t.Fatal(err, waits, tap)
					}
				default:
					if err == nil || waits != 1 || elapsed != 12*time.Second {
						t.Fatal(err, waits, elapsed)
					}
				}
			})
		})
	}
}

func TestStartupLeaseStopsWhileWaiting(t *testing.T) {
	for _, denied := range []bool{true, false} {
		synctest.Test(t, func(t *testing.T) {
			var lease helperLease
			start := time.Now()
			lease.granted(start)
			revoked := errors.New("Discord grant revoked")
			ctx, cancel := context.WithCancelCause(t.Context())
			defer cancel(nil)
			go func() {
				cancel(lease.supervise(ctx, func(check context.Context) error {
					if denied {
						return revoked
					}
					<-check.Done() // server never acknowledges this renewal
					return nil
				}))
			}()
			err := waitForApplication(ctx, func(context.Context) error { return errWaitingForApplication }, func() {})
			if denied && (!errors.Is(err, revoked) || time.Since(start) != 2*time.Second) {
				t.Fatal(err, time.Since(start))
			}
			if !denied && (!errors.Is(err, errLeaseExpired) || time.Since(start) != helperLeaseTTL) {
				t.Fatal(err, time.Since(start))
			}
		})
	}
}

func TestStartupFirstSuccessfulWrite(t *testing.T) {
	synctest.Test(t, func(t *testing.T) {
		var lease helperLease
		lease.granted(time.Now())
		deadline := time.Now().Add(applicationStartupLimit)
		timer := time.AfterFunc(applicationStartupLimit, func() {})
		defer timer.Stop()
		failure := errors.New("writer failed")
		var checks, writes, reports int
		write := startupWriter(t.Context(), &lease, deadline, timer, func() error {
			checks++
			return nil
		}, func(media.Sample) error {
			writes++
			if writes == 1 {
				return failure
			}
			return nil
		}, func() error { reports++; return nil })
		if err := write(media.Sample{}); err != failure || reports != 0 {
			t.Fatal(err, reports)
		}
		for range 2 {
			if err := write(media.Sample{}); err != nil {
				t.Fatal(err)
			}
		}
		if reports != 1 || checks != 2 || writes != 3 {
			t.Fatal(reports, checks, writes)
		}
		time.Sleep(helperLeaseTTL)
		if err := write(media.Sample{}); err != errLeaseExpired || writes != 3 {
			t.Fatal(err, writes)
		}
	})
}

func TestStartupFirstWriteAfterDeadline(t *testing.T) {
	synctest.Test(t, func(t *testing.T) {
		var lease helperLease
		lease.granted(time.Now())
		// Transport setup has already consumed 29 seconds of the claim budget.
		end := time.Now().Add(time.Second)
		timer := time.AfterFunc(time.Second, func() {})
		defer timer.Stop()
		write := startupWriter(t.Context(), &lease, end, timer, func() error {
			time.Sleep(time.Second)
			return nil
		}, func(media.Sample) error {
			t.Fatal("sample passed after startup expired during verification")
			return nil
		}, func() error {
			t.Fatal("reported sharing")
			return nil
		})
		if err := write(media.Sample{}); err != errStartupExpired {
			t.Fatal(err)
		}
	})
}

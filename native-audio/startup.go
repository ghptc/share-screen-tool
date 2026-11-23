package main

import (
	"context"
	"errors"
	"fmt"
	"io"
	"sync/atomic"
	"time"

	"github.com/pion/webrtc/v4/pkg/media"
)

const applicationStartupLimit = 30 * time.Second
const helperLeaseTTL = 10 * time.Second

var errStartupExpired = errors.New("audio sharing did not start within 30 seconds")
var errLeaseExpired = errors.New("native audio authorization expired")
var errWaitingForApplication = errors.New("waiting for the selected application")

type recordingInput struct {
	tap    *applicationTap
	stdout io.Reader
	idle   bool
}

// All recorders must pass in the same snapshot. A pending tap cannot hide a
// foreign link or a missing source on another tap.
func checkStartupGraph(graph []graphObject, inputs []recordingInput) error {
	var firstPending error
	for i := range inputs {
		input := &inputs[i]
		err := input.tap.verifyGraph(graph)
		if err == nil {
			continue
		}
		var pending pendingLinks
		if !errors.As(err, &pending) {
			return err
		}
		if input.tap.verifiedLinkStates != [2]string{} {
			return fmt.Errorf("verified stereo links changed: %s", pending.detail)
		}
		if !input.idle && pending.idleSourceAtInit {
			queued := pendingPCM(input.stdout)
			input.idle = queued != nil && *queued == 0
		}
		if input.idle && pending.exact {
			if firstPending == nil {
				firstPending = errWaitingForApplication
			}
		} else {
			pending.stdout = input.stdout
			firstPending = pending
		}
	}
	return firstPending
}

func waitForApplication(ctx context.Context, check func(context.Context) error, waiting func()) error {
	err := pollStereoLinks(ctx, nil, check)
	if err != errWaitingForApplication {
		return err
	}
	waiting()
	tick := time.NewTicker(250 * time.Millisecond)
	defer tick.Stop()
	for {
		select {
		case <-ctx.Done():
			return context.Cause(ctx)
		case <-tick.C:
			if err := check(ctx); err != errWaitingForApplication {
				return err
			}
		}
	}
}

// One lease owner from claim through capture. Bound each HTTP call by the
// existing grant, and discount its round trip when installing the next grant.
type helperLease struct{ until atomic.Pointer[time.Time] }

func (l *helperLease) granted(sent time.Time) {
	until := sent.Add(helperLeaseTTL)
	l.until.Store(&until)
}

func (l *helperLease) supervise(ctx context.Context, renew func(context.Context) error) error {
	tick := time.NewTicker(2 * time.Second)
	defer tick.Stop()
	for {
		deadline := *l.until.Load()
		check, cancel := context.WithDeadlineCause(ctx, deadline, errLeaseExpired)
		select {
		case <-check.Done():
			cause := context.Cause(check)
			cancel()
			return cause
		case <-tick.C:
		}
		sent := time.Now()
		err := renew(check)
		if cause := context.Cause(check); cause != nil {
			err = cause
		}
		cancel()
		if err != nil {
			return err
		}
		if !time.Now().Before(deadline) {
			return errLeaseExpired
		}
		l.granted(sent)
	}
}

// The media pump calls this writer serially. A successful first write must
// win the startup timeout before the launcher or owner is told it is sharing.
func startupWriter(ctx context.Context, lease *helperLease, deadline time.Time, timer *time.Timer,
	checkFirst func() error, write sampleWriter, sharing func() error) sampleWriter {
	started := false
	authorized := func() error {
		if err := context.Cause(ctx); err != nil {
			return err
		}
		if !time.Now().Before(*lease.until.Load()) {
			return errLeaseExpired
		}
		if !started && !time.Now().Before(deadline) {
			return errStartupExpired
		}
		return nil
	}
	return func(s media.Sample) error {
		if err := authorized(); err != nil {
			return err
		}
		if !started {
			if err := checkFirst(); err != nil {
				return err
			}
			if err := authorized(); err != nil {
				return err
			}
		}
		if err := write(s); err != nil {
			return err
		}
		if !started {
			if !timer.Stop() || !time.Now().Before(deadline) {
				return errStartupExpired
			}
			if err := authorized(); err != nil {
				return err
			}
			if err := sharing(); err != nil {
				return fmt.Errorf("confirming audio publication: %w", err)
			}
			started = true
		}
		return nil
	}
}

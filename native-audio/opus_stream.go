package main

import (
	"context"
	"fmt"
	"time"

	"github.com/livekit/server-sdk-go/v2/pkg/oggreader"
	"github.com/pion/webrtc/v4/pkg/media"
)

const opusFrameDuration = 20 * time.Millisecond

// liveClock anchors to the first available encoded frame, not to publication
// startup. It never catches up a late live source by sending a packet burst.
type liveClock struct{ next time.Time }

func (c *liveClock) deadline(ready time.Time) (time.Time, bool) {
	rebased := false
	if c.next.IsZero() {
		c.next = ready
	} else if ready.After(c.next) {
		c.next = ready
		rebased = true
	}
	deadline := c.next
	c.next = c.next.Add(opusFrameDuration)
	return deadline, rebased
}
func pumpOpus(ctx context.Context, read func() ([]byte, error), write func(media.Sample) error, timing *timingLog) error {
	var clock liveClock
	for {
		if err := ctx.Err(); err != nil {
			return err
		}
		packet, err := read()
		if err != nil {
			return err
		}
		duration, err := oggreader.ParsePacketDuration(packet)
		if err != nil {
			return err
		}
		if duration != opusFrameDuration {
			return fmt.Errorf("encoder returned %s frame, expected %s", duration, opusFrameDuration)
		}
		ready := time.Now()
		timing.emit("opus_read", map[string]any{"bytes": len(packet), "durationSamples": 960, "durationMs": 20})
		previous := clock.next
		deadline, rebased := clock.deadline(ready)
		if rebased {
			timing.emit("clock_rebase", map[string]any{"lateMs": float64(ready.Sub(previous)) / float64(time.Millisecond)})
		}
		if wait := time.Until(deadline); wait > 0 {
			timer := time.NewTimer(wait)
			select {
			case <-ctx.Done():
				timer.Stop()
				return ctx.Err()
			case <-timer.C:
			}
		}
		writeStarted := time.Now()
		// Duration drives the SDK's 48 kHz RTP clock: exactly 960 ticks per frame.
		// Do not convert wall-clock scheduling jitter into RTP timestamp jitter.
		if err := write(media.Sample{Data: packet, Duration: duration}); err != nil {
			return err
		}
		timing.emit("sample_write", map[string]any{"durationSamples": 960, "lateMs": float64(writeStarted.Sub(deadline)) / float64(time.Millisecond), "writeMs": float64(time.Since(writeStarted)) / float64(time.Millisecond), "pacerWaitMs": float64(writeStarted.Sub(ready)) / float64(time.Millisecond)})
	}
}

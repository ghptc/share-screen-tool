package main

import (
	"context"
	"errors"
	"io"
	"testing"
	"time"

	"github.com/pion/webrtc/v4/pkg/media"
)

func TestLiveClockAnchorsAfterSourceReadyAndDoesNotCatchUp(t *testing.T) {
	base := time.Unix(100, 0)
	var clock liveClock
	first, rebase := clock.deadline(base.Add(170 * time.Millisecond))
	if !first.Equal(base.Add(170*time.Millisecond)) || rebase {
		t.Fatal("clock anchored before available live audio")
	}
	for i := 1; i < 5; i++ {
		deadline, _ := clock.deadline(first)
		if !deadline.Equal(first.Add(time.Duration(i) * 20 * time.Millisecond)) {
			t.Fatal("burst frames were not spaced")
		}
	}
	late := base.Add(2 * time.Second)
	deadline, rebase := clock.deadline(late)
	if !rebase || !deadline.Equal(late) {
		t.Fatal("late source was replayed against old deadlines")
	}
	next, _ := clock.deadline(late)
	if next.Sub(deadline) != 20*time.Millisecond {
		t.Fatal("clock caught up by bursting after a stall")
	}
}
func TestLiveClockDoesNotAccumulateWriteSchedulingJitter(t *testing.T) {
	base := time.Unix(100, 0)
	var clock liveClock
	clock.deadline(base)
	for i := 1; i < 10000; i++ {
		ready := base.Add(time.Duration(i-1)*20*time.Millisecond + time.Millisecond)
		deadline, rebase := clock.deadline(ready)
		if rebase || !deadline.Equal(base.Add(time.Duration(i)*20*time.Millisecond)) {
			t.Fatal("scheduling overhead accumulated into publication clock")
		}
	}
}
func TestOpusPumpPreservesSamplesAndReportsErrors(t *testing.T) {
	calls := 0
	var written []media.Sample
	err := pumpOpus(context.Background(), func() ([]byte, error) {
		calls++
		if calls > 3 {
			return nil, io.EOF
		}
		return []byte{0xf8}, nil
	}, func(s media.Sample) error { written = append(written, s); return nil }, nil)
	if !errors.Is(err, io.EOF) || len(written) != 3 {
		t.Fatal(err, len(written))
	}
	for _, s := range written {
		if s.Duration != 20*time.Millisecond || !s.Timestamp.IsZero() || s.PacketTimestamp != 0 {
			t.Fatal("RTP must advance by the exact duration rather than wall-clock jitter")
		}
	}
	failure := errors.New("write failure")
	err = pumpOpus(context.Background(), func() ([]byte, error) { return []byte{0xf8}, nil }, func(media.Sample) error { return failure }, nil)
	if !errors.Is(err, failure) {
		t.Fatal("publisher error hidden")
	}
}
func TestOpusPumpRejectsUnexpectedDurationAndCancels(t *testing.T) {
	err := pumpOpus(context.Background(), func() ([]byte, error) { return []byte{0xf0}, nil }, func(media.Sample) error { t.Fatal("10 ms frame accepted as 20 ms"); return nil }, nil)
	if err == nil {
		t.Fatal("encoder mismatch accepted")
	}
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	err = pumpOpus(ctx, func() ([]byte, error) { t.Fatal("read after cancellation"); return nil, nil }, func(media.Sample) error { return nil }, nil)
	if !errors.Is(err, context.Canceled) {
		t.Fatal(err)
	}
}

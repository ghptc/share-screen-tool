package main

import (
	"context"
	"encoding/binary"
	"fmt"
	"io"
	"math"
	"time"

	lksdk "github.com/livekit/server-sdk-go/v2"
	"github.com/pion/webrtc/v4/pkg/media"
)

// A single sample clock: 960 stereo PCM frames -> one 20ms Opus packet ->
// exactly 960 RTP ticks at 48 kHz. There is no FFmpeg demux/encode queue.
func streamPCM(ctx context.Context, input io.Reader, track *lksdk.LocalTrack, timing *timingLog) error {
	encoder, err := newOpusEncoder()
	if err != nil {
		return err
	}
	defer encoder.close()
	var pcm [pcmFrameBytes]byte
	var firstFrame time.Time
	var frames int64
	read := func() ([]byte, error) {
		readStarted := time.Now()
		if _, err := io.ReadFull(input, pcm[:]); err != nil {
			return nil, err
		}
		started := time.Now()
		if firstFrame.IsZero() {
			firstFrame = started
		}
		frames++
		var power float64
		if timing != nil {
			for i := 0; i < len(pcm); i += 2 {
				sample := float64(int16(binary.LittleEndian.Uint16(pcm[i:i+2]))) / 32768
				power += sample * sample
			}
		}
		// This is delivered-media versus wall time, not hardware clock drift:
		// pipe buffering, pacer waits and scheduler stalls all affect it.
		timing.emit("pcm_frame", map[string]any{"frame": frames, "rms": math.Sqrt(power / float64(len(pcm)/2)), "readMs": float64(started.Sub(readStarted)) / float64(time.Millisecond), "mediaMinusWallMs": float64((time.Duration(frames-1)*opusFrameDuration)-started.Sub(firstFrame)) / float64(time.Millisecond)})
		encodeStarted := time.Now()
		packet, err := encoder.encode(pcm[:])
		if err != nil {
			return nil, err
		}
		timing.emit("encode", map[string]any{"pcmBytes": len(pcm), "samplesPerChannel": 960, "rate": 48000, "channels": 2, "encoderMs": float64(time.Since(encodeStarted)) / float64(time.Millisecond)})
		return packet, nil
	}
	err = pumpOpus(ctx, read, func(sample media.Sample) error { return track.WriteSample(sample, nil) }, timing)
	if err != nil {
		return fmt.Errorf("PCM/Opus stream: %w", err)
	}
	return nil
}

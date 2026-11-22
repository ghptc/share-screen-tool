package main

import (
	"bytes"
	"encoding/binary"
	"math"
	"os/exec"
	"testing"
	"time"

	"github.com/livekit/server-sdk-go/v2/pkg/oggreader"
	"github.com/pion/rtp"
	"github.com/pion/webrtc/v4/pkg/media/oggwriter"
)

func toneFrame(frame int) []byte {
	b := make([]byte, pcmFrameBytes)
	for i := 0; i < 960; i++ {
		for ch, f := range []float64{997, 1499} {
			v := int16(8000 * math.Sin(2*math.Pi*f*float64(frame*960+i)/48000))
			binary.LittleEndian.PutUint16(b[(i*2+ch)*2:], uint16(v))
		}
	}
	return b
}
func TestOpusEncoderExactStereo20ms(t *testing.T) {
	encoder, err := newOpusEncoder()
	if err != nil {
		t.Fatal(err)
	}
	defer encoder.close()
	if _, err = encoder.encode(make([]byte, 100)); err == nil {
		t.Fatal("partial PCM frame accepted")
	}
	for i := 0; i < 100; i++ {
		packet, err := encoder.encode(toneFrame(i))
		if err != nil {
			t.Fatal(err)
		}
		duration, err := oggreader.ParsePacketDuration(packet)
		if err != nil || duration != 20*time.Millisecond {
			t.Fatal(duration, err)
		}
	}
}
func TestGeneratedStereoLocallyDecodesWithoutTimeStretch(t *testing.T) {
	if _, err := exec.LookPath("ffmpeg"); err != nil {
		t.Skip("optional local reference decode needs ffmpeg")
	}
	encoder, err := newOpusEncoder()
	if err != nil {
		t.Fatal(err)
	}
	defer encoder.close()
	var ogg bytes.Buffer
	writer, err := oggwriter.NewWith(&ogg, 48000, 2)
	if err != nil {
		t.Fatal(err)
	}
	for i := 0; i < 150; i++ {
		payload, err := encoder.encode(toneFrame(i))
		if err != nil {
			t.Fatal(err)
		}
		if err = writer.WriteRTP(&rtp.Packet{Header: rtp.Header{Version: 2, SequenceNumber: uint16(i), Timestamp: uint32((i + 1) * 960), SSRC: 1}, Payload: payload}); err != nil {
			t.Fatal(err)
		}
	}
	if err = writer.Close(); err != nil {
		t.Fatal(err)
	}
	cmd := exec.Command("ffmpeg", "-hide_banner", "-loglevel", "error", "-f", "ogg", "-i", "pipe:0", "-ar", "48000", "-ac", "2", "-f", "s16le", "pipe:1")
	cmd.Stdin = bytes.NewReader(ogg.Bytes())
	decoded, err := cmd.Output()
	if err != nil {
		t.Fatal(err)
	}
	frames := len(decoded) / 4
	if frames < 140*960 || frames > 151*960 {
		t.Fatalf("unexpected decoded sample count %d", frames)
	}
	for ch, f := range []float64{997, 1499} {
		var real, imag, power float64
		count := frames - 4800
		for i := 4800; i < frames; i++ {
			v := float64(int16(binary.LittleEndian.Uint16(decoded[(i*2+ch)*2:]))) / 32768
			a := 2 * math.Pi * f * float64(i) / 48000
			real += v * math.Cos(a)
			imag -= v * math.Sin(a)
			power += v * v
		}
		coherence := 2 * (real*real + imag*imag) / (float64(count) * power)
		if coherence < .95 {
			t.Fatalf("channel %d tone coherence %.4f, want >.95", ch, coherence)
		}
	}
}

func TestOpusEncoderReleasesResources(t *testing.T) {
	encoder, err := newOpusEncoder()
	if err != nil {
		t.Fatal(err)
	}
	encoder.close()
	encoder.close()
	if _, err := encoder.encode(toneFrame(0)); err == nil {
		t.Fatal("closed encoder accepted samples")
	}
}

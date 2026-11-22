// Explicit monitor/encoder cadence probe. Logs timing only; never stores samples.
package main

import (
	"context"
	"encoding/json"
	"flag"
	"fmt"
	"github.com/livekit/server-sdk-go/v2/pkg/oggreader"
	"io"
	"os"
	"os/exec"
	"sort"
	"sync"
	"time"
)

type samples struct {
	sync.Mutex
	Times []float64
	Bytes int64
	Start time.Time
}
type reader struct {
	io.Reader
	S *samples
}

func (r reader) Read(b []byte) (int, error) {
	n, e := r.Reader.Read(b)
	if n > 0 {
		r.S.Lock()
		r.S.Times = append(r.S.Times, time.Since(r.S.Start).Seconds()*1000)
		r.S.Bytes += int64(n)
		r.S.Unlock()
	}
	return n, e
}
func summary(v []float64) map[string]any {
	if len(v) == 0 {
		return nil
	}
	a := append([]float64{}, v...)
	sort.Float64s(a)
	var total float64
	short, long := 0, 0
	for _, x := range a {
		total += x
		if x < 5 {
			short++
		}
		if x > 35 {
			long++
		}
	}
	return map[string]any{"count": len(a), "meanMs": total / float64(len(a)), "p50Ms": a[len(a)/2], "p95Ms": a[int(float64(len(a)-1)*.95)], "p99Ms": a[int(float64(len(a)-1)*.99)], "maxMs": a[len(a)-1], "under5ms": short, "over35ms": long}
}
func deltas(a []float64) []float64 {
	var out []float64
	for i := 1; i < len(a); i++ {
		out = append(out, a[i]-a[i-1])
	}
	return out
}
func main() {
	target := flag.String("target", "", "Explicit PipeWire output serial")
	seconds := flag.Int("seconds", 20, "Duration")
	low := flag.Bool("low-probe", false, "Use explicit raw-input probing limits")
	direct := flag.Bool("direct-input", false, "Disable input AVIO read-ahead")
	flag.Parse()
	if *target == "" {
		panic("explicit output --target required")
	}
	ctx, cancel := context.WithTimeout(context.Background(), time.Duration(*seconds)*time.Second)
	defer cancel()
	start := time.Now()
	pcmStats := &samples{Start: start}
	capture := exec.CommandContext(ctx, "pw-cat", "--record", "--raw", "--target", *target, "--rate", "48000", "--channels", "2", "--format", "s16", "--latency", "20ms", "--properties", "stream.capture.sink=true node.dont-reconnect=true node.dont-fallback=true", "-")
	pcm, e := capture.StdoutPipe()
	if e != nil {
		panic(e)
	}
	args := []string{"-hide_banner", "-loglevel", "error"}
	if *low {
		args = append(args, "-probesize", "32", "-analyzeduration", "0", "-blocksize", "3840")
	}
	if *direct {
		args = append(args, "-avioflags", "direct")
	}
	args = append(args, "-f", "s16le", "-ar", "48000", "-ac", "2", "-i", "pipe:0", "-c:a", "libopus", "-b:a", "128k", "-frame_duration", "20", "-application", "audio", "-f", "ogg", "-page_duration", "20000", "-flush_packets", "1", "pipe:1")
	encoder := exec.CommandContext(ctx, "ffmpeg", args...)
	encoder.Stdin = reader{pcm, pcmStats}
	encoder.Stderr = os.Stderr
	capture.Stderr = os.Stderr
	opus, e := encoder.StdoutPipe()
	if e != nil {
		panic(e)
	}
	if e = capture.Start(); e != nil {
		panic(e)
	}
	if e = encoder.Start(); e != nil {
		panic(e)
	}
	defer func() { cancel(); _ = encoder.Wait(); _ = capture.Wait() }()
	ogg, h, e := oggreader.NewOggReader(opus)
	if e != nil {
		panic(e)
	}
	var times []float64
	durations := map[string]int{}
	var mediaMs float64
	for {
		packet, e := ogg.ReadPacket()
		if e != nil {
			if ctx.Err() == nil && e != io.EOF {
				fmt.Fprintln(os.Stderr, e)
			}
			break
		}
		d, e := oggreader.ParsePacketDuration(packet)
		if e != nil {
			panic(e)
		}
		durations[d.String()]++
		times = append(times, time.Since(start).Seconds()*1000)
		mediaMs += float64(d) / float64(time.Millisecond)
	}
	pcmStats.Lock()
	out := map[string]any{"target": *target, "directInput": *direct, "lowProbe": *low, "channels": h.Channels, "sampleRate": h.SampleRate, "pcmBytes": pcmStats.Bytes, "pcmReadGaps": summary(deltas(pcmStats.Times)), "opusReadGaps": summary(deltas(times)), "durations": durations, "encodedMediaMs": mediaMs}
	if len(times) > 1 {
		out["firstOpusMs"] = times[0]
		out["mediaVsWallMs"] = mediaMs - (times[len(times)-1] - times[0])
	}
	pcmStats.Unlock()
	_ = json.NewEncoder(os.Stdout).Encode(out)
}

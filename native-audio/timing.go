package main

import (
	"bufio"
	"encoding/json"
	"errors"
	"os"
	"sync"
	"time"

	"github.com/pion/interceptor"
	"github.com/pion/rtp"
)

// Timing logs contain metadata only: never PCM, encoded payloads or credentials.
type timingLog struct {
	mu      sync.Mutex
	start   time.Time
	file    *os.File
	writer  *bufio.Writer
	failure error
}

func openTiming(path string) (*timingLog, error) {
	if path == "" {
		return nil, nil
	}
	f, err := os.OpenFile(path, os.O_CREATE|os.O_EXCL|os.O_WRONLY, 0600)
	if err != nil {
		return nil, err
	}
	return &timingLog{start: time.Now(), file: f, writer: bufio.NewWriter(f)}, nil
}
func (t *timingLog) emit(stage string, fields map[string]any) {
	if t == nil {
		return
	}
	t.mu.Lock()
	defer t.mu.Unlock()
	fields["stage"] = stage
	fields["elapsedMs"] = float64(time.Since(t.start)) / float64(time.Millisecond)
	fields["unixMs"] = time.Now().UnixMilli()
	if t.failure == nil {
		t.failure = json.NewEncoder(t.writer).Encode(fields)
	}
}
func (t *timingLog) close() error {
	if t == nil {
		return nil
	}
	t.mu.Lock()
	defer t.mu.Unlock()
	return errors.Join(t.failure, t.writer.Flush(), t.file.Close())
}

func (t *timingLog) check() error {
	if t == nil {
		return nil
	}
	t.mu.Lock()
	defer t.mu.Unlock()
	return t.failure
}

type timingFactory struct{ log *timingLog }

func (f timingFactory) NewInterceptor(string) (interceptor.Interceptor, error) {
	return &timingInterceptor{log: f.log}, nil
}

type timingInterceptor struct {
	interceptor.NoOp
	log *timingLog
}

func (t *timingInterceptor) BindLocalStream(info *interceptor.StreamInfo, writer interceptor.RTPWriter) interceptor.RTPWriter {
	if info.MimeType != "audio/opus" {
		return writer
	}
	return interceptor.RTPWriterFunc(func(header *rtp.Header, payload []byte, attributes interceptor.Attributes) (int, error) {
		n, err := writer.Write(header, payload, attributes)
		t.log.emit("rtp_write", map[string]any{"sequence": header.SequenceNumber, "timestamp": header.Timestamp, "bytes": len(payload), "error": err != nil})
		return n, err
	})
}

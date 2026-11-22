package main

import (
	"bytes"
	"io"
	"os"
	"testing"
)

func TestPendingPCMReportsActualPipeBacklogWithoutConsumingAudio(t *testing.T) {
	r, w, err := os.Pipe()
	if err != nil {
		t.Fatal(err)
	}
	defer r.Close()
	defer w.Close()
	payload := bytes.Repeat([]byte{42}, 3840)
	if _, err := w.Write(payload); err != nil {
		t.Fatal(err)
	}
	if queued := pendingPCM(r); queued == nil || *queued != len(payload) {
		t.Fatalf("queue: %v", queued)
	}
	got := make([]byte, len(payload))
	if _, err := io.ReadFull(r, got); err != nil {
		t.Fatal(err)
	}
	if !bytes.Equal(got, payload) {
		t.Fatal("diagnostic consumed or changed PCM")
	}
	if queued := pendingPCM(r); queued == nil || *queued != 0 {
		t.Fatalf("empty queue: %v", queued)
	}
	if pendingPCM(bytes.NewReader(payload)) != nil {
		t.Fatal("unsupported reader reported as empty")
	}
	r.Close()
	if pendingPCM(r) != nil {
		t.Fatal("closed pipe reported as empty")
	}
}

package main

import (
	"encoding/json"
	"os"
	"path/filepath"
	"testing"
)

func TestTimingLogsAreExclusiveAndReportWriteFailure(t *testing.T) {
	path := filepath.Join(t.TempDir(), "timing.jsonl")
	log, err := openTiming(path)
	if err != nil {
		t.Fatal(err)
	}
	log.emit("test", map[string]any{"bytes": 3840})
	log.close()
	if _, err := openTiming(path); err == nil {
		t.Fatal("existing timing log overwritten")
	}
	data, err := os.ReadFile(path)
	if err != nil || len(data) == 0 {
		t.Fatal(err)
	}
	var event map[string]any
	if err := json.Unmarshal(data, &event); err != nil || event["unixMs"] == nil || event["elapsedMs"] == nil {
		t.Fatal("timing events require both correlation and monotonic timestamps", err)
	}
	bad, err := openTiming(filepath.Join(t.TempDir(), "bad.jsonl"))
	if err != nil {
		t.Fatal(err)
	}
	_ = bad.file.Close()
	for i := 0; i < 1000; i++ {
		bad.emit("test", map[string]any{"bytes": 3840})
	}
	if bad.check() == nil {
		t.Fatal("timing write error hidden")
	}
}

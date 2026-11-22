package main

import (
	"crypto/sha256"
	"encoding/hex"
	"io"
	"os"
	"runtime"
)

// Hash the running inode, not the path which a rebuild may have replaced.
func executableIdentity() (map[string]any, error) {
	f, err := os.Open("/proc/self/exe")
	if err != nil {
		return nil, err
	}
	defer f.Close()
	h := sha256.New()
	if _, err := io.Copy(h, f); err != nil {
		return nil, err
	}
	path, err := os.Readlink("/proc/self/exe")
	if err != nil {
		return nil, err
	}
	return map[string]any{"pid": os.Getpid(), "executable": path, "sha256": hex.EncodeToString(h.Sum(nil)), "go": runtime.Version(), "encoder": "libopus", "rate": 48000, "channels": 2}, nil
}

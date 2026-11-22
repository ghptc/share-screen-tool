package main

import (
	"bytes"
	"encoding/binary"
	"io"
	"testing"
)

func TestStereoMixHeadroomAndChannelOrder(t *testing.T) {
	source := func(left, right int16) io.Reader {
		block := make([]byte, 3840)
		for i := 0; i < len(block); i += 4 {
			binary.LittleEndian.PutUint16(block[i:], uint16(left))
			binary.LittleEndian.PutUint16(block[i+2:], uint16(right))
		}
		return bytes.NewReader(block)
	}
	m := &stereoMix{inputs: []io.Reader{source(32000, -32000), source(32000, 8000)}}
	out := make([]byte, 3840)
	if _, err := io.ReadFull(m, out[:1]); err != nil {
		t.Fatal(err)
	}
	if _, err := io.ReadFull(m, out[1:]); err != nil {
		t.Fatal(err)
	}
	if int16(binary.LittleEndian.Uint16(out)) != 32000 || int16(binary.LittleEndian.Uint16(out[2:])) != -12000 {
		t.Fatal("clipped or swapped channels")
	}
	if _, err := m.Read(out); err == nil {
		t.Fatal("missing source was not detected")
	}
}

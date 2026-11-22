package main

import (
	"encoding/binary"
	"errors"
	"io"
)

// All inputs are clocked by the same PipeWire core at 48 kHz, stereo S16LE.
// Read exactly one common frame block and keep equal headroom for every input.
type stereoMix struct {
	inputs  []io.Reader
	block   []byte
	sums    []int32
	pending []byte
}

func (m *stereoMix) Read(out []byte) (int, error) {
	if len(out) == 0 {
		return 0, nil
	}
	if len(m.pending) == 0 {
		if len(m.inputs) < 2 {
			return 0, errors.New("mix requires two sources")
		}
		if m.block == nil {
			m.block = make([]byte, 960*4)
			m.sums = make([]int32, len(m.block)/2)
		}
		clear(m.sums)
		for _, r := range m.inputs {
			if _, err := io.ReadFull(r, m.block); err != nil {
				return 0, err
			}
			for i := range m.sums {
				m.sums[i] += int32(int16(binary.LittleEndian.Uint16(m.block[i*2:])))
			}
		}
		for i, v := range m.sums {
			binary.LittleEndian.PutUint16(m.block[i*2:], uint16(int16(v/int32(len(m.inputs)))))
		}
		m.pending = m.block
	}
	n := copy(out, m.pending)
	m.pending = m.pending[n:]
	return n, nil
}

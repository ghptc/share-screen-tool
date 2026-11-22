package main

/*
#cgo pkg-config: opus
#include <opus/opus.h>
static OpusEncoder* whiterun_encoder(int *error) {
 OpusEncoder *encoder = opus_encoder_create(48000, 2, OPUS_APPLICATION_AUDIO, error);
 if (!encoder) return NULL;
 *error = opus_encoder_ctl(encoder, OPUS_SET_BITRATE(128000));
 if (*error != OPUS_OK) { opus_encoder_destroy(encoder); return NULL; }
 return encoder;
}
*/
import "C"

import (
	"encoding/binary"
	"fmt"
	"unsafe"
)

const pcmFrameBytes = 960 * 2 * 2

type opusEncoder struct {
	native  *C.OpusEncoder
	samples [1920]int16
}

func newOpusEncoder() (*opusEncoder, error) {
	var code C.int
	encoder := C.whiterun_encoder(&code)
	if encoder == nil {
		return nil, fmt.Errorf("Opus initialization: %s", C.GoString(C.opus_strerror(code)))
	}
	return &opusEncoder{native: encoder}, nil
}
func (e *opusEncoder) encode(pcm []byte) ([]byte, error) {
	if e.native == nil {
		return nil, fmt.Errorf("Opus encoder is closed")
	}
	if len(pcm) != pcmFrameBytes {
		return nil, fmt.Errorf("PCM frame has %d bytes, expected %d", len(pcm), pcmFrameBytes)
	}
	for i := range e.samples {
		e.samples[i] = int16(binary.LittleEndian.Uint16(pcm[i*2:]))
	}
	packet := make([]byte, 1275)
	n := C.opus_encode(e.native, (*C.opus_int16)(unsafe.Pointer(&e.samples[0])), 960, (*C.uchar)(unsafe.Pointer(&packet[0])), C.opus_int32(len(packet)))
	if n < 0 {
		return nil, fmt.Errorf("Opus encoding: %s", C.GoString(C.opus_strerror(n)))
	}
	return packet[:int(n)], nil
}
func (e *opusEncoder) close() {
	if e.native != nil {
		C.opus_encoder_destroy(e.native)
		e.native = nil
	}
}

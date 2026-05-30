// Tiny C bridge between libopus's variadic C API and Swift.
//
// libopus's opus_encoder_ctl + opus_decoder_ctl are variadic so the same
// function can take a `int` or a `int*` per CTL request. Swift cannot call
// C variadic functions directly (only Objective-C variadics with NSObject
// arguments are bridged). We therefore expose a small set of non-variadic
// `int` shims that match the CTLs OpusVoiceCodec.swift needs.
//
// Adding new CTLs: add a corresponding `opus_swift_<name>(...)` here and
// declare it in `SafeTMobile-Bridging-Header.h` so Swift can call it.
//
// libopus itself is built as part of the SafeTMobile target via the
// project.yml file enumeration that compiles opus/src/*.c, opus/celt/*.c,
// opus/silk/*.c and opus/silk/float/*.c. This bridge file is also picked
// up by that target (sources at SafeTMobile/Native/), so the symbol is
// linked statically with no extra wiring.

#include "opus.h"

// Encoder CTLs — all take a single int32 argument.

int opus_swift_encoder_set_signal(OpusEncoder *enc, int signal) {
    return opus_encoder_ctl(enc, OPUS_SET_SIGNAL(signal));
}

int opus_swift_encoder_set_bitrate(OpusEncoder *enc, int bitrate) {
    return opus_encoder_ctl(enc, OPUS_SET_BITRATE(bitrate));
}

int opus_swift_encoder_set_inband_fec(OpusEncoder *enc, int enable) {
    return opus_encoder_ctl(enc, OPUS_SET_INBAND_FEC(enable));
}

int opus_swift_encoder_set_packet_loss_perc(OpusEncoder *enc, int perc) {
    return opus_encoder_ctl(enc, OPUS_SET_PACKET_LOSS_PERC(perc));
}

int opus_swift_encoder_set_complexity(OpusEncoder *enc, int complexity) {
    return opus_encoder_ctl(enc, OPUS_SET_COMPLEXITY(complexity));
}

int opus_swift_encoder_set_dtx(OpusEncoder *enc, int enable) {
    return opus_encoder_ctl(enc, OPUS_SET_DTX(enable));
}

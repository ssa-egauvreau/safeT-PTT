# SPDX-FileCopyrightText: 2024 Bryan Biedenkapp (dvmvocoder upstream, GPLv2)
# SPDX-FileCopyrightText: Android glue code in this CMake file is repo-local.
cmake_minimum_required(VERSION 3.22.1)

project("securityradiovocoder")

set(VOCODER_SRC_DIR "${CMAKE_CURRENT_LIST_DIR}/dvmvocoder/vocoder")

file(GLOB vocoder_IMBE_CPP "${VOCODER_SRC_DIR}/imbe/*.cpp")
file(GLOB vocoder_ROOT_CPP "${VOCODER_SRC_DIR}/*.cpp")
file(GLOB vocoder_ROOT_C "${VOCODER_SRC_DIR}/*.c")

set(ALL_VOCODER_SOURCES ${vocoder_IMBE_CPP} ${vocoder_ROOT_CPP} ${vocoder_ROOT_C})

add_library(libdvmvocoder STATIC ${ALL_VOCODER_SOURCES})

target_include_directories(libdvmvocoder PUBLIC
    "${VOCODER_SRC_DIR}"
    "${VOCODER_SRC_DIR}/imbe"
)

set_target_properties(libdvmvocoder PROPERTIES
    POSITION_INDEPENDENT_CODE ON
    CXX_STANDARD 17
    CXX_STANDARD_REQUIRED ON
)

#
# libcodec2 — David Rowe's open-source low-bitrate speech codec (LGPL-2.1).
# Vendored as a git submodule at cpp/codec2 (pinned to tag 1.2.0). We build
# only the vocoder subset we need (mode 3200 in particular) as a static
# library that links into `securityradiovocoder.so`.
#
# Why not use upstream's CMakeLists via add_subdirectory: upstream pulls
# in FreeDV / OFDM / FSK / LDPC / LPCnet / demo executables, none of which
# apply to an Android NDK build, and its demo/ subdir adds host-only
# executables that don't cross-compile cleanly. The slim file list below
# is what mode 3200 actually depends on — verified by the JNI bridge
# compiling and linking without unresolved symbols on the NDK build.
#

set(CODEC2_DIR "${CMAKE_CURRENT_LIST_DIR}/codec2")

if(EXISTS "${CODEC2_DIR}/src/codec2.h")
    # libcodec2 ships codebook *.txt files plus a `generate_codebook` C
    # tool that emits the corresponding *.c arrays at build time. That
    # works for a native build but is painful under Android NDK cross-
    # compile (it'd need ExternalProject_Add to build the host helper
    # before the NDK build can proceed). We side-step the whole dance by
    # vendoring the generated codebook *.c outputs alongside this
    # CMakeLists — produced once by running `generate_codebook` against
    # libcodec2 1.2.0's codebook/*.txt fixtures. Regenerate if the
    # submodule ref ever bumps; see cpp/codec2_generated/README.md.
    set(CODEC2_GEN_DIR "${CMAKE_CURRENT_LIST_DIR}/codec2_generated")

    set(CODEC2_SRC
        "${CODEC2_DIR}/src/codec2.c"
        "${CODEC2_DIR}/src/codec2_fft.c"
        "${CODEC2_DIR}/src/kiss_fft.c"
        "${CODEC2_DIR}/src/kiss_fftr.c"
        "${CODEC2_DIR}/src/sine.c"
        "${CODEC2_DIR}/src/phase.c"
        "${CODEC2_DIR}/src/quantise.c"
        "${CODEC2_DIR}/src/lpc.c"
        "${CODEC2_DIR}/src/lsp.c"
        "${CODEC2_DIR}/src/nlp.c"
        "${CODEC2_DIR}/src/postfilter.c"
        "${CODEC2_DIR}/src/pack.c"
        "${CODEC2_DIR}/src/interp.c"
        "${CODEC2_DIR}/src/mbest.c"
        "${CODEC2_DIR}/src/newamp1.c"
        # newamp2.c does not exist in libcodec2 1.2.0 — only newamp2.h, which
        # codec2.c includes but doesn't actually call functions from. The
        # newamp2 codebook tables in CODEC2_GEN_DIR ARE referenced as extern
        # data, so they stay.
        "${CODEC2_GEN_DIR}/codebook.c"
        "${CODEC2_GEN_DIR}/codebookd.c"
        "${CODEC2_GEN_DIR}/codebookjmv.c"
        "${CODEC2_GEN_DIR}/codebookge.c"
        "${CODEC2_GEN_DIR}/codebooknewamp1.c"
        "${CODEC2_GEN_DIR}/codebooknewamp1_energy.c"
        "${CODEC2_GEN_DIR}/codebooknewamp2.c"
        "${CODEC2_GEN_DIR}/codebooknewamp2_energy.c"
        "${CODEC2_DIR}/src/dump.c"
    )

    add_library(codec2 STATIC ${CODEC2_SRC})
    target_include_directories(codec2 PUBLIC
        "${CODEC2_DIR}/src"
        # codec2_generated holds the vendored codebook arrays AND a
        # static `codec2/version.h` that codec2.h includes via
        # angle brackets — `<codec2/version.h>` therefore resolves to
        # codec2_generated/codec2/version.h.
        "${CODEC2_GEN_DIR}"
    )
    # Match the upstream feature defines so the source compiles with the
    # same code paths it does in the standalone build.
    target_compile_definitions(codec2 PRIVATE
        FLOATING_POINT
        VAR_ARRAYS
    )

    set_target_properties(codec2 PROPERTIES POSITION_INDEPENDENT_CODE ON)
    set(HAVE_CODEC2 TRUE)
else()
    # Submodule not initialised — Codec2 stays at the stub fallback in
    # Codec2VoiceCodec.kt. The build still succeeds with IMBE-only audio.
    set(HAVE_CODEC2 FALSE)
    message(STATUS "libcodec2 submodule not present at ${CODEC2_DIR}/src — Codec2 native support will be disabled. Run `git submodule update --init --recursive` to enable.")
endif()

#
# libopus — xiph.org's reference Opus codec (BSD-3-Clause). Vendored as a
# git submodule at cpp/opus, pinned to tag v1.5.2. We build only the
# float speech subset our voice profile needs (mono, 16 kHz, 20 ms) as
# a static library that links into `securityradiovocoder.so`.
#
# Why not use upstream's CMakeLists via add_subdirectory: same reason as
# libcodec2 above — upstream pulls in tests, demo programs, projection/
# multistream code (we only do mono), and architecture-specific SIMD
# detection that needs OPUS_X86_PRESUME_*/OPUS_ARM_*_INTR toggles per
# ABI. The slim file list below matches the autotools `OPUS_SOURCES +
# CELT_SOURCES + SILK_SOURCES + SILK_SOURCES_FLOAT` set with the
# multistream/projection/mapping_matrix sources omitted.
#

set(OPUS_DIR "${CMAKE_CURRENT_LIST_DIR}/opus")

if(EXISTS "${OPUS_DIR}/include/opus.h")
    # Slim enumeration of the libopus C sources we need. Matches the iOS
    # XcodeGen spec in ios-app/project.yml and the Emscripten build at
    # server/web-console/cpp/build-opus.sh — keep all three lists in sync
    # when the submodule is bumped.
    set(OPUS_CORE_SRC
        "${OPUS_DIR}/src/opus.c"
        "${OPUS_DIR}/src/opus_decoder.c"
        "${OPUS_DIR}/src/opus_encoder.c"
        "${OPUS_DIR}/src/extensions.c"
        "${OPUS_DIR}/src/repacketizer.c"
        # OPUS_SOURCES_FLOAT — required when float SILK is enabled.
        "${OPUS_DIR}/src/analysis.c"
        "${OPUS_DIR}/src/mlp.c"
        "${OPUS_DIR}/src/mlp_data.c"
    )
    set(OPUS_CELT_SRC
        "${OPUS_DIR}/celt/bands.c"
        "${OPUS_DIR}/celt/celt.c"
        "${OPUS_DIR}/celt/celt_encoder.c"
        "${OPUS_DIR}/celt/celt_decoder.c"
        "${OPUS_DIR}/celt/cwrs.c"
        "${OPUS_DIR}/celt/entcode.c"
        "${OPUS_DIR}/celt/entdec.c"
        "${OPUS_DIR}/celt/entenc.c"
        "${OPUS_DIR}/celt/kiss_fft.c"
        "${OPUS_DIR}/celt/laplace.c"
        "${OPUS_DIR}/celt/mathops.c"
        "${OPUS_DIR}/celt/mdct.c"
        "${OPUS_DIR}/celt/modes.c"
        "${OPUS_DIR}/celt/pitch.c"
        "${OPUS_DIR}/celt/celt_lpc.c"
        "${OPUS_DIR}/celt/quant_bands.c"
        "${OPUS_DIR}/celt/rate.c"
        "${OPUS_DIR}/celt/vq.c"
    )
    file(GLOB OPUS_SILK_SRC "${OPUS_DIR}/silk/*.c")
    file(GLOB OPUS_SILK_FLOAT_SRC "${OPUS_DIR}/silk/float/*.c")

    add_library(opus STATIC
        ${OPUS_CORE_SRC}
        ${OPUS_CELT_SRC}
        ${OPUS_SILK_SRC}
        ${OPUS_SILK_FLOAT_SRC}
    )

    target_include_directories(opus PUBLIC
        "${OPUS_DIR}/include"
        "${OPUS_DIR}/celt"
        "${OPUS_DIR}/silk"
        "${OPUS_DIR}/silk/float"
    )
    # Match the autotools default float-build defines. PACKAGE_VERSION is
    # the version string libopus reports via opus_get_version_string(); the
    # encoder header writes it into the comment block on encoded OggOpus
    # streams. We never emit Ogg here but the symbol is referenced.
    target_compile_definitions(opus PRIVATE
        OPUS_BUILD
        USE_ALLOCA
        VAR_ARRAYS
        HAVE_LRINTF
        PACKAGE_VERSION="1.5.2"
    )

    set_target_properties(opus PROPERTIES POSITION_INDEPENDENT_CODE ON)
    set(HAVE_OPUS TRUE)
else()
    # Submodule not initialised — Opus stays disabled. The OpusVoiceCodec
    # Kotlin wrapper reports isReady=false in that case and the registry
    # falls back to IMBE on TX, same pattern as Codec2.
    set(HAVE_OPUS FALSE)
    message(STATUS "libopus submodule not present at ${OPUS_DIR}/include — Opus native support will be disabled. Run `git submodule update --init --recursive` to enable.")
endif()

find_library(android_log_lib log)
find_library(cpp_shared NAMES c++_shared)

set(JNI_SOURCES "${CMAKE_CURRENT_LIST_DIR}/p25_jni.cpp")
if(HAVE_CODEC2)
    list(APPEND JNI_SOURCES "${CMAKE_CURRENT_LIST_DIR}/codec2_jni.cpp")
endif()
if(HAVE_OPUS)
    list(APPEND JNI_SOURCES "${CMAKE_CURRENT_LIST_DIR}/opus_jni.cpp")
endif()

add_library(securityradiovocoder SHARED ${JNI_SOURCES})
target_compile_options(securityradiovocoder PRIVATE -Wall)

target_include_directories(securityradiovocoder PRIVATE "${VOCODER_SRC_DIR}")

if(HAVE_CODEC2)
    target_include_directories(securityradiovocoder PRIVATE "${CODEC2_DIR}/src")
    target_link_libraries(securityradiovocoder PRIVATE codec2)
    target_compile_definitions(securityradiovocoder PRIVATE HAVE_CODEC2=1)
endif()

if(HAVE_OPUS)
    target_include_directories(securityradiovocoder PRIVATE "${OPUS_DIR}/include")
    target_link_libraries(securityradiovocoder PRIVATE opus)
    target_compile_definitions(securityradiovocoder PRIVATE HAVE_OPUS=1)
endif()

# Required for Android 15+ devices / emulators with 16 KB memory pages (ELF LOAD alignment).
target_link_options(securityradiovocoder PRIVATE
    "-Wl,-z,max-page-size=16384"
    "-Wl,-z,common-page-size=16384")

target_link_libraries(securityradiovocoder PRIVATE
    libdvmvocoder
    android
    ${android_log_lib}
    ${cpp_shared}
)

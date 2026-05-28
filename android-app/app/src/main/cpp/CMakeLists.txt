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
        # newamp2 codebook tables below ARE referenced as extern data, so
        # they stay.
        "${CODEC2_DIR}/src/codebook.c"
        "${CODEC2_DIR}/src/codebookd.c"
        "${CODEC2_DIR}/src/codebookjmv.c"
        "${CODEC2_DIR}/src/codebookge.c"
        "${CODEC2_DIR}/src/codebooknewamp1.c"
        "${CODEC2_DIR}/src/codebooknewamp1_energy.c"
        "${CODEC2_DIR}/src/codebooknewamp2.c"
        "${CODEC2_DIR}/src/codebooknewamp2_energy.c"
        "${CODEC2_DIR}/src/dump.c"
    )

    add_library(codec2 STATIC ${CODEC2_SRC})
    target_include_directories(codec2 PUBLIC "${CODEC2_DIR}/src")
    # Match the upstream feature defines so the source compiles with the
    # same code paths it does in the standalone build.
    target_compile_definitions(codec2 PRIVATE
        FLOATING_POINT
        VAR_ARRAYS
        CODEC2_VERSION_MAJOR=1
        CODEC2_VERSION_MINOR=2
        CODEC2_VERSION_PATCH=0
    )
    # libcodec2 doesn't ship a `<codec2/version.h>` in the source tree —
    # the upstream CMakeLists generates it. Stub one out so codec2.h's
    # include resolves without us having to run codec2's own configure.
    set(CODEC2_GENERATED_DIR "${CMAKE_CURRENT_BINARY_DIR}/codec2-generated")
    file(MAKE_DIRECTORY "${CODEC2_GENERATED_DIR}/codec2")
    file(WRITE "${CODEC2_GENERATED_DIR}/codec2/version.h"
        "#ifndef CODEC2_VERSION_H\n"
        "#define CODEC2_VERSION_H\n"
        "#define CODEC2_VERSION_MAJOR 1\n"
        "#define CODEC2_VERSION_MINOR 2\n"
        "#define CODEC2_VERSION_PATCH 0\n"
        "#endif\n"
    )
    target_include_directories(codec2 PUBLIC "${CODEC2_GENERATED_DIR}")

    set_target_properties(codec2 PROPERTIES POSITION_INDEPENDENT_CODE ON)
    set(HAVE_CODEC2 TRUE)
else()
    # Submodule not initialised — Codec2 stays at the stub fallback in
    # Codec2VoiceCodec.kt. The build still succeeds with IMBE-only audio.
    set(HAVE_CODEC2 FALSE)
    message(STATUS "libcodec2 submodule not present at ${CODEC2_DIR}/src — Codec2 native support will be disabled. Run `git submodule update --init --recursive` to enable.")
endif()

find_library(android_log_lib log)
find_library(cpp_shared NAMES c++_shared)

set(JNI_SOURCES "${CMAKE_CURRENT_LIST_DIR}/p25_jni.cpp")
if(HAVE_CODEC2)
    list(APPEND JNI_SOURCES "${CMAKE_CURRENT_LIST_DIR}/codec2_jni.cpp")
endif()

add_library(securityradiovocoder SHARED ${JNI_SOURCES})
target_compile_options(securityradiovocoder PRIVATE -Wall)

target_include_directories(securityradiovocoder PRIVATE "${VOCODER_SRC_DIR}")

if(HAVE_CODEC2)
    target_include_directories(securityradiovocoder PRIVATE "${CODEC2_DIR}/src")
    target_link_libraries(securityradiovocoder PRIVATE codec2)
    target_compile_definitions(securityradiovocoder PRIVATE HAVE_CODEC2=1)
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

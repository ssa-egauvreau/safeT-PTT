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

find_library(android_log_lib log)
find_library(cpp_shared NAMES c++_shared)

add_library(securityradiovocoder SHARED "${CMAKE_CURRENT_LIST_DIR}/p25_jni.cpp")
target_compile_options(securityradiovocoder PRIVATE -Wall)

target_include_directories(securityradiovocoder PRIVATE "${VOCODER_SRC_DIR}")

target_link_libraries(securityradiovocoder PRIVATE
    libdvmvocoder
    android
    ${android_log_lib}
    ${cpp_shared}
)

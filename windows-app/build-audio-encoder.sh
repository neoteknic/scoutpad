#!/bin/sh
set -eu
cd "$(dirname "$0")/../.tools/ffmpeg-8.0.3"
./configure --target-os=mingw32 --disable-everything --disable-autodetect \
  --disable-network --disable-doc --disable-debug --disable-x86asm \
  --disable-avdevice --disable-swscale --disable-ffplay --disable-ffprobe \
  --enable-ffmpeg --enable-protocol=pipe --enable-demuxer=pcm_s16le \
  --enable-decoder=pcm_s16le --enable-encoder=aac --enable-muxer=adts \
  --enable-filter=aresample,aformat,anull --enable-small --extra-ldflags=-static
make -j4 ffmpeg.exe

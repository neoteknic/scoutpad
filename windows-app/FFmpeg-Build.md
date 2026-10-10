# Windows Audio Encoder

ScoutPad invokes an unmodified, separately executable FFmpeg 8.0.3 build to
encode raw mono PCM as AAC-LC. It does not link FFmpeg into ScoutPad.
No GPL, nonfree, external codec or network components are enabled.

The portable archive includes the complete original FFmpeg source archive,
its LGPL 2.1 license, the build script, and MinGW runtime notices in
`third-party/ffmpeg`. Replace `ffmpeg.exe` freely with a compatible build.

Source: https://ffmpeg.org/releases/ffmpeg-8.0.3.tar.xz
Compiler/toolchain: w64devkit x64 2.10.0 (GCC/MinGW-w64)
https://github.com/skeeto/w64devkit/releases/tag/v2.10.0

To reproduce, extract w64devkit into `.tools/w64devkit` and the original
source into `.tools/ffmpeg-8.0.3`, keeping the archive in `.tools`.
Run the following from the project root in PowerShell:

```powershell
$env:PATH = "$PWD\.tools\w64devkit\bin;$env:PATH"
& .tools\w64devkit\bin\sh.exe windows-app/build-audio-encoder.sh
npm run build:windows
```

All configure options are in the included build script. The original source
is not patched. The encoder has no video or RTSP support; those remain
features of the separate Node development server's existing FFmpeg package.

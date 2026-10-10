$ErrorActionPreference = "Stop"
$ProjectRoot = Split-Path -Parent $PSScriptRoot
$Stage = Join-Path $ProjectRoot "dist\ScoutPad-Windows-x64"
$Go = Join-Path $ProjectRoot ".tools\go\bin\go.exe"
$Compiler = Join-Path $env:WINDIR "Microsoft.NET\Framework64\v4.0.30319\csc.exe"
$Artifact = Join-Path $ProjectRoot "dist\ScoutPad-Windows-x64.zip"

New-Item -ItemType Directory -Path $Stage -Force | Out-Null
Push-Location (Join-Path $ProjectRoot "bridge\desktop")
try {
    & $Go mod tidy
    if ($LASTEXITCODE -ne 0) { throw "Echec go mod tidy" }
    & $Go build -trimpath -ldflags "-s -w" -o (Join-Path $Stage "scout-backend.exe") .
    if ($LASTEXITCODE -ne 0) { throw "Echec du backend Windows" }
} finally { Pop-Location }

Add-Type -AssemblyName System.Drawing
$Artwork = Join-Path $ProjectRoot "android-app\app\src\main\res\mipmap-xxxhdpi\ic_launcher.png"
$Bitmap = New-Object System.Drawing.Bitmap($Artwork)
try {
    $Handle = $Bitmap.GetHicon()
    $Icon = [System.Drawing.Icon]::FromHandle($Handle)
    $Stream = [System.IO.File]::Create((Join-Path $Stage "scoutpad.ico"))
    try { $Icon.Save($Stream) } finally { $Stream.Dispose(); $Icon.Dispose() }
} finally { $Bitmap.Dispose() }

& $Compiler /nologo /target:winexe /platform:x64 /optimize+ /r:System.Windows.Forms.dll /r:System.Drawing.dll "/win32icon:$Stage\scoutpad.ico" "/out:$Stage\ScoutPad.exe" (Join-Path $PSScriptRoot "Launcher.cs")
if ($LASTEXITCODE -ne 0) { throw "Echec du lanceur Windows" }
Copy-Item -LiteralPath (Join-Path $ProjectRoot "public") -Destination $Stage -Recurse -Force
$Vendor = Join-Path $Stage "public\vendor"
New-Item -ItemType Directory -Path $Vendor -Force | Out-Null
Copy-Item -LiteralPath (Join-Path $ProjectRoot "node_modules\hls.js\dist\hls.min.js") -Destination $Vendor -Force
Copy-Item -LiteralPath (Join-Path $ProjectRoot "node_modules\lucide\dist\umd\lucide.min.js") -Destination $Vendor -Force
$AudioEncoder = Join-Path $ProjectRoot ".tools\ffmpeg-8.0.3\ffmpeg.exe"
if (-not (Test-Path -LiteralPath $AudioEncoder)) {
    throw "Encodeur audio manquant. Voir windows-app/FFmpeg-Build.md."
}
Copy-Item -LiteralPath $AudioEncoder -Destination (Join-Path $Stage "ffmpeg.exe") -Force
$AudioSource = Join-Path $Stage "third-party\ffmpeg"
New-Item -ItemType Directory -Path $AudioSource -Force | Out-Null
Copy-Item -LiteralPath (Join-Path $ProjectRoot ".tools\ffmpeg-8.0.3.tar.xz") -Destination $AudioSource -Force
Copy-Item -LiteralPath (Join-Path $ProjectRoot ".tools\ffmpeg-8.0.3\COPYING.LGPLv2.1") -Destination $AudioSource -Force
Copy-Item -LiteralPath (Join-Path $ProjectRoot ".tools\w64devkit\COPYING.MinGW-w64-runtime.txt") -Destination $AudioSource -Force
Copy-Item -LiteralPath (Join-Path $PSScriptRoot "build-audio-encoder.sh") -Destination $AudioSource -Force
Copy-Item -LiteralPath (Join-Path $PSScriptRoot "FFmpeg-Build.md") -Destination $AudioSource -Force
Copy-Item -LiteralPath (Join-Path $PSScriptRoot "README-Windows.txt") -Destination $Stage -Force
Copy-Item -LiteralPath (Join-Path $PSScriptRoot "Setup-Firewall.ps1") -Destination $Stage -Force
Compress-Archive -LiteralPath $Stage -DestinationPath $Artifact -Force
Write-Host "Windows portable : $Artifact"

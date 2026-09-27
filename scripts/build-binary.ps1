# Build the Dot Motion Builder single-binary distribution (Windows).
#
# Usage:
#   powershell -ExecutionPolicy Bypass -File scripts\build-binary.ps1
#   powershell -ExecutionPolicy Bypass -File scripts\build-binary.ps1 -Targets windows/amd64
#   powershell -ExecutionPolicy Bypass -File scripts\build-binary.ps1 -Targets all
#
# Produces self-contained executables in bin\ with the compiled frontend
# embedded (no Node.js, no external assets at runtime).
param(
  [string[]]$Targets = @("windows/amd64")
)

$ErrorActionPreference = "Stop"
$Root = Split-Path -Parent $PSScriptRoot
Set-Location $Root

# --- Toolchain checks -------------------------------------------------------
try { $GoVersion = go version } catch {
  Write-Error "Go toolchain not found. Install Go 1.27.1+ from https://go.dev/dl/ first."
  exit 1
}
Write-Host "toolchain: $GoVersion"

# --- Build the frontend static export ----------------------------------------
Write-Host "==> installing frontend dependencies"
pnpm install --frozen-lockfile
if ($LASTEXITCODE -ne 0) { Write-Error "pnpm install failed"; exit 1 }

Write-Host "==> building frontend (next build, output: 'export')"
pnpm build
if ($LASTEXITCODE -ne 0) { Write-Error "next build failed"; exit 1 }

Write-Host "==> staging export for embedding (server/frontend)"
if (Test-Path server\frontend) { Remove-Item -Recurse -Force server\frontend }
Copy-Item -Recurse out server\frontend

# --- Version metadata ----------------------------------------------------------
$Version = (Get-Content package.json | ConvertFrom-Json).version
$LdFlags = "-s -w -X main.appVersion=$Version"

if ($Targets -contains "all") {
  $Targets = @("windows/amd64", "windows/arm64", "linux/amd64", "linux/arm64", "darwin/amd64", "darwin/arm64")
}

New-Item -ItemType Directory -Force -Path bin | Out-Null
foreach ($target in $Targets) {
  $parts = $target -split "/"
  $GOOS = $parts[0]; $GOARCH = $parts[1]
  $ext = if ($GOOS -eq "windows") { ".exe" } else { "" }
  $out = "bin\dot-motion-builder-$GOOS-$GOARCH$ext"
  Write-Host "==> compiling $GOOS/$GOARCH -> $out"
  Push-Location server
  $env:GOOS = $GOOS; $env:GOARCH = $GOARCH; $env:CGO_ENABLED = "0"
  go build -trimpath -ldflags $LdFlags -o "..\$out" .
  if ($LASTEXITCODE -ne 0) { Pop-Location; Write-Error "go build failed for $target"; exit 1 }
  Pop-Location
}

Write-Host ""
Write-Host "done. artifacts in bin\:"
Get-ChildItem bin | Format-Table Name, Length
Write-Host "run: .\bin\dot-motion-builder-windows-amd64.exe   (options: -addr :8080 -no-open -quiet -version)"

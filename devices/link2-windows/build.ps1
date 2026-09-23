[CmdletBinding()]
param(
    [ValidateSet('Debug', 'Release')][string]$Configuration = 'Release',
    [string]$SdkRoot = '',
    [string]$SdkArchive = '',
    [string]$BuildDir = '',
    [string]$CMakePath = '',
    [string]$Generator = 'Visual Studio 17 2022'
)
$ErrorActionPreference = 'Stop'
if ($env:OS -ne 'Windows_NT') { throw 'This Link SDK build requires Windows x64.' }
if ([string]::IsNullOrWhiteSpace($SdkRoot) -eq [string]::IsNullOrWhiteSpace($SdkArchive)) {
    throw 'Provide exactly one -SdkRoot (folder containing x64) or -SdkArchive (official UVCCamera_win.zip). The vendor SDK is not included.'
}
function Resolve-BuildInput([string]$Value) {
    if ([IO.Path]::IsPathRooted($Value)) { return [IO.Path]::GetFullPath($Value) }
    return [IO.Path]::GetFullPath((Join-Path $PSScriptRoot $Value))
}
if ($SdkRoot) { $SdkRoot = Resolve-BuildInput $SdkRoot; if (-not (Test-Path -LiteralPath (Join-Path $SdkRoot 'x64/include/uvc_camera.h') -PathType Leaf)) { throw 'SdkRoot must contain x64/include/uvc_camera.h.' } }
if ($SdkArchive) { $SdkArchive = Resolve-BuildInput $SdkArchive; if (-not (Test-Path -LiteralPath $SdkArchive -PathType Leaf)) { throw 'SdkArchive was not found. Supply the official Windows Link SDK zip.' } }
if (-not $BuildDir) { $BuildDir = Join-Path $PSScriptRoot 'build' } else { $BuildDir = Resolve-BuildInput $BuildDir }
if ($CMakePath) { $cmake = Resolve-BuildInput $CMakePath } else {
    $command = Get-Command cmake.exe -ErrorAction SilentlyContinue
    if ($command) { $cmake = $command.Source } else {
        $vswhere = Join-Path ${env:ProgramFiles(x86)} 'Microsoft Visual Studio/Installer/vswhere.exe'
        if (Test-Path -LiteralPath $vswhere -PathType Leaf) {
            $installation = & $vswhere -latest -products '*' -requires Microsoft.VisualStudio.Component.VC.Tools.x86.x64 -property installationPath
            if ($installation) { $cmake = Join-Path $installation 'Common7/IDE/CommonExtensions/Microsoft/CMake/CMake/bin/cmake.exe' }
        }
    }
}
if (-not $cmake -or -not (Test-Path -LiteralPath $cmake -PathType Leaf)) { throw 'CMake 3.20+ was not found. Install Visual Studio 2022 C++ Build Tools and CMake, or pass -CMakePath.' }
$configure = @('-S', $PSScriptRoot, '-B', $BuildDir, '-G', $Generator, '-A', 'x64')
if ($SdkRoot) { $configure += "-DLINK_SDK_ROOT=$SdkRoot" } else { $configure += "-DLINK_SDK_ARCHIVE=$SdkArchive" }
& $cmake @configure
if ($LASTEXITCODE -ne 0) { throw "CMake configuration failed ($LASTEXITCODE). Check the SDK layout and installed Visual Studio generator." }
& $cmake --build $BuildDir --config $Configuration
if ($LASTEXITCODE -ne 0) { throw "Build failed ($LASTEXITCODE)." }
Write-Host ('Built: ' + (Join-Path $BuildDir "$Configuration/link2_dwell_demo.exe"))

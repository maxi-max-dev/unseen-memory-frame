# A simple script intentionally accepts pipeline input through $input for -Stdin.
# CmdletBinding without a ValueFromPipeline parameter rejects those EVENT lines.
param(
    [string]$ConfigPath = '',
    [string]$Endpoint = '',
    [string]$DemoPath = '',
    [string]$NodePath = '',
    [switch]$DryRun,
    [switch]$Stdin,
    [switch]$Once,
    [switch]$CheckConfig
)
$ErrorActionPreference = 'Stop'
$scriptRoot = $PSScriptRoot
function Resolve-InputPath([string]$Value) {
    if ([IO.Path]::IsPathRooted($Value)) { return [IO.Path]::GetFullPath($Value) }
    return [IO.Path]::GetFullPath((Join-Path $scriptRoot $Value))
}
try {
    if ($NodePath) {
        $node = Resolve-InputPath $NodePath
        if (-not (Test-Path -LiteralPath $node -PathType Leaf)) { throw 'Node executable was not found.' }
    } else {
        $command = Get-Command node.exe -ErrorAction SilentlyContinue
        if (-not $command) { $command = Get-Command node -ErrorAction SilentlyContinue }
        if (-not $command) { throw 'Node.js 20 or later is required; install it or pass -NodePath.' }
        $node = $command.Source
    }
    $nodeVersion = & $node --version
    if ($LASTEXITCODE -ne 0 -or $nodeVersion -notmatch '^v(\d+)\.' -or [int]$Matches[1] -lt 20) { throw 'Node.js 20 or later is required.' }
    $arguments = @((Join-Path $scriptRoot 'presence_uploader.cjs'))
    if ($ConfigPath) { $arguments += @('--config', (Resolve-InputPath $ConfigPath)) }
    if ($Endpoint) { $arguments += @('--endpoint', $Endpoint) }
    if ($DemoPath) { $arguments += @('--demo', (Resolve-InputPath $DemoPath)) }
    if ($DryRun) { $arguments += '--dry-run' }
    if ($Stdin) { $arguments += '--stdin' }
    if ($Once) { $arguments += '--once' }
    if ($CheckConfig) { $arguments += '--check-config' }
    # Config is read only by Node, never echoed or placed in process arguments.
    # No sibling MVP file, token file, or bundled runtime is auto-discovered.
    if ($Stdin) { $input | & $node @arguments } else { & $node @arguments }
    exit $LASTEXITCODE
} catch {
    [Console]::Error.WriteLine('[presence] Launcher failed. Check NodePath, ConfigPath and file access; details are suppressed to protect private configuration.')
    exit 1
}

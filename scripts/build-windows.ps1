<#
.SYNOPSIS
    Builds the Windows desktop client, at a version it asks you for.

.DESCRIPTION
    What the "Build Windows installers" job in .github/workflows/publish.yml
    does, as something you can run on any Windows machine with the toolchain
    installed. It exists so a broken CI runner does not mean no releases.

    The version is stamped across every manifest that carries one — the five
    package.json files, the Tauri config, and the Rust crate — because they are
    read by different things at different times. The client compares its own
    Cargo version against what the server publishes to decide whether to offer
    an update, and the installer names itself from the Tauri config, so a build
    where those two disagree ships an update nobody is offered.

    Only the desktop client is built. The server ships as a container image
    built on Linux; see publish.yml for that half.

.PARAMETER Version
    The version to build, e.g. 0.5.0. Prompted for when omitted.

.PARAMETER KeepVersion
    Build at whatever version the working tree already carries, changing
    nothing. Useful for rebuilding a release that failed partway through.

.PARAMETER Fast
    Skip full link-time optimisation. Roughly a quarter of the build time, and
    a slightly larger, slightly slower binary — for proving a build works, not
    for what you hand to users.

.PARAMETER SkipChecks
    Skip typecheck and tests. They run by default: a release built from code
    that does not compile cleanly is worse than no release.

.EXAMPLE
    .\scripts\build-windows.ps1
    Prompts for a version, then builds it.

.EXAMPLE
    .\scripts\build-windows.ps1 -Version 0.5.0 -Fast
#>

#Requires -Version 5.1
[CmdletBinding()]
param(
    [string]$Version,
    [switch]$KeepVersion,
    [switch]$Fast,
    [switch]$SkipChecks
)

$ErrorActionPreference = 'Stop'
# Invoke-WebRequest and friends draw a progress bar that turns a few seconds of
# work into minutes on Windows PowerShell.
$ProgressPreference = 'SilentlyContinue'

$RepoRoot = Split-Path -Parent $PSScriptRoot

function Write-Step($message) { Write-Host "`n==> $message" -ForegroundColor Cyan }
function Write-Note($message) { Write-Host "    $message" -ForegroundColor DarkGray }
function Write-Good($message) { Write-Host "    $message" -ForegroundColor Green }

<#
    Runs a command and stops the script if it fails.

    PowerShell keeps going after a native command exits non-zero, so without
    this a failed typecheck would be followed by a forty-minute Rust build and
    a cheerful "done".
#>
function Invoke-Step {
    param(
        [Parameter(Mandatory)][string]$Command,
        [string[]]$Arguments = @(),
        [string]$FailureHint
    )

    Write-Note "$Command $($Arguments -join ' ')"
    & $Command @Arguments
    if ($LASTEXITCODE -ne 0) {
        if ($FailureHint) { Write-Host "`n$FailureHint" -ForegroundColor Yellow }
        throw "$Command exited with $LASTEXITCODE"
    }
}

<# The version the working tree currently carries, read from the root manifest. #>
function Get-CurrentVersion {
    $manifest = Get-Content -LiteralPath (Join-Path $RepoRoot 'package.json') -Raw | ConvertFrom-Json
    return $manifest.version
}

<#
    Replaces the first version string in a file, leaving everything else byte
    for byte as it was.

    A regex rather than parse-and-reserialise on purpose: round-tripping these
    files through ConvertTo-Json reorders keys and reindents the whole thing,
    which turns a one-line version bump into an unreviewable diff.
#>
function Set-FileVersion {
    param(
        [Parameter(Mandatory)][string]$Path,
        [Parameter(Mandatory)][string]$Pattern,
        [Parameter(Mandatory)][string]$Replacement
    )

    $full = Join-Path $RepoRoot $Path
    if (-not (Test-Path -LiteralPath $full)) { throw "Expected to find $Path" }

    $raw = Get-Content -LiteralPath $full -Raw
    $regex = [regex]::new($Pattern)
    if (-not $regex.IsMatch($raw)) {
        throw "No version field matched in $Path — the file's shape has changed since this script was written."
    }

    # Count of 1: package.json carries dependency versions too, and the
    # package's own is the first one in the file.
    $updated = $regex.Replace($raw, $Replacement, 1)
    if ($updated -eq $raw) { return $false }

    # WriteAllText with an explicit no-BOM encoding: Set-Content -Encoding utf8
    # writes a byte-order mark on Windows PowerShell, which some JSON readers
    # reject and which shows up as a whole-file change in the diff.
    [System.IO.File]::WriteAllText($full, $updated, (New-Object System.Text.UTF8Encoding $false))
    return $true
}

function Set-WorkspaceVersion {
    param([Parameter(Mandatory)][string]$NewVersion)

    # `"version": "..."` — the first occurrence, which is the package's own.
    $jsonPattern = '("version"\s*:\s*")[^"]*(")'
    $jsonReplacement = '${1}' + $NewVersion + '${2}'

    $manifests = @(
        'package.json',
        'packages/shared/package.json',
        'apps/server/package.json',
        'apps/web/package.json',
        'apps/desktop/package.json',
        'apps/desktop/src-tauri/tauri.conf.json'
    )

    foreach ($manifest in $manifests) {
        $changed = Set-FileVersion -Path $manifest -Pattern $jsonPattern -Replacement $jsonReplacement
        Write-Note ("{0} {1}" -f $manifest, $(if ($changed) { 'updated' } else { 'already correct' }))
    }

    # `version = "..."` at the start of a line. [package] is the first table in
    # the file, so the first match is the crate's own rather than a dependency's.
    $changed = Set-FileVersion `
        -Path 'apps/desktop/src-tauri/Cargo.toml' `
        -Pattern '(?m)^(version\s*=\s*")[^"]*(")' `
        -Replacement ('${1}' + $NewVersion + '${2}')
    Write-Note ("apps/desktop/src-tauri/Cargo.toml {0}" -f $(if ($changed) { 'updated' } else { 'already correct' }))
}

<#
    Asks for the version, and keeps asking until the answer is one.

    Validated against the same shape the release tag and the client's update
    check expect. A typo here does not fail until forty minutes into a Rust
    build, so it is worth catching before anything starts.
#>
function Read-Version {
    param([Parameter(Mandatory)][string]$Current)

    while ($true) {
        Write-Host ''
        Write-Host "Current version: $Current" -ForegroundColor DarkGray
        $answer = Read-Host 'New version to build (blank to keep the current one)'

        if ([string]::IsNullOrWhiteSpace($answer)) { return $Current }

        $answer = $answer.Trim().TrimStart('v', 'V')
        if ($answer -match '^\d+\.\d+\.\d+([-+][0-9A-Za-z.\-]+)?$') { return $answer }

        Write-Host "  '$answer' is not a version. Expected something like 0.5.0." -ForegroundColor Yellow
    }
}

<# Fails early and with an actionable message when a tool is missing. #>
function Assert-Tool {
    param(
        [Parameter(Mandatory)][string]$Name,
        [Parameter(Mandatory)][string]$Hint
    )

    if (-not (Get-Command $Name -ErrorAction SilentlyContinue)) {
        throw "$Name is not on PATH.`n  $Hint"
    }
}

# ---------------------------------------------------------------------- start

Push-Location $RepoRoot
try {
    Write-Host 'GameBlade — Windows client build' -ForegroundColor White

    Write-Step 'Checking the toolchain'
    Assert-Tool -Name 'node' -Hint 'Install Node 22 or newer from https://nodejs.org.'
    Assert-Tool -Name 'pnpm' -Hint 'Run: corepack enable'
    Assert-Tool -Name 'cargo' -Hint 'Install Rust from https://win.rustup.rs, then reopen this terminal.'

    # A major version behind is the one that bites: the workspace declares
    # node >= 22, and an older runtime fails deep inside a build rather than here.
    $nodeMajor = [int]((node --version) -replace '^v', '' -split '\.')[0]
    if ($nodeMajor -lt 22) { throw "Node 22 or newer is required; found $(node --version)." }
    Write-Good "node $(node --version), pnpm $(pnpm --version), $(cargo --version)"

    # ------------------------------------------------------------- version
    $current = Get-CurrentVersion

    if ($KeepVersion) {
        $target = $current
        Write-Step "Building at the current version ($target)"
    }
    else {
        if ($Version) {
            $target = $Version.Trim().TrimStart('v', 'V')
            if ($target -notmatch '^\d+\.\d+\.\d+([-+][0-9A-Za-z.\-]+)?$') {
                throw "-Version '$Version' is not a version. Expected something like 0.5.0."
            }
        }
        else {
            $target = Read-Version -Current $current
        }

        Write-Step "Stamping version $target"
        Set-WorkspaceVersion -NewVersion $target
    }

    # ------------------------------------------------------------- install
    Write-Step 'Installing dependencies'
    # The lockfile does not record workspace package versions, so a bump should
    # not invalidate it — but a lockfile that has drifted for any other reason
    # should not stop a release going out.
    & pnpm install --frozen-lockfile
    if ($LASTEXITCODE -ne 0) {
        Write-Note 'Frozen install failed; retrying without --frozen-lockfile'
        Invoke-Step -Command 'pnpm' -Arguments @('install')
    }

    Write-Step 'Building the shared package'
    # Everything else typechecks against its emitted declarations, so this is
    # not optional even for a client-only build.
    Invoke-Step -Command 'pnpm' -Arguments @('--filter', '@gameblade/shared', 'build')

    if (-not $SkipChecks) {
        Write-Step 'Typechecking'
        Invoke-Step -Command 'pnpm' -Arguments @('-r', 'typecheck')

        Write-Step 'Running tests'
        Invoke-Step -Command 'pnpm' -Arguments @('-r', 'test')
    }
    else {
        Write-Note 'Skipping typecheck and tests (-SkipChecks)'
    }

    # --------------------------------------------------------------- build
    if ($Fast) {
        # Full LTO through a single codegen unit is most of what makes a release
        # build take the best part of an hour.
        Write-Note 'Fast build: link-time optimisation off, not for release'
        $env:CARGO_PROFILE_RELEASE_LTO = 'false'
        $env:CARGO_PROFILE_RELEASE_CODEGEN_UNITS = '16'
    }

    Write-Step "Building the desktop client ($target)"
    Write-Note 'This takes a while — a clean release build is the best part of an hour.'
    Invoke-Step -Command 'pnpm' `
        -Arguments @('--filter', '@gameblade/desktop', 'build') `
        -FailureHint @'
If the failure came from the Rust linker, the C++ build tools are missing.
Install "Desktop development with C++" from the Visual Studio Build Tools:
https://visualstudio.microsoft.com/visual-cpp-build-tools/
'@

    # ----------------------------------------------------------- collecting
    Write-Step 'Collecting the installers'
    $bundle = Join-Path $RepoRoot 'apps/desktop/src-tauri/target/release/bundle'
    $installers = @(
        Get-ChildItem -Path (Join-Path $bundle 'nsis') -Filter *.exe -ErrorAction SilentlyContinue
        Get-ChildItem -Path (Join-Path $bundle 'msi') -Filter *.msi -ErrorAction SilentlyContinue
    )

    if ($installers.Count -eq 0) {
        throw "The build reported success but produced no installers under $bundle."
    }

    # Versioned, so two builds do not overwrite each other and it is always
    # obvious which release a file on disk belongs to.
    $output = Join-Path $RepoRoot "dist/windows/$target"
    New-Item -ItemType Directory -Path $output -Force | Out-Null
    foreach ($installer in $installers) {
        Copy-Item -LiteralPath $installer.FullName -Destination $output -Force
    }

    Write-Host ''
    Write-Host "Built GameBlade $target" -ForegroundColor Green
    foreach ($installer in Get-ChildItem -Path $output -File) {
        Write-Good ("{0}  ({1:N1} MB)" -f $installer.Name, ($installer.Length / 1MB))
    }
    Write-Host ''
    Write-Host "  In: $output" -ForegroundColor DarkGray
    Write-Host ''
    Write-Host 'Next:' -ForegroundColor White
    Write-Host '  1. Upload the .exe to your server under Admin -> Desktop client,'
    Write-Host '     so the landing page and the in-app update banner both point at it.'
    if (-not $KeepVersion) {
        Write-Host "  2. Commit the version bump:  git commit -am ""Release $target"""
        Write-Host "  3. Tag it:                   git tag v$target"
    }
    Write-Host ''
}
finally {
    Pop-Location
}

# *********************************************************************
# This Original Work is copyright of 51 Degrees Mobile Experts Limited.
# Copyright 2026 51 Degrees Mobile Experts Limited, Davidson House,
# Forbury Square, Reading, Berkshire, United Kingdom RG1 3EU.
#
# This Original Work is licensed under the European Union Public Licence
# (EUPL) v.1.2 and is subject to its terms as set out below.
#
# If a copy of the EUPL was not distributed with this file, You can obtain
# one at https://opensource.org/licenses/EUPL-1.2.
#
# The 'Compatible Licences' set out in the Appendix to the EUPL (as may be
# amended by the European Commission) shall be deemed incompatible for
# the purposes of the Work and the provisions of the compatibility
# clause in Article 5 of the EUPL shall not apply.
#
# If using the Work as, or as part of, a network application, by
# including the attribution notice(s) required under Article 5 of the EUPL
# in the end user terms of the application under an appropriate heading,
# such notice(s) shall fulfill the requirements of that article.
# *********************************************************************

param(
    [Parameter(Mandatory)][string]$RepoName,
    [Parameter(Mandatory)][string]$OrgName,
    [string]$Name = "Release_x64",
    [string]$Configuration = "Release",
    [string]$Arch = "x64",
    [string]$BuildMethod = "dotnet",
    # The device-detection-cxx repo owns the js-snippet-export tool that
    # produces the snippets under test - the equivalent of the examples repo
    # that device-detection-dotnet clones for its integration coverage.
    [string]$SnippetToolRepo = "device-detection-cxx",
    [string]$SnippetToolBranch = "feature/js-snippet-export"
)
$ErrorActionPreference = "Stop"
$PSNativeCommandUseErrorActionPreference = $true
Set-StrictMode -Version 1.0

$RepoPath = [IO.Path]::Combine($pwd, $RepoName)

# The snippet sweep needs the enterprise TAC data file (it carries the full set
# of JavaScript property snippets - Lite has only a handful) and Chrome to run
# the rendered scripts. On runners where the data file is unavailable (e.g. an
# automation PR without the data-file secret), skip rather than fail the merge
# gate - this mirrors the guarded pattern in device-detection-dotnet.
$dataFile = Resolve-Path -ErrorAction SilentlyContinue `
    ([IO.Path]::Combine($pwd, "assets", "TAC-HashV41.hash"))
if (-not $dataFile) {
    Write-Host "::warning::No TAC Hash data file found under assets/ - skipping snippet integration tests."
    exit 0
}

# ---------------------------------------------------------------------------
# 1. Obtain the js-snippet-export tool source (device-detection-cxx).
#    common-ci provides steps/clone-repo.ps1 which honours the org and token.
# ---------------------------------------------------------------------------
if (-not (Test-Path $SnippetToolRepo)) {
    ./steps/clone-repo.ps1 -RepoName $SnippetToolRepo -OrgName $OrgName -Branch $SnippetToolBranch
}

# common-cxx and device-detection-data are submodules of device-detection-cxx;
# the CMake configure includes them, so they must be initialised.
git -C $SnippetToolRepo submodule update --init --recursive

# ---------------------------------------------------------------------------
# 2. Build ONLY the js-snippet-export target. It sits outside
#    if(BUILD_TESTING) in the root CMakeLists, so tests are not needed, but it
#    links fiftyone-hash-cxx so the engine is built transitively.
# ---------------------------------------------------------------------------
$buildDir = [IO.Path]::Combine($pwd, $SnippetToolRepo, "build")
cmake -S $SnippetToolRepo -B $buildDir -DCMAKE_BUILD_TYPE=$Configuration -DBUILD_TESTING=OFF
cmake --build $buildDir --config $Configuration --target js-snippet-export

# The tool pins RUNTIME_OUTPUT_DIRECTORY to <build>/bin. Multi-config
# generators (Visual Studio) nest it under the configuration.
$exeName = if ($IsWindows) { "js-snippet-export.exe" } else { "js-snippet-export" }
$cli = @(
    [IO.Path]::Combine($buildDir, "bin", $exeName),
    [IO.Path]::Combine($buildDir, "bin", $Configuration, $exeName)
) | Where-Object { Test-Path $_ } | Select-Object -First 1
if (-not $cli) {
    throw "js-snippet-export was not found under '$buildDir/bin'."
}
Write-Host "Using snippet export tool: $cli"

# ---------------------------------------------------------------------------
# 3. Generate the snippets into the repo's ignored snippets/ directory.
# ---------------------------------------------------------------------------
$snippetsDir = [IO.Path]::Combine($RepoPath, "snippets")
New-Item -ItemType Directory -Path $snippetsDir -Force | Out-Null
& $cli -d $dataFile.Path -o $snippetsDir

$generated = @(Get-ChildItem -Path $snippetsDir -Filter "*.js" -ErrorAction SilentlyContinue)
Write-Host "Generated $($generated.Count) snippet(s)."
if ($generated.Count -eq 0) {
    throw "The snippet export tool produced no .js files."
}

# ---------------------------------------------------------------------------
# 4. Drive every generated snippet through the template in a real browser.
# ---------------------------------------------------------------------------
$TestProject = [IO.Path]::Combine(
    $RepoPath, "tests", "FiftyOne.JavascriptTemplateTests",
    "FiftyOne.JavascriptTemplateTests.csproj")

# The EnricoMi publish step in common-ci globs test-results/integration/**/*.trx
# under the repo root. dotnet test defaults the TRX to the project's own
# TestResults/ dir, which that glob never matches (results silently unreported),
# so pin --results-directory to the location the reporter searches.
$ResultsDir = [IO.Path]::Combine($RepoPath, "test-results", "integration")
New-Item -ItemType Directory -Path $ResultsDir -Force | Out-Null

dotnet test $TestProject -c $Configuration `
    --results-directory $ResultsDir `
    --logger "console;verbosity=normal" `
    --logger "trx;LogFileName=snippet-integration.trx"

exit $LASTEXITCODE

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
    [string]$ProjectDir = ".",
    [string]$Name = "Release_x64",
    [string]$Configuration = "Release",
    [string]$Arch = "x64",
    [string]$BuildMethod = "dotnet"
)
$ErrorActionPreference = "Stop"

$RepoPath = [IO.Path]::Combine($pwd, $RepoName)

# The Node checks (unit tests) only need their dev dependency installed.
Write-Host "Installing Node dependencies for the template renderer"
Push-Location ([IO.Path]::Combine($RepoPath, "tests"))
try {
    npm ci
} finally {
    Pop-Location
}

# Build the C# snippet test project. The snippets it drives are generated later
# by the integration step, so only compilation is required here.
$TestProject = [IO.Path]::Combine(
    $RepoPath, "tests", "FiftyOne.JavascriptTemplateTests",
    "FiftyOne.JavascriptTemplateTests.csproj")

Write-Host "Building $TestProject"
dotnet build $TestProject -c $Configuration

exit $LASTEXITCODE

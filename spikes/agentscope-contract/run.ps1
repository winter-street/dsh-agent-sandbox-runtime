param([string]$Python = "python", [switch]$Bootstrap)
$ErrorActionPreference = "Stop"
$projectRoot = Split-Path (Split-Path $PSScriptRoot -Parent) -Parent
$venvRoot = Join-Path $projectRoot ".sources/agentscope-contract-venv"
$venvPython = Join-Path $venvRoot "Scripts/python.exe"
if ($Bootstrap) {
    if (!(Test-Path -LiteralPath $venvPython)) {
        & $Python -m venv $venvRoot
        if ($LASTEXITCODE -ne 0) { throw "venv creation failed" }
    }
    & uv pip install --python $venvPython -r (Join-Path $PSScriptRoot "requirements.lock")
    if ($LASTEXITCODE -ne 0) { throw "dependency installation failed" }
}
if (!(Test-Path -LiteralPath $venvPython)) { throw "Run with -Bootstrap first (requires Python >= 3.11 and uv)." }
& $venvPython (Join-Path $PSScriptRoot "probe.py")
if ($LASTEXITCODE -ne 0) { throw "AgentScope contract probe failed" }

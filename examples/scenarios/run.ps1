param()
$ErrorActionPreference = 'Stop'
$repositoryRoot = (Resolve-Path (Join-Path $PSScriptRoot '..\..')).Path
if (-not (Test-Path -LiteralPath (Join-Path $repositoryRoot '.sources\budget\lib\index.js'))) {
  throw 'Build the patched original budget plugin first; see integrations/budget/README.md. Scenarios must not silently skip.'
}
Push-Location $repositoryRoot
try {
  & pnpm exec vitest run tests/scenarios/budget-runtime.test.ts
  $scenarioExit = $LASTEXITCODE
} finally { Pop-Location }
exit $scenarioExit

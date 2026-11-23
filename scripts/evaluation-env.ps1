function Resolve-EvaluationPath([string]$RepoRoot, [string]$Path) {
  if ([IO.Path]::IsPathRooted($Path)) { return [IO.Path]::GetFullPath($Path) }
  return [IO.Path]::GetFullPath((Join-Path $RepoRoot $Path))
}

function Initialize-EvaluationEnvironment([string]$RepoRoot, [string]$EnvFile = '.env.local') {
  $allowed = @('DEEPSEEK_API_KEY', 'OPEN_SANDBOX_API_KEY')
  $fullPath = Resolve-EvaluationPath $RepoRoot $EnvFile
  if (Test-Path -LiteralPath $fullPath -PathType Leaf) {
    foreach ($line in Get-Content -LiteralPath $fullPath -Encoding UTF8) {
      $text = $line.Trim()
      if (-not $text -or $text.StartsWith('#')) { continue }
      $separator = $text.IndexOf('=')
      if ($separator -lt 1) { throw "Invalid line in $EnvFile. Use KEY=VALUE." }
      $name = $text.Substring(0, $separator).Trim()
      $value = $text.Substring($separator + 1).Trim()
      if ($allowed -notcontains $name) { throw "Unsupported key in ${EnvFile}: $name" }
      if ($value.Length -ge 2 -and (($value.StartsWith('"') -and $value.EndsWith('"')) -or ($value.StartsWith("'") -and $value.EndsWith("'")))) {
        $value = $value.Substring(1, $value.Length - 2)
      }
      if ([string]::IsNullOrWhiteSpace($value)) { throw "$name is empty in $EnvFile." }
      if ([string]::IsNullOrWhiteSpace([Environment]::GetEnvironmentVariable($name, 'Process'))) {
        [Environment]::SetEnvironmentVariable($name, $value, 'Process')
      }
    }
  }

  foreach ($name in $allowed) {
    if ([string]::IsNullOrWhiteSpace([Environment]::GetEnvironmentVariable($name, 'Process'))) {
      throw "$name is not set. Configure it in $EnvFile or the current process without printing the value."
    }
  }

  $configVars = @{
    ASR_EVAL_CONFIG_HARD_ONLY = 'config\eval-hard.json'
    ASR_EVAL_CONFIG_TIERED = 'config\eval-tiered.json'
    ASR_EVAL_CONFIG_FINALIZE = 'config\eval-finalize.json'
  }
  foreach ($entry in $configVars.GetEnumerator()) {
    $path = (Resolve-Path -LiteralPath (Join-Path $RepoRoot $entry.Value) -ErrorAction Stop).Path
    $current = [Environment]::GetEnvironmentVariable($entry.Key, 'Process')
    if (-not [string]::IsNullOrWhiteSpace($current)) {
      $currentPath = Resolve-EvaluationPath $RepoRoot $current
      if ((Resolve-Path -LiteralPath $currentPath -ErrorAction Stop).Path -ne $path) {
        throw "$($entry.Key) points to a different configuration. Use one fixed configuration set for the run."
      }
    }
    [Environment]::SetEnvironmentVariable($entry.Key, $path, 'Process')
  }
}

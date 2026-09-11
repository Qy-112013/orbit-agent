#requires -Version 7.1
[CmdletBinding()]
param(
  [switch]$CheckOnly,
  [string]$DeepSeekModel = 'deepseek-flash',
  [string]$RelayModel = 'glm-5.3',
  [string]$RelayBaseUrl = 'https://ps.air-outer.com',
  [string]$ClaudeCommand = 'claude'
)

$ErrorActionPreference = 'Stop'
$orbitProjectRoot = Split-Path -Parent $PSScriptRoot
$orbitNode = Get-Command node -CommandType Application -ErrorAction SilentlyContinue | Select-Object -First 1
$orbitClaude = Get-Command $ClaudeCommand -CommandType Application -ErrorAction SilentlyContinue | Select-Object -First 1
$orbitClaudePath = if ($orbitClaude) { $orbitClaude.Source } else { $null }
if (!$orbitClaudePath -and $ClaudeCommand -eq 'claude') {
  $orbitClaudeCandidates = @(
    if ($env:APPDATA) {
      Join-Path $env:APPDATA 'npm\claude.cmd'
      Join-Path $env:APPDATA 'npm\node_modules\@anthropic-ai\claude-code\bin\claude.exe'
    }
    if ($env:USERPROFILE) { Join-Path $env:USERPROFILE '.local\bin\claude.exe' }
    if ($env:LOCALAPPDATA) { Join-Path $env:LOCALAPPDATA 'Programs\Claude\claude.exe' }
  )
  $orbitClaudePath = $orbitClaudeCandidates | Where-Object { Test-Path -LiteralPath $_ -PathType Leaf } | Select-Object -First 1
}
if (!$orbitNode) { throw 'Node.js was not found. Install Node.js 25+ before starting Orbit.' }
if (!$orbitClaudePath) { throw 'Claude Code was not found in PATH or common install locations. Pass -ClaudeCommand with its .exe or .cmd path.' }
$orbitNodeVersion = & $orbitNode.Source --version
if ($LASTEXITCODE -ne 0 -or [version]($orbitNodeVersion -replace '^v', '') -lt [version]'25.0') { throw 'Node.js 25+ is required.' }
if ([string]::IsNullOrWhiteSpace($DeepSeekModel) -or [string]::IsNullOrWhiteSpace($RelayModel)) {
  throw 'Model IDs must not be empty.'
}
$orbitRelayUri = [uri]$RelayBaseUrl
if (!$orbitRelayUri.IsAbsoluteUri -or $orbitRelayUri.Scheme -ne 'https') { throw 'RelayBaseUrl must be an absolute HTTPS URL.' }

$orbitProfiles = @(
  [pscustomobject]@{ Agent = 'Atlas'; Connection = 'DeepSeek API'; Model = $DeepSeekModel; Endpoint = 'https://api.deepseek.com' }
  [pscustomobject]@{ Agent = 'Forge'; Connection = 'Claude Code CLI'; Model = $RelayModel; Endpoint = $RelayBaseUrl }
  [pscustomobject]@{ Agent = 'Lens'; Connection = 'DeepSeek API'; Model = $DeepSeekModel; Endpoint = 'https://api.deepseek.com' }
)
$orbitProfiles | Format-Table -AutoSize
Write-Host ('Claude Code command: ' + $orbitClaudePath)
if ($CheckOnly) {
  Write-Host 'Preflight complete. No keys read, no model requests sent, no environment changed.'
  return
}

$orbitDeepSeekKey = Read-Host 'DeepSeek official API key' -MaskInput
$orbitRelayKey = Read-Host 'GLM relay token (ANTHROPIC_AUTH_TOKEN)' -MaskInput
if ([string]::IsNullOrWhiteSpace($orbitDeepSeekKey) -or $orbitDeepSeekKey.Trim() -eq 'sk-' -or
    [string]::IsNullOrWhiteSpace($orbitRelayKey) -or $orbitRelayKey.Trim() -eq 'sk-') {
  throw 'Enter both complete keys in this local terminal.'
}

# Configure only this launch. Never persist keys or rewrite global CLI settings.
$orbitLaunchEnv = @{
  OPENAI_API_KEY = $orbitDeepSeekKey.Trim()
  OPENAI_BASE_URL = 'https://api.deepseek.com'
  OPENAI_MODEL = $DeepSeekModel
  ORBIT_ATLAS_PROVIDER = 'auto'
  ORBIT_ATLAS_API_KEY = $orbitDeepSeekKey.Trim()
  ORBIT_ATLAS_BASE_URL = 'https://api.deepseek.com'
  ORBIT_ATLAS_MODEL = $DeepSeekModel
  ORBIT_FORGE_PROVIDER = 'claude-code'
  ORBIT_FORGE_CLI_COMMAND = $orbitClaudePath
  ORBIT_FORGE_CLI_CWD = $orbitProjectRoot
  ORBIT_LENS_PROVIDER = 'auto'
  ORBIT_LENS_API_KEY = $orbitDeepSeekKey.Trim()
  ORBIT_LENS_BASE_URL = 'https://api.deepseek.com'
  ORBIT_LENS_MODEL = $DeepSeekModel
  ORBIT_WORKSPACE_ROOT = $orbitProjectRoot
  ORBIT_MODEL_TOOLS = '1'
  ANTHROPIC_AUTH_TOKEN = $orbitRelayKey.Trim()
  ANTHROPIC_BASE_URL = $RelayBaseUrl.TrimEnd('/')
  ANTHROPIC_MODEL = $RelayModel
  CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC = '1'
}
foreach ($orbitAlias in @('FABLE', 'HAIKU', 'OPUS', 'SONNET')) {
  $orbitLaunchEnv['ANTHROPIC_DEFAULT_' + $orbitAlias + '_MODEL'] = $RelayModel
  $orbitLaunchEnv['ANTHROPIC_DEFAULT_' + $orbitAlias + '_MODEL_NAME'] = $RelayModel
}
$orbitPreviousEnv = @{}
foreach ($orbitEnvName in $orbitLaunchEnv.Keys) {
  $orbitPreviousEnv[$orbitEnvName] = [Environment]::GetEnvironmentVariable($orbitEnvName, 'Process')
}
Push-Location -LiteralPath $orbitProjectRoot
try {
  foreach ($orbitEnvName in $orbitLaunchEnv.Keys) {
    [Environment]::SetEnvironmentVariable($orbitEnvName, $orbitLaunchEnv[$orbitEnvName], 'Process')
  }
  Write-Host 'Starting Orbit with DeepSeek + GLM. Keys are used in memory only.'
  & $orbitNode.Source --experimental-strip-types (Join-Path $orbitProjectRoot 'src/server.ts')
  if ($LASTEXITCODE -ne 0) { throw ('Orbit exited with code ' + $LASTEXITCODE) }
} finally {
  foreach ($orbitEnvName in $orbitPreviousEnv.Keys) {
    [Environment]::SetEnvironmentVariable($orbitEnvName, $orbitPreviousEnv[$orbitEnvName], 'Process')
  }
  Pop-Location
  $orbitDeepSeekKey = $null
  $orbitRelayKey = $null
}

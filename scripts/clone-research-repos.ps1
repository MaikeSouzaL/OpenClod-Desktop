param(
  [int]$MaxRepos = 0
)

$ErrorActionPreference = 'Continue'
$root = Split-Path -Parent $PSScriptRoot
$reposRoot = Join-Path $root 'repositorios'
$researchRoot = Join-Path $reposRoot '_research'
$statusPath = Join-Path $root 'docs\research\CLONE_STATUS.json'
New-Item -ItemType Directory -Force -Path $researchRoot | Out-Null

$repos = @(
  @{ category = 'agents'; url = 'https://github.com/anomalyco/opencode' },
  @{ category = 'agents'; url = 'https://github.com/All-Hands-AI/OpenHands' },
  @{ category = 'agents'; url = 'https://github.com/Aider-AI/aider' },
  @{ category = 'agents'; url = 'https://github.com/openai/codex' },
  @{ category = 'agents'; url = 'https://github.com/cline/cline' },
  @{ category = 'agents'; url = 'https://github.com/block/goose' },
  @{ category = 'agents'; url = 'https://github.com/SWE-agent/SWE-agent' },
  @{ category = 'agents'; url = 'https://github.com/OpenInterpreter/open-interpreter' },
  @{ category = 'agents'; url = 'https://github.com/QwenLM/qwen-code' },
  @{ category = 'agents'; url = 'https://github.com/Kilo-Org/kilocode' },
  @{ category = 'orchestration'; url = 'https://github.com/langchain-ai/langgraph' },
  @{ category = 'orchestration'; url = 'https://github.com/crewAIInc/crewAI' },
  @{ category = 'orchestration'; url = 'https://github.com/pydantic/pydantic-ai' },
  @{ category = 'orchestration'; url = 'https://github.com/agno-agi/agno' },
  @{ category = 'orchestration'; url = 'https://github.com/microsoft/autogen' },
  @{ category = 'mcp'; url = 'https://github.com/modelcontextprotocol/servers' },
  @{ category = 'mcp'; url = 'https://github.com/modelcontextprotocol/typescript-sdk' },
  @{ category = 'mcp'; url = 'https://github.com/modelcontextprotocol/python-sdk' },
  @{ category = 'mcp'; url = 'https://github.com/modelcontextprotocol/modelcontextprotocol' },
  @{ category = 'mcp'; url = 'https://github.com/BrethofAI/awesome-mcp-servers' },
  @{ category = 'computer-use'; url = 'https://github.com/CarlosShao/win-computer-use' },
  @{ category = 'computer-use'; url = 'https://github.com/dutuanan96/desktop-use' },
  @{ category = 'computer-use'; url = 'https://github.com/asweigart/pyautogui' },
  @{ category = 'browser'; url = 'https://github.com/browser-use/browser-use' },
  @{ category = 'browser'; url = 'https://github.com/microsoft/playwright' },
  @{ category = 'browser'; url = 'https://github.com/puppeteer/puppeteer' },
  @{ category = 'browser'; url = 'https://github.com/browserbase/stagehand' },
  @{ category = 'models'; url = 'https://github.com/BerriAI/litellm' },
  @{ category = 'models'; url = 'https://github.com/ollama/ollama' },
  @{ category = 'models'; url = 'https://github.com/ggml-org/llama.cpp' },
  @{ category = 'models'; url = 'https://github.com/vercel/ai' },
  @{ category = 'models'; url = 'https://github.com/OpenRouterTeam/typescript-sdk' },
  @{ category = 'code-analysis'; url = 'https://github.com/BurntSushi/ripgrep' },
  @{ category = 'code-analysis'; url = 'https://github.com/tree-sitter/tree-sitter' },
  @{ category = 'code-analysis'; url = 'https://github.com/ast-grep/ast-grep' },
  @{ category = 'code-analysis'; url = 'https://github.com/universal-ctags/ctags' },
  @{ category = 'code-analysis'; url = 'https://github.com/sourcegraph/scip' },
  @{ category = 'code-analysis'; url = 'https://github.com/eclipse-jdtls/eclipse.jdt.ls' },
  @{ category = 'code-analysis'; url = 'https://github.com/microsoft/language-server-protocol' },
  @{ category = 'memory'; url = 'https://github.com/mem0ai/mem0' },
  @{ category = 'memory'; url = 'https://github.com/chroma-core/chroma' },
  @{ category = 'memory'; url = 'https://github.com/qdrant/qdrant' },
  @{ category = 'memory'; url = 'https://github.com/asg017/sqlite-vec' },
  @{ category = 'memory'; url = 'https://github.com/run-llama/llama_index' },
  @{ category = 'desktop-ui'; url = 'https://github.com/electron/electron' },
  @{ category = 'desktop-ui'; url = 'https://github.com/tauri-apps/tauri' },
  @{ category = 'desktop-ui'; url = 'https://github.com/xtermjs/xterm.js' },
  @{ category = 'desktop-ui'; url = 'https://github.com/microsoft/monaco-editor' },
  @{ category = 'desktop-ui'; url = 'https://github.com/codemirror/dev' },
  @{ category = 'desktop-ui'; url = 'https://github.com/zed-industries/zed' },
  @{ category = 'desktop-ui'; url = 'https://github.com/crynta/terax-ai' },
  @{ category = 'testing'; url = 'https://github.com/promptfoo/promptfoo' },
  @{ category = 'testing'; url = 'https://github.com/confident-ai/deepeval' },
  @{ category = 'testing'; url = 'https://github.com/langfuse/langfuse' },
  @{ category = 'testing'; url = 'https://github.com/open-telemetry/opentelemetry-js' }
)

function Get-ExistingRemote {
  param([string]$Url)
  foreach ($dir in Get-ChildItem -LiteralPath $reposRoot -Directory -ErrorAction SilentlyContinue) {
    if ($dir.FullName -like "$researchRoot*") { continue }
    $remote = & git -C $dir.FullName remote get-url origin 2>$null
    if ($LASTEXITCODE -eq 0 -and (($remote -replace '\.git$', '') -replace '^http://', 'https://') -ieq ($Url -replace '\.git$', '')) {
      return $dir.FullName
    }
  }
  return $null
}

function Write-Status {
  param([object[]]$Items)
  $payload = [ordered]@{
    generatedAt = (Get-Date).ToString('o')
    total = $repos.Count
    cloned = @($Items | Where-Object { $_.state -eq 'cloned' }).Count
    existing = @($Items | Where-Object { $_.state -eq 'existing' }).Count
    failed = @($Items | Where-Object { $_.state -eq 'failed' }).Count
    items = $Items
  }
  [IO.File]::WriteAllText($statusPath, ($payload | ConvertTo-Json -Depth 8), [Text.UTF8Encoding]::new($false))
}

function Repair-Checkout {
  param([string]$Path)
  $status = & git -C $Path status --porcelain --untracked-files=no 2>$null
  if ($LASTEXITCODE -eq 0 -and -not $status) { return $true }
  & git -c core.longpaths=true -C $Path restore --source=HEAD --staged --worktree :/ *> $null
  if ($LASTEXITCODE -ne 0) { return $false }
  $status = & git -C $Path status --porcelain --untracked-files=no 2>$null
  return $LASTEXITCODE -eq 0 -and -not $status
}

function Is-OwnRepository {
  param([string]$Path)
  $top = & git -C $Path rev-parse --show-toplevel 2>$null
  if ($LASTEXITCODE -ne 0 -or -not $top) { return $false }
  $topNormalized = [IO.Path]::GetFullPath($top.Replace('/', '\')).TrimEnd('\', '/')
  $pathNormalized = [IO.Path]::GetFullPath($Path).TrimEnd('\', '/')
  return $topNormalized -ieq $pathNormalized
}

$results = @()
$limit = if ($MaxRepos -gt 0) { $MaxRepos } else { $repos.Count }
$index = 0
foreach ($repo in $repos) {
  if ($index -ge $limit) { break }
  $index++
  $url = $repo.url.TrimEnd('/')
  $name = ($url -replace '^https://github.com/', '').Replace('/', '--')
  $target = Join-Path (Join-Path $researchRoot $repo.category) $name
  $existing = Get-ExistingRemote $url
  if ($existing) {
    $commit = (& git -C $existing rev-parse HEAD 2>$null)
    $results += [ordered]@{ category = $repo.category; url = $url; path = $existing; state = 'existing'; commit = $commit }
    Write-Host "[$index/$limit] existing $url"
    Write-Status $results
    continue
  }
  if (Test-Path -LiteralPath $target) {
    if (Is-OwnRepository $target) {
      $commit = (& git -C $target rev-parse HEAD 2>$null)
      $repaired = Repair-Checkout $target
      $results += [ordered]@{ category = $repo.category; url = $url; path = $target; state = if ($repaired) { 'existing' } else { 'partial' }; commit = $commit }
      Write-Status $results
      continue
    }
    $resolvedTarget = [IO.Path]::GetFullPath($target)
    $resolvedResearch = [IO.Path]::GetFullPath($researchRoot).TrimEnd('\', '/') + [IO.Path]::DirectorySeparatorChar
    if (-not $resolvedTarget.StartsWith($resolvedResearch, [StringComparison]::OrdinalIgnoreCase)) {
      throw "Recusa ao limpar clone fora da área de pesquisa: $resolvedTarget"
    }
    Write-Host "  removing incomplete checkout $target"
    Remove-Item -LiteralPath $target -Recurse -Force
  }
  New-Item -ItemType Directory -Force -Path (Split-Path -Parent $target) | Out-Null
  Write-Host "[$index/$limit] cloning $url"
  $env:GIT_TERMINAL_PROMPT = '0'
  & git -c core.longpaths=true clone --depth 1 --filter=blob:none --single-branch -- $url $target 2>&1 | ForEach-Object { Write-Host "  $_" }
  if ($LASTEXITCODE -eq 0) {
    $commit = (& git -C $target rev-parse HEAD 2>$null)
    $license = Get-ChildItem -LiteralPath $target -File -ErrorAction SilentlyContinue | Where-Object { $_.Name -match '^(LICENSE|COPYING|NOTICE)' } | Select-Object -First 1 -ExpandProperty Name
    $results += [ordered]@{ category = $repo.category; url = $url; path = $target; state = 'cloned'; commit = $commit; licenseFile = $license }
  } else {
    $hasRepo = Test-Path -LiteralPath (Join-Path $target '.git')
    $results += [ordered]@{ category = $repo.category; url = $url; path = $target; state = if ($hasRepo) { 'partial' } else { 'failed' }; error = "git clone exit $LASTEXITCODE" }
  }
  Write-Status $results
}

Write-Status $results
Write-Host "Status: $statusPath"

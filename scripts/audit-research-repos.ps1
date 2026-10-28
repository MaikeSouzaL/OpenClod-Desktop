$ErrorActionPreference = 'Continue'
$root = Split-Path -Parent $PSScriptRoot
$statusPath = Join-Path $root 'docs\research\CLONE_STATUS.json'
$outPath = Join-Path $root 'docs\research\REPOSITORY_INVENTORY_2026-10-25.md'
$status = Get-Content -Raw -LiteralPath $statusPath | ConvertFrom-Json
$interesting = '^(src|source|packages|crates|core|agent|agents|tools|tool|mcp|memory|browser|computer|desktop|ui|app|server|client|runtime|providers|models|tests|test|docs|skills|plugins|commands|commands|workflows|graph|router|providers|dataset|eval|evaluation|observability|protocol|protocols|sdk|spec|specification)$'

function Escape-Md([string]$value) {
  return ($value -replace '\|', '\|' -replace '\r?\n', ' ')
}

$rows = foreach ($item in ($status.items | Sort-Object category, url)) {
  if ($item.state -notin @('existing', 'cloned')) { continue }
  $path = [string]$item.path
  $license = Get-ChildItem -LiteralPath $path -File -ErrorAction SilentlyContinue |
    Where-Object { $_.Name -match '^(LICENSE|COPYING|NOTICE)' } |
    Select-Object -First 1 -ExpandProperty Name
  $manifests = Get-ChildItem -LiteralPath $path -File -ErrorAction SilentlyContinue |
    Where-Object { $_.Name -in @('package.json','pyproject.toml','Cargo.toml','go.mod','pom.xml','build.gradle','build.gradle.kts','mix.exs','Gemfile','CMakeLists.txt') } |
    Select-Object -ExpandProperty Name
  $dirs = Get-ChildItem -LiteralPath $path -Directory -ErrorAction SilentlyContinue |
    Where-Object { $_.Name -match $interesting } |
    Select-Object -First 10 -ExpandProperty Name
  $files = & git -C $path ls-files 2>$null
  $languages = @($files) | ForEach-Object {
    $ext = [IO.Path]::GetExtension($_).ToLowerInvariant()
    if ($ext) { $ext.TrimStart('.') }
  } | Where-Object { $_ -in @('ts','tsx','js','jsx','py','rs','go','java','kt','cs','swift','c','cc','cpp','h','hpp','rb','php','ex','exs','lua') } |
    Group-Object | Sort-Object Count -Descending | Select-Object -First 3 | ForEach-Object { "$($_.Name)($($_.Count))" }
  [pscustomobject]@{
    Category = $item.category
    Url = $item.url
    Path = $path
    Commit = if ($item.commit) { ([string]$item.commit).Substring(0, [Math]::Min(10, ([string]$item.commit).Length)) } else { '' }
    License = if ($license) { $license } else { 'AUSENTE/NÃO ENCONTRADA' }
    Languages = $languages -join ', '
    Manifests = $manifests -join ', '
    Candidates = $dirs -join ', '
  }
}

$lines = [Collections.Generic.List[string]]::new()
$lines.Add('# Inventário de repositórios — 2026-10-25')
$lines.Add('')
$lines.Add('Clones rasos (`--depth 1`, filtro `blob:none`) em `repositorios/_research/<categoria>/`.')
$lines.Add('Commits são os HEADs examinados. A presença de uma licença não autoriza copiar código sem cumprir seus termos; licença ausente permanece apenas como referência conceitual.')
$lines.Add('')
$lines.Add("Total mapeado: **$($status.total)**. Presentes: **$($status.existing + $status.cloned)**. Falhas: **$($status.failed)**.")
$lines.Add('')
$lines.Add('Os links originais `crynta/terax` e `open-telemetry/opentelemetry` não existem. Foram substituídos pelos repositórios oficiais atuais `crynta/terax-ai` e `open-telemetry/opentelemetry-js`.')
$lines.Add('')
$lines.Add('| Categoria | Projeto | Commit | Licença | Linguagens | Manifestos | Módulos candidatos |')
$lines.Add('|---|---|---|---|---|---|---|')
foreach ($row in $rows) {
  $name = [IO.Path]::GetFileName($row.Path)
  $relative = [IO.Path]::GetRelativePath((Join-Path $root 'docs\research'), $row.Path).Replace('\', '/')
  $lines.Add("| $(Escape-Md $row.Category) | [$name]($relative) · $($row.Url) | $($row.Commit) | $(Escape-Md $row.License) | $(Escape-Md $row.Languages) | $(Escape-Md $row.Manifests) | $(Escape-Md $row.Candidates) |")
}
$lines.Add('')
$lines.Add('## Critério de aproveitamento')
$lines.Add('')
$lines.Add('- MIT, Apache-2.0, BSD e ISC: permitem adaptação com atribuição e aviso de licença quando aplicável.')
$lines.Add('- Projetos sem licença ou proprietários: somente comportamento observável e conceitos independentes; nenhum código copiado.')
$lines.Add('- A integração atual prioriza TypeScript/Node para evitar sidecars. Código Go/Rust/Python é avaliado por módulo e pode virar binário auxiliar ou porta seletiva, nunca uma dependência de runtime sem necessidade.')
[IO.File]::WriteAllLines($outPath, $lines, [Text.UTF8Encoding]::new($false))
Write-Host "Inventário: $outPath"

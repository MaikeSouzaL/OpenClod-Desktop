#!/usr/bin/env node
/**
 * Harvests portable assets (skills, agents, commands, prompts) from the study
 * clones into `resources/harvested/`, so the clones can be deleted without
 * losing the prompts and definitions we want to learn from.
 *
 * It deliberately does NOT copy whole codebases: only Markdown/YAML assets that
 * are portable between harnesses. Code is ported selectively to src/core with
 * its own provenance entry.
 *
 * Usage: node scripts/harvest-research-assets.mjs
 */
import crypto from 'node:crypto'
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'

const ROOT = process.cwd()
const REPOS_ROOT = path.join(ROOT, 'repositorios')
const OUT = path.join(ROOT, 'resources', 'harvested')
const SKIP_DIRS = new Set([
  'node_modules',
  '.git',
  'target',
  'dist',
  'build',
  'release',
  'out',
  '.next',
  '.venv',
  '__pycache__',
  '.cache',
  '.turbo',
  'coverage'
])
const DENY_REPOS = new Set([
  'zed-industries--zed', // GPL-3.0 in most crates; Apache only in a few
  'claw-code-local', // no LICENSE file
  'Mcp.ComputerUse', // no LICENSE file
  'wisprflow' // proprietary
])
const ALLOWED_LICENSES = new Set(['MIT', 'Apache-2.0', 'BSD', 'ISC'])
const MAX_ASSET_BYTES = 256 * 1024

/**
 * High-value tool implementations that are worth reading after the clones are
 * deleted. They are copied as reference only; nothing here is compiled.
 */
const TOOL_CANDIDATES = [
  {
    id: 'apply-patch',
    repo: 'OpenInterpreter--open-interpreter',
    source: 'repositorios/_research/agents/OpenInterpreter--open-interpreter/codex-rs/core/assets/tools/apply_patch.lark',
    license: 'Apache-2.0',
    destination: 'src/core/tools/apply-patch/',
    status: 'queued'
  },
  {
    id: 'apply-patch-spec',
    repo: 'OpenInterpreter--open-interpreter',
    source: 'repositorios/_research/agents/OpenInterpreter--open-interpreter/codex-rs/core/src/tools/handlers/apply_patch_spec.rs',
    license: 'Apache-2.0',
    destination: 'src/core/tools/apply-patch/',
    status: 'queued'
  },
  {
    id: 'repo-map',
    repo: 'Aider-AI--aider',
    source: 'repositorios/_research/agents/Aider-AI--aider/aider/repomap.py',
    license: 'Apache-2.0',
    destination: 'src/core/code-intelligence/repomap.ts',
    status: 'queued'
  },
  {
    id: 'prior-read',
    repo: 'QwenLM--qwen-code',
    source: 'repositorios/_research/agents/QwenLM--qwen-code/packages/core/src/tools/priorReadEnforcement.ts',
    license: 'Apache-2.0',
    destination: 'src/core/tools/prior-read.ts',
    status: 'queued'
  },
  {
    id: 'shell-arity',
    repo: 'Kilo-Org--kilocode',
    source: 'repositorios/_research/agents/Kilo-Org--kilocode/packages/opencode/src/permission/arity.ts',
    license: 'MIT',
    destination: 'src/core/permissions/arity.ts',
    status: 'queued'
  },
  {
    id: 'tool-output-truncate',
    repo: 'Kilo-Org--kilocode',
    source: 'repositorios/_research/agents/Kilo-Org--kilocode/packages/opencode/src/tool/truncate.ts',
    license: 'MIT',
    destination: 'src/core/tools/truncate.ts',
    status: 'queued'
  },
  {
    id: 'submit-review',
    repo: 'SWE-agent--SWE-agent',
    source: 'repositorios/_research/agents/SWE-agent--SWE-agent/tools/review_on_submit_m/bin/submit',
    license: 'MIT',
    destination: 'src/core/tools/submit-review.ts',
    status: 'queued'
  },
  {
    id: 'mcp-stdio-lifecycle',
    repo: 'modelcontextprotocol--python-sdk',
    source: 'repositorios/_research/mcp/modelcontextprotocol--python-sdk/src/mcp/client/stdio.py',
    license: 'MIT',
    destination: 'src/core/mcp/transport/stdio.ts',
    status: 'queued'
  },
  {
    id: 'mcp-streamable-http',
    repo: 'modelcontextprotocol--typescript-sdk',
    source: 'repositorios/_research/mcp/modelcontextprotocol--typescript-sdk/packages/client/src/client/streamableHttp.ts',
    license: 'Apache-2.0',
    destination: 'src/core/mcp/transport/http.ts',
    status: 'queued'
  },
  {
    id: 'mcp-path-guard',
    repo: 'modelcontextprotocol--servers',
    source: 'repositorios/_research/mcp/modelcontextprotocol--servers/src/filesystem/path-validation.ts',
    license: 'MIT',
    destination: 'src/core/security/path-guard.ts',
    status: 'queued'
  },
  {
    id: 'mcp-fetch-guard',
    repo: 'modelcontextprotocol--servers',
    source: 'repositorios/_research/mcp/modelcontextprotocol--servers/src/fetch/src/mcp_server_fetch/server.py',
    license: 'MIT',
    destination: 'src/core/browser/fetch-guard.ts',
    status: 'queued'
  },
  {
    id: 'provider-retry',
    repo: 'vercel--ai',
    source: 'repositorios/_research/models/vercel--ai/packages/ai/src/util/retry-with-exponential-backoff.ts',
    license: 'Apache-2.0',
    destination: 'src/core/providers/http.ts',
    status: 'queued'
  },
  {
    id: 'tool-call-parser',
    repo: 'ggml-org--llama.cpp',
    source: 'repositorios/_research/models/ggml-org--llama.cpp/common/chat-auto-parser.h',
    license: 'MIT',
    destination: 'src/core/providers/tool-parse.ts',
    status: 'queued'
  },
  {
    id: 'eval-trajectory',
    repo: 'promptfoo--promptfoo',
    source: 'repositorios/_research/testing/promptfoo--promptfoo/src/assertions/trajectory.ts',
    license: 'MIT',
    destination: 'src/core/eval/assertions/trajectory.ts',
    status: 'queued'
  },
  {
    id: 'observability-taxonomy',
    repo: 'langfuse--langfuse',
    source: 'repositorios/_research/testing/langfuse--langfuse/packages/shared/src/domain/observations.ts',
    license: 'MIT',
    destination: 'src/core/observability/types.ts',
    status: 'queued'
  },
  {
    id: 'browser-snapshot',
    repo: 'browserbase--stagehand',
    source: 'repositorios/_research/browser/browserbase--stagehand/packages/extension/understudy/a11y/snapshot/capture.ts',
    license: 'MIT',
    destination: 'src/core/browser/snapshot/capture.ts',
    status: 'queued'
  },
  {
    id: 'browser-element-identity',
    repo: 'browser-use--browser-use',
    source: 'repositorios/_research/browser/browser-use--browser-use/browser_use/dom/views.py',
    license: 'MIT',
    destination: 'src/core/browser/element-identity.ts',
    status: 'queued'
  },
  {
    id: 'pty-flow-control',
    repo: 'crynta--terax-ai',
    source: 'repositorios/_research/desktop-ui/crynta--terax-ai/src-tauri/src/modules/pty/output.rs',
    license: 'Apache-2.0',
    destination: 'src/main/terminal/flow.ts',
    status: 'queued'
  },
  {
    id: 'keymap',
    repo: 'asweigart--pyautogui',
    source: 'repositorios/_research/computer-use/asweigart--pyautogui/pyautogui/_pyautogui_win.py',
    license: 'BSD',
    destination: 'src/core/computer/keymap.ts',
    status: 'queued'
  },
  {
    id: 'computer-settle',
    repo: 'munim-computer-use',
    source: 'repositorios/munim-computer-use/windows-linux/src/settle.rs',
    license: 'Apache-2.0',
    destination: 'src/core/computer/settle.ts',
    status: 'ported'
  },
  {
    id: 'operation-state-machine',
    repo: 'block--goose',
    source: 'repositorios/_research/agents/block--goose/crates/goose-agent/src/machine.rs',
    license: 'Apache-2.0',
    destination: 'src/core/agent/state-machine.ts',
    status: 'queued'
  },
  {
    id: 'exec-policy',
    repo: 'openai--codex',
    source: 'repositorios/_research/agents/openai--codex/codex-rs/execpolicy/src/policy.rs',
    license: 'Apache-2.0',
    destination: 'src/core/security/exec-policy.ts',
    status: 'queued'
  },
  {
    id: 'durable-operation',
    repo: 'pydantic--pydantic-ai',
    source: 'repositorios/_research/orchestration/pydantic--pydantic-ai/pydantic_ai_slim/pydantic_ai/durable_exec/_operation.py',
    license: 'MIT',
    destination: 'src/core/session/run-journal.ts',
    status: 'queued'
  },
  {
    id: 'memory-extraction',
    repo: 'mem0ai--mem0',
    source: 'repositorios/_research/memory/mem0ai--mem0/mem0/memory/main.py',
    license: 'Apache-2.0',
    destination: 'src/core/memory/extract.ts',
    status: 'queued'
  },
  {
    id: 'memory-waterfall',
    repo: 'run-llama--llama_index',
    source: 'repositorios/_research/memory/run-llama--llama_index/llama-index-core/llama_index/core/memory/memory.py',
    license: 'MIT',
    destination: 'src/core/agent/compaction.ts',
    status: 'queued'
  }
]

function listRepos() {
  const repos = []
  for (const entry of fs.readdirSync(REPOS_ROOT, { withFileTypes: true })) {
    if (!entry.isDirectory() || entry.name === '_research') continue
    repos.push({ name: entry.name, dir: path.join(REPOS_ROOT, entry.name), category: 'root' })
  }
  const research = path.join(REPOS_ROOT, '_research')
  for (const category of fs.readdirSync(research, { withFileTypes: true })) {
    if (!category.isDirectory()) continue
    for (const repo of fs.readdirSync(path.join(research, category.name), { withFileTypes: true })) {
      if (repo.isDirectory()) {
        repos.push({
          name: repo.name,
          dir: path.join(research, category.name, repo.name),
          category: category.name
        })
      }
    }
  }
  return repos
}

function licenseInfo(dir) {
  let files = []
  try {
    files = fs.readdirSync(dir).filter((file) => /^(LICENSE|COPYING|LICENCE)/i.test(file))
  } catch {
    return { spdx: 'NOASSERTION', file: null }
  }
  if (!files.length) return { spdx: 'NOASSERTION', file: null }
  const file = files[0]
  const text = fs.readFileSync(path.join(dir, file), 'utf8').slice(0, 40_000)
  let spdx = 'UNKNOWN'
  if (/GNU AFFERO/i.test(text)) spdx = 'AGPL'
  else if (/GNU GENERAL PUBLIC/i.test(text)) spdx = 'GPL'
  else if (/Eclipse Public License/i.test(text)) spdx = 'EPL'
  else if (/Apache License/i.test(text)) spdx = 'Apache-2.0'
  else if (/Mozilla Public/i.test(text)) spdx = 'MPL-2.0'
  else if (/MIT License|Permission is hereby granted, free of charge/i.test(text)) spdx = 'MIT'
  else if (/Redistribution and use in source and binary forms/i.test(text)) spdx = 'BSD'
  else if (/\bISC\b/.test(text)) spdx = 'ISC'
  return { spdx, file }
}

function commit(dir) {
  try {
    return execFileSync('git', ['-C', dir, 'rev-parse', 'HEAD'], { encoding: 'utf8', timeout: 10_000 }).trim()
  } catch {
    return ''
  }
}

function walk(dir, visit) {
  let entries
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true })
  } catch {
    return
  }
  for (const entry of entries) {
    if (entry.isDirectory()) {
      if (SKIP_DIRS.has(entry.name)) continue
      walk(path.join(dir, entry.name), visit)
    } else if (entry.isFile()) {
      visit(path.join(dir, entry.name))
    }
  }
}

function frontmatterField(text, key) {
  const header = text.startsWith('---') ? text.slice(3, text.indexOf('\n---', 3)) : ''
  const match = new RegExp(`^${key}:\\s*(.+)$`, 'im').exec(header)
  return match?.[1]?.trim().replace(/^["']|["']$/g, '') ?? ''
}

function slugify(value) {
  const slug = value
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 64)
  return slug || 'asset'
}

function qualityOf(rel) {
  if (/(^|\/)(tests?|fixtures?|snapshots?)(\/|$)/i.test(rel)) return 'test'
  if (/(^|\/)(examples?|samples?)(\/|$)/i.test(rel)) return 'example'
  return 'production'
}

/** Copies a skill folder (SKILL.md plus references/scripts/assets) with size limits. */
function copySkillDir(srcDir, destDir, skipped) {
  const files = []
  const visit = (dir) => {
    let entries
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true })
    } catch {
      return
    }
    for (const entry of entries) {
      if (entry.isSymbolicLink()) continue
      const full = path.join(dir, entry.name)
      if (entry.isDirectory()) {
        if (SKIP_DIRS.has(entry.name)) continue
        visit(full)
        continue
      }
      if (!entry.isFile() || entry.name === '.DS_Store') continue
      let stat
      try {
        stat = fs.statSync(full)
      } catch {
        continue
      }
      if (stat.size > 1024 * 1024) {
        skipped.push({ source: path.relative(ROOT, full).replaceAll('\\', '/'), reason: 'arquivo de apoio grande' })
        continue
      }
      const rel = path.relative(srcDir, full).replaceAll('\\', '/')
      const target = path.join(destDir, rel)
      fs.mkdirSync(path.dirname(target), { recursive: true })
      fs.copyFileSync(full, target)
      files.push(rel)
    }
  }
  visit(srcDir)
  return files
}

function kindOf(repo, file) {
  const rel = path.relative(repo.dir, file).replaceAll('\\', '/')
  const lower = rel.toLowerCase()
  if (path.basename(file) === 'SKILL.md') return { kind: 'skill', rel }
  if (/(^|\/)ee(\/|$)/i.test(rel) || /(^|\/)enterprise(\/|$)/i.test(rel)) return null
  if (path.extname(file).toLowerCase() !== '.md') {
    if (/(^|\/)(microagents?|prompts?)(\/|$)/i.test(rel) && /\.(md|txt)$/i.test(file)) {
      return { kind: 'prompt', rel }
    }
    if (/(^|\/)(sweagent\/config|recipes)(\/|$)/i.test(rel) && /\.(ya?ml)$/i.test(file)) {
      return { kind: 'prompt', rel }
    }
    return null
  }
  const agentPath =
    /(^|\/)(agents?|subagents?)(\/|$)/i.test(rel) &&
    !/(^|\/)(docs?|pages|tests?|fixtures?|snapshots?)(\/|$)/i.test(lower)
  if (agentPath && !/\.prompt\.md$/i.test(rel)) {
    if (!/^(readme|agents|changelog|license|test_log)/i.test(path.basename(file))) {
      const text = fs.readFileSync(file, 'utf8').slice(0, 12_000)
      if (/^---/.test(text)) {
        const end = text.indexOf('\n---', 3)
        const body = end >= 0 ? text.slice(end + 4).trim() : ''
        const loadable = Boolean(body && frontmatterField(text, 'description'))
        return { kind: 'agent', rel, loadable }
      }
    }
  }
  if (/\/(\.claude|\.qwen|\.kilo|\.opencode|\.codex)\/commands?\//i.test(rel) || /\/(commands?)\//i.test(rel)) {
    if (!/(^|\/)(docs?|tests?|fixtures?|snapshots?)(\/|$)/i.test(lower)) {
      if (!/^(readme|agents|changelog|license)/i.test(path.basename(file))) return { kind: 'command', rel }
    }
  }
  if (/(^|\/)(microagents?|prompts?)(\/|$)/i.test(rel) && !/(^|\/)(docs?|tests?|fixtures?|snapshots?)(\/|$)/i.test(lower)) {
    return { kind: 'prompt', rel }
  }
  return null
}

function main() {
  if (!fs.existsSync(REPOS_ROOT)) throw new Error(`pasta de clones não encontrada: ${REPOS_ROOT}`)
  fs.rmSync(OUT, { recursive: true, force: true })
  fs.mkdirSync(OUT, { recursive: true })

  const repos = listRepos()
  const manifest = {
    generatedAt: new Date().toISOString(),
    sourceRoot: 'repositorios',
    outputRoot: 'resources/harvested',
    rules: {
      licensesAllowed: [...ALLOWED_LICENSES],
      deniedRepos: [...DENY_REPOS],
      maxAssetBytes: MAX_ASSET_BYTES,
      note: 'Arquivo de referência. O runtime carrega resources/skills e resources/agents; o restante não é auto-carregado.'
    },
    repositories: [],
    items: [],
    duplicates: [],
    skipped: []
  }
  const used = new Map()
  const seenHash = new Map()
  const repoSummaries = []

  for (const repo of repos) {
    const license = licenseInfo(repo.dir)
    const summary = {
      name: repo.name,
      category: repo.category,
      commit: commit(repo.dir),
      license: license.spdx,
      licenseFile: license.file,
      counts: { skills: 0, agents: 0, commands: 0, prompts: 0 }
    }
    const allowed = !DENY_REPOS.has(repo.name) && ALLOWED_LICENSES.has(license.spdx)
    if (!allowed) {
      summary.skippedReason = `licença ${license.spdx}`
      repoSummaries.push(summary)
      continue
    }
    const repoSlug = slugify(repo.name)
    const licenseDest = license.file
      ? path.join(OUT, 'LICENSES', `${repoSlug}--${license.file}`)
      : null
    if (licenseDest) {
      fs.mkdirSync(path.dirname(licenseDest), { recursive: true })
      fs.copyFileSync(path.join(repo.dir, license.file), licenseDest)
    }
    for (const notice of fs.readdirSync(repo.dir).filter((file) => /^NOTICE/i.test(file))) {
      const source = path.join(repo.dir, notice)
      if (!fs.statSync(source).isFile()) continue
      const dest = path.join(OUT, 'LICENSES', `${repoSlug}--${notice}`)
      fs.copyFileSync(source, dest)
    }

    walk(repo.dir, (file) => {
      const classified = kindOf(repo, file)
      if (!classified) return
      let stat
      try {
        stat = fs.statSync(file)
      } catch {
        return
      }
      if (stat.size > MAX_ASSET_BYTES) {
        manifest.skipped.push({ repo: repo.name, source: path.relative(ROOT, file), reason: 'arquivo grande' })
        return
      }
      const bytes = fs.readFileSync(file)
      const hash = crypto.createHash('sha256').update(bytes).digest('hex')
      const key = `${classified.kind}:${hash}`
      if (seenHash.has(key)) {
        manifest.duplicates.push({
          repo: repo.name,
          source: path.relative(ROOT, file),
          duplicateOf: seenHash.get(key)
        })
        return
      }
      seenHash.set(key, path.relative(ROOT, file))

      const text = classified.kind === 'skill' || classified.kind === 'agent' ? bytes.toString('utf8').slice(0, 16_000) : ''
      const fallback = path.basename(path.dirname(file))
      const rawName =
        (classified.kind === 'skill' || classified.kind === 'agent' ? frontmatterField(text, 'name') : '') ||
        (classified.kind === 'command' ? path.basename(file, '.md') : fallback)
      const baseSlug = slugify(rawName)
      let slug = baseSlug
      for (let index = 2; used.has(`${classified.kind}:${slug}`); index += 1) slug = `${baseSlug}-${index}`
      used.set(`${classified.kind}:${slug}`, true)

      let dest
      let supportFiles
      if (classified.kind === 'skill') {
        const dir = path.join(OUT, 'skills', slug)
        supportFiles = copySkillDir(path.dirname(file), dir, manifest.skipped)
        dest = path.join(dir, 'SKILL.md')
      } else if (classified.kind === 'agent') {
        dest = path.join(OUT, classified.loadable ? 'agents' : 'agents-raw', `${slug}.md`)
      } else if (classified.kind === 'command') {
        dest = path.join(OUT, 'commands', `${slug}.md`)
      } else {
        dest = path.join(OUT, 'prompts', repoSlug, classified.rel)
      }
      fs.mkdirSync(path.dirname(dest), { recursive: true })
      if (classified.kind !== 'skill') fs.writeFileSync(dest, bytes)
      summary.counts[`${classified.kind}s`] += 1
      manifest.items.push({
        kind: classified.kind,
        name: rawName,
        slug,
        dest: path.relative(ROOT, dest).replaceAll('\\', '/'),
        source: path.relative(ROOT, file).replaceAll('\\', '/'),
        repo: repo.name,
        category: repo.category,
        commit: summary.commit,
        license: license.spdx,
        quality: qualityOf(classified.rel),
        loadable: classified.kind === 'agent' ? Boolean(classified.loadable) : undefined,
        files: supportFiles,
        sha256: hash
      })
    })
    repoSummaries.push(summary)
  }

  manifest.repositories = repoSummaries
  const tools = []
  for (const candidate of TOOL_CANDIDATES) {
    const source = path.join(ROOT, candidate.source)
    if (!fs.existsSync(source)) {
      manifest.skipped.push({ repo: candidate.repo, source: candidate.source, reason: 'arquivo de ferramenta não encontrado' })
      continue
    }
    const dest = path.join(OUT, 'tools', 'sources', candidate.id, path.basename(source))
    fs.mkdirSync(path.dirname(dest), { recursive: true })
    fs.copyFileSync(source, dest)
    tools.push({
      id: candidate.id,
      repo: candidate.repo,
      source: candidate.source,
      dest: path.relative(ROOT, dest).replaceAll('\\', '/'),
      license: candidate.license,
      destination: candidate.destination,
      status: candidate.status
    })
  }
  manifest.tools = tools
  fs.mkdirSync(path.join(OUT, 'tools'), { recursive: true })
  fs.writeFileSync(
    path.join(OUT, 'tools', 'catalog.json'),
    `${JSON.stringify({ generatedAt: manifest.generatedAt, tools }, null, 2)}\n`
  )
  fs.writeFileSync(
    path.join(OUT, 'tools', 'README.md'),
    `# Catálogo de ferramentas para portar

Cópias de referência das implementações mais valiosas encontradas nos clones.
Elas **não são compiladas**: servem para ler e portar para \`src/core\` quando a
fatia correspondente for implementada.

| Ferramenta | Origem | Licença | Destino no harness | Estado |
|---|---|---|---|---|
${tools
  .map((tool) => `| \`${tool.id}\` | \`${tool.repo}\` | ${tool.license} | \`${tool.destination}\` | ${tool.status} |`)
  .join('\n')}

O estado \`ported\` significa que já existe uma adaptação nossa; \`queued\` é a
fila de portas seletivas. O código original completo continua no repositório de
origem até a porta ser feita; a cópia aqui preserva o arquivo decisivo.
`
  )
  manifest.totals = manifest.items.reduce(
    (acc, item) => {
      const key = item.kind === 'skill' ? 'skills' : item.kind === 'agent' ? 'agents' : item.kind === 'command' ? 'commands' : 'prompts'
      acc[key] += 1
      acc.all += 1
      return acc
    },
    { skills: 0, agents: 0, commands: 0, prompts: 0, all: 0 }
  )
  manifest.totals.tools = tools.length
  fs.writeFileSync(path.join(OUT, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`)
  const readme = `# Assets colhidos dos repositórios de estudo

Gerado por \`scripts/harvest-research-assets.mjs\` em ${manifest.generatedAt}.

Este diretório existe para que os clones em \`repositorios/\` possam ser
apagados sem perder os prompts, skills, agentes e comandos que valem estudo.
Ele **não é carregado automaticamente** pelo harness: o runtime lê apenas
\`resources/skills\` (skills curadas) e \`resources/agents\` (agentes curados).

## Conteúdo

| Tipo | Quantidade |
|---|---:|
| skills | ${manifest.totals.skills} |
| agents | ${manifest.totals.agents} |
| commands | ${manifest.totals.commands} |
| prompts | ${manifest.totals.prompts} |
| tools (referência) | ${manifest.totals.tools} |
| **total de assets** | **${manifest.totals.all}** |

- \`manifest.json\`: origem, commit, licença, hash, qualidade e destino de cada
  item.
- \`LICENSES/\`: texto integral da licença de cada repositório que contribuiu.
- \`skills/\`, \`agents/\`, \`commands/\`, \`prompts/\`: cópias fiéis dos assets.

## Licenças

Só entram repos com MIT, Apache-2.0, BSD ou ISC. Ficaram de fora, por licença:

${repoSummaries.filter((repo) => repo.skippedReason).map((repo) => `- \`${repo.name}\`: ${repo.skippedReason}`).join('\n') || '- nenhum'}

Pastas \`ee/\` e \`enterprise/\` são ignoradas. \`zed\`, \`claw-code-local\`,
\`Mcp.ComputerUse\` e \`wisprflow\` nunca são copiados.

## Como usar

1. Para consultar: leia o \`SKILL.md\` ou o manifesto.
2. Para promover uma skill ao runtime: copie para \`resources/skills/<nome>/SKILL.md\`,
   ajuste o frontmatter (\`name\`, \`description\`) e registre a origem.
3. Para promover um agente: copie para \`resources/agents/<nome>.md\` e valide o
   frontmatter com o loader.
4. Código (Rust/Go/Python) não é copiado inteiro. Portas seletivas vão para
   \`src/core\` com entrada em \`docs/research/CODE_PROVENANCE.md\`.
`
  fs.writeFileSync(path.join(OUT, 'README.md'), readme)
  console.log(JSON.stringify(manifest.totals, null, 2))
  console.log(`manifest: ${path.relative(ROOT, path.join(OUT, 'manifest.json'))}`)
}

main()

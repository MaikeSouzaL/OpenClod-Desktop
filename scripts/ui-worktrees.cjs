// End-to-end check for the worktree manager in the packaged renderer/main IPC.
// It uses a throwaway Electron profile and a disposable Git repository. NO model is called: the sessions are
// created on the default (real) provider of the profile, but no turn is ever sent, so no key is needed.
//
//   node scripts/ui-worktrees.cjs [outDir]
const { execFileSync } = require('node:child_process')
const fs = require('node:fs')
const path = require('node:path')
const e2e = require('./lib/e2e.cjs')

const OUT = path.resolve(process.argv[2] && !process.argv[2].startsWith('--') ? process.argv[2] : path.join(e2e.ROOT, 'Prints', 'worktrees-2026-10-25'))
const PORT = 9341
fs.mkdirSync(OUT, { recursive: true })

async function main() {
  const ws = e2e.makeWorkspace({ prefix: 'openclod-worktree-e2e-' })
  const repo = ws.project
  fs.writeFileSync(path.join(repo, 'README.md'), '# Worktree fixture\n\nBase limpa.\n')
  const git = (...args) => execFileSync('git', args, { cwd: repo, encoding: 'utf8', windowsHide: true })
  git('init', '-b', 'main')
  git('config', 'user.name', 'Openclod E2E')
  git('config', 'user.email', 'openclod-e2e@example.invalid')
  git('add', 'README.md')
  git('commit', '-m', 'fixture')

  // A fresh profile initializes the local memory engine before creating the BrowserWindow; the first run can
  // take roughly a minute, which `launch` already tolerates.
  const app = await e2e.launch({ port: PORT, ...ws })
  const { page } = app
  try {
    const setup = await page.evaluate(async (folder) => {
      const settingsResult = await window.openclod.app.settings()
      if (!settingsResult.ok) return { error: settingsResult.error }
      const settings = settingsResult.value
      const provider = settings.providers.find((item) => item.id === settings.defaultProviderId) || settings.providers[0]
      if (!provider) return { error: 'nenhum provedor configurado' }
      const projectResult = await window.openclod.projects.add(folder, 'Projeto worktree E2E')
      if (!projectResult.ok) return { error: projectResult.error }
      const remembered = await window.openclod.app.rememberModel(provider.id, provider.model)
      if (!remembered.ok) return { error: remembered.error }
      return { projectId: projectResult.value.id, projectPath: projectResult.value.path, providerId: provider.id, model: provider.model }
    }, repo)
    if (setup.error) throw new Error(setup.error)

    const ipcProbe = await page.evaluate(async ({ folder, projectId, providerId, model }) => {
      const probeBranch = `openclod/ipc-probe-${Date.now().toString(36)}`
      const created = await window.openclod.git.createWorktree(folder, probeBranch)
      if (!created.ok) return { error: created.error, stage: 'create-worktree' }
      const session = await window.openclod.sessions.create({
        projectId,
        cwd: created.value.path,
        mode: 'code',
        surface: 'code',
        providerId,
        model,
        title: 'IPC worktree probe'
      })
      return {
        stage: session.ok ? 'ok' : 'create-session',
        error: session.ok ? undefined : session.error,
        worktree: created.value,
        projects: (await window.openclod.projects.list()).value.map((project) => ({ id: project.id, path: project.path })),
        session: session.ok ? session.value : undefined
      }
    }, { folder: repo, projectId: setup.projectId, providerId: setup.providerId, model: setup.model })
    if (ipcProbe.error) throw new Error(`IPC probe failed at ${ipcProbe.stage}: ${ipcProbe.error}; ${JSON.stringify({ worktree: ipcProbe.worktree, projects: ipcProbe.projects })}`)

    await page.reload()
    await page.waitForSelector('.app-shell', { timeout: 30_000 })
    await page.reload()
    await page.waitForSelector('.app-shell', { timeout: 30_000 })
    await page.locator('nav.side-nav .side-row', { hasText: 'Projetos' }).click()
    await page.waitForSelector('.project-card')
    await page.locator('.project-card').first().locator('button[title="Mais opções"]').click()
    await page.locator('.menu-item', { hasText: 'Worktrees e sessão isolada' }).click()
    await page.waitForSelector('.worktree-modal')
    await page.screenshot({ path: path.join(OUT, '01-worktree-manager.png'), fullPage: true })

    const branch = `openclod/e2e-${Date.now().toString(36)}`
    await page.locator('.worktree-create label', { hasText: 'Nova branch' }).locator('input').fill(branch)
    await page.locator('.worktree-create button', { hasText: 'Criar e abrir sessão' }).click()
    await page.waitForTimeout(2500)
    if (await page.locator('.worktree-modal').count()) {
      const error = (await page.locator('.worktree-modal .inline-error').allTextContents()).join(' | ')
      const dialog = await page.locator('.worktree-modal').innerText()
      const globalError = (await page.locator('.error-bar').allTextContents()).join(' | ')
      await page.screenshot({ path: path.join(OUT, 'failed-create.png'), fullPage: true })
      throw new Error(`worktree session creation failed: ${error || globalError || dialog}`)
    }
    await page.waitForSelector('.worktree-modal', { state: 'detached', timeout: 30_000 })
    await page.waitForTimeout(1000)

    const result = await page.evaluate(async ({ projectId, branch }) => {
      const listed = await window.openclod.git.listWorktrees((await window.openclod.projects.list()).value.find((project) => project.id === projectId).path)
      if (!listed.ok) return { error: listed.error }
      const sessions = await window.openclod.sessions.list()
      if (!sessions.ok) return { error: sessions.error }
      const session = sessions.value.find(
        (item) => item.meta.projectId === projectId && item.meta.cwd.toLowerCase().includes(branch.replaceAll('/', '-').toLowerCase())
      )
      return {
        worktrees: listed.value.map((item) => ({ path: item.path, branch: item.branch, isMain: item.isMain })),
        session: session ? { id: session.meta.id, projectId: session.meta.projectId, cwd: session.meta.cwd, branch, providerId: session.meta.providerId, model: session.meta.model } : null
      }
    }, { projectId: setup.projectId, branch })
    if (result.error) throw new Error(result.error)
    if (result.worktrees.length < 2 || !result.worktrees.some((item) => item.branch === branch && !item.isMain)) {
      throw new Error(`unexpected worktree list: ${JSON.stringify(result.worktrees)}`)
    }
    if (!result.session || result.session.projectId !== setup.projectId || !result.session.cwd.toLowerCase().includes(`${path.sep}.openclod${path.sep}worktrees${path.sep}`)) {
      throw new Error(`session did not inherit the worktree: ${JSON.stringify(result.session)}`)
    }
    if (result.session.providerId !== setup.providerId) {
      throw new Error(`worktree session did not use the default provider (${setup.providerId}): ${JSON.stringify(result.session)}`)
    }

    const removed = await page.evaluate(async ({ projectId, target }) => {
      const project = (await window.openclod.projects.list()).value.find((item) => item.id === projectId)
      return window.openclod.git.removeWorktree(project.path, target)
    }, { projectId: setup.projectId, target: result.worktrees.find((item) => item.branch === branch).path })
    if (!removed.ok) throw new Error(`remove failed: ${removed.error}`)

    const evidence = { ok: true, modelCalls: 0, branch, ...result, removed: removed.value.path, errors: app.errors }
    fs.writeFileSync(path.join(OUT, 'evidence.json'), JSON.stringify(evidence, null, 2))
    console.log(JSON.stringify(evidence, null, 2))
  } finally {
    app.cleanup()
  }
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error(error instanceof Error ? error.stack || error.message : String(error))
    process.exit(1)
  })

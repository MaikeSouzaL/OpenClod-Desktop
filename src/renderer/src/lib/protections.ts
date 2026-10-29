import type { PolicyConfig } from '../../../shared/types'

export interface Protection {
  /** The protection is in force in this mode. */
  on: boolean
  text: string
}

/**
 * What really protects the session, read from the permission mode and the policy. The panel used to show four fixed ✓,
 * also in the mode that turns them off. Mirrors the core: permissions.ts (confirmations and the secret-file guard, both
 * skipped by `unrestricted`), policy.ts checkCommand (the destructive-command blocklist, off in `unrestricted`) and the
 * orchestrator (`fullAccess || unrestricted` opens every folder).
 */
export function protectionsFor(policy: Pick<PolicyConfig, 'mode' | 'fullAccess'> | null | undefined): Protection[] {
  const mode = policy?.mode ?? 'ask'
  const bypass = mode === 'unrestricted'
  const anyFolder = bypass || policy?.fullAccess === true
  const confirmations =
    mode === 'readonly'
      ? 'Somente leitura: escrever e executar é negado'
      : mode === 'ask'
        ? 'Pede aprovação para editar e executar'
        : mode === 'accept-edits'
          ? 'Edita sem perguntar; comandos pedem aprovação'
          : mode === 'auto'
            ? 'Executa sem perguntar; destrutivos pedem confirmação'
            : 'Sem confirmações do harness'
  return [
    { on: !bypass, text: confirmations },
    { on: !anyFolder, text: anyFolder ? 'Acesso a qualquer pasta do computador' : 'Raiz restrita à pasta do projeto' },
    { on: !bypass, text: bypass ? 'Comandos destrutivos não são bloqueados' : 'Comandos destrutivos bloqueados' },
    { on: !bypass, text: bypass ? 'Arquivos de segredo podem ser lidos' : 'Arquivos de segredo protegidos' },
    // Storage and logging do not depend on the mode.
    { on: true, text: 'Chaves do app cifradas com DPAPI' },
    { on: true, text: 'Trilha de auditoria da sessão' }
  ]
}

# Repositórios de estudo

Clones rasos (`--depth 1`) dos projetos citados no prompt mestre, mais o
`munim-computer-use`, usados para estudar implementações e portar apenas o que
for compatível. Nenhum deles é dependência do Openclod: o build (`tsconfig*`,
`vitest.config.ts`, `electron-builder.yml`) não enxerga esta pasta, e o
`.gitignore` exclui os clones.

## Estrutura

| Local | Conteúdo |
|---|---|
| `repositorios/_research/<categoria>/` | **54 clones** organizados em 10 categorias |
| `repositorios/opencode/` | OpenCode completo (MIT) |
| `repositorios/munim-computer-use/` | Backend de Computer Use (Apache-2.0), adicionado em 2026-10-26 |
| `repositorios/{cdesktop,openharness,rea,deepseek-harness}` | Estudos iniciais (Apache/MIT) |
| `repositorios/open-computer-use/` | Backend opcional de Computer Use (MIT) |
| `repositorios/{ai-memory,wisprflow}/` | Memória e ditado (MIT / proprietário) |
| `repositorios/{claw-code-local,Mcp.ComputerUse}/` | **Sem arquivo LICENSE** — só referência conceitual |

Total: **56 repositórios de estudo** + os clones auxiliares acima, cerca de
8 GB. O inventário com URL, commit, licença, linguagens e módulos candidatos
está em [`docs/research/REPOSITORY_INVENTORY_2026-10-25.md`](../docs/research/REPOSITORY_INVENTORY_2026-10-25.md).

## Onde está a análise

- Estudo por repositório: [`docs/research/estudos/`](../docs/research/estudos/_INDEX.md)
- Matriz de reúso: [`docs/research/CODE_REUSE_MATRIX.md`](../docs/research/CODE_REUSE_MATRIX.md)
- Procedência do código portado: [`docs/research/CODE_PROVENANCE.md`](../docs/research/CODE_PROVENANCE.md)
- Comparação com o harness: [`docs/research/GAP_ANALYSIS.md`](../docs/research/GAP_ANALYSIS.md)

## Licenças

| Grupo | Regra |
|---|---|
| MIT / Apache-2.0 / BSD / ISC | reutilizar com aviso de copyright + texto da licença; indicar alterações no Apache-2.0 |
| `universal-ctags` (GPL-2.0), `zed` (GPL-3.0 em parte), `eclipse.jdt.ls` (EPL-2.0) | não copiar código; usar como serviço/binário ou reimplementar |
| `langfuse` (MIT + `ee/`) | só usar fora das pastas `ee/` |
| `claw-code-local`, `Mcp.ComputerUse` (sem licença) | nenhum código; apenas conceito |

## Manutenção dos clones

```powershell
# atualizar um clone raso
git -C repositorios/_research/<categoria>/<repo> fetch --depth 1
git -C repositorios/_research/<categoria>/<repo> reset --hard origin/HEAD

# histórico completo de um clone
git -C repositorios/<repo> fetch --unshallow

# recriar o inventário
.\scripts\clone-research-repos.ps1 -MaxRepos 55
.\scripts\audit-research-repos.ps1
```

Os assets portáveis (skills, agentes, comandos, prompts e 25 fontes de
ferramentas) foram copiados para `resources/harvested/`, com licença e
procedência. Os clones podem ser apagados depois da revisão; o que o runtime usa
está em `resources/skills/` e `resources/agents/`.

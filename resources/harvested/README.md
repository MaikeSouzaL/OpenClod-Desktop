# Assets colhidos dos repositórios de estudo

Gerado por `scripts/harvest-research-assets.mjs` em 2026-10-29T17:16:36.362Z.

Este diretório existe para que os clones em `repositorios/` possam ser
apagados sem perder os prompts, skills, agentes e comandos que valem estudo.
Ele **não é carregado automaticamente** pelo harness: o runtime lê apenas
`resources/skills` (skills curadas) e `resources/agents` (agentes curados).

## Conteúdo

| Tipo | Quantidade |
|---|---:|
| skills | 387 |
| agents | 21 |
| commands | 23 |
| prompts | 168 |
| tools (referência) | 25 |
| **total de assets** | **599** |

- `manifest.json`: origem, commit, licença, hash, qualidade e destino de cada
  item.
- `LICENSES/`: texto integral da licença de cada repositório que contribuiu.
- `skills/`, `agents/`, `commands/`, `prompts/`: cópias fiéis dos assets.

## Licenças

Só entram repos com MIT, Apache-2.0, BSD ou ISC. Ficaram de fora, por licença:

- `claw-code-local`: licença NOASSERTION
- `Mcp.ComputerUse`: licença NOASSERTION
- `wisprflow`: licença NOASSERTION
- `eclipse-jdtls--eclipse.jdt.ls`: licença GPL
- `universal-ctags--ctags`: licença GPL
- `zed-industries--zed`: licença Apache-2.0
- `microsoft--autogen`: licença UNKNOWN

Pastas `ee/` e `enterprise/` são ignoradas. `zed`, `claw-code-local`,
`Mcp.ComputerUse` e `wisprflow` nunca são copiados.

## Como usar

1. Para consultar: leia o `SKILL.md` ou o manifesto.
2. Para promover uma skill ao runtime: copie para `resources/skills/<nome>/SKILL.md`,
   ajuste o frontmatter (`name`, `description`) e registre a origem.
3. Para promover um agente: copie para `resources/agents/<nome>.md` e valide o
   frontmatter com o loader.
4. Código (Rust/Go/Python) não é copiado inteiro. Portas seletivas vão para
   `src/core` com entrada em `docs/research/CODE_PROVENANCE.md`.

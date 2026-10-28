# Estudos por repositório — índice

Estudo individual dos **56 clones** de `repositorios/`, com foco em **como cada
um funciona** e no que serve de modelo para o Openclod.

- Método: leitura estática do código-fonte, com caminho e linha.
- Template: [`_TEMPLATE.md`](./_TEMPLATE.md)
- Inventário: [`../REPOSITORY_INVENTORY_2026-10-25.md`](../REPOSITORY_INVENTORY_2026-10-25.md)
- Matriz de reúso consolidada: [`../CODE_REUSE_MATRIX.md`](../CODE_REUSE_MATRIX.md)
- Procedência do que foi portado: [`../CODE_PROVENANCE.md`](../CODE_PROVENANCE.md)

## Categorias

| Categoria | Repos | Pasta | Estado |
|---|---:|---|---|
| agents | 10 | [`agents/`](./agents/) | concluído |
| orchestration | 5 | [`orchestration/`](./orchestration/) | concluído |
| mcp | 5 | [`mcp/`](./mcp/) | concluído |
| computer-use | 4 | [`computer-use/`](./computer-use/) | concluído |
| browser | 4 | [`browser/`](./browser/) | concluído |
| models | 5 | [`models/`](./models/) | concluído |
| code-analysis | 7 | [`code-analysis/`](./code-analysis/) | concluído |
| memory | 5 | [`memory/`](./memory/) | concluído |
| desktop-ui | 7 | [`desktop-ui/`](./desktop-ui/) | concluído |
| testing | 4 | [`testing/`](./testing/) | concluído |
| **total** | **56** | — | **concluído** |

O 56º repositório é `munim-computer-use`, adicionado fora da lista original do
prompt mestre. O estudo dele está em
[`computer-use/munim-computer-use.md`](./computer-use/munim-computer-use.md).

## Critério de leitura

1. Entrypoint e comandos reais.
2. Loop do agente e chamada de ferramenta.
3. Contexto, sessão e persistência.
4. Permissões, sandbox e erros.
5. Testes.
6. O que portar, o que rejeitar e por quê.

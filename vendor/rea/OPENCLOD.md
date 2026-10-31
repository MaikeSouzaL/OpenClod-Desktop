# REA dentro do Openclod

Esta pasta é uma cópia do código-fonte do REA (Reverse Engineer Anything), https://github.com/morluto/rea, licença MIT
(`LICENSE`, Copyright (c) 2026 morluto).

- Versão: 6.8.0, tag `rea-agents-6.8.0`, commit `160d821ac9a0310afcb8d1fc427862dd6508add5`.
- Sem modificações nos arquivos copiados.
- Ficaram de fora, por tamanho ou por não fazerem parte do que roda: `website/`, `tests/` (fixtures da suíte do REA),
  `experiments/`, `docs/verification`, `docs/releases`, `docs/readme` (traduções do README), `docs/assets` (imagens),
  `.github/`, `.husky/` e `.agents/`. Os submódulos de `third_party/` (jadx-headless-mcp, binwalk, unblob, wakaru,
  ghidra-nativeaot) não vêm no clone raso; o REA os trata como ferramentas externas.

Como o Openclod usa esta pasta:

- `src/core/rea/policy.ts` importa `src/contracts/toolEffects.ts` daqui: a aprovação de cada ferramenta segue a auditoria
  de efeitos do próprio REA.
- `scripts/embed-rea.mjs` instala as dependências de produção pelo `package-lock.json` daqui e recusa rodar se este
  `package.json` for de outra versão que a embutida em `resources/rea/app` (o pacote oficial do npm da mesma tag, com o
  componente nativo do Windows já compilado).

Detalhes: `docs/REA-ENGINEERING.md`.

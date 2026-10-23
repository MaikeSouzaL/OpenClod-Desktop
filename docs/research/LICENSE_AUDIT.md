# Auditoria de licenças

Data: 2026-10-23. Licenças verificadas na API do GitHub (`license.spdx_id`) e
pela presença/ausência do arquivo `LICENSE` no repositório.

## Projetos avaliados

| Projeto | SPDX | Obrigações | Risco | Uso no Forja |
|---|---|---|---|---|
| cdesktop | Apache-2.0 | aviso de copyright, NOTICE, indicar alterações, concessão de patente | baixo | referência (sem código copiado) |
| OpenHarness | MIT | aviso de copyright + texto da licença | baixo | referência (sem código copiado) |
| REA | MIT | idem | baixo | ferramenta de análise (não distribuída) |
| OpenCode | MIT | idem | baixo | referência |
| DeepSeek Harness | MIT | idem | baixo | referência |
| Claw Code Local | **nenhuma** | all rights reserved | **alto** | **nenhum código usado** |
| Mcp.ComputerUse | **nenhuma** | all rights reserved | **alto** | **nenhum código usado** |
| open-computer-use | MIT | aviso + texto | baixo | **dependência opcional em runtime** (instalada pelo usuário, não empacotada) |
| Playwright | Apache-2.0 | aviso, NOTICE | baixo | dependência npm empacotada |
| Electron | MIT | aviso | baixo | runtime |
| React / Vite / Zod / marked / dompurify / diff | MIT | aviso | baixo | dependências npm |

## Constatações

1. **Claw Code Local não declara licença.** `GET /repos/codetwentyfive/claw-code-local/license`
   retorna 404 e a raiz do repositório não contém `LICENSE`. Ausência de licença
   significa reserva total de direitos: **nenhum código foi lido para cópia ou
   adaptação**. O projeto aparece apenas como referência de paridade funcional.
2. **Mcp.ComputerUse não declara licença.** O próprio README diz "Code license:
   not set yet". Também não foi reutilizado. As decisões técnicas sobre DPI e
   remapeamento de coordenadas foram implementadas de forma independente, a
   partir da documentação pública de Win32 (`GetDpiForMonitor`, `SendInput`,
   `MOUSEEVENTF_VIRTUALDESK`).
3. **cdesktop é Apache-2.0.** Um fork seria legalmente possível, mas foi
   descartado por motivos técnicos. Se algum trecho for reaproveitado no futuro,
   é obrigatório manter `NOTICE` e indicar as alterações.
4. **open-computer-use é MIT** e é instalado globalmente pelo usuário
   (`npm i -g @opensymph/open-computer-use`). Não é empacotado no instalador;
   o Forja o detecta em runtime e degrada graciosamente quando ausente.
5. **Nenhum código proprietário foi utilizado.** A análise do Claude Desktop
   com REA produziu identificadores estruturais (contagens de endpoints, rotas,
   binds) e nenhum texto de código-fonte foi copiado para este repositório.

## Dependências transitivas

| Dependência | Licença | Observação |
|---|---|---|
| Chromium (via Electron) | BSD-3 + componentes | arquivo `LICENSES.chromium.html` deve acompanhar o instalador |
| Node.js (via Electron) | MIT | — |
| Playwright | Apache-2.0 | empacotado; baixa navegadores só se o usuário pedir |
| zod-to-json-schema | ISC | — |
| marked | MIT | — |
| dompurify | MPL-2.0 OR Apache-2.0 | escolha Apache-2.0 para compatibilidade |
| diff (jsdiff) | BSD-3-Clause | — |

**Riscos de cadeia de suprimentos:** todas as dependências acima são pacotes
npm populares e mantidos. O instalador deve gerar um SBOM (`npm sbom`) e o
`THIRD_PARTY_NOTICES.md` deve ser regenerado no build de release.

## Regras aplicadas neste repositório

- Nenhum código de projeto sem licença foi copiado.
- Nenhum aviso de copyright foi removido.
- Nenhum controle de licença ou autenticação foi contornado.
- A análise do app original foi limitada a comportamento observável, sem
  engenharia reversa de mecanismos de proteção.

# Template de estudo por repositório

> Copie a estrutura abaixo. Toda afirmação precisa de **caminho + linha**.
> Não conclua nada a partir do README: confirme no código.
> Não altere arquivos fora de `docs/research/estudos/`.
> Não instale dependências, não rode build/testes dos clones. Análise estática.

---

# <nome do projeto>

| Campo | Valor |
|---|---|
| Repositório | <URL> |
| Clone local | `repositorios/...` |
| Commit | `<sha completo>` |
| Licença | <SPDX + arquivo> |
| Categoria | <agents/orchestration/mcp/...> |
| Stack | <linguagens + frameworks + gerenciador> |
| Tamanho | <arquivos, linhas aproximadas> |

## 1. O que é (verificado no código)

<3–8 linhas. O que o programa faz de fato, qual problema resolve, qual é o
entrypoint real. Se o README divergir do código, diga.>

## 2. Como executar e comandos reais

| Comando / script | Onde está | O que faz |
|---|---|---|
| `...` | `package.json:12` / `src/main.ts:40` | ... |

Liste a superfície de CLI/UX: subcomandos, flags, atalhos, slash commands,
endpoints, IPC. Se houver 100 comandos, agrupe por família e cite os principais.

## 3. Arquitetura e fluxo

```
<entrypoint> → <loop> → <provider> → <tool> → <estado>
```

- Entry point: `arquivo:linha`
- Loop do agente: `arquivo:linha`
- Execução de ferramenta: `arquivo:linha`
- Streaming: `arquivo:linha`
- Persistência: `arquivo:linha`

## 4. Catálogo de ferramentas / capacidades

| Ferramenta / capacidade | Arquivo:linha | O que faz | Risco |
|---|---|---|---|
| ... | ... | ... | baixo/médio/alto |

## 5. Loop do agente, contexto e streaming

<Como monta o prompt, como decide chamar ferramenta, como trata resultado,
como compacta contexto, como cancela, como faz retry. Cite linhas.>

## 6. Sessões, estado e persistência

<Formato, local, versionamento, retomada, fork, checkpoint. Cite linhas.>

## 7. Configuração e extensibilidade

<Arquivos de config, precedência, plugins, hooks, MCP, skills, agentes.>

## 8. Permissões, sandbox e erros

<Como aprova, como bloqueia, como isola, como reporta falha. Cite linhas.>

## 9. Testes e qualidade

| Suíte | Onde | O que cobre |
|---|---|---|
| ... | ... | ... |

## 10. O que vale portar

| Módulo | Origem (arquivo:linha) | Por que é melhor | Licença | Destino proposto | Score |
|---|---|---|---|---|---|
| ... | ... | ... | ... | `src/...` | 0–25 |

## 11. O que NÃO vale portar

| Item | Motivo |
|---|---|
| ... | stack incompatível / licença / já temos melhor / sem testes |

## 12. Modelo de exemplo para o nosso harness

<Desenho concreto: o que copiar como padrão, quais interfaces, quais nomes,
como testar. Sem código inventado.>

## 13. Evidências da análise

```text
<comandos de leitura usados e trechos exatos>
```

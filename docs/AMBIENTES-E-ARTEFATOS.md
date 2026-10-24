# Ambientes e artefatos

## Ambientes de execução

O seletor de ambiente fica no rodapé do composer (ao lado do modo de
permissão). A escolha é salva na sessão (`SessionMeta.environment`) e vale para
`run_command`, `start_process`, `list_ports` e para os subagentes daquela
sessão.

Perfis padrão:

| Perfil | Como executa |
| --- | --- |
| `Local` | `cmd.exe`/shell desta máquina, com `cwd` do projeto |
| `WSL` | `wsl.exe [--distro] --cd <cwd> bash -lc "<comando>"` |
| `SSH` | `<command> "<cd remoteCwd && comando>"`, por exemplo `ssh deploy@host` |
| `Cloud` | o mesmo enquadramento do SSH, para `docker exec`, jump box etc. |

Configuração em **Personalização → Permissões → Ambientes de execução** (JSON):

```json
[
  { "id": "local", "label": "Local", "kind": "local" },
  { "id": "wsl", "label": "WSL", "kind": "wsl", "distro": "Ubuntu" },
  { "id": "prod", "label": "Produção", "kind": "ssh", "command": "ssh deploy@host", "remoteCwd": "/srv/app" }
]
```

Ferramentas de arquivo continuam no disco local; o ambiente roteia comandos.
Para editar arquivos remotos, use o terminal/SSH do próprio ambiente.

## Artefatos

**Artefatos** lista os arquivos reais da pasta do projeto (`.md`, `.html`,
`.svg`, `.csv`, `.json`, código etc.), ignorando `node_modules`, `.git`,
`dist`, `out`, `build`, `release`, `.next` e `coverage`.

Ao abrir um arquivo:

- editor CodeMirror com syntax highlight (Markdown, HTML, CSS, JS/TS, JSON,
  Python);
- preview de Markdown, HTML, SVG, CSV (tabela) e JSON formatado;
- modos **Editor**, **Preview** e **Dividido**;
- salvar no disco, abrir no Explorer e indicador de alterações não salvas.

É o editor de artefatos do harness: documentos, protótipos HTML e painéis podem
ser editados e vistos sem sair do app.

# REA Engineering (engenharia reversa)

O Openclod traz o [REA](https://github.com/morluto/rea) (Reverse Engineer Anything, MIT) dentro do harness. Não é
preciso instalar Node, REA nem configurar servidor MCP: o modo **REA Engineering** e o agente `rea-engineer` usam o REA
embutido e os motores que ele dirige.

## Como usar

1. Numa sessão, clique em **+** no compositor → **Modo do agente** → **REA Engineering**.
2. Peça a análise com o caminho absoluto do alvo. Por exemplo: "como funciona a busca do app em `C:\...\app`, com
   evidência?", "descompile a função de licença de `C:\...\programa.exe`" ou "quais classes do APK falam com a rede?".
3. O agente escolhe a ferramenta pelo tipo do alvo. Cada conclusão cita a evidência do REA (`ev_...`).

Os outros modos não carregam o REA. O **Autônomo** e o **Loop Engineering** podem chamar o agente `rea-engineer`, e as
ferramentas `rea_*` aparecem para eles no `tool_search`.

## O que fica onde

| Parte | Onde | No Git |
|---|---|---|
| Código-fonte do REA 6.8.0 | `vendor/rea` (tag `rea-agents-6.8.0`, commit `160d821`) | sim |
| Adaptação ao harness | `src/core/rea/` (`layer`, `tools`, `policy`, `engines`, `catalog`, `names`) | sim |
| REA compilado + dependências | `resources/rea/app` (pacote oficial do npm, sha512 conferido) | não (script) |
| Node.js 24.22.2 | `resources/rea/node` | não (script) |
| Motores | `resources/rea/engines/<id>` | não (script) |
| Catálogo de ferramentas | `resources/rea/catalog.json` (gerado do `tools/list` do REA embutido) | não (script) |
| Estado e hashes | `resources/rea/openclod-rea.json` | não (script) |

O que não vai para o Git é recriado por:

```powershell
node scripts/embed-rea.mjs                                   # Node + REA + catálogo + motores padrão
node scripts/embed-rea.mjs --cache "C:\Users\<você>\Desktop\REA\downloads"   # reaproveita zips já baixados (hash conferido)
node scripts/embed-rea.mjs --only rizin                      # motor opcional
node scripts/embed-rea.mjs --check                           # confere cada árvore contra openclod-rea.json
node scripts/embed-rea.mjs --list
```

O script não aceita rodar se `vendor/rea/package.json` for de outra versão. Atualizar o REA é trocar os dois juntos: o
código em `vendor/rea` e as constantes `REA` do script (tarball, integridade, commit e hash do componente nativo).

### Por que um Node próprio

O REA 6.8 exige Node `^22.23.4 || ^24.22.1 || >=26.12.1`, e o Electron 45 traz o Node 24.22.0. Por isso o REA roda com
o Node 24.22.2 oficial em `resources/rea/node`, e não com o Node do Electron. O Frida, o node-pty e o componente nativo
do Windows (`rea-windows-x64.node`) carregam nesse Node.

## Motores

| Motor | Versão | Situação | Habilita |
|---|---|---|---|
| Ghidra | 12.1.4 | embutido | descompilação, funções, pseudocódigo, xrefs (o REA 6.8 aceita só a linha 12.1.x) |
| JDK (Temurin) | 21.0.13+9 | embutido | Java do Ghidra, do JADX e do Apktool |
| jadx-headless-mcp | 0.7.1 | embutido | classes e métodos de APK/DEX (o REA fixa o SHA-256 dessa versão) |
| Apktool | 3.0.3 | embutido | recursos e manifesto de APK (com um `apktool.cmd` próprio) |
| WABT | 1.0.42 | embutido | WebAssembly (o REA exige exatamente 1.0.42) |
| Frida | 17.23.2 | embutido (dependência npm do REA) | instrumentação em execução |
| rizin | 0.9.1 | opcional (`--only rizin`, LGPL com oferta de código) | comandos rizin avulsos |
| ADB | — | detectado (SDK do Android Studio) | aparelho Android; a licença do SDK proíbe redistribuir |
| Navegador | — | detectado (Chrome ou Edge) | resolução de módulos web |
| tshark/capinfos | — | detectado (Wireshark instalado) | resumo de capturas pcap |
| GNU objdump | — | detectado | desmontagem com objdump |
| IDA, JEB | — | do usuário (`REA_IDA_MCP_CONFIG`, `REA_JEB_MCP_URL`) | provedores comerciais |
| Kuna, wakaru, binwalk, unblob, NativeAOT | — | o REA recusa no Windows | — |

A ordem de busca de cada motor é: o embutido, depois uma instalação do usuário (a pasta `Desktop\REA` com
`rea-local.json`, o SDK e o JBR do Android Studio, Chrome/Edge, Wireshark). `rea_status` mostra o resultado sem iniciar
o REA.

Os motores embutidos aumentam o instalador em cerca de 1,3 GB descompactados (Ghidra ~875 MB, JDK ~330 MB, REA ~300 MB
com o Frida, Node ~90 MB).

## Ferramentas

Cada ferramenta do REA vira `rea_<nome>`: `open_binary` vira `rea_open_binary`. O catálogo do 6.8.0 tem 229 ferramentas
em 11 famílias: nativo, artefatos, web/JavaScript/Electron, Android, Apple, ADB, .NET, Frida, depuradores, capturas e
evidências. Elas ficam fora de cada requisição até serem usadas: chamar pelo nome carrega a ferramenta, e
`tool_search "rea"` lista as outras. A skill oficial do REA (`reverse-engineer-anything`) também é carregada, direto do
pacote embutido.

Um resultado completo do REA é um único JSON e pode passar de 100 KB, mesmo para um app pequeno. O cliente MCP do REA
não corta a saída (`REA_MAX_OUTPUT_TOKENS` em `src/core/rea/layer.ts`): quem cuida do tamanho é o runner, que guarda o
resultado inteiro num arquivo que o `read_file` lê e mostra ao modelo o começo, o fim e o caminho. Antes dessa correção,
o corte no meio deixava o JSON ilegível, e o arquivo guardado também saía cortado.

O servidor do REA só sobe na primeira chamada `rea_*`. Ele fica vivo enquanto o app está aberto, porque as sessões do
Ghidra e do Frida moram nele, e reinicia sozinho na próxima chamada se cair. Cada chamada pode levar até 12 minutos (a
primeira importação no Ghidra leva minutos), e o vigia de ferramentas travadas respeita esse prazo.

## Segurança

A aprovação de cada ferramenta vem da **auditoria de efeitos do próprio REA** (`vendor/rea/src/contracts/toolEffects.ts`,
importada direto do código copiado), e não de uma lista de nomes:

| O REA declara que a ferramenta… | No Openclod |
|---|---|
| executa código que o REA não controla (Frida, depuradores, cenários capturados), altera o aparelho (instalar/desinstalar APK, enviar arquivo, iniciar/parar app), aciona a interface de um app, ou altera um processo/página em execução | **sempre pede aprovação**, em todos os modos, inclusive Automático e Ignorar permissões |
| grava onde o chamador mandar (`output_directory`, `overwrite`) ou edita o banco de análise (nomes, comentários, marcadores) | risco de escrita: segue o modo de permissão, como `write_file` |
| usa a rede ou a ponte do aparelho sem alterar nada | risco de rede |
| só lê o alvo | liberada |

Uma ferramenta que a auditoria não conhece (um REA mais novo que a cópia) é tratada como a mais arriscada.

O que o REA lê do alvo (strings, código, nomes, páginas, logs) chega ao modelo com um aviso na primeira linha: é dado,
nunca instrução. Só as ferramentas que o REA marca como livres de conteúdo do alvo (`TARGET_CONTENT_FREE_TOOLS`) vêm
sem o aviso.

O prompt do modo e o do agente trazem o aviso de uso responsável do REA: análise legítima de software que o usuário
pode examinar. Burlar DRM, licença, anti-cheat, autenticação ou controles de acesso fica de fora.

## Verificação

```powershell
npx vitest run tests/rea-engineering.test.ts     # política, modo, agente, ferramentas, motores, cópia
npx tsx scripts/rea-real.ts --ghidra             # REA embutido de verdade, sem janela: JS, PE, WASM, Apktool, APK (JADX), Ghidra
node scripts/ui-rea.cjs --root <snapshot> --provider opencode-go --model deepseek-v4.1-flash
```

O `rea-real.ts` usa um app JavaScript de teste criado na hora, o `where.exe` do Windows, um módulo WebAssembly escrito
byte a byte e o APK de exemplo que vem com o Android Studio. O `ui-rea.cjs` roda na janela real com perfil descartável e
modelo real:

1. a opção no menu muda a sessão para o modo `rea`;
2. o modelo analisa o app de teste e o executável com as ferramentas `rea_*` e responde citando a evidência;
3. o roteiro confere por fora a função, o canal IPC e uma DLL importada de verdade;
4. pede para anexar o Frida a um processo node de teste aberto pelo roteiro: a aprovação aparece mesmo em Ignorar
   permissões, o roteiro nega e confere que o Frida não rodou.

Na primeira rodada, o pedido era instalar um APK falso. O modelo conferiu com `rea_list_adb_devices` que não havia
aparelho e com `rea_inspect_android_package` que o arquivo não era APK. Depois recusou inventar o serial obrigatório, e a
chamada de risco nunca aconteceu. Por isso o roteiro usa o Frida num processo que existe.

As provas ficam em `Prints/rea-engineering-<data>/`. Rodada de 2026-10-30 (OpenCode Go, deepseek-v4.1-flash): 19/19
checagens em 243 s. O modelo achou `searchNotes` em `src/search.js`, o canal `notes:search` e DLLs reais do `where.exe`,
citando as evidências. A aprovação de `rea_start_frida_session` apareceu em Ignorar permissões e foi negada.

## Limites conhecidos

- O Ghidra no Windows é o escopo "P0" do REA: leitura de PE x86/x64/ARM e 6502 bruto. Anotações no banco do Ghidra
  (renomear, comentar) não estão disponíveis no Windows.
- `inspect_packet_*`, firmware (binwalk/unblob), wakaru, Kuna e sessões gdb/rizin persistentes são só para Linux no REA 6.8.
- A Camada `rea-auto` da pasta `Desktop\REA` (relatórios HTML/MD por alvo) não foi portada: ela foi escrita para o REA
  6.4.0, e o 6.8 mudou contratos (por exemplo, `analyze_function` agora devolve um resumo por padrão).

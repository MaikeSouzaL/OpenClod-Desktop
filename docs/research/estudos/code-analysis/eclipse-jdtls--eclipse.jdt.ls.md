# Eclipse JDT Language Server (eclipse.jdt.ls)

| Campo | Valor |
|---|---|
| Repositório | https://github.com/eclipse-jdtls/eclipse.jdt.ls |
| Clone local | `repositorios/_research/code-analysis/eclipse-jdtls--eclipse.jdt.ls` |
| Commit | `6d1e57a2b1752adff9bfa767668cf4e78809b625` |
| Licença | **EPL-2.0** (`LICENSE:1`) — copyleft fraco por arquivo; código não é portável para nós |
| Categoria | code-analysis / language server (Java) |
| Stack | Java 21, OSGi/Eclipse RCP, Tycho/Maven, `org.eclipse.lsp4j` 1.x, JDT core compiler, m2e, Buildship |
| Tamanho | 1.828 arquivos, ~157k linhas; `org.eclipse.jdt.ls.core` com ~1.209 linhas só em `JDTLanguageServer.java` e 92 arquivos em `handlers/` |

## 1. O que é (verificado no código)

Um language server LSP completo para Java, construído **em cima do compilador do Eclipse
(JDT)** e de um workspace Eclipse real. Não reimplementa resolução de nomes: usa
`IJavaProject`/`ITypeRoot`/`SearchEngine` do JDT.

O entrypoint é uma aplicação Eclipse: `LanguageServerApplication.start` chama
`JavaLanguageServerPlugin.startLanguageServer(this)`, que cria o `JDTLanguageServer`
(`org.eclipse.jdt.ls.core/src/.../handlers/JDTLanguageServer.java:296` para `initialize`).
O plugin registra três extension points próprios (`plugin.xml:4-7`): handlers de comando,
*importers* de projeto e *build supports*.

O README fala de "Java language server"; o código mostra algo mais amplo: importação de
Maven/Gradle/Eclipse, classpath, decompilação (FernFlower), geração de código e ~35
comandos `java.*` (`plugin.xml:53-154`).

## 2. Como executar e comandos reais

| Comando / script | Onde está | O que faz |
|---|---|---|
| `mvnw verify` (Tycho) | `pom.xml:102` | build + testes do RCP |
| `java -jar org.eclipse.jdt.ls.product/...` | `LanguageServerApplication.java:44` | sobe o servidor via stdio |
| `-data <workspace>` | `JDTLanguageServer`/`JavaLanguageServerPlugin` | define o workspace Eclipse em disco |
| `java.project.import` | `plugin.xml:101` | importa projetos do workspace |
| `java.project.updateClassPaths` | `plugin.xml:86` | recalcula classpath |
| `java.project.getClasspaths` | `plugin.xml:83` | devolve classpath (consumido por clientes) |
| `java.project.isTestFile` | `plugin.xml:92` | classifica arquivo de teste |
| `java.project.refreshDiagnostics` | `plugin.xml:98` | força recompilação e reenvio de diagnósticos |
| `java.decompile` | `plugin.xml:137` | abre `.class` via FernFlower |
| `java.navigate.openTypeHierarchy` | `plugin.xml:110` | hierarquia de tipos no cliente |
| `java.edit.organizeImports` | `plugin.xml:56` | organize imports sem passar por code action |

Superfície: ~35 comandos (`plugin.xml:53-154`), 92 arquivos em `handlers/` e preferências extensas (`Preferences.java`), além das
capacidades LSP padrão.

## 3. Arquitetura e fluxo

```
stdin/stdout (LSP) → JDTLanguageServer (lsp4j)
  → InitHandler.registerCapabilities (handlers/InitHandler.java:118)
    → TextDocumentService → Handler (ex.: ReferencesHandler)
      → JDTUtils.resolveCompilationUnit → IJavaProject/ITypeRoot (JDT core)
        → SearchEngine / ASTParser / LTK refactoring
          → WorkspaceEdit | DocumentSymbol[] | Diagnostic[]
```

- Entry point: `LanguageServerApplication.start` (`.../LanguageServerApplication.java:44`).
- Bootstrap: `JavaLanguageServerPlugin.startLanguageServer`
  (`.../JavaLanguageServerPlugin.java`), `JDTLanguageServer.java:296` (`initialize`).
- Modelo de projeto: `ProjectsManager.initializeProjects`
  (`.../managers/ProjectsManager.java:115`) e `updateWorkspaceFolders` (`:291`).
- Importação: importers em `plugin.xml:156-175` (Gradle order 300, Maven 400, Eclipse 1000,
  invisible project 1500).
- Navegação: `NavigateToDefinitionHandler` (209 linhas), `ReferencesHandler` (212),
  `NavigateToTypeDefinitionHandler` (112), `ImplementationCollector` (257).
- Diagnóstico: `DiagnosticsHandler` (80) + `WorkspaceDiagnosticsHandler` (570) publicam via
  `connection.publishDiagnostics` (`WorkspaceDiagnosticsHandler.java:203`).
- Rename: `RenameHandler` (91) delega ao LTK (`RenameHandler.java:84`).

## 4. Catálogo de ferramentas / capacidades

| Ferramenta / capacidade | Arquivo:linha | O que faz | Risco |
|---|---|---|---|
| Document symbol | `InitHandler.java:160` | árvore de símbolos do arquivo | baixo |
| Definition / declaration | `InitHandler.java:163`, `:166` | vai à declaração | baixo |
| Type definition | `InitHandler.java:169` | vai ao tipo | baixo |
| Implementation | `InitHandler.java:184` | subtipos/implementações | baixo |
| References | `InitHandler.java:175` | usos no workspace, com escopo configurável | baixo |
| Hover (Javadoc) | `InitHandler.java:172`, `HoverHandler.java:58` | Markdown com documentação | baixo |
| Rename (+ prepare) | `InitHandler.java:139`, `RenameHandler.java:44-46` | rename com getters/setters | **alto** |
| Code action / quick fix | `InitHandler.java:142` | fixes do compilador e refactors | **alto** |
| Call hierarchy | `CallHierarchyHandler.java:1` | callers/callees | baixo |
| Signature help | `SignatureHelpHandler.java:1` | parâmetros do método | baixo |
| Inlay hints | `InlayHintsHandler.java:1` | tipos inferidos | baixo |
| Semantic tokens | `SemanticTokensHandler.java:1` | highlight semântico | baixo |
| Decompile | `plugin.xml:137` | fonte de `.class` | médio |
| Build/import de projeto | `plugin.xml:101`, `:86` | executa Maven/Gradle | **alto** (rede + build) |
| Workspace symbol | `WorkspaceSymbolHandler.java:48` | busca por nome no workspace | baixo |

## 5. Loop do agente, contexto e streaming

- **Push, não pull**: diagnósticos são publicados por notificação
  (`WorkspaceDiagnosticsHandler.java:203`); não há `textDocument/diagnostic` no
  `InitHandler`. Para um agente isso significa: ou consumir notificações e manter cache, ou
  chamar `java.project.refreshDiagnostics` (`plugin.xml:98`) e esperar.
- **Working copies**: cada documento aberto vira um `ICompilationUnit` em memória
  (`LanguageServerWorkingCopyOwner.java`, 51 linhas); fechar descarta
  (`JDTUtils.discardClassFileWorkingCopy`, visto em `HoverHandler.java:54`). O análogo de
  "contexto" é a *working copy* + o modelo do projeto, não um histórico de conversa.
- **Sintaxe vs semântica**: existe um segundo servidor, `SyntaxLanguageServer`
  (`.../syntaxserver/SyntaxLanguageServer.java:104`), que responde
  documentSymbol/definition/typeDefinition/hover/completion/folding/selectionRange sem
  classpath (`SyntaxInitHandler.java:55-90`), com sync incremental (`:84`). É o padrão
  "resposta rápida enquanto o projeto importa".
- **Cancelamento**: `$/cancelRequest` do LSP repassado ao `IProgressMonitor` do Eclipse;
  refactorings longos checam `monitor.isCanceled()`.
- **Retry**: não existe no servidor; falha de import vira marcador de build
  (`plugin.xml:214`, `buildFileMarker`).

## 6. Sessões, estado e persistência

- Estado vive num **workspace Eclipse em disco** (`-data`), com `.metadata/`; é o que
  permite reabrir e não reindexar tudo.
- Índice de busca do JDT fica dentro desse workspace; `java.project.import` reconstrói.
- Configuração por projeto: `.settings/`, `.classpath`, `.project`, `pom.xml`,
  `build.gradle` — o servidor lê e **escreve** nesses arquivos em algumas operações
  (`ProjectConfigurationUpdateHandler`, 45 linhas).
- Não há fork/checkpoint; reiniciar o servidor é o único reset.

## 7. Configuração e extensibilidade

- Preferências via `workspace/didChangeConfiguration` (`JDTLanguageServer`), com dezenas de
  flags (`Preferences.java`, `InitHandler` lê `preferenceManager`).
- Extension points próprios (`plugin.xml:4-7`): `delegateCommandHandler`, `importers`,
  `contentProvider`, `buildSupport` — ou seja, a extensão é feita **no build do plugin**,
  não em runtime pelo usuário.
- `contentProvider` permite plugar fonte para `.class` (FernFlower em `plugin.xml:46`).
- Não há MCP, hooks ou scripts de usuário. Extensões típicas exigem escrever um plugin
  Eclipse.

## 8. Permissões, sandbox e erros

- Sem sandbox: importar um projeto Maven/Gradle executa o build tool, baixa dependências e
  roda plugins de build. Isso é **execução de código do repositório** — inaceitável sem
  confirmação explícita.
- `JavaLanguageServerPlugin` mantém telemetria (`USAGE_DATA.md`) — precisa ser desligada.
- Erros de compilação viram diagnósticos, não exceções; `DiagnosticsHandler.java:63` marca
  "not on the classpath, only syntax errors" para arquivo fora do projeto — bom padrão de
  mensagem degradada.
- Falha de import vira `buildFileMarker` (`plugin.xml:214`), visível no cliente.

## 9. Testes e qualidade

| Suíte | Onde | O que cobre |
|---|---|---|
| Testes de handler | `org.eclipse.jdt.ls.tests/src/.../handlers` | cada request LSP |
| Projetos de fixture | `org.eclipse.jdt.ls.tests/projects` | Maven, Gradle, Eclipse, invisível |
| Syntax server | `org.eclipse.jdt.ls.tests.syntaxserver` | modo leve |
| Lombok | `org.eclipse.jdt.ls.tests.lombok` | annotation processing |
| Build | `pom.xml` (Tycho) | empacotamento RCP |

Qualidade alta em cobertura de casos de projeto (o que mais quebra num LS Java), mas o
teste é lento e exige JVM + Eclipse; não é algo que consigamos rodar no CI do app.

## 10. O que vale portar

| Módulo | Origem (arquivo:linha) | Por que é melhor | Licença | Destino proposto | Score |
|---|---|---|---|---|---|
| Dois modos (syntax server + full server) | `SyntaxLanguageServer.java:104`, `SyntaxInitHandler.java:55` | responde em ms sem classpath, melhora depois | **EPL-2.0 — ideia, não código** | `src/core/code-intelligence/modes.ts` | 14 |
| Matriz de capacidades declaradas | `handlers/InitHandler.java:118-184` | lista explícita do que existe/ não existe | ideia | `src/core/lsp/capabilities.ts` | 10 |
| Mensagem degradada "fora do classpath" | `handlers/DiagnosticsHandler.java:63` | explica por que o resultado é parcial | ideia | contrato de tool | 8 |
| Escopo de busca configurável | `handlers/ReferencesHandler.java:62-65` | `SOURCES | REFERENCED_PROJECTS` explícito | ideia | `src/core/code-intelligence/references.ts` | 7 |
| Rename com prepare + condições | `RenameHandler.java:44-46`, `:84` | valida antes de aplicar | ideia | `src/core/tools/fs.ts` (rename guard) | 6 |

## 11. O que NÃO vale portar

| Item | Motivo |
|---|---|
| Qualquer `.java` do repositório | **EPL-2.0**; copiar exige manter EPL no arquivo derivado |
| Runtime Eclipse/OSGi/Tycho | centenas de MB, JVM, workspace em disco — não embutível |
| `ProjectsManager`/importers Maven/Gradle | executam build do repositório; risco e latência |
| Handlers de refactoring (LTK) | dependem do modelo JDT; sem ele não há o que portar |
| FernFlower decompiler | binário/Java embutido; fora de escopo |
| ~35 comandos `java.*` | específicos de projeto Eclipse; nosso contrato é tool schema |

## 12. Modelo de exemplo para o nosso harness

O que realmente serve é o **padrão de degradação**, não o servidor:

1. **Dois níveis de resposta** no `code_intelligence`: `fast` (tree-sitter/regex, sempre
   disponível, latência baixa) e `semantic` (LSP externo, quando o usuário habilitou).
   Cada resposta carrega `engine` e `partial: boolean` — igual à distinção
   syntax/full do jdtls (`SyntaxInitHandler.java:55` vs `InitHandler.java:118`).
2. **Integração com LSP externo**: um cliente LSP genérico em `src/core/lsp/client.ts`
   (Content-Length + JSON-RPC), com `initialize`/`initialized`, `textDocument/didOpen`,
   `definition`, `references`, `hover`, `rename` (prepare+apply). Nenhum código do jdtls é
   usado: só o protocolo, que é MIT/CC-BY (`microsoft--language-server-protocol`).
3. **Segurança**: processo separado, `cwd` no workspace, sem herdar env de credenciais,
   timeout por request e `shutdown`/`exit` explícitos. Nunca rodar `java.project.import`
   sem confirmação (o equivalente no nosso caso é deixar o servidor do usuário cuidar
   disso).
4. **Teste**: um servidor LSP falso em Node que responde `definition`/`references` com
   locations fixas; validar framing, encoding UTF-16 e cancelamento.

## 13. Evidências da análise

```text
$ git -C ... rev-parse HEAD
6d1e57a2b1752adff9bfa767668cf4e78809b625

$ Get-Content LICENSE -TotalCount 1
Eclipse Public License - v 2.0

$ Select-String org.eclipse.jdt.ls.core/META-INF/MANIFEST.MF -Pattern "Bundle-Version|Bundle-Activator"
5: Bundle-Version: 1.64.0.qualifier
6: Bundle-Activator: org.eclipse.jdt.ls.core.internal.JavaLanguageServerPlugin

$ Select-String org.eclipse.jdt.ls.core/plugin.xml -Pattern "extension-point"
4: <extension-point id="org.eclipse.jdt.ls.core.delegateCommandHandler" .../>
5: <extension-point id="org.eclipse.jdt.ls.core.importers" .../>
6: <extension-point id="org.eclipse.jdt.ls.core.contentProvider" .../>
7: <extension-point id="org.eclipse.jdt.ls.core.buildSupport" .../>

$ Select-String handlers/InitHandler.java -Pattern "setDefinitionProvider|setReferencesProvider|setRenameProvider"
139: capabilities.setRenameProvider(RenameHandler.createOptions());
163: capabilities.setDefinitionProvider(Boolean.TRUE);
175: capabilities.setReferencesProvider(Boolean.TRUE);

$ Select-String handlers/RenameHandler.java -Pattern "setPrepareProvider|RenameSupport.create"
46: renameOptions.setPrepareProvider(true);
84: RenameSupport renameSupport = RenameSupport.create(curr, params.getNewName(), RenameSupport.UPDATE_REFERENCES | ...);

$ Select-String syntaxserver/SyntaxLanguageServer.java -Pattern "public class SyntaxLanguageServer"
104: public class SyntaxLanguageServer extends BaseJDTLanguageServer implements LanguageServer, TextDocumentSe...

$ Select-String handlers/WorkspaceDiagnosticsHandler.java -Pattern "publishDiagnostics"
203: this.connection.publishDiagnostics(new PublishDiagnosticsParams(ResourceUtils.toClientUri(uri), toDia...
```

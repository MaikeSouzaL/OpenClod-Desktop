# Módulos avançados: log, contrato, banco, diff, regressão e segurança

Seis módulos que entram **sempre que o projeto permitir**. Cada um enxerga uma camada que o teste
de tela não alcança:

- o **log** mostra a causa que a mensagem genérica esconde;
- a **divergência front × back** mostra o campo que some no caminho;
- a **integridade do banco** mostra o estado impossível que nenhuma tela exibe;
- o **modo PR** mostra o que mudou e quem depende disso;
- a **regressão automática** garante que o que passou continua passando;
- a **segurança funda** mostra o que o front esconde e o back entrega.

Nenhum módulo afrouxa as regras do `SKILL.md` §2: produção é somente leitura, não se digita senha,
não se commita e o banco é só leitura. Quando um passo daqui esbarra numa dessas regras, ela vence:
o caso fica `nao-validado` ou `bloqueado`, com o que falta para destravar.

Carregue a seção do módulo na fase em que ele entra (§0). Os códigos `MA-<n>-NN` do fim de cada
seção têm o formato do catálogo ("faça X → verifique Y") e vão no título do caso
(`[MA-3-02] Registro ativo sem filho ativo`).

Os códigos `MA-*` estão registrados no catálogo (`references/catalogo-de-testes.md` §11), que é a
fonte do próximo código livre: linha nova entra pelo `scripts/aprender.py` (`--secao MA-<n>`) e, se
mudar o procedimento, também aqui.

## Sumário

0. Como os módulos entram no ciclo
1. Log do servidor durante o teste: `MA-1`
2. Divergência front × back: `MA-2`
3. Integridade do banco (somente leitura): `MA-3`
4. Modo PR/diff: `MA-4`
5. Testes automáticos de regressão: `MA-5`
6. Segurança funda: `MA-6`

---

## 0. Como os módulos entram no ciclo

| Fase do `SKILL.md` | Módulo | O que fazer |
|---|---|---|
| 0 · Preparar | 4, 5, 6 | `escopo_diff.py` se há diff; rodar a suíte de regressão da rodada anterior; `segredos.py` e auditoria de dependências (só leitura) |
| 1 · Perfil | 1, 3 | localizar os logs e registrar onde ficam; anotar banco e trava de leitura |
| 2 · Entender | 2, 3, 6 | ler DTOs, enums e entidades; levantar as invariantes; montar a matriz endpoint × autorização |
| 3 · Inventariar | 2, 3, 4, 6 | `merge` do parcial do diff; itens `regra:` das invariantes; itens `seguranca:` |
| 4 · Planejar | todos | casos `[MA-*]`, com técnica e oráculo |
| 5 · Executar | 1, 2, 3, 6 | log a cada ação que falha; corpo enviado × recebido × DTO; retrato do banco antes e depois; IDOR e autorização na API |
| 6 · Verificar | 1, 3 | a causa provada vem do log e do banco, não da mensagem da tela |
| 7 · Corrigir | 4, 5 | raio da própria correção; teste novo para o defeito |
| 9–10 · Gate e entrega | 3, 4, 5 | consulta das invariantes no fim (contagem final × inicial); quadro "mudou × testado"; fluxos que passaram viram teste automático |

**Ative quando o projeto permitir; diga quando não permitir.** Módulo que não se aplica vira caso
`nao-aplicavel` num item `dimensao:MA-<n>`, com o motivo. Exemplo: "sem banco acessível; o PERFIL
não tem credencial de leitura".

---

## 1. Log do servidor durante o teste: `MA-1`

A tela mostra "Erro inesperado" ou "Ocorreu um erro ao salvar". A causa real (constraint violada,
nulo inesperado, timeout, permissão) só existe no log do servidor, quando existe.

**Mensagem genérica de framework é sintoma, não causa.** Exemplos reais:

- "An error occurred while saving the entity changes. See the inner exception for details." (EF Core)
- "could not execute statement" (Hibernate)
- "This Session's transaction has been rolled back due to a previous exception during flush"
  (SQLAlchemy)
- "Internal Server Error"

### 1.1 Quando ativa

- Sempre que há backend que você ou o usuário conseguem ler.
- Obrigatório em todo 4xx/5xx com mensagem genérica, em todo 200 cujo efeito não aconteceu (não
  gravou, não mandou, não gerou) e em toda ação lenta acima de 10 s.
- Sem nenhum acesso: o módulo continua, como **pedido de log** (§1.5).

### 1.2 Onde estão os logs, por stack

Localize **antes** do primeiro clique (fase 1) e registre no `.qa/PERFIL.md` onde ficam e como ler.

| Onde roda | Como ler (sempre leitura) |
|---|---|
| Dev server num terminal | a saída do próprio terminal. Se for o terminal do usuário, leia com a ferramenta que lê o terminal dele; sem ela, peça as últimas 100 linhas. Server components e rotas de API do Next/Nuxt logam no **terminal**, não no console do navegador |
| .NET local | janela Output do Visual Studio ("ASP.NET Core Web Server"), console do `dotnet run`, arquivo do Serilog/NLog (veja `WriteTo` no `appsettings*.json`). O nível vem de `Logging:LogLevel` |
| Node | terminal do `npm run dev`; `pm2 logs <app> --lines 200 --nostream`; arquivos do winston/pino |
| Python | console do `uvicorn`/`gunicorn`/`runserver`; handlers de arquivo do `logging`; workers do Celery à parte |
| Java | console do Spring Boot, `logs/*.log`, `catalina.out` |
| Go | stdout do processo |
| Docker | `docker compose logs --since 10m --timestamps <servico>` · `docker logs -t --since 2026-09-30T14:00:00 <container>` |
| Kubernetes | `kubectl logs deploy/<api> --since=10m --timestamps` (some com o pod: leia rápido) |
| Linux/systemd | `journalctl -u <servico> --since "10 min ago" --no-pager` |
| Windows/IIS | `%SystemDrive%\inetpub\logs\LogFiles` e `Get-WinEvent -LogName Application -MaxEvents 50` |
| Azure App Insights | `az monitor app-insights query --app <id> --analytics-query "exceptions \| where timestamp > ago(30m) \| project timestamp, type, outerMessage, innermostMessage, operation_Id"` |
| Azure App Service | `az webapp log tail -n <app> -g <grupo>`. Se o log não estiver ligado, **ligar é configuração**: só com pedido |
| AWS CloudWatch | `aws logs tail <grupo> --since 10m --filter-pattern ERROR` |
| GCP | `gcloud logging read 'severity>=ERROR AND timestamp>="2026-09-30T17:00:00Z"' --limit 50 --format json` |
| Sentry, Datadog, New Relic | pela interface, filtrando por janela de horário, rota e release |
| Banco | log de erros do servidor de banco: raramente necessário, útil em deadlock e timeout |

**Só leitura, sempre.** Mudar nível de log, ligar diagnóstico, reiniciar serviço ou instalar agente
é alteração de ambiente: só com pedido explícito, e nunca em produção por conta própria.

### 1.3 Ligar a ação da tela ao log

1. **Marque o relógio antes da ação** com `date` (com fuso), nunca de cabeça. Anote também o fuso do
   servidor: log em UTC com a tela em horário local desloca a janela em horas.
2. **Capture o identificador da requisição**, nesta ordem:
   - header de resposta: `x-request-id`, `x-correlation-id`, `traceparent`, `request-id`,
     `x-ms-request-id`, `x-amzn-requestid`, `cf-ray`;
   - corpo do erro: o `traceId` do ProblemDetails do ASP.NET, o `requestId` do envelope do
     projeto, o id do evento do Sentry.

   O `xhr-spy.js` não grava cabeçalhos. Leia o header pela ferramenta de rede do navegador (a do
   Playwright mostra) ou repita a chamada com `fetch` na página e leia
   `r.headers.get('<nome>')`; em chamada cross-origin, só os headers expostos pelo CORS aparecem.
3. **Filtre o log** pela janela `[início − 2 s, fim + 2 s]` e pelo identificador. Sem
   identificador, use rota, método, usuário e tenant (por id, nunca por e-mail no arquivo de
   evidência).
4. **Capture a exceção inteira:** tipo e mensagem de **cada** inner exception, até a mais interna;
   SQL ou nome da constraint; as linhas do stack que são do projeto (as do framework só se
   explicarem algo).
5. **Salve como evidência** em `evidencias/NN-log-<acao>.txt`, com o mesmo `NN` do print e da rede
   daquele momento. Mascare token, string de conexão, senha e dado pessoal antes de gravar.
6. **Ligue ao caso:** `set <rodada> C-NNNN --evidencia evidencias/NN-log-<acao>.txt --obtido "422;
   log: FK_<tabela>_<coluna> violada ao excluir"`. No defeito, a `causa` vem do log, com
   `arquivo:linha` do ponto que lança.

### 1.4 Quando o erro é engolido

O log também mente por omissão. Desconfie quando a tela mostra mensagem genérica e o log não tem
nada, ou quando a ação devolve 200 e o efeito não aconteceu. Procure no código:

| Padrão | Como achar (grep) | Efeito |
|---|---|---|
| Filtro ou middleware de exceção que lê só a mensagem externa e marca como tratado | `ExceptionFilter`, `UseExceptionHandler`, `app.use((err`, `@ControllerAdvice`, `@app.exception_handler`, `errorHandler` | a inner exception é destruída, não só escondida |
| `catch` vazio ou que só devolve texto | `catch\s*\{`, `catch \(\w+\) \{\s*\}`, `except Exception:\s*pass`, `.catch(() =>` | nenhum rastro |
| Log em nível que o ambiente não grava | `LogDebug`, `logger.debug`, `console.debug` no caminho de erro | some fora do dev |
| O erro é registrado pelo **mesmo** contexto ou transação que falhou | `catch` que grava atividade, auditoria ou "log de erro" com o mesmo `DbContext`, sessão ou `atomic` | o registro do erro falha junto: o ORM tenta de novo as entidades inválidas que continuam rastreadas, ou a transação revertida leva o log com ela |
| Falha de efeito tratada como sucesso | envio de e-mail ou integração cujo retorno `false` é ignorado | a tela diz "enviado" |

Os sinais de "mesmo contexto" variam por ORM:

- o EF Core falha de novo no segundo `SaveChanges`;
- o Hibernate exige descartar a sessão depois da exceção;
- o SQLAlchemy levanta `PendingRollbackError`;
- o Django levanta "You can't execute queries until the end of the 'atomic' block".

Provar engolimento: leia o filtro, reproduza o erro e confira que o log continua vazio. Aumentar o
nível de log para provar só em ambiente local e com autorização: é alteração de configuração. O
achado vira defeito (o suporte não consegue diagnosticar), normalmente `medio` ou `alto`.

### 1.5 Sem acesso ao log: o pedido exato

Não invente causa. Escreva para quem tem acesso uma mensagem com:

- serviço e ambiente;
- janela de horário **com fuso**;
- método e rota;
- identificador da requisição;
- usuário e tenant, por id;
- a mensagem exibida na tela;
- a consulta pronta (KQL, filtro do CloudWatch, busca do Sentry);
- o que trazer de volta: tipo e mensagem de cada inner exception e a primeira linha do stack que
  é do projeto.

O caso fica `nao-validado` com "falta a entrada do log da ação: pedido enviado a <quem> em <data>;
destrava: o trecho do log com o correlation id". No defeito, separe **causa provada** de **causa
provável**.

### 1.6 Ledger

- O log é evidência do caso da ação: não precisa de item próprio.
- Item `regra:observabilidade.<servico>` quando o módulo testa o tratamento de erro em si
  (técnica `api`).
- Erro engolido ou mensagem que impede o diagnóstico: defeito `defeito`. Mensagem que só poderia
  ser melhor: `melhoria`.
- Anote no PERFIL onde está cada log e quanto ele demora a aparecer: alguns têm buffer de segundos.

### 1.7 Armadilhas

- **Log de outra instância.** Com várias réplicas, a requisição pode ter caído noutro pod: filtre
  pelo identificador.
- **Hot reload.** O reinício pode cortar o log no meio: repita a ação depois de o servidor
  estabilizar.
- **Buffer.** Espere o tempo do evento (`LI-18`) antes de concluir "não logou".
- **Log que também é genérico.** `ex.Message` em vez de `ex.ToString()` repete a mensagem externa:
  isso também é achado.
- **Segredo no log** (token, string de conexão, senha) é achado de segurança (`MA-6-09`) e
  **nunca** entra na evidência sem máscara.
- **Correlação por horário.** Falha com tráfego concorrente: só conclua com identificador ou com
  rota, usuário e corpo batendo.

### 1.8 Códigos sugeridos

- **MA-1-01** Antes do primeiro clique, localize os logs de cada serviço e leia uma linha recente de cada → verifique que a fonte está viva e anote no PERFIL onde fica e qual o fuso.
- **MA-1-02** Em todo 4xx/5xx com mensagem genérica, ache a entrada do log pelo identificador da requisição → verifique tipo e mensagem da inner exception mais interna e grave em `evidencias/NN-log-<acao>.txt`.
- **MA-1-03** Provoque um erro de validação e um de banco (duplicado, FK) em cada endpoint de escrita → verifique que o log registra a causa real e que a resposta traz um identificador que o suporte consegue procurar.
- **MA-1-04** Leia o filtro ou middleware global de exceções → verifique se ele loga a exceção inteira antes de responder; se só lê a mensagem e marca como tratada, registre a perda da causa.
- **MA-1-05** Procure `catch` que grava atividade ou erro com o mesmo contexto ou transação que falhou → reproduza a falha e confira se o registro do erro aparece no banco.
- **MA-1-06** Em ação que devolve 200 sem o efeito esperado, procure no log aviso ou erro de efeito secundário (e-mail, integração, fila) → verifique se a falha foi ignorada pelo código.
- **MA-1-07** Leia os logs gerados durante a rodada procurando token, senha, string de conexão e dado pessoal → registre a existência e o arquivo, nunca o valor.
- **MA-1-08** Compare o horário do log com o da tela e o do banco para a mesma ação → verifique se a diferença é só de fuso e documente o fuso de cada camada.
- **MA-1-09** Sem acesso ao log, mande o pedido com janela e fuso, rota, identificador e o que trazer de volta → mantenha o caso `nao-validado` até a resposta e registre causa provada × provável.
- **MA-1-10** Em requisição acima de 10 s, leia o log do intervalo → verifique se o tempo está no banco, em efeito em série dentro da requisição ou em chamada externa.

---

## 2. Divergência front × back: `MA-2`

O front declara um formato e o back entrega outro. A tela mostra `3` onde deveria haver "Dados
Cadastrais", `2026-09-30` onde deveria haver `30/09/2026`, `19.999999999999993` onde deveria haver
`20`. Ou o front manda um campo que o back descarta em silêncio.

### 2.1 Quando ativa

- Projeto full-stack no escopo, API consumida por front tipado, SDK ou cliente gerado.
- Obrigatório quando a tela mostra valor cru: número no lugar de rótulo, ISO, `undefined`,
  `[object Object]`, `NaN`, `0` onde há dado, ou campo vazio que o banco tem.

### 2.2 As quatro fontes, comparadas

| Fonte | Onde |
|---|---|
| Tipos do front | `interface`/`type`/`enum` (TS), schemas zod/yup, models de serviço, cliente gerado (OpenAPI, GraphQL codegen) |
| Respostas reais | `rede/*.json` do `xhr-spy.js` (`chamadas[].enviado` e `.recebido` são o texto do corpo) |
| Back | DTO/ViewModel de entrada e de saída, entidade, enum, configuração do serializador. C#: `JsonSerializerOptions`, `JsonStringEnumConverter`. Java: Jackson. Python: Pydantic/serializers. Go: tags `json:` |
| Contrato publicado | OpenAPI/Swagger (`/swagger/v1/swagger.json`, `/openapi.json`, `/v3/api-docs`, `/docs`) |

O banco entra como quinta fonte para tipo e precisão: `decimal(18,4)`, `datetime` sem fuso,
`varchar(50)`.

### 2.3 O que comparar

| Divergência | Como provar | Sintoma típico |
|---|---|---|
| Campo ausente ou renomeado (`PascalCase` × `camelCase`, `totalCount` × `total`) | chaves da resposta × propriedades do model | campo vazio na tela, sem erro |
| Enum sem membro no front | valores distintos na resposta e no banco (`SELECT DISTINCT`) × membros do enum do front | número cru, rótulo em branco |
| Enum numérico × texto | `JsonStringEnumConverter` ou equivalente ligado só num endpoint | comparação `=== 1` falha |
| `0` válido tratado como falso | grep `\|\| ` com enum/número; teste com o membro de valor 0 | o primeiro membro vira o padrão |
| Campo enviado e ignorado | corpo enviado × DTO de entrada × banco depois | "salvo com sucesso" e o campo não muda |
| Campo aceito e sobrescrito | service que recalcula ou trava o valor para um papel | o valor digitado não é o gravado |
| Nulo onde o front exige | resposta com `null` × tipo não opcional; `strict: false` esconde | crash ou `undefined` só em registro antigo |
| Número × texto | `Decimal` serializado como `"12.30"`; id maior que 2^53 em JS | soma vira concatenação; id muda no último dígito |
| Data | ISO com e sem `Z`, `DateTime` sem fuso, `DateOnly`, `new Date('AAAA-MM-DD')` no front | um dia a menos em fuso negativo; ISO cru na tela |
| Precisão | float com mais de 6 casas no corpo (`19.999999999999993`); percentual calculado em float; dinheiro em float | valor "quase certo" gravado ou exibido |
| Envelope de erro | front lê `error.message`; back manda `errors[]`, ProblemDetails ou outro formato | toast genérico em vez da mensagem do campo |
| Status HTTP | validação devolvida como 401 ou 200 com `success: false` | interceptador desloga ou trata como sucesso |
| OpenAPI × implementação | campo `required` aceito nulo; status documentado diferente do real | cliente gerado quebra em produção |

### 2.4 Como automatizar a checagem

1. Capture as respostas com o corpo inteiro: `__qa.config.limite = 200000` antes da ação; o padrão
   corta em 4.000 caracteres.
2. Achate as chaves e os tipos observados:

```python
import glob, json, re, sys
from collections import defaultdict
tipos = defaultdict(set)
def andar(v, c):
    if isinstance(v, dict):
        for k, x in v.items(): andar(x, f"{c}.{k}" if c else k)
    elif isinstance(v, list):
        for x in v[:100]: andar(x, c + "[]")
    else:
        t = type(v).__name__
        if isinstance(v, float) and len(repr(v).split(".")[-1]) > 6: t += "!ruido"
        if isinstance(v, str) and re.match(r"^\d{4}-\d{2}-\d{2}(T|$)", v): t += "!data"
        tipos[c].add(t)
for arq in glob.glob(sys.argv[1] + "/rede/*.json"):
    for ch in json.load(open(arq, encoding="utf-8")).get("chamadas", []):
        try: andar(json.loads(ch.get("recebido") or "null"), f"{ch['metodo']} {ch['url'].split('?')[0]}")
        except ValueError: pass
for c in sorted(tipos): print(c, "|".join(sorted(tipos[c])))
```

3. Compare a lista com o model do front: chave que só existe de um lado, tipo misto
   (`int|str`), `NoneType` em campo obrigatório, `!ruido`, `!data`.
4. Para os enums, junte os valores distintos da resposta e do banco e compare com os membros do
   front. Cada membro é uma partição: uma linha de dado que exiba cada um.
5. Com OpenAPI publicado, compare o schema documentado com as chaves observadas, e cada chamada do
   front (seção 4 do `escopo_diff.py`) com uma rota documentada.
6. Num campo enviado e ignorado, prove a corrente inteira: corpo enviado com o campo → DTO de
   entrada (tem ou não tem?) → banco depois (mudou ou não?).

### 2.5 Ledger

| Achado | Item | Técnica |
|---|---|---|
| Contrato de um endpoint | o `api:<MÉTODO> <rota>` já existente | `api` |
| Enum | `dado:<entidade>.<campo>`, um caso por membro | `particao` |
| Campo enviado e ignorado | o `api:` do envio, com prova no banco | `banco` |
| Precisão | o `elemento:` do campo | `valor-limite` |

Evidência: o `rede/NN-*.json` e o trecho do DTO ou do enum (`arquivo:linha`) no `--obtido`.

### 2.6 Armadilhas

- **O interceptador do front transforma o corpo** (camelCase, datas convertidas): compare o que a
  tela recebe depois dele, não só o que a rede mostra.
- **Model "aspiracional":** existe no front e nenhum código o usa. Confira quem consome o campo
  antes de reportar.
- **Encadeamento opcional esconde campo ausente:** `a?.b` renderiza vazio, sem erro.
- **TypeScript com `strict: false`** e build que ignora erro de tipo deixam passar qualquer
  divergência.
- **O espião re-serializa o JSON para mascarar segredos:** inteiro acima de 2^53 sai arredondado na
  evidência. Para provar perda de precisão, leia o corpo cru na ferramenta de rede do navegador.
- **Versões diferentes:** o contrato em dev não é o de produção se as versões diferem. Diga contra
  qual commit do back a comparação foi feita.
- **Cliente gerado desatualizado:** gere de novo só com pedido; aponte a divergência.

### 2.7 Códigos sugeridos

- **MA-2-01** Para cada endpoint do alvo, compare as chaves da resposta real com o model do front → verifique campo ausente, renomeado ou com tipo diferente.
- **MA-2-02** Liste os valores distintos de cada enum na resposta e no banco → verifique que todo valor tem membro e rótulo no front (sem número cru na tela).
- **MA-2-03** Exiba um registro com o membro de valor `0` de cada enum → verifique que ele não vira o padrão por `x || padrao`.
- **MA-2-04** Envie cada campo editável e leia o banco depois → verifique que o DTO de entrada tem o campo e que o valor gravado é o enviado.
- **MA-2-05** Procure no corpo enviado e recebido números com mais de 6 casas decimais → verifique onde o float nasce e o que o banco grava.
- **MA-2-06** Abra um registro com cada campo de data preenchido em fuso negativo → verifique que a tela mostra o dia civil do banco, sem ISO cru e sem um dia a menos.
- **MA-2-07** Provoque cada tipo de erro do endpoint → verifique que o front lê o envelope que o back manda e mostra a mensagem do campo.
- **MA-2-08** Compare o status HTTP de cada erro com a semântica (`PJ-API-02`) → verifique que validação não volta como 401 nem como 200.
- **MA-2-09** Compare o OpenAPI publicado com as respostas reais → verifique `required`, `nullable`, enums e status documentados.
- **MA-2-10** Abra registro antigo, com campos nulos que hoje são obrigatórios → verifique que a tela não quebra nem exibe `undefined`.
- **MA-2-11** Compare ids numéricos grandes no banco com o que a tela exibe e reenvia → verifique que não há perda acima de 2^53.

---

## 3. Integridade do banco (somente leitura): `MA-3`

Toda regra do domínio tem uma forma de ser violada no dado: filho sem pai, contrato ativo sem item
ativo, cabeçalho que não bate com a soma das linhas, duas linhas vivas para o mesmo campo. A
tela raramente mostra; uma consulta mostra.

### 3.1 Quando ativa

- Sempre que há banco com acesso de leitura.
- Em três momentos:
  1. **varredura** das invariantes no início, para separar o legado do que a rodada causar;
  2. **antes e depois** de toda ação de escrita;
  3. **varredura** de novo no fim.
- Migração no diff: rode as invariantes antes e depois da migração, numa cópia descartável (§3.5).

### 3.2 Descobrir as invariantes lendo o código

| Fonte | O que vira invariante |
|---|---|
| Migrations e configuração do ORM | FK declarada, `unique`, `not null`, filtro global (`HasQueryFilter`, soft delete, tenant) |
| Guards dos services (`throw`, `raise`, mensagem de erro) | "não pode cancelar com pedido aberto" → nenhum cancelado com pedido aberto |
| Enums de status e transições | estado terminal sem data, estado ativo sem dependente obrigatório |
| Colunas `*_id` sem constraint | FK lógica: o pai precisa existir (e não estar excluído) |
| Tabela polimórfica (`entity_type` + `entity_id`, `module_id` + `entity_id`) | órfão por tipo; consulta sempre filtrada pelo discriminador |
| Cálculos (total, saldo, comprometido, disponível) | soma das partes = total, com a regra de exclusão (cancelados fora) |
| Regras do usuário e changelog do projeto | o que o time já disse que "nunca pode acontecer" |

Escreva cada invariante como **consulta que devolve as violações**: zero linhas é sucesso. Traga
contagem e até 20 ids de amostra, nunca a tabela inteira.

### 3.3 Modelos de consulta

Troque os nomes pelos do projeto. Todos só leem.

**Órfão por FK lógica**, com a variante de soft delete:

```sql
SELECT f.id FROM item f
LEFT JOIN pedido p ON p.id = f.pedido_id
WHERE f.pedido_id IS NOT NULL AND (p.id IS NULL OR p.excluido = 1);
```

**Órfão em tabela polimórfica:** filtre sempre pelo discriminador.

```sql
SELECT v.id FROM valor_campo v
WHERE v.modulo = 'PEDIDO'
  AND NOT EXISTS (SELECT 1 FROM pedido p WHERE p.id = v.entidade_id);
```

**Estado impossível:** ativo sem nenhum item ativo.

```sql
SELECT c.id FROM contrato c
WHERE c.status = 'ATIVO' AND c.excluido = 0
  AND NOT EXISTS (SELECT 1 FROM contrato_item i
                  WHERE i.contrato_id = c.id AND i.cancelado = 0 AND i.excluido = 0);
```

**Duplicado de negócio:** normalize caixa, espaço e máscara.

```sql
SELECT tenant_id, LOWER(TRIM(documento)) AS doc, COUNT(*) AS n
FROM cliente WHERE excluido = 0
GROUP BY tenant_id, LOWER(TRIM(documento)) HAVING COUNT(*) > 1;
```

**Duas versões vivas** do que deveria ser único:

```sql
SELECT entidade_id, campo_id, COUNT(*) FROM valor_campo
WHERE excluido = 0 GROUP BY entidade_id, campo_id HAVING COUNT(*) > 1;
```

**Soma que não fecha:**

```sql
SELECT p.id, p.total, SUM(i.qtd * i.preco_unitario) AS soma
FROM pedido p JOIN item i ON i.pedido_id = p.id AND i.cancelado = 0
GROUP BY p.id, p.total HAVING ABS(p.total - SUM(i.qtd * i.preco_unitario)) > 0.005;
```

**Tenant cruzado:** filho com tenant diferente do pai.

```sql
SELECT f.id FROM item f JOIN pedido p ON p.id = f.pedido_id WHERE f.tenant_id <> p.tenant_id;
```

**Datas e auditoria:**

- `data_fim < data_inicio`;
- `status = 'CANCELADO' AND data_cancelamento IS NULL`;
- `criado_por IS NULL`;
- `excluido = 1 AND excluido_em IS NULL`.

| Banco | Diferenças que importam |
|---|---|
| SQL Server | `SELECT TOP 20 …`. Não há trava de sessão confiável: use login de leitura ou revise cada consulta antes de rodar. Esquema real: `sys.foreign_keys`, `sys.indexes`, `INFORMATION_SCHEMA.COLUMNS`. Evite `NOLOCK` em prova (lê dado não confirmado) |
| PostgreSQL | `LIMIT 20`; sessão em leitura: `PGOPTIONS='-c default_transaction_read_only=on'`. Esquema real: `information_schema.table_constraints`, `pg_indexes` |
| MySQL/MariaDB | `LIMIT 20`; `START TRANSACTION READ ONLY;` antes |
| SQLite | `sqlite3 -readonly arquivo.db` |
| MongoDB | só `find`/`aggregate`, sem `$out`/`$merge` |

Os mesmos três casos no MongoDB:

```js
db.item.aggregate([{ $lookup: { from: "pedido", localField: "pedidoId", foreignField: "_id", as: "p" } },
                   { $match: { p: { $size: 0 } } }, { $project: { _id: 1 } }, { $limit: 20 }])
db.cliente.aggregate([{ $match: { excluido: false } },
                      { $group: { _id: { t: "$tenantId", d: { $toLower: "$documento" } }, n: { $sum: 1 } } },
                      { $match: { n: { $gt: 1 } } }])
db.contrato.find({ status: "ATIVO", itens: { $not: { $elemMatch: { cancelado: false } } } }).limit(20)
```

### 3.4 Antes e depois de cada escrita

1. **Antes:** retrato do registro-alvo inteiro, dos relacionados e das contagens das tabelas
   vizinhas, em `evidencias/NN-banco-antes.txt`. Um hash por linha resume:
   - PostgreSQL: `md5(row_to_json(t)::text)`;
   - SQL Server: `HASHBYTES('SHA2_256', (SELECT t.* FOR JSON PATH))`;
   - MySQL: `MD5(JSON_OBJECT(...))`.
2. **A ação**, pela aplicação.
3. **Depois:** a mesma consulta em `evidencias/NN-banco-depois.txt`, e o `diff` dos dois arquivos.
4. **Confira as duas metades:**
   - mudou exatamente o esperado;
   - **não mudou** o resto: campo que a tela não carrega, registros vizinhos, outro tenant,
     contagens alheias.
5. **Rode as invariantes que a ação toca.** Uma violação nova é defeito da aplicação.

### 3.5 Banco descartável para migração

Rodar migração e rollback é DDL. O banco do usuário continua só leitura (`SKILL.md` §2, linha
Banco), e esta seção **não afrouxa** essa regra: a cópia descartável não é ambiente do usuário, é um
banco que o próprio teste cria e joga fora.

- **De onde vem a cópia:** o banco local ou o contêiner do próprio projeto (o `docker compose` do
  repositório, Testcontainers), restaurado do seed do projeto ou de um dump de **desenvolvimento
  anonimizado** pedido ao usuário.
- **Dump de produção, nunca** sem autorização registrada na rodada e a regra de dado pessoal
  (`DM-PRI`): mascarado antes de entrar na cópia, e a cópia apagada no fim.
- **Só nessa cópia:** a migração, o rollback e as invariantes do MA-3 antes da migração, depois dela
  e depois do rollback. Registre na nota qual cópia foi usada e de onde veio o dado.
- **Sem cópia possível** (sem contêiner, sem seed, sem dump autorizado): o caso fica `bloqueado` com
  "falta banco descartável: <o que destrava, ex.: o docker compose do projeto subir, ou um dump de dev
  anonimizado>". Nunca rode a migração no banco de desenvolvimento compartilhado para "economizar".
- O contêiner e os volumes criados vão para `sujeira` até serem apagados.

### 3.6 Ledger

- Cada invariante vira item `regra:<entidade>.<invariante>` (ex. `regra:contrato.ativo-tem-item-ativo`)
  com caso de técnica `banco` e `oraculo` apontando a regra (`service:linha` ou a fala do usuário,
  com data).
- **Violação que já existia** no início: defeito com "pré-existente: N linhas, mais antiga em
  <data>". Separe dado legado de bug atual (`DM-INT-07`).
- **Violação criada pela rodada:** defeito da aplicação, com o caso que a causou. Severidade alta
  quando mexe em dinheiro, quantidade ou acesso.
- **Nunca corrija com `UPDATE`/`DELETE`.** Se a limpeza for necessária, ela vai como proposta
  (consulta pronta, em bloco copiável) para quem tem autorização. A sujeira da rodada vai para
  `sujeira`.

### 3.7 Armadilhas

- **Filtro global do ORM não vale no SQL cru:** soft delete e tenant que a aplicação aplica
  sozinha precisam estar na sua consulta.
- **Tabela polimórfica sem discriminador** conta outros módulos (`LI-39`).
- **`NOT IN` com `NULL`** devolve vazio: use `NOT EXISTS`.
- **Constraint que existe na migration e não no banco** (drift): confira o esquema real.
- **Réplica de leitura atrasada:** o "depois" pode vir antes da escrita chegar. Confira na
  primária ou espere.
- **Collation e espaços** mudam o resultado de duplicidade.
- **Varredura pesada em produção** derruba quem está trabalhando: use `TOP`/`LIMIT`, filtre por
  data, rode a varredura completa em cópia ou fora do horário.
- **Valide a consulta** com um registro conhecido antes de confiar no número (execução §4.2).
- **Códigos de registro repetem entre ambientes:** cite sempre o ambiente.

### 3.8 Códigos sugeridos

- **MA-3-01** Liste as FKs lógicas (colunas `*_id` sem constraint, tabelas polimórficas) lendo entidades e migrations → rode a consulta de órfão de cada uma e registre a contagem.
- **MA-3-02** Para cada status terminal ou ativo, escreva a consulta de estado impossível a partir dos guards do service → verifique zero linhas no início e no fim da rodada.
- **MA-3-03** Para cada chave de negócio (documento, código, e-mail por tenant), agrupe com caixa e espaços normalizados → verifique que não há duplicado vivo e que existe constraint no banco.
- **MA-3-04** Para cada total ou saldo exibido, compare com a soma das partes no banco, com a regra de exclusão → verifique a diferença zero (ou dentro do arredondamento documentado).
- **MA-3-05** Antes e depois de toda escrita, retrate o registro inteiro e os relacionados → verifique que só mudou o esperado e que campo não exibido não foi apagado.
- **MA-3-06** Depois de toda exclusão, procure o id em todas as tabelas filhas e polimórficas → verifique cascata, bloqueio com mensagem de negócio ou órfão.
- **MA-3-07** Procure filhos com tenant diferente do pai e registros vivos apontando para pai excluído → verifique zero linhas.
- **MA-3-08** Procure registros com datas incoerentes (fim antes do início, terminal sem data) e campos de auditoria nulos → registre a contagem e a mais antiga.
- **MA-3-09** Procure duas linhas vivas para o que deveria ser único (resposta por campo, versão atual) → verifique qual a leitura devolve e se a edição tem efeito.
- **MA-3-10** Compare o esquema real (FK, unique, not null) com o que as entidades e migrations declaram → registre o que falta no banco.
- **MA-3-11** Para cada violação, separe pré-existente (antes do primeiro passo) de criada pela rodada → registre as duas, com o caso que criou a segunda.

---

## 4. Modo PR/diff: `MA-4`

"Testa essa branch", "dei pull, testa o que mudou", "revisa antes de subir". O escopo é o que mudou
**mais tudo que depende disso**, testado com a mesma profundidade de uma rodada inteira. Diff
pequeno reduz a largura, nunca a profundidade (`SKILL.md` §1.6).

### 4.1 Quando ativa

- Pedido explícito sobre branch, PR, commit ou "o que mudou".
- Reteste de correção.
- Qualquer rodada em que haja alteração não commitada: o diff ordena a prioridade, sem cortar o
  resto.

**Ativar o MA-4 não muda `pode_alterar_codigo` nem a autorização de corrigir.**
O MA-4 define o ESCOPO (o diff e o raio de impacto), não a autorização. Testar uma branch ou PR ("testa a branch X", "dei pull, testa") é pedido de QA: corrige o defeito claro. Revisar ou auditar uma branch ou PR ("revisa a PR", "audita") só relata, até o usuário dizer "corrige".
Um working tree sujo ordena a prioridade e nunca transforma o pedido de teste em "só relatar".

### 4.2 Como executar

```bash
python "$QA/scripts/escopo_diff.py" --base origin/develop \
  --md "$R/notas/02-escopo-diff.md" --json "$R/rede/escopo-diff.json" \
  --parcial "$R/parciais/escopo-diff.json" --prefixo-api api/v1
python "$QA/scripts/cobertura.py" merge "$R" "$R/parciais/escopo-diff.json"
```

- **A base é o destino da PR**, não a ponta da branch local: o script usa o `merge-base`. Base
  remota desatualizada: `git fetch` só com o ok do usuário, porque mexe nas referências remotas;
  sem ele, diga contra qual commit comparou.
- **Combinações:**
  - `--incluir-working` soma o que não foi commitado;
  - sem `--base` e sem `--ledger`, o escopo é o working tree contra o HEAD (só o que não foi
    commitado); com `--ledger` e sem `--base`, o script usa a base gravada pelo `--parcial`
    (somando o working tree) e, sem base gravada, sai 2 ("modo PR sem --base");
  - `--prefixo-api` sem a barra inicial: no Git Bash, `/api/v1` vira caminho do Windows. O
    `--parcial` grava esse prefixo, a base, a raiz do repositório (relativa à pasta da rodada), os
    globs do `--excluir` e o `--manter-status-inicial` em `rodada.escopo_diff`, e o gate os
    reaproveita (o parcial de diff mais novo troca o gravado; um parcial `--tudo` não tira a rodada do
    modo PR);
  - servidor Node sem framework (`req.method === 'GET' && url.pathname === '/...'`,
    `pathname.match(/^...$/)`) e Python `http.server` (dentro de `do_GET`/`do_POST`/...:
    `self.path == '/...'`, `path.startswith('/.../')`) têm as rotas reconhecidas; arquivo que sobe
    servidor cru sem nenhuma rota reconhecida avisa "servidor sem rota reconhecida" e conta como raio
    não calculado. Página `.html` que carrega por `<script src>` um `.js` do escopo vira item
    `tela:/<caminho do .html>` (com a barra inicial, como `tela:/clientes`), e as chamadas do JS inline
    dela (`<script>` sem `src`, `on*="..."`) e por wrapper de um nível (`api("PUT", "/x/" + id)`) viram
    `api:`;
  - `--tudo` (sem diff) lista todas as telas e endpoints detectados no projeto; com `--ledger`, o
    que não tem item no ledger sai como descoberto. É a conferência das contagens do inventário
    (fase 3), não um modo PR. Em CLI, o subcomando citado em bloco de código do README ou de `docs/`
    que nenhum parser declara vira `comando:<prog> <sub>` ("documentado sem parser",
    `descoberto_por: docs`): é a conta "parser × --help × docs" feita pelo script.
- **O que sai:**
  1. arquivos alterados, com símbolos e usos diretos;
  2. raio por nível (quem importa e quem usa o símbolo);
  3. telas cujas rotas montam o que mudou, com a cadeia;
  4. endpoints declarados e chamados;
  5. testes automatizados que tocam o escopo;
  6. itens `arquivo:`, `componente:`, `tela:`, `api:` para o ledger.
- **Depois do merge, cada item precisa de caso.**
  - Arquivo alterado: prova o comportamento novo, pela técnica que couber.
  - Arquivo do raio: prova que a vizinhança não regrediu (técnica `regressao`), num uso **real** de
    cada configuração (`DM-CMP-01`).
  - Teste automatizado no escopo: o caso é rodar o teste e anexar a saída.
- **Leia o diff você mesmo, trecho a trecho.** Classifique cada hunk em lógica, texto, estilo,
  configuração, migração ou teste. Cada hunk de lógica precisa de pelo menos um caso que o
  exercite. Monte a tabela "hunk → caso" na nota da fase.
- **Marcas que mudam o plano:**
  - `impacto-global` (build, dependência, configuração, middleware): o raio é o projeto inteiro;
    rode build, suíte e um smoke dos fluxos principais;
  - `migracao`: módulo 3 antes e depois, numa cópia descartável (§3.5);
  - `textos`: os idiomas (`DM-I18`);
  - `teste`: rode e leia o teste alterado.
- **Fechamento**, com o **mesmo** `--prefixo-api` do parcial (sem ele, o script usa o gravado no
  ledger; item `api:` sem par exato casa por sufixo de caminho, com aviso), a base da PR e o
  working tree (a correção que o QA fez e ainda não foi commitada):
  ```bash
  python "$QA/scripts/escopo_diff.py" --base origin/develop --incluir-working --prefixo-api api/v1 --ledger "$R" --falhar-se-descoberto
  ```
  Sem `--incluir-working` e com alteração não commitada fora de `.qa/`, o script avisa que a correção
  do QA ficou fora do quadro.
  O quadro "mudou × testado" mostra cada item do escopo com os casos e a situação (testado,
  "testado (falha corrigida: D-NNN)" quando o defeito foi retestado com regressão que passou,
  pendente, com falha, não coberto, sem prova). A coluna **Herdados** mostra à parte os casos dos itens
  `api:` que saem de um arquivo do front: eles não cobrem o arquivo (um front nunca aberto não vira
  "testado" por `curl`). Exit 1 significa item sem caso próprio, pendente, **arquivo do diff só com
  `nao-aplicavel`/`bloqueado`/`nao-validado`**, item do raio só com esses status e justificativa
  genérica ou curta, ou arquivo com raio não calculado: o relatório não diz "pronto".

### 4.3 Ledger

- Itens novos do tipo `arquivo:<caminho>` (alterado ou no raio), com `descoberto_por` `diff` ou
  `raio-de-impacto` e `pai` apontando quem o puxou.
- `componente:`, `tela:` e `api:` seguem a gramática de sempre. Chamada do front sai com
  `descoberto_por: diff-chamada-front`: confirme a rota real na aba de rede antes de testar.
- Item que não tem superfície testável sozinho (tipo, utilitário puro) recebe caso pelo uso real
  que o exercita, com o `item_id` dele e a tela no `passos`.
- Registre na rodada a base, o merge-base e o commit testado: reteste em outro commit é outra
  rodada.

### 4.4 Armadilhas

- **O raio é heurístico.** Ficam de fora:
  - injeção de dependência registrada por configuração;
  - reflexão;
  - rota ou handler montados por string;
  - evento publicado por nome;
  - chave de i18n;
  - CSS global;
  - feature flag lida do banco.

  Complete a mão lendo o diff, e registre o que acrescentou (`descoberto_por: critico`).
- **Linguagem sem suporte.** O parser cobre TS/JS, Python, C#, Java/Kotlin e Go. Para Dart,
  Swift, Rust, Ruby, PHP, C/C++, Scala, Elixir, templates (`.html`, Razor, Jinja, Twig, ERB…) e
  afins, o script **não calcula o raio**: escreve "Linguagem sem suporte: raio NAO calculado" no MD
  e no JSON, faz um plano B por nome (sem parser: identificadores das linhas +/- dos hunks, as
  definições que envolvem cada hunk e o nome do arquivo, procurados em todo arquivo de texto, só
  no nível 1) e, com `--falhar-se-descoberto`, sai 1 enquanto houver arquivo sem raio. Complete o
  raio à mão (quem usa o que mudou, até a tela), registre na nota o que acrescentou e só então rode
  com `--aceitar-raio-incompleto`. Nunca passe a flag sem ter lido o diff.
- **Barrel files** (`index.ts` que reexporta) inflam o raio: confira se o importador usa mesmo o
  símbolo alterado.
- **Monorepo:** o script lê os workspaces (`package.json` `workspaces`, `pnpm-workspace.yaml`,
  `lerna.json`) e resolve `@escopo/pacote` e `@escopo/pacote/sub` para o arquivo de entrada do
  pacote (`exports`, `source`, `module`, `main`, `types`, `src/index.*`; `dist/` vira `src/`).
  Workspace que ele não reconhece (Nx, Bazel, Gradle multi-projeto): o consumidor em outro pacote só
  aparece pela busca por nome, e some com `--sem-simbolos`.
- **Impacto entre repositórios:** front e back separados, pacote compartilhado. Rode o script em
  cada repositório e cruze o endpoint alterado no back com as chamadas do front.
- **O working tree tem mudança de outra sessão:** compare com o `git status` inicial (fase 0) e
  separe. O gate exclui sozinho o que está em `notas/00-git-status-inicial.txt` (linhas `XY caminho`
  do `git status --short`; num rename, os dois caminhos) e diz quantos arquivos do diff saíram da
  conta; o `escopo_diff.py` com `--ledger` (ou com `--parcial` em `<rodada>/parciais/`) faz o mesmo,
  então o arquivo de outra sessão nem vira item. Para excluir mais, `escopo_diff --excluir
  <glob>` no `--parcial`, que o gate repete. Se o pedido é testar justamente essas alterações não
  commitadas ("testa o que eu não commitei"), gere o parcial com `--manter-status-inicial`; se todo o
  diff sair da conta, o gate reprova ("nada foi conferido") em vez de passar vazio. Arquivo que já estava
  sujo e que você também corrigiu sai do quadro: a correção continua cobrada pelo defeito (regressão e
  `estatico:`), e a nota 07 diz que o arquivo é misto (a entrega separa por trecho).
- **Arquivo renomeado:** quem ainda importa o caminho antigo aparece no raio. É quebra, não
  regressão.
- **Símbolo de nome genérico** (`get`, `save`, `index`) não é buscado por nome; o import ainda
  conta. O aviso do script lista quais ficaram de fora.
- **Teste verde no escopo não prova a tela:** é camada 2, não substitui a camada 4.

### 4.5 Códigos sugeridos

- **MA-4-01** Gere o escopo com `escopo_diff.py` contra o destino da PR e faça o merge do parcial → verifique que todo arquivo alterado e todo arquivo do raio têm item e caso.
- **MA-4-02** Leia o diff hunk a hunk e classifique cada um → verifique que todo hunk de lógica tem um caso que o exercita na tela ou na API.
- **MA-4-03** Para cada componente ou utilitário alterado, teste um uso real de cada configuração listada no raio → verifique que nenhum uso regrediu (`DM-CMP-01`).
- **MA-4-04** Para cada tela listada em "Telas afetadas", abra a tela real e exercite o trecho que monta o arquivo alterado → verifique com print e rede.
- **MA-4-05** Para cada endpoint alterado no back, ache as chamadas do front (deste e de outros repositórios) → verifique contrato e comportamento pelos dois lados.
- **MA-4-06** Rode os testes automatizados listados no escopo antes e depois da mudança → verifique mesma contagem ou melhor, e leia o teste alterado.
- **MA-4-07** Com marca `impacto-global`, rode build de produção, suíte e smoke dos fluxos principais → registre o número contra o baseline.
- **MA-4-08** Com marca `migracao`, rode as invariantes do módulo 3 antes e depois da migração numa cópia descartável (§3.5) → verifique zero violação nova.
- **MA-4-09** Procure o que o raio heurístico não vê (registro de DI, rota por string, evento por nome, chave de i18n) → acrescente os itens com `descoberto_por: critico`.
- **MA-4-10** Feche com `escopo_diff.py --base <destino> --incluir-working --prefixo-api <o mesmo do parcial> --ledger <rodada> --falhar-se-descoberto` → verifique saída 0 e anexe o quadro "mudou × testado" ao relatório.

---

## 5. Testes automáticos de regressão: `MA-5`

Fluxo que passou com prova vira teste automatizado. A rodada seguinte começa rodando todos eles,
e o que quebrou vira caso antes do primeiro clique.

### 5.1 Quando ativa

- **Gerar:** fim da rodada, para fluxos com status `passou` e prova estável (sem dado que muda a
  cada execução).
- **Rodar:** fase 0 da rodada seguinte, sempre que `.qa/regressao/` ou a suíte do projeto
  existirem.
- **Não gerar:** fluxo com efeito externo sem modo de teste, ou que depende de papel que não tem
  sessão reutilizável. Anote o motivo na nota.

### 5.2 Onde salvar

| Situação | Onde | Por quê |
|---|---|---|
| Sem autorização para alterar código | `.qa/regressao/` (fora do git pelo `.git/info/exclude`), com config própria que usa o framework **já instalado** | não toca o repositório |
| Com autorização | a pasta de testes do projeto, no padrão que ele já usa (`e2e/`, `tests/`, `*.spec.ts`, `test_*.py`) | o time passa a rodar |

Nunca crie runner, CI ou dependência nova sem pedido. Projeto sem framework de teste: proponha
(qual, por quê, quanto custa) e gere em `.qa/regressao/` só o que roda com o que existe. Um
Playwright ou pytest instalado globalmente conta, com nota.

### 5.3 Do `replay/passos.yaml` ao teste

| Projeto | Framework típico | Prova |
|---|---|---|
| Web | Playwright (`@playwright/test`), Cypress | `getByTestId`/`getByRole`; `waitForResponse` com status; texto do toast |
| API | pytest + httpx/requests, Jest/Vitest + supertest, xUnit + `WebApplicationFactory`, REST Assured | status, corpo, leitura de volta pela própria API |
| Biblioteca e CLI | o runner de unidade do projeto | retorno, exceção, código de saída, stdout |

Exemplo Playwright, gerado a partir de um fluxo que passou:

```ts
import { test, expect } from '@playwright/test'

const base = process.env.QA_BASE_URL ?? 'http://localhost:3000'
const proibidos = (process.env.QA_HOSTS_PROIBIDOS ?? '').split(',').filter(Boolean)

test.beforeAll(() => {
  const host = new URL(base).host
  if (proibidos.some((h) => host.includes(h))) throw new Error(`QA bloqueado: ${host} esta na lista de producao`)
})

test('[C-0012][EL-TXT-03] Salvar com CNPJ vazio bloqueia sem requisicao', async ({ page }) => {
  await page.goto(`${base}/clientes/novo`)
  let posts = 0
  page.on('request', (r) => { if (r.method() === 'POST' && r.url().includes('/cliente')) posts++ })
  await page.getByTestId('cliente-save-button').click()
  await expect(page.getByText('CNPJ é obrigatório')).toBeVisible()
  expect(posts).toBe(0)
})

test('[C-0001][EL-BTN-01] Salvar cliente valido grava', async ({ page }) => {
  const sufixo = Date.now().toString().slice(-6)
  await page.goto(`${base}/clientes/novo`)
  await page.getByTestId('cliente-nome-input').fill(`QA ${sufixo}`)
  const resposta = page.waitForResponse((r) => r.url().includes('/cliente') && r.request().method() === 'POST')
  await page.getByTestId('cliente-save-button').click()
  expect((await resposta).status()).toBe(201)
})
```

- **Sessão sem senha.** O usuário loga uma vez num perfil persistente, ou gera um `storageState`
  com a sessão dele. O arquivo de sessão é segredo: fica em `.qa/`, nunca em evidência, relatório
  ou repositório. Sessão expirada derruba tudo com 401, e isso não é regressão.
- **Dados isolados.** Cada teste cria o próprio registro, com prefixo `QA <data>` e sufixo único;
  nunca depende de registro de outra pessoa. A limpeza só pelo caminho de negócio, se existir.
  Ambiente compartilhado: cada execução gera sujeira, registre-a.
- **Sem segredos no código do teste:** URL, usuário e token vêm de variável de ambiente.
- **Trava de produção** no `beforeAll`, com a lista de hosts do PERFIL. Efeito externo atrás de uma
  variável explícita (`test.skip(!process.env.QA_PERMITE_EMAIL)`).
- **Espera por condição**, nunca `sleep`. O timeout é o tempo medido mais folga.
- **Rastreável:** o título traz o caso e o código do catálogo.
- **Mapa:** `replay/passos.yaml` (fluxo) ↔ arquivo de teste, na nota da fase 10.

### 5.4 Rodada seguinte

1. Rode antes de tudo. Por exemplo:
   `npx playwright test --config .qa/regressao/playwright.config.ts --reporter=json > .qa/<rodada>/rede/regressao.json`.
   Registre em `rodada.baselines` (`gate: "regressao-qa"`, "N passaram, M falharam, K pulados").
2. Cada falha vira caso `[MA-5-04] regressão automática: <teste>`, técnica `regressao`, no item do
   fluxo, com o trace ou o print do runner como evidência.
3. **Triagem antes de chamar de regressão:**
   - mudou a regra (`git log -S`, `LI-51`)? Então é decisão, e o teste se atualiza com o ok de quem
     decide;
   - ambiente ou sessão (401, servidor fora)? Então é `bloqueado`;
   - intermitente (passa ao repetir uma vez)? Então é achado de estabilidade, registrado;
   - sobrou: regressão real, defeito.
4. **Nunca ajuste o teste para passar** sem entender a falha. Teste que falhava antes da mudança é
   achado, não ruído.

### 5.5 Armadilhas

- **Teste que não afirma nada** (só navega) passa sempre: todo teste tem `expect` do efeito.
- **Seletor por texto** quebra na troca de idioma; por coordenada ou `nth-child`, na troca de
  layout.
- **Ordem entre testes e dado compartilhado** criam falha intermitente: cada teste se basta.
- **Fuso e relógio:** datas relativas ("hoje") falham à meia-noite. Fixe o fuso do runner.
- **Modo de desenvolvimento duplica efeitos:** rode contra o build quando contar requisições.
- **Acúmulo de dado de teste** em ambiente compartilhado vira problema do time: limpeza ou volume
  mínimo.

### 5.6 Códigos sugeridos

- **MA-5-01** No fim da rodada, liste os fluxos `passou` com prova estável → gere um teste por fluxo no framework do projeto, com `data-testid` e afirmação do efeito.
- **MA-5-02** Antes de gravar o teste, procure segredo, URL fixa de ambiente e dado de terceiro → verifique que tudo vem de variável de ambiente e que o teste cria o próprio dado.
- **MA-5-03** Rode o teste novo duas vezes seguidas e uma vez em ordem diferente → verifique que passa sempre e não depende de outro teste.
- **MA-5-04** No início da rodada seguinte, rode a suíte de regressão antes de qualquer clique → registre o baseline e abra um caso `regressao` por falha.
- **MA-5-05** Para cada falha da suíte, faça a triagem (regra mudou, ambiente, intermitente, regressão) → verifique com `git log -S` e repetição antes de chamar de defeito.
- **MA-5-06** Confira a trava de produção do teste apontando para um host da lista proibida → verifique que o teste se recusa a rodar.
- **MA-5-07** Para cada defeito corrigido na rodada, escreva o teste que falhava antes da correção → verifique que falha no código antigo e passa no novo.

---

## 6. Segurança funda: `MA-6`

Complementa o `DM-SEC`, o `DM-TEN` e o `DM-AUT` do catálogo com o método: o que rodar, onde, até
onde ir e como provar sem causar estrago.

**Limites, sempre:**

- prove com o mínimo, uma requisição que mostre o problema, e pare;
- não baixe dados, não escale e não encadeie;
- nunca use credencial encontrada;
- nunca faça teste de carga;
- nada que escreva em produção;
- payload hostil só em ambiente de teste.

### 6.1 Quando ativa

| Parte | Onde pode |
|---|---|
| Dependências, segredos, varredura estática | qualquer ambiente: só lê o repositório |
| Cabeçalhos, cookies, preflight de CORS (GET/HEAD/OPTIONS sem credencial alheia) | qualquer ambiente, inclusive produção |
| Autorização e IDOR por leitura (GET com a sessão do papel) | teste; em produção só com pedido explícito |
| IDOR, mass assignment ou autorização com escrita; limite de taxa; upload; injeção | só ambiente de teste, com autorização da rodada, sobre dado criado pelo teste |

### 6.2 Dependências vulneráveis

| Ecossistema | Comando (somente leitura) |
|---|---|
| npm | `npm audit --json` (com `--omit=dev` para o que vai ao ar) |
| pnpm | `pnpm audit --json` |
| Yarn 1 | `yarn audit --json` |
| Yarn 2+ | `yarn npm audit --all --recursive --json` |
| Python | `pip-audit -r requirements.txt -f json`. Com Poetry: `poetry export -f requirements.txt` e depois `pip-audit -r` |
| .NET | `dotnet list package --vulnerable --include-transitive` (precisa do restore feito) |
| Ruby | `bundle-audit check --update` |
| Go | `govulncheck ./...` (diz se o código chega a chamar a função vulnerável) |
| Rust | `cargo audit --json` |
| Java | `mvn org.owasp:dependency-check-maven:check` ou o plugin do Gradle (lento, baixa a base do NVD) |
| PHP | `composer audit --format=json` |
| Vários | `osv-scanner -r .` ou `trivy fs --scanners vuln .`, se instalados |

- **Nunca** `npm audit fix`, `--force` nem atualização de pacote: isso altera o projeto.
- Ferramenta ausente: "não executável", com o comando de instalação como proposta.
- **Registre:** contagem por severidade, direta × transitiva, se há correção disponível e, quando a
  ferramenta diz, se o código alcança a função vulnerável. Crítica alcançável é defeito `alto`;
  transitiva sem uso é `melhoria` com prazo.

### 6.3 Segredos no repositório e no histórico

```bash
python "$QA/scripts/segredos.py" . --json --saida "$R/rede/segredos.json"
python "$QA/scripts/segredos.py" . --historico --max-commits 5000
python "$QA/scripts/segredos.py" .next/static --tudo
```

- O primeiro varre o repositório: arquivos rastreados e novos, respeitando o `.gitignore`.
- O segundo (`--historico`) varre o histórico: custo alto, e só com autorização.
- O terceiro varre o **bundle** que vai ao navegador (`.next/static`, `dist/`, `build/`). Ali,
  tudo é público, inclusive variáveis `NEXT_PUBLIC_*`, `VITE_*` e `REACT_APP_*`.
- **A saída nunca traz o valor:** traz `arquivo:linha`, a regra, o valor mascarado e um `id`
  (impressão digital).
  - Falso positivo comprovado vai num arquivo de ignorados, pelo `id` (`--ignorar`).
  - Segredo de teste proposital: marque a linha com `segredos:ignorar`.
- **Segredo encontrado:** defeito, com severidade pelo alcance (produção > teste; chave de nuvem ou
  banco > chave de serviço de baixo risco).
  - Recomende rotacionar: o que entrou no git está exposto, mesmo apagado depois. O achado "só no
    histórico" continua válido.
  - Recomende mover para cofre ou variável de ambiente.
  - Nunca teste a credencial para "ver se funciona".
- Saída 1 com achado não é falha da rodada: é a evidência do caso.

### 6.4 Cabeçalhos HTTP, cookies e CORS

Leia a resposta de um GET da página e de uma rota da API:

- `curl -s -D - -o /dev/null https://<host>/`;
- no PowerShell, `(Invoke-WebRequest https://<host>/ -UseBasicParsing).Headers`;
- ou `fetch` na página e `[...r.headers]`, só para mesma origem.

| Cabeçalho | Esperado |
|---|---|
| `Content-Security-Policy` | presente; sem `unsafe-eval`; `unsafe-inline` justificado; `frame-ancestors` restrito (rotas de embed podem liberar, documentado) |
| `Strict-Transport-Security` | em HTTPS, `max-age` ≥ 15552000 e `includeSubDomains` quando couber |
| `X-Content-Type-Options` | `nosniff` |
| `X-Frame-Options` ou `frame-ancestors` | `DENY`/`SAMEORIGIN`, salvo embed |
| `Referrer-Policy` | `strict-origin-when-cross-origin` ou mais restrito |
| `Permissions-Policy` | presente, desligando o que o produto não usa |
| `Server`, `X-Powered-By` | sem versão de software |
| `Cache-Control` em resposta autenticada com dado pessoal | `no-store` |

**Cookies de sessão** (lidos no `Set-Cookie` da resposta de login que o usuário fizer, ou na aba de
armazenamento do navegador):

- `HttpOnly`, `Secure` e `SameSite` (`Lax` ou `Strict`);
- `Path` e `Domain` mínimos e expiração coerente;
- token de sessão em `localStorage`/`sessionStorage` fica exposto a XSS: registre como achado de
  projeto, sem propor a troca sozinho.

**CORS**, por preflight sem credencial:

```bash
curl -s -D - -o /dev/null -X OPTIONS https://<api>/<rota> \
  -H "Origin: https://origem-falsa.exemplo" -H "Access-Control-Request-Method: GET"
```

`Access-Control-Allow-Origin` ecoando a origem falsa junto de `Access-Control-Allow-Credentials:
true` é defeito `alto`.

### 6.5 Autorização no back do que o front esconde

1. **Matriz estática:** endpoints × proteção, a partir dos controllers e rotas e do
   `escopo_diff.py` ou do OpenAPI.

   | Stack | O que procurar |
   |---|---|
   | .NET | `[Authorize]`, `[Authorize(Policy=…)]`, `[AllowAnonymous]` |
   | Express/Nest | middleware de rota, `@UseGuards` |
   | FastAPI | `Depends(...)` |
   | Django | `@login_required`, `permission_classes` |
   | Spring | `@PreAuthorize` |

   Endpoint com só "autenticado" e regra de papel só no front: anote.
2. **Dentro do service:** existe checagem de dono, de tenant ou de papel? Grep pelo usuário da
   sessão no service do endpoint.
3. **Dinâmico:** chame o endpoint com a sessão do papel que **não** deveria poder.
   - Leitura: GET (execução §1.2).
   - Escrita: só em teste, sobre dado do próprio teste, e confira no banco que nada mudou.
   - Se o back aceitou, a escrita aconteceu: registre o defeito **e** a sujeira.
4. **Mesmo efeito por outro caminho:** combo de status, endpoint em lote, rota antiga, exportação
   (`LI-42`, `LI-45`).
5. Quando a regra é só de front por decisão registrada, o caso registra isso e o caminho exposto,
   sem ser "passou".

### 6.6 IDOR e tenant cruzado em todo endpoint com id

1. **Inventário:** todo endpoint com id na rota, na query ou no corpo, inclusive `parentId`,
   `tenantId`, `ownerId`, anexo e download.
2. **Dois donos:** peça ao usuário a segunda sessão (outro tenant ou outro usuário) ou leia no banco
   ids de registros de outro dono.
3. **Leitura:** GET do id alheio com a sessão própria. Esperado 403 ou 404; 200 com dado é defeito
   `critico` ou `alto`.
4. **Escrita (só teste):**
   - a sessão A cria o registro;
   - a sessão B tenta PUT, PATCH e DELETE sobre ele;
   - esperado 403/404 e banco igual (`MA-3-05`).
5. **Corpo:** troque `tenantId`/`ownerId`/`status`/preço no corpo (mass assignment). Esperado:
   ignorado ou recusado, conferido no banco.
6. **Listas e agregados:** "todos", "pendentes", "busca", "exportar", "estatísticas" e painéis
   embutidos filtram pelo tenant da sessão (`DM-TEN-03`, `DM-TEN-05`).
7. **GUID não é proteção:** se outro endpoint lista o id, ele é descobrível.

### 6.7 Limite de taxa, dados sensíveis e upload

- **Limite de taxa** (só teste, com autorização): rajada pequena (10 a 20 requisições) em
  recuperação de senha, envio de código, formulário público e busca pesada. Pare no primeiro 429.
  - Nunca em login com conta real (bloqueia a pessoa).
  - Nunca com e-mail real fora das caixas autorizadas.
- **Dados sensíveis:**
  - procure nos `rede/*.json` chaves como `password`, `hash`, `token`, `secret`, documento pessoal
    e cartão;
  - dados de outro usuário numa resposta que não precisa deles;
  - pilha, SQL ou caminho do servidor em resposta de erro;
  - token na URL (vai para log e `Referer`);
  - dado pessoal no log (`MA-1-07`).
- **Upload** (só teste):
  - extensão trocada (`.png` com conteúdo de script);
  - SVG com `<script>` servido inline;
  - arquivo acima do limite;
  - nome com `../`;
  - `Content-Disposition` e tipo de resposta no download;
  - URL pública adivinhável de anexo de outro tenant (`DM-TEN-06`).

### 6.8 Ledger

| O quê | Item | Técnica |
|---|---|---|
| Dependências | `seguranca:dependencias/<ecossistema>` | `estatico` |
| Segredos | `seguranca:segredos` (e `seguranca:segredos/historico`) | `estatico` |
| Cabeçalhos e cookies | `seguranca:cabecalhos/<host>`, `seguranca:cookies/<host>` | `seguranca` |
| CORS | `seguranca:cors/<host>` | `seguranca` |
| Autorização por endpoint | o `api:` de cada endpoint, um caso por papel proibido | `rbac` |
| IDOR e mass assignment | o `api:` de cada endpoint com id | `seguranca` |
| Limite de taxa e upload | o `api:` correspondente | `seguranca` |

- Evidência sem segredo: status, corpo cortado e mascarado, consulta ao banco depois.
- Severidade: `critico` para dado de outro tenant lido ou escrito, escrita sem autorização ou
  segredo de produção exposto; `alto` para autorização só no front em ação sensível, CORS com
  credencial aberto ou dependência crítica alcançável.

### 6.9 Armadilhas

- **403 da UI não prova o back:** só a chamada direta prova (`LI-43`).
- **Duas sessões no mesmo navegador** misturam cookie e token: um papel por perfil de navegador
  (`LI-47`).
- **Permissão alterada pode exigir novo login** antes de concluir (`LI-46`).
- **Cabeçalho ausente no dev e presente em produção** (ou o contrário): leia no ambiente que importa,
  só com GET.
- **`npm audit` sem lockfile** não roda, e com lockfile desatualizado mente: diga qual lockfile leu.
- **A varredura de segredos acha o próprio teste:** use `segredos:ignorar` ou o `id` no arquivo de
  ignorados, com o motivo.

### 6.10 Códigos sugeridos

- **MA-6-01** Rode a auditoria de dependências de cada ecossistema do projeto, só leitura → registre contagem por severidade, direta × transitiva e correção disponível.
- **MA-6-02** Rode `segredos.py` no repositório e no bundle publicado → verifique zero segredo; cada achado vira defeito com `arquivo:linha`, `id` e a recomendação de rotacionar.
- **MA-6-03** Com autorização, rode `segredos.py --historico` → verifique segredos que saíram do HEAD mas continuam no histórico e precisam de rotação.
- **MA-6-04** Leia os cabeçalhos de segurança da página e de uma rota da API em cada ambiente → verifique CSP, HSTS, `nosniff`, `frame-ancestors`, `Referrer-Policy` e ausência de versão de software.
- **MA-6-05** Leia os atributos do cookie de sessão e onde o token fica guardado → verifique `HttpOnly`, `Secure`, `SameSite` e registre token em armazenamento acessível por script.
- **MA-6-06** Mande preflight com origem falsa a cada API → verifique que a origem não é ecoada junto de credenciais.
- **MA-6-07** Monte a matriz endpoint × proteção lendo controllers e services → verifique que toda ação que o front esconde por papel é barrada no back pela chamada direta.
- **MA-6-08** Em todo endpoint com id (rota, query, corpo, anexo), use o id de outro dono com a própria sessão → verifique 403/404 na leitura e, em teste, banco intacto na escrita.
- **MA-6-09** Procure nas respostas, nas URLs e nos logs da rodada senha, hash, token, documento pessoal e pilha de erro → registre onde aparece, nunca o valor.
- **MA-6-10** Em ambiente de teste, mande campos extras no corpo (`tenantId`, `ownerId`, `status`, preço) → verifique no banco que foram ignorados.
- **MA-6-11** Em ambiente de teste, faça rajada pequena nos endpoints que enviam código, e-mail ou fazem busca pesada → verifique 429 ou limite equivalente e pare no primeiro.
- **MA-6-12** Em ambiente de teste, envie arquivo com extensão trocada, SVG com script, nome com `../` e acima do limite → verifique recusa e o tipo de resposta no download.

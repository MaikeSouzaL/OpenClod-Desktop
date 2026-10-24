<!--
Modelo de UM defeito (vale também para melhoria, decisão de produto e retratação).
Um bloco por D-NNN. Cole na nota da fase ou salve em .qa/<rodada>/defeitos/D-NNN.md.
Os campos espelham cobertura.json -> defeitos[]: mantenha os dois iguais.
Troque cada {{...}}. Não apague seção: se não se aplica, escreva "não se aplica" e por quê.
As 4 partes (ANTES, POR QUE, DEPOIS, STATUS) são fixas: é o formato que vai para o relatório.
-->

## D-{{NNN}} — {{o sintoma em uma frase, como quem usa a tela descreveria}}

| Campo | Valor |
|---|---|
| Severidade | {{critico / alto / medio / baixo}} — {{por quê: o impacto em quem usa ou no dado}} |
| Tipo | {{defeito / melhoria / decisao-de-produto / retratado}} |
| Status | {{aberto / corrigido / retestado-ok / nao-corrigido}} |
| Justificativa | {{obrigatória em nao-corrigido e em corrigido sem reteste: outro time, decisão de produto, fora do escopo, sem autorização, reinício pendente — ou "não se aplica"}} |
| Evidências no ledger | antes: `{{evidencias/NN-...-ANTES-circulado.png}}` · depois: `{{...-CORRIGIDO-circulado.png}}` · reteste: `{{...-RETESTE-circulado.png}}` |
| Item e casos | `{{tela:/rota}}` · {{C-0001, C-0002}} |
| Onde | `{{caminho/do/arquivo.ext:linha}}` ({{repositório}}) |
| Ambiente | {{front → API → banco}} · papel: {{papel/usuário de teste}} |
| Código testado | `{{branch}}` @ `{{commit curto}}` |
| Achado em | {{AAAA-MM-DDTHH:MM:SS-03:00, saída de date}} |

### Como reproduzir

1. {{passo}}
2. {{passo}}
3. {{passo}}

- **Esperado:** {{o que deveria acontecer}} — oráculo: {{código / especificação / regra dita pelo usuário / comportamento anterior}}
- **Obtido:** {{o que aconteceu, medido: valor, status HTTP, tempo, texto exato}}
- **Reproduzido por outro caminho:** {{como — descarta a ferramenta: clique real em vez de script, outra aba, chamada direta à API}}
- **Foi de propósito?** {{resultado de `git log -S` / histórico de decisões: nada encontrado, ou o commit e a decisão}}

### 1. ANTES — o que estava errado

{{O que quem usa vê, em 1 a 3 frases. Com o valor real, não com adjetivo.}}

![{{NN}} — {{o que mostra}}](../evidencias/{{NN-o-que-mostra}}-ANTES-circulado.png)

*{{NN}}: {{o que o print MOSTRA — valores, códigos, estado do botão, texto do erro}}.*

Prova:

- Rede: `{{MÉTODO /caminho}}` → **{{status}}** em {{tempo}} — enviado `{{trecho do corpo}}`, recebido `{{trecho}}` (`rede/{{NN-chamada}}.json`)
- Banco (somente leitura): `{{consulta}}` → {{resultado}}
- Efeito a jusante: {{o que mais ficou errado: listagem, contador, e-mail, registro gerado}}

### 2. POR QUE — a causa no código

- **Arquivo:** `{{caminho/do/arquivo.ext:linha}}`
- **Causa:** {{1 a 3 frases: quem escreve o valor, quem lê, onde diverge}}
- **Trecho:**

```{{linguagem}}
{{o trecho mínimo que mostra a causa}}
```

- **Alcance (grep):** {{outros usos do componente, cópias da mesma lógica, constantes duplicadas, outros caminhos para o mesmo efeito — ou "nenhum além deste"}}

### 3. DEPOIS — o que mudou

- **Mudança:** {{o que foi feito, em 1 a 3 frases}} — `{{arquivo(s)}}`
- **Verificação mecânica:** `git diff --stat` = `--ignore-cr-at-eol --stat` ({{N}} linhas) · typecheck {{X}} (baseline {{Y}}) · lint {{...}} · build {{...}} · testes {{...}}
- **Reinício necessário:** {{não / sim — pedido ao usuário em {{data}}, confirmado em {{data}}}}

![{{NN}} — {{o que mostra}}](../evidencias/{{NN-o-que-mostra}}-CORRIGIDO-circulado.png)

*{{NN}}: {{o que o print mostra agora, no mesmo enquadramento do ANTES}}.*

Prova:

- Rede: `{{MÉTODO /caminho}}` → **{{status}}** — {{trecho que prova}}
- Banco: `{{consulta}}` → {{resultado}}
- **Par de controle:** {{o caso que não deveria mudar, e o que se viu}}
- **Teste inverso:** {{tirar a condição → efeito some; devolver → volta — ou "não se aplica"}}
- **Regressão:** {{casos C-NNNN e usos do componente retestados, com o resultado}}

### 4. STATUS

**{{RETESTADO-OK / CORRIGIDO, SEM RETESTE / NÃO CORRIGIDO / RESOLVEU / PRECISA DE AJUSTE}}**

- {{motivo do status; se não corrigido: quem precisa agir e por quê (outro time, decisão de produto, fora do escopo, sem autorização)}}
- {{se houve decisão: "fala literal" — quem, data, canal}}
- **Não validado:** {{o que ficou sem prova e por quê — ou "nada"}}
- **Sujeira deste item:** {{o que ficou criado/alterado — ou "nenhuma"}}

<!--
VARIANTE — decisão de produto: no lugar de DEPOIS, use:

### 3. PERGUNTA PARA QUEM DECIDE ({{nome/papel}})

> Hoje, ao {{ação}}, a tela {{comportamento}} (print {{NN}}). O código faz assim desde
> `{{commit}}` ({{data}}). Deve continuar assim, ou passar a {{alternativa}}?
> Se mudar, o efeito é {{efeito}}.

VARIANTE — retratado: troque as 4 partes por:

### O que parecia
{{o achado como foi registrado}}

### O que era
{{a causa real: ferramenta, hora da medição, dado, ambiente}}

### Como descobri
{{o segundo caminho, o controle, a medição que derrubou}}

### O que muda no método
{{a lição — grave com scripts/aprender.py licao (references/aprender.md): genérica na skill, do projeto com --destino perfil}}

VARIANTE — reteste de correção feita por outra pessoa: em DEPOIS, use o print -RETESTE,
diga o commit/versão testado e o veredito RESOLVEU ou PRECISA DE AJUSTE (com o que falta).
-->

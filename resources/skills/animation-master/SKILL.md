---
name: animation-master
description: "Criação e revisão de animações para a web: SVG animado (SMIL), CSS keyframes/transições, Web Animations API, Canvas e microinterações de interface (loaders, ícones animados, entradas de tela, estados de botão). Use SEMPRE que pedirem animar algo, 'dar vida' a um ícone/logo, criar loader/spinner/skeleton, transição de página, animação de entrada, efeito de hover, apresentação animada ou melhorar uma animação existente — mesmo sem dizer 'animação'. Em inglês: animate this, loading animation, animated SVG, micro-interaction, CSS keyframes, motion design. Não use para vídeo, GIF gravado, edição de imagem ou 3D."
---

# Animation Master — Role, Task, Format (RTF)

## Role

Você é um **motion designer e engenheiro front-end**. Uma boa animação explica o que mudou na tela
(causa e efeito), não decora. Ela precisa ser fluida (60 fps), acessível (respeita quem pediu menos
movimento) e pequena (sem biblioteca quando CSS/SVG resolvem).

## Task

1. **Entenda o pedido:** o que anima, por quê (feedback, atenção, continuidade, marca), onde roda
   (página, app Electron, e-mail, apresentação), duração desejada e se repete. Se faltar algo que muda o
   resultado, pergunte uma vez; senão assuma o padrão seguro e diga a suposição.
2. **Carregue esta skill** com `use_skill` antes de criar ou revisar. Se for um ícone/logo novo, use também
   a skill `svg-master` para desenhar a forma estática primeiro; só depois anime.
3. **Escolha a técnica mais simples que serve:**
   | Caso | Técnica |
   |---|---|
   | Ícone/logo/ilustração vetorial que se move sozinho | SVG com `<animate>`, `<animateTransform>` ou CSS dentro do `<style>` do SVG |
   | Entrada, saída, hover, foco, loader, skeleton em HTML | CSS (`transition`, `@keyframes`) |
   | Sequência controlada por código, pausa/retomada, encadeamento | Web Animations API (`element.animate`) |
   | Muitos objetos, partículas, gráficos que não são DOM | Canvas 2D com `requestAnimationFrame` |
4. **Regras de ouro (siga todas):**
   - Anime só `transform` e `opacity` (compositor, sem layout). Evite animar `width`, `height`, `top`,
     `left`, `margin`, `padding`, `box-shadow` e `filter: blur()` em elementos grandes.
   - Durações: microinteração 120–200 ms, transição de elemento 200–350 ms, entrada de tela 300–500 ms;
     loops contínuos 0,8–2 s por ciclo. Nada acima de 1 s para feedback de clique.
   - Easing: saída `cubic-bezier(.2,.8,.2,1)`, entrada `cubic-bezier(.4,0,1,1)`, movimento contínuo
     `linear` (spinners). Nunca `linear` em deslocamento de interface.
   - **Acessibilidade obrigatória:** todo movimento que repete ou cruza a tela tem um bloco
     `@media (prefers-reduced-motion: reduce)` que o pára ou troca por um fade curto. SVG animado
     autônomo que não consegue usar CSS deve ter `repeatCount` finito ou ficar parado em estado final legível.
   - Estado final legível: se a animação não rodar (JS desligado, e-mail), o quadro estático precisa fazer sentido.
   - `transform-origin` explícito (`transform-box: fill-box; transform-origin: center` em SVG).
   - Sem `<script>`, sem recursos externos, sem fontes remotas em SVG autônomo.
   - `will-change` só em elementos que realmente animam, e removido depois.
5. **Escreva o arquivo** (`write_file`): para SVG, um `.svg` autônomo; para web, um `.html` de demonstração
   com o CSS/JS inline, para abrir direto no navegador.
6. **Valide antes de entregar:**
   - Rode `node <skill-dir>/scripts/check-animation.mjs <arquivo>` e leia a saída real: corrija todo
     `ERRO` e justifique ou corrija cada `AVISO`.
   - **Prove que se mexe, mesmo sem enxergar imagens:** rode
     `node <skill-dir>/scripts/check-animation.mjs <arquivo.svg|.html> --frames` (use `--times 0,250,500,750,1000`
     para outros instantes). Ele renderiza o arquivo num Chrome/Edge de verdade em instantes fixos e mede a
     porcentagem de pixels que mudou (`percentDifferentFromFirst`, `changed`); se a animação está declarada mas os
     quadros são iguais, devolve `ERRO`. Os PNG ficam em `outDir` para quem tem visão olhar. Num loop de 1 s, o
     quadro de 1000 ms voltar a 0% de diferença é o esperado (ponto de emenda sem salto). Animações movidas por
     `requestAnimationFrame`/JS não podem ser posicionadas no tempo: nesse caso diga que só a checagem estática vale.
   - **Veja funcionando** (se o modelo tem visão): abra o arquivo com `browser_open` (`file:///C:/caminho/arquivo.html`),
     tire `browser_screenshot` em pelo menos três instantes (use `browser_wait` entre eles) e confirme que os
     quadros são diferentes e que nada corta, pula ou sai do enquadramento. Diga o que viu em cada quadro.
   - Para loops, confira o ponto de emenda (último quadro igual ao primeiro, sem salto).

## Format (relatório final)

Comece com o caminho do arquivo e uma frase do que ele faz. Depois: técnica escolhida e por quê; duração,
easing e se repete; como respeita `prefers-reduced-motion`; saída do `check-animation.mjs` (erros e avisos
restantes com justificativa); o que você viu nos quadros do navegador; e o que não conseguiu validar
(por exemplo, desempenho em máquina lenta).

## Receitas curtas

**Spinner em SVG (CSS dentro do SVG, respeita movimento reduzido):**

```svg
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" width="24" height="24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round">
  <title>Carregando</title>
  <style>
    .arc { transform-box: fill-box; transform-origin: center; animation: spin 1s linear infinite }
    @keyframes spin { to { transform: rotate(360deg) } }
    @media (prefers-reduced-motion: reduce) { .arc { animation: none } }
  </style>
  <circle cx="12" cy="12" r="9" opacity=".25"/>
  <path class="arc" d="M12 3a9 9 0 0 1 9 9"/>
</svg>
```

**Entrada de cartão (CSS):**

```css
.card { animation: enter .35s cubic-bezier(.2,.8,.2,1) both }
@keyframes enter { from { opacity: 0; transform: translateY(8px) } }
@media (prefers-reduced-motion: reduce) { .card { animation: fade .15s both } @keyframes fade { from { opacity: 0 } } }
```

**Sequência com a Web Animations API:**

```js
const keyframes = [{ transform: 'scale(1)' }, { transform: 'scale(1.08)' }, { transform: 'scale(1)' }]
const pulse = el.animate(keyframes, { duration: 600, easing: 'ease-in-out', iterations: 2 })
await pulse.finished
```

## Armadilhas frequentes

- `transform` no CSS sobrescreve o atributo `transform` do SVG: coloque o movimento num `<g>` pai.
- SMIL `begin="0s"` conta a partir do carregamento do documento; em página longa use `begin="indefinite"` e dispare por script.
- Animar `stroke-dashoffset` exige `pathLength="1"` para a duração não depender do tamanho do traço.
- `animation-fill-mode: both` evita o "piscar" antes/depois da animação.
- Em Electron/Chrome, `prefers-reduced-motion` segue o Windows (Configurações → Acessibilidade → Efeitos visuais).

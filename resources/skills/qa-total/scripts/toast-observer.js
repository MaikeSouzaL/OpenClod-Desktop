/*
 * qa-total · scripts/toast-observer.js · observador de toast, alerta e aria-live.
 *
 * Por que existe: toast some em 3 a 5 s e o screenshot quase sempre chega tarde. E muitos
 * sistemas de toast REAPROVEITAM o mesmo no: ou trocam o texto, ou escondem o no (atributo
 * hidden, classe, style, aria-hidden) e mostram de novo com o MESMO texto. Um observador que
 * olha so childList perde o segundo toast. Este observa childList + subtree + characterData +
 * atributos (hidden, class, style, aria-hidden), rele o texto do conteiner a cada mutacao e,
 * quando o conteiner fica invisivel, esquece o texto dele: o mesmo texto mostrado de novo
 * conta como mensagem nova (respeitando a janela dedupMs).
 *
 * Instale ANTES do clique que vai produzir a mensagem:
 *   - extensao do Chrome: javascript_tool com o conteudo inteiro deste arquivo;
 *   - Playwright MCP:     browser_evaluate com  () => { <conteudo>; return window.__qa.toastsResumo() }
 *   - console do DevTools: colar e Enter.
 *
 * Grava em window.__qa.toasts, sem filtro de texto (o registro e cru de proposito: um
 * filtro por "sucesso|erro" ja perdeu um "Atencao / Revise os campos!"):
 *   { n, t, hora, texto, tipo, classe, visivel }
 *
 * Uso:
 *   __qa.toastsResumo()                     "#2 12:04:31.220 [alert] Erro / CNPJ invalido"
 *   __qa.toastsResumo(/erro/i)              filtro so na LEITURA (string, RegExp ou funcao)
 *   __qa.toastsAgora()                      textos de toast/alerta visiveis neste instante
 *   await __qa.esperarToast(null, 10000)    espera o proximo toast novo (qualquer um)
 *   await __qa.esperarToast(/salv/i, 10000) espera o proximo que casa
 *   __qa.toastsLimpar()                     zera a lista e a memoria de textos vistos; o observador
 *                                           continua (o proximo toast, mesmo com texto repetido, e gravado)
 *   __qa.toastsParar()                      desliga o observador
 *   __qa.configToast.seletor += ', .meu-toast'   ensina um conteiner novo
 *   __qa.configToast.dedupMs = 800          janela para nao gravar o mesmo texto repetido
 *
 * Regras:
 *   - Reinstale depois de toda navegacao completa (reload, URL nova digitada).
 *   - Nao instala duas vezes (marca na janela).
 *   - Validacao inline (texto vermelho embaixo do campo) nao e toast: procure-a na tela
 *     e no print, nao so aqui.
 *   - Mesmo com o texto capturado, tire o print em ate ~2 s depois da resposta.
 */
(function () {
  var MARCA = '__qaObservadorToast';
  var qa = (window.__qa = window.__qa || {});
  if (window[MARCA]) {
    var salvo = window[MARCA];
    Object.keys(salvo).forEach(function (k) {
      if (!(k in qa)) qa[k] = salvo[k];
    });
    return 'toast-observer ja instalado: ' + salvo.toasts.length + ' mensagem(ns) registrada(s). Nada foi reinstalado.';
  }
  if (typeof MutationObserver === 'undefined') return 'toast-observer: MutationObserver indisponivel nesta pagina.';

  var config = (qa.configToast = qa.configToast || {});
  if (!config.seletor) {
    config.seletor = [
      '[role="alert"]',
      '[role="alertdialog"]',
      '[role="status"]',
      '[aria-live]',
      '[data-sonner-toast]',
      '[data-testid*="toast" i]',
      '[id*="toast" i]',
      '[class*="toast" i]',
      '[class*="snackbar" i]',
      '[class*="notistack" i]',
      '.Toastify__toast',
      '.chakra-toast',
      '.MuiSnackbar-root',
      '.MuiAlert-root',
      '.ant-message',
      '.ant-notification',
      '.p-toast-message',
      '.swal2-popup',
      '.notyf__toast',
      '.iziToast'
    ].join(', ');
  }
  if (config.dedupMs == null) config.dedupMs = 800;
  if (config.maxTexto == null) config.maxTexto = 600;
  if (config.maxRegistros == null) config.maxRegistros = 300;

  var toasts = (qa.toasts = []);
  var seq = 0;
  var ultimoTextoDoConteiner = new WeakMap();
  var ultimaVezDoTexto = {};
  var esperas = [];

  function hora(d) {
    function p(n, k) {
      return String(n).padStart(k || 2, '0');
    }
    return p(d.getHours()) + ':' + p(d.getMinutes()) + ':' + p(d.getSeconds()) + '.' + p(d.getMilliseconds(), 3);
  }

  function textoDe(el) {
    var bruto = typeof el.innerText === 'string' ? el.innerText : el.textContent;
    var t = String(bruto || '').replace(/\s+/g, ' ').trim();
    var lim = Number(config.maxTexto) || 0;
    return lim > 0 && t.length > lim ? t.slice(0, lim) + '...' : t;
  }

  function visivel(el) {
    try {
      var r = el.getBoundingClientRect();
      return r.width > 0 && r.height > 0;
    } catch (e) {
      return false;
    }
  }

  function escondido(el) {
    try {
      if (el.hidden || (el.getAttribute && el.getAttribute('aria-hidden') === 'true')) return true;
      if (typeof getComputedStyle === 'function') {
        var cs = getComputedStyle(el);
        if (cs.display === 'none' || cs.visibility === 'hidden' || cs.opacity === '0') return true;
        if (cs.display === 'contents') return false;
      }
      return !visivel(el);
    } catch (e) {
      return false;
    }
  }

  function tipoDe(el) {
    var role = el.getAttribute && el.getAttribute('role');
    if (role) return role;
    if (el.hasAttribute && el.hasAttribute('aria-live')) return 'aria-live=' + el.getAttribute('aria-live');
    return 'toast';
  }

  function conteinerDe(no) {
    var el = no && no.nodeType === 1 ? no : no && no.parentElement;
    if (!el || !el.closest) return null;
    try {
      var achado = el.closest(config.seletor);
      if (achado) return achado;
      if (no.nodeType === 1 && el.querySelector) return el.querySelector(config.seletor);
    } catch (e) {
      return null;
    }
    return null;
  }

  function casa(item, filtro) {
    if (filtro == null || filtro === '') return true;
    if (typeof filtro === 'function') return !!filtro(item);
    if (filtro instanceof RegExp) return filtro.test(item.texto);
    return item.texto.toLowerCase().indexOf(String(filtro).toLowerCase()) !== -1;
  }

  function gravar(el) {
    var texto = textoDe(el);
    if (!texto || escondido(el)) {
      ultimoTextoDoConteiner.set(el, '');
      return;
    }
    var anterior = ultimoTextoDoConteiner.get(el);
    if (anterior === texto) return;
    ultimoTextoDoConteiner.set(el, texto);
    if (anterior && anterior.indexOf(texto) !== -1) return;
    var agoraMs = Date.now();
    if (ultimaVezDoTexto[texto] && agoraMs - ultimaVezDoTexto[texto] < config.dedupMs) return;
    ultimaVezDoTexto[texto] = agoraMs;
    seq += 1;
    var d = new Date(agoraMs);
    var item = {
      n: seq,
      t: d.toISOString(),
      hora: hora(d),
      texto: texto,
      tipo: tipoDe(el),
      classe: String((el.className && el.className.baseVal) || el.className || '').slice(0, 120),
      visivel: visivel(el)
    };
    toasts.push(item);
    var max = Number(config.maxRegistros) || 0;
    if (max > 0 && toasts.length > max) toasts.splice(0, toasts.length - max);
    esperas.slice().forEach(function (w) {
      if (item.n > w.desde && casa(item, w.filtro)) {
        esperas.splice(esperas.indexOf(w), 1);
        clearTimeout(w.timer);
        w.resolver(item);
      }
    });
  }

  var observador = new MutationObserver(function (mutacoes) {
    var vistos = new Set();
    for (var i = 0; i < mutacoes.length; i++) {
      var m = mutacoes[i];
      if (m.type === 'attributes' && (m.target === document.documentElement || m.target === document.body)) continue;
      var alvos = [m.target];
      if (m.type === 'childList') {
        for (var j = 0; j < m.addedNodes.length; j++) alvos.push(m.addedNodes[j]);
      }
      for (var k = 0; k < alvos.length; k++) {
        var c = conteinerDe(alvos[k]);
        if (c) vistos.add(c);
      }
    }
    vistos.forEach(gravar);
  });

  function preparar() {
    try {
      document.querySelectorAll(config.seletor).forEach(function (el) {
        ultimoTextoDoConteiner.set(el, escondido(el) ? '' : textoDe(el));
      });
    } catch (e) {}
  }

  try {
    document.querySelector(config.seletor);
  } catch (e) {
    return 'toast-observer NAO instalado: seletor invalido em __qa.configToast.seletor (' + e.message + ')';
  }
  preparar();
  observador.observe(document.documentElement, {
    childList: true,
    subtree: true,
    characterData: true,
    attributes: true,
    attributeFilter: ['hidden', 'class', 'style', 'aria-hidden']
  });

  qa.toastsResumo = function (filtro) {
    var linhas = toasts
      .filter(function (t) {
        return casa(t, filtro);
      })
      .map(function (t) {
        return '#' + t.n + ' ' + t.hora + ' [' + t.tipo + ']' + (t.visivel ? '' : ' (oculto)') + ' ' + t.texto;
      });
    return linhas.length ? linhas.join('\n') : 'nenhuma mensagem registrada' + (filtro ? ' para o filtro' : '');
  };

  qa.toastsAgora = function () {
    var achados = [];
    try {
      document.querySelectorAll(config.seletor).forEach(function (el) {
        var t = textoDe(el);
        if (t && visivel(el)) achados.push('[' + tipoDe(el) + '] ' + t);
      });
    } catch (e) {
      return 'seletor invalido: ' + e.message;
    }
    return achados.length ? achados.join('\n') : 'nenhum toast/alerta visivel agora';
  };

  qa.esperarToast = function (filtro, timeoutMs) {
    var limite = timeoutMs == null ? 10000 : timeoutMs;
    return new Promise(function (resolver) {
      var w = { filtro: filtro, desde: seq, resolver: resolver, timer: null };
      w.timer = setTimeout(function () {
        var i = esperas.indexOf(w);
        if (i !== -1) esperas.splice(i, 1);
        resolver('nenhuma mensagem nova' + (filtro ? ' casou com o filtro' : '') + ' em ' + limite + 'ms (veja tambem a validacao inline na tela)');
      }, limite);
      esperas.push(w);
    });
  };

  qa.toastsLimpar = function () {
    var n = toasts.length;
    toasts.length = 0;
    ultimoTextoDoConteiner = new WeakMap();
    ultimaVezDoTexto = {};
    return n + ' mensagem(ns) removida(s) e a memoria de textos zerada; o observador continua ativo.';
  };

  qa.toastsParar = function () {
    observador.disconnect();
    return 'observador desligado; reinstale colando o script de novo (recarregue a pagina antes).';
  };

  qa.observadorToastVersao = '1.0';
  var api = {};
  ['toasts', 'configToast', 'toastsResumo', 'toastsAgora', 'esperarToast', 'toastsLimpar', 'toastsParar', 'observadorToastVersao'].forEach(function (k) {
    api[k] = qa[k];
  });
  Object.defineProperty(window, MARCA, { value: api, enumerable: false });
  return 'toast-observer instalado em ' + location.href + '.';
})();

/*
 * qa-total · scripts/axe-inject.js · acessibilidade automatica (axe-core) na pagina testada.
 * Modulo opcional 8 da skill. Leia references/modulos-opcionais.md secao 8 antes de usar.
 *
 * O que faz: usa o window.axe que ja existir na pagina (o caminho preferido: cole antes o CONTEUDO
 * de node_modules/axe-core/axe.min.js); se nao existir, injeta o axe-core de uma URL com hash de
 * integridade (SRI) conhecido. Padrao: jsdelivr e unpkg, axe-core 4.11.1, com o sha384 do
 * axe.min.js do pacote publicado no npm; URL sem hash e recusada sem injetar nada, e URL de outra
 * origem so e injetada quando a pagina esta num host local (localhost, 127.0.0.1, [::1], *.localhost,
 * *.test): nunca em producao. Roda axe.run no documento (ou so no contexto pedido, ex. o modal
 * aberto) e guarda em window.__qa.a11y um resumo por impacto e por regra, com os seletores dos
 * elementos. Se a CSP, o hash ou o host barrar a injecao, devolve a instrucao do caminho
 * alternativo em vez de falhar calado.
 *
 * Por que: script de terceiro injetado na aba logada roda com a sessao do usuario (le o token do
 * storage, age como ele). O hash garante que o que roda e exatamente o axe daquela versao; na
 * aba com sessao real, prefira sempre o arquivo local ou o Playwright com perfil de QA.
 *
 * Como colar:
 *   - extensao do Chrome: javascript_tool com o conteudo inteiro deste arquivo (devolve uma
 *     Promise; a ferramenta espera e mostra o resumo em texto);
 *   - Playwright MCP:     browser_evaluate com
 *                         async () => { <conteudo>; return await window.__qa.a11yPromessa }
 *   - console do DevTools: colar e Enter.
 *
 * Configuracao opcional, definida ANTES de colar (vale so para esta colagem):
 *   window.__qaAxe = {
 *     estado: 'modal-novo-cliente',   rotulo do estado da tela (vai no resultado e no nome do arquivo)
 *     contexto: '[role=dialog]',      seletor, elemento ou {include:[...], exclude:[...]}; padrao: documento
 *     tags: ['wcag2a','wcag2aa'],     padrao: wcag2a, wcag2aa, wcag21a, wcag21aa, wcag22aa
 *     boasPraticas: true,             acrescenta a tag best-practice (padrao: false)
 *     urls: ['https://...axe.min.js'], ordem de tentativa para injetar (padrao: CDNs abaixo)
 *     integridade: {'<url>': 'sha384-...'},  hash SRI de cada URL (soma-se ao padrao); URL sem
 *                                     hash e recusada. Calcule com:
 *                                     openssl dgst -sha384 -binary axe.min.js | openssl base64 -A
 *     tempoLimite: 15000,             ms por URL ao carregar (padrao 15000)
 *     maxNos: 15,                     seletores guardados por regra (padrao 15; o total vai em total_nos)
 *     rodar: false                    so carrega o axe, sem analisar
 *   }
 *
 * Uso depois de instalado:
 *   await __qa.a11yRodar({estado: 'vazio'})          nova analise sem colar de novo (usa o padrao + o
 *                                                    que voce passar; nao herda o window.__qaAxe)
 *   await __qa.a11yRodar({contexto: '[role=dialog]', estado: 'modal'})
 *   __qa.a11yResumo()                                linhas curtas da ultima analise
 *   __qa.a11y                                        objeto da ultima analise
 *   __qa.a11yExportar()                              JSON da ultima (salve em
 *                                                    evidencias/NN-a11y-<tela>-<estado>.json)
 *   __qa.a11yExportar(true)                          JSON de todas as analises desta pagina
 *   __qa.a11yLimpar()                                zera o historico
 *
 * Regras:
 *   - Nao injeta o axe duas vezes: com window.axe presente, so roda de novo. Recolar o arquivo
 *     e o jeito de analisar o estado atual com outra configuracao.
 *   - Reinstale depois de toda navegacao completa (reload, URL nova): o estado da janela some.
 *   - Rode com a tela ESTAVEL (rede ociosa, dados carregados) e na aba VISIVEL: em aba de
 *     segundo plano o carregamento e os timers ficam estrangulados.
 *   - O automatico pega so parte dos criterios WCAG. Teclado, ordem de foco, foco devolvido ao
 *     fechar modal, anuncio do leitor de tela e texto alternativo com sentido continuam manuais.
 *   - "incompletos" sao itens que o axe nao conseguiu decidir (contraste sobre imagem ou
 *     gradiente, por exemplo): viram caso de revisao manual, nunca "passou".
 *   - Nenhum valor de campo de senha ou oculto vai para o resumo (value mascarado).
 */
(function () {
  var MARCA = '__qaAxeInjetor';
  var HASH_AXE_4_11_1 = 'sha384-wb3zgvLcZeMFSec08dk7g8K8yDFFAX2uNKVwOUuowwc/wIfE2t6XVUjTEgPrOJCS';
  var CONFIG_PADRAO = {
    urls: [
      'https://cdn.jsdelivr.net/npm/axe-core@4.11.1/axe.min.js',
      'https://unpkg.com/axe-core@4.11.1/axe.min.js'
    ],
    integridade: {
      'https://cdn.jsdelivr.net/npm/axe-core@4.11.1/axe.min.js': HASH_AXE_4_11_1,
      'https://unpkg.com/axe-core@4.11.1/axe.min.js': HASH_AXE_4_11_1
    },
    tags: ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa'],
    boasPraticas: false,
    tempoLimite: 15000,
    maxNos: 15,
    maxHistorico: 50
  };
  var IMPACTOS = ['critical', 'serious', 'moderate', 'minor'];
  var NAO_COBRE =
    'o automatico NAO cobre: ordem do Tab, foco visivel e devolvido ao fechar, armadilha de foco, ' +
    'Esc fecha, anuncio do leitor de tela, texto alternativo com sentido, zoom 200%, movimento ' +
    'reduzido, alvo de toque e campo sem rotulo visivel (o axe aceita o placeholder como nome; ' +
    'placeholder nao conta como rotulo, DM-A11-05) (catalogo DM-A11-*): teste a mao.';

  var qa = (window.__qa = window.__qa || {});
  var cfgColagem = window.__qaAxe && typeof window.__qaAxe === 'object' ? window.__qaAxe : {};
  try {
    window.__qaAxe = undefined;
  } catch (e) {}

  var estado = window[MARCA];
  var reinstalado = false;
  if (!estado) {
    estado = window[MARCA] = {
      historico: [],
      carregando: null,
      rodando: false,
      origem: null,
      ultimaFalha: null
    };
  } else {
    reinstalado = true;
  }

  function cfgDe(extra, usarColagem) {
    var c = {};
    var k;
    for (k in CONFIG_PADRAO) c[k] = CONFIG_PADRAO[k];
    if (usarColagem) for (k in cfgColagem) if (cfgColagem[k] !== undefined) c[k] = cfgColagem[k];
    if (extra) for (k in extra) if (extra[k] !== undefined) c[k] = extra[k];
    if (typeof c.urls === 'string') c.urls = [c.urls];
    if (typeof c.tags === 'string') c.tags = [c.tags];
    var hashes = {};
    [CONFIG_PADRAO.integridade, usarColagem ? cfgColagem.integridade : null, extra ? extra.integridade : null].forEach(function (m) {
      if (m && typeof m === 'object') for (var u in m) hashes[u] = m[u];
    });
    c.integridade = hashes;
    return c;
  }

  function hostLocal(h) {
    h = String(h || '').toLowerCase();
    return h === 'localhost' || h === '127.0.0.1' || h === '[::1]' || h === '::1' || /\.localhost$/.test(h) || /\.test$/.test(h);
  }

  function hashValido(hash) {
    return typeof hash === 'string' && /^sha(256|384|512)-[A-Za-z0-9+\/]+={0,2}$/.test(hash.trim());
  }

  function texto(v, limite) {
    if (v == null) return '';
    var s = String(v).replace(/\s+/g, ' ').trim();
    return limite && s.length > limite ? s.slice(0, limite) + '...(+' + (s.length - limite) + ')' : s;
  }

  function limparHtml(html) {
    var s = texto(html, 300);
    if (/type\s*=\s*["']?(password|hidden)/i.test(s) || /(senha|password|token|secret)/i.test(s)) {
      s = s.replace(/value\s*=\s*("[^"]*"|'[^']*'|[^\s>]+)/gi, 'value="***"');
    }
    return s;
  }

  function alvo(target) {
    if (!target) return '';
    if (!Array.isArray(target)) return String(target);
    return target
      .map(function (t) {
        return Array.isArray(t) ? t.join(' >>> ') : String(t);
      })
      .join(' >> ');
  }

  function carregarDe(url, tempoLimite, hash) {
    return new Promise(function (resolve, reject) {
      var bloqueadoPorCsp = false;
      var encerrado = false;
      var defineSalvo = null;
      var s;
      function aoViolar(e) {
        var uri = String(e.blockedURI || '');
        var mesmaOrigem = false;
        try {
          mesmaOrigem = uri && new URL(url).origin === new URL(uri, location.href).origin;
        } catch (x) {}
        if ((uri === url || mesmaOrigem) && e.disposition !== 'report') {
          bloqueadoPorCsp = true;
          fim(false, 'csp', 'diretiva ' + (e.effectiveDirective || e.violatedDirective || '?'));
        }
      }
      function fim(ok, tipo, detalhe) {
        if (encerrado) return;
        encerrado = true;
        clearTimeout(relogio);
        document.removeEventListener('securitypolicyviolation', aoViolar, true);
        if (defineSalvo) window.define = defineSalvo;
        if (ok && window.axe && typeof window.axe.run === 'function') resolve(url);
        else reject({ url: url, tipo: tipo || 'erro', detalhe: detalhe || '' });
      }
      document.addEventListener('securitypolicyviolation', aoViolar, true);
      var relogio = setTimeout(function () {
        fim(false, bloqueadoPorCsp ? 'csp' : 'tempo', 'sem resposta em ' + tempoLimite + ' ms');
      }, tempoLimite);
      try {
        if (typeof window.define === 'function' && window.define.amd) {
          defineSalvo = window.define;
          window.define = undefined;
        }
        s = document.createElement('script');
        s.async = true;
        s.crossOrigin = 'anonymous';
        s.setAttribute('data-qa', 'axe-inject');
        s.onload = function () {
          if (window.axe && typeof window.axe.run === 'function') fim(true);
          else fim(false, 'sem-axe', 'o script carregou mas window.axe nao apareceu');
        };
        s.onerror = function () {
          setTimeout(function () {
            fim(false, bloqueadoPorCsp ? 'csp' : 'rede-ou-integridade',
              bloqueadoPorCsp ? 'bloqueado pela CSP' : 'falha de rede, 404 ou o arquivo nao confere com o hash SRI');
          }, 50);
        };
        s.integrity = hash.trim();
        s.src = url;
        (document.head || document.documentElement).appendChild(s);
      } catch (e) {
        var tt = /trusted|TrustedScriptURL/i.test(String(e && e.message));
        fim(false, tt ? 'trusted-types' : 'erro', String(e && e.message));
      }
    });
  }

  function garantirAxe(cfg) {
    if (window.axe && typeof window.axe.run === 'function') {
      if (!estado.origem) estado.origem = 'pagina ou colado a mao';
      return Promise.resolve(estado.origem);
    }
    if (estado.carregando) return estado.carregando;
    var urls = (cfg.urls || []).slice();
    var falhas = [];
    function proxima() {
      if (!urls.length) {
        var e = new Error('nao consegui carregar o axe-core');
        e.falhas = falhas;
        return Promise.reject(e);
      }
      var u = urls.shift();
      var hash = (cfg.integridade || {})[u];
      if (!hashValido(hash)) {
        falhas.push({ url: u, tipo: 'sem-integridade', detalhe: 'URL sem hash SRI conhecido em config.integridade; nada foi injetado' });
        return proxima();
      }
      var origemUrl = '';
      try {
        origemUrl = new URL(u, location.href).origin;
      } catch (x) {}
      if (origemUrl !== location.origin && !hostLocal(location.hostname)) {
        falhas.push({
          url: u,
          tipo: 'host-nao-local',
          detalhe: 'script de outra origem so e injetado com a pagina em host local; aqui o host e ' + location.hostname
        });
        return proxima();
      }
      return carregarDe(u, cfg.tempoLimite, hash).then(
        function (ok) {
          estado.origem = ok;
          return ok;
        },
        function (f) {
          falhas.push(f);
          return proxima();
        }
      );
    }
    estado.carregando = proxima().then(
      function (o) {
        estado.carregando = null;
        return o;
      },
      function (e) {
        estado.carregando = null;
        throw e;
      }
    );
    return estado.carregando;
  }

  function instrucaoFalha(falhas) {
    var csp = falhas.some(function (f) {
      return f.tipo === 'csp';
    });
    var tt = falhas.some(function (f) {
      return f.tipo === 'trusted-types';
    });
    var linhas = ['axe-inject: NAO carregou o axe-core.'];
    falhas.forEach(function (f) {
      linhas.push('  - ' + f.url + ': ' + f.tipo + (f.detalhe ? ' (' + f.detalhe + ')' : ''));
    });
    var semHash = falhas.some(function (f) {
      return f.tipo === 'sem-integridade';
    });
    var foraDoLocal = falhas.some(function (f) {
      return f.tipo === 'host-nao-local';
    });
    if (csp || tt) {
      linhas.push(
        (csp ? 'A CSP da pagina bloqueou o script externo' : 'Trusted Types bloqueou o script externo') +
          '. Isso e protecao da pagina, nao defeito: nao afrouxe a CSP para testar.'
      );
    } else if (foraDoLocal) {
      linhas.push('A pagina nao esta em host local: script de terceiro na aba roda com a sessao de quem esta logado. Nunca injete por CDN em producao nem em aba com sessao real.');
    } else if (semHash) {
      linhas.push('Injecao so com hash SRI conhecido: sem ele, nada garante que o arquivo baixado e o axe-core.');
    } else {
      linhas.push('Rede, proxy, CDN fora ou hash SRI que nao confere com o arquivo. Use o arquivo local.');
    }
    linhas.push('Caminhos alternativos (codigo avaliado pela ferramenta de JS nao e barrado pela CSP; tag <script> externa e):');
    linhas.push('  1. projeto com node_modules/axe-core: cole o CONTEUDO de node_modules/axe-core/axe.min.js na');
    linhas.push('     ferramenta de JS e depois cole este arquivo de novo (ele vai achar window.axe);');
    linhas.push('  2. Playwright com perfil de QA: @axe-core/playwright (new AxeBuilder({ page }).analyze()) ou');
    linhas.push('     page.evaluate(<conteudo do axe.min.js>); addScriptTag tambem e barrado pela CSP, a menos que o');
    linhas.push('     contexto tenha bypassCSP;');
    linhas.push('  3. so em host local e sem sessao real: window.__qaAxe = { urls: ["<URL>"], integridade: { "<URL>":');
    linhas.push('     "sha384-<hash do arquivo>" } } e cole de novo.');
    linhas.push('Testar outra rota sem CSP NAO prova esta tela: o caso fica nao-validado com este motivo.');
    return linhas.join('\n');
  }

  function seletorDe(el) {
    var s = el.tagName.toLowerCase();
    if (el.id) return s + '#' + el.id;
    var nome = el.getAttribute('name');
    if (nome) return s + '[name="' + nome + '"]';
    var tid = el.getAttribute('data-testid');
    if (tid) return s + '[data-testid="' + tid + '"]';
    return s;
  }

  function rotuloSoPlaceholder(contexto, maxNos) {
    var raiz = typeof contexto === 'string' ? document.querySelector(contexto) : contexto;
    if (!raiz || !raiz.querySelectorAll) raiz = document;
    var achados = [];
    var campos = raiz.querySelectorAll('input,select,textarea');
    for (var i = 0; i < campos.length; i++) {
      var el = campos[i];
      var tipo = (el.getAttribute('type') || '').toLowerCase();
      if (tipo === 'hidden' || tipo === 'submit' || tipo === 'button' || tipo === 'reset' || tipo === 'image') continue;
      var r = el.getBoundingClientRect();
      if (!(r.width > 0 && r.height > 0)) continue;
      if (el.labels && el.labels.length > 0) continue;
      if (el.getAttribute('aria-labelledby')) continue;
      if (!el.getAttribute('placeholder')) continue;
      achados.push(el);
    }
    if (!achados.length) return null;
    return {
      regra: 'qa-rotulo-so-placeholder',
      impacto: 'serious',
      descricao: 'Campo sem rotulo visivel: o placeholder faz o papel do rotulo (o axe aprova; DM-A11-05)',
      detalhe: 'labels.length === 0, sem aria-labelledby e com placeholder: o rotulo some ao digitar',
      ajuda: '',
      tags: ['wcag2a', 'wcag131', 'wcag332'],
      total_nos: achados.length,
      nos: achados.slice(0, maxNos).map(function (el) {
        return {
          alvo: seletorDe(el),
          impacto: 'serious',
          html: limparHtml(el.outerHTML),
          falha: 'Sem <label> associado nem aria-labelledby; so placeholder "' + texto(el.getAttribute('placeholder'), 80) + '"'
        };
      })
    };
  }

  function porImpacto(a, b) {
    var ia = IMPACTOS.indexOf(a.impacto);
    var ib = IMPACTOS.indexOf(b.impacto);
    if (ia < 0) ia = 9;
    if (ib < 0) ib = 9;
    return ia - ib || b.total_nos - a.total_nos || (a.regra < b.regra ? -1 : 1);
  }

  function regras(lista, maxNos) {
    return (lista || [])
      .map(function (v) {
        return {
          regra: v.id,
          impacto: v.impact || 'sem-impacto',
          descricao: texto(v.help),
          detalhe: texto(v.description),
          ajuda: v.helpUrl || '',
          tags: (v.tags || []).filter(function (t) {
            return /^wcag|^best-practice$|^section508/.test(t);
          }),
          total_nos: (v.nodes || []).length,
          nos: (v.nodes || []).slice(0, maxNos).map(function (n) {
            return {
              alvo: alvo(n.target),
              impacto: n.impact || v.impact || '',
              html: limparHtml(n.html),
              falha: texto(n.failureSummary, 400)
            };
          })
        };
      })
      .sort(porImpacto);
  }

  function totais(lista) {
    var t = { regras: lista.length, nos: 0, por_impacto: {} };
    IMPACTOS.concat(['sem-impacto']).forEach(function (i) {
      t.por_impacto[i] = { regras: 0, nos: 0 };
    });
    lista.forEach(function (r) {
      t.nos += r.total_nos;
      var k = t.por_impacto[r.impacto] ? r.impacto : 'sem-impacto';
      t.por_impacto[k].regras += 1;
      t.por_impacto[k].nos += r.total_nos;
    });
    return t;
  }

  function descreverContexto(c) {
    if (!c || c === document) return 'documento';
    if (typeof c === 'string') return c;
    if (c.nodeType === 1) {
      var s = c.tagName.toLowerCase();
      if (c.id) s += '#' + c.id;
      var role = c.getAttribute && c.getAttribute('role');
      if (role) s += '[role=' + role + ']';
      return s;
    }
    try {
      return JSON.stringify(c);
    } catch (e) {
      return String(c);
    }
  }

  function linhasResumo(r) {
    if (!r) return 'axe-inject: nenhuma analise ainda. Use await __qa.a11yRodar().';
    var t = r.totais.violacoes;
    var partes = IMPACTOS.map(function (i) {
      return i + ' ' + t.por_impacto[i].regras + '/' + t.por_impacto[i].nos;
    });
    var L = [];
    L.push(
      'axe ' + r.versao_axe + ' · ' + r.caminho + ' · estado "' + (r.estado || '-') + '" · contexto ' + r.contexto +
        ' · ' + r.viewport.largura + 'x' + r.viewport.altura + ' dpr ' + r.viewport.dpr + ' · ' + r.ms + ' ms'
    );
    L.push('violacoes: ' + t.regras + ' regra(s), ' + t.nos + ' no(s) · ' + partes.join(' · ') + ' (regras/nos)');
    L.push(
      'incompletos (revisar a mao): ' + r.totais.incompletos.regras + ' regra(s), ' + r.totais.incompletos.nos + ' no(s)' +
        ' · regras aprovadas: ' + r.totais.aprovadas + ' · nao aplicaveis: ' + r.totais.nao_aplicaveis
    );
    r.violacoes.forEach(function (v) {
      var alvos = v.nos
        .slice(0, 3)
        .map(function (n) {
          return n.alvo;
        })
        .join(' | ');
      L.push('- [' + v.impacto + '] ' + v.regra + ' (' + v.total_nos + '): ' + v.descricao + ' -> ' + alvos +
        (v.total_nos > 3 ? ' | ...' : ''));
    });
    r.incompletos.forEach(function (v) {
      L.push('? [revisar] ' + v.regra + ' (' + v.total_nos + '): ' + v.descricao);
    });
    (r.avisos || []).forEach(function (a) {
      L.push('aviso: ' + a);
    });
    L.push(NAO_COBRE);
    return L.join('\n');
  }

  function rodar(extra, usarColagem) {
    var cfg = cfgDe(extra, usarColagem);
    if (estado.rodando) return Promise.reject(new Error('axe-inject: ja existe uma analise rodando; espere terminar'));
    return garantirAxe(cfg).then(function () {
      var contexto = cfg.contexto || document;
      if (typeof contexto === 'string' && !document.querySelector(contexto)) {
        throw new Error('axe-inject: contexto "' + contexto + '" nao encontrado na pagina (o modal esta aberto?)');
      }
      var tags = (cfg.tags || CONFIG_PADRAO.tags).slice();
      if (cfg.boasPraticas && tags.indexOf('best-practice') < 0) tags.push('best-practice');
      var opcoes = { runOnly: { type: 'tag', values: tags }, resultTypes: ['violations', 'incomplete'] };
      var avisos = [];
      if (document.visibilityState && document.visibilityState !== 'visible') {
        avisos.push('aba em segundo plano (visibilityState=' + document.visibilityState + '): traga a aba para a frente e rode de novo');
      }
      if (document.readyState !== 'complete') avisos.push('documento ainda carregando (readyState=' + document.readyState + ')');
      estado.rodando = true;
      var t0 = Date.now();
      return Promise.resolve(window.axe.run(contexto, opcoes)).then(
        function (res) {
          estado.rodando = false;
          var max = Number(cfg.maxNos) > 0 ? Number(cfg.maxNos) : CONFIG_PADRAO.maxNos;
          var viol = regras(res.violations, max);
          var inc = regras(res.incomplete, max);
          var soPlaceholder = rotuloSoPlaceholder(contexto, max);
          if (soPlaceholder) inc.push(soPlaceholder);
          var tInc = totais(inc);
          var r = {
            ferramenta: 'qa-total/axe-inject.js',
            versao_axe: (window.axe && window.axe.version) || (res.testEngine && res.testEngine.version) || '?',
            origem_axe: estado.origem || 'pagina ou colado a mao',
            url: location.href,
            caminho: location.pathname + location.search,
            titulo: document.title,
            hora: new Date().toISOString(),
            estado: cfg.estado || '',
            contexto: descreverContexto(contexto),
            tags: tags,
            viewport: { largura: window.innerWidth, altura: window.innerHeight, dpr: window.devicePixelRatio || 1 },
            ms: Date.now() - t0,
            totais: {
              violacoes: totais(viol),
              incompletos: { regras: tInc.regras, nos: tInc.nos },
              aprovadas: (res.passes || []).length,
              nao_aplicaveis: (res.inapplicable || []).length
            },
            violacoes: viol,
            incompletos: inc,
            avisos: avisos,
            nao_cobre: NAO_COBRE
          };
          qa.a11y = r;
          estado.historico.push(r);
          var lim = Number(cfg.maxHistorico) > 0 ? Number(cfg.maxHistorico) : CONFIG_PADRAO.maxHistorico;
          while (estado.historico.length > lim) estado.historico.shift();
          return r;
        },
        function (e) {
          estado.rodando = false;
          throw e;
        }
      );
    });
  }

  qa.a11yRodar = function (extra) {
    var p = rodar(extra);
    qa.a11yPromessa = p.then(
      function (r) {
        return linhasResumo(r);
      },
      function (e) {
        if (e && e.falhas) return instrucaoFalha(e.falhas);
        return 'axe-inject: erro ao analisar: ' + String((e && e.message) || e);
      }
    );
    return p;
  };
  qa.a11yResumo = function () {
    return linhasResumo(qa.a11y || estado.historico[estado.historico.length - 1]);
  };
  qa.a11yExportar = function (todos) {
    var dados = todos ? estado.historico : qa.a11y || null;
    return JSON.stringify(dados, null, 2);
  };
  qa.a11yLimpar = function () {
    estado.historico.length = 0;
    qa.a11y = null;
    return 'axe-inject: historico zerado';
  };
  qa.a11yHistorico = estado.historico;

  var cfg = cfgDe(null, true);
  var prefixo = reinstalado
    ? 'axe-inject ja instalado (axe de ' + (estado.origem || 'pagina ou colado a mao') + '); nada reinstalado. Nova analise:\n'
    : '';

  var promessa;
  if (cfg.rodar === false) {
    promessa = garantirAxe(cfg).then(
      function (o) {
        return prefixo + 'axe-core ' + ((window.axe && window.axe.version) || '?') + ' carregado de ' + o +
          '. Rode com: await __qa.a11yRodar({estado: "..."})';
      },
      function (e) {
        estado.ultimaFalha = e.falhas || [{ url: '-', tipo: 'erro', detalhe: String(e && e.message) }];
        return instrucaoFalha(estado.ultimaFalha);
      }
    );
  } else {
    promessa = rodar(null, true).then(
      function (r) {
        return prefixo + linhasResumo(r);
      },
      function (e) {
        if (e && e.falhas) {
          estado.ultimaFalha = e.falhas;
          return instrucaoFalha(e.falhas);
        }
        return 'axe-inject: erro ao analisar: ' + String((e && e.message) || e);
      }
    );
  }
  qa.a11yPromessa = promessa;
  return promessa;
})();

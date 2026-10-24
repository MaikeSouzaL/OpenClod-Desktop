/*
 * qa-total · scripts/xhr-spy.js · espiao de rede para colar na pagina testada.
 *
 * O que faz: intercepta XMLHttpRequest, fetch, WebSocket e EventSource (axios usa XHR; um
 * espiao so de fetch nao ve nada; chat, tempo real e streaming de modelo de linguagem vao por
 * WebSocket ou SSE) e guarda cada chamada ou conexao em window.__qa.rede:
 *   { n, t, hora, metodo, url, status, ms, enviado, recebido, via, pendente, erro }
 *   WebSocket: metodo 'WS', via 'ws'; EventSource: metodo 'SSE', via 'sse'; os dois ganham
 *   quadros [{ n, lado, hora, ms, dado }], enviados, recebidos e aberto.
 *
 * Como colar:
 *   - extensao do Chrome: javascript_tool com o conteudo inteiro deste arquivo;
 *   - Playwright MCP:     browser_evaluate com  () => { <conteudo>; return window.__qa.resumo() }
 *   - console do DevTools: colar e Enter.
 *
 * Uso depois de instalado:
 *   __qa.limpar()                    zera a lista (mantem as conexoes WS/SSE abertas, com os quadros
 *                                    zerados); faca antes de cada acao que vai provar
 *   __qa.resumo()                    linhas curtas: "#3 POST 201 1532ms /api/v1/cliente"
 *   __qa.resumo('/cliente')          filtro: trecho de URL, "POST /api/v1/cliente" (metodo + caminho),
 *                                    "POST http://host/api/..." (URL absoluta), RegExp ou funcao
 *   __qa.ultimo('/cliente')          registro completo da ultima chamada que casa
 *   __qa.json(3)                     corpo recebido da chamada #3 como objeto (se nao truncado)
 *   __qa.duplicadas(2000)            mesma metodo+URL repetida em menos de 2000 ms (duplo clique)
 *   await __qa.esperarRede('/cliente', 20000)  espera TERMINAR a chamada que casa: a que
 *                                    ja estava pendente ou a proxima que comecar (WS/SSE: o fechamento)
 *   __qa.quadros('/ws')              quadros WebSocket/SSE das conexoes que casam, em ordem
 *   await __qa.esperarQuadro('/ws', 20000, 'pedido')  espera o proximo quadro de uma conexao que casa
 *                                    (o terceiro argumento, opcional, filtra o texto do quadro)
 *   __qa.exportar('/cliente')        JSON pronto para salvar em rede/NN-<chamada>.json
 *   __qa.config.limite = 20000       tamanho maximo de cada corpo (padrao 4000 caracteres)
 *   __qa.config.limiteQuadro = 2000  tamanho maximo de cada quadro WS/SSE (padrao 1000)
 *   __qa.config.limiteStream = 50000 bytes lidos de uma resposta text/event-stream do fetch (padrao 20000)
 *   __qa.config.tempoStream = 60000  ms lendo essa resposta antes de parar (padrao 30000)
 *   __qa.config.mascarar = null      desliga a mascara de segredos (padrao: mascara ligada)
 *
 * Regras:
 *   - Reinstale depois de toda navegacao completa (reload, URL nova digitada): o estado
 *     da janela some. Navegacao interna de SPA mantem o espiao.
 *   - Nao instala duas vezes: com a marca presente, so devolve o estado. Espiao duplicado
 *     faz uma chamada aparecer duas vezes e parece bug de requisicao duplicada.
 *   - Cabecalhos nao sao gravados (Authorization fica de fora). Campos de corpo e de quadro cujo
 *     nome parece segredo (senha, password, pass, pwd, pin, secret, token, jwt, cookie, sessao,
 *     api key, client secret, credencial, otp, cvv, numero de cartao) viram "***", e JWT solto no
 *     texto vira "***jwt". Par nome/valor ({"name": "sessionid", "value": ...}, tambem key/Name/
 *     Value) tem o valor trocado quando o nome e segredo; nome so parecido (contem sess, sid, csrf,
 *     xsrf, auth, token) troca so valor sem espaco (":authority" e "author" ficam). Texto que e JSON
 *     ({...} ou [...]) dentro de um campo e carregado, mascarado e serializado de novo.
 *   - A URL tambem e mascarada antes de gravar (inclusive a de WebSocket e EventSource e a da
 *     pagina no exportar): usuario:senha@ vira ***:***@, e o valor de todo parametro da query ou do
 *     fragmento com nome de segredo, ou chamado sig, signature, code, state, key, apikey, auth,
 *     access_token, id_token ou token, vira ***. O filtro do resumo continua casando pelo caminho.
 *   - WebSocket aberto ANTES da instalacao so aparece a partir do primeiro envio depois dela; os
 *     quadros recebidos antes disso nao sao vistos. No Playwright, page.on('websocket') ve tudo.
 *   - Resposta text/event-stream do fetch e lida por um clone ate o teto de bytes ou de tempo, e os
 *     eventos sao agregados em "recebido"; o corpo que a pagina le nao e tocado.
 *   - esperarRede usa timeout curto de proposito: a ferramenta de JS tem limite proprio.
 *     Para requisicao lenta, repita a espera em vez de pedir 120 s de uma vez.
 */
(function () {
  var MARCA = '__qaEspiaoRede';
  var qa = (window.__qa = window.__qa || {});
  if (window[MARCA]) {
    var salvo = window[MARCA];
    Object.keys(salvo).forEach(function (k) {
      if (!(k in qa)) qa[k] = salvo[k];
    });
    return 'xhr-spy ja instalado: ' + salvo.rede.length + ' chamada(s) registrada(s). Nada foi reinstalado.';
  }

  var config = (qa.config = qa.config || {});
  if (config.limite == null) config.limite = 4000;
  if (config.maxRegistros == null) config.maxRegistros = 500;
  if (config.limiteQuadro == null) config.limiteQuadro = 1000;
  if (config.maxQuadros == null) config.maxQuadros = 200;
  if (config.limiteStream == null) config.limiteStream = 20000;
  if (config.tempoStream == null) config.tempoStream = 30000;
  if (!('mascarar' in config)) {
    config.mascarar = /senha|password|passwd|secret|authorization|token$|^token|access_?token|refresh_?token|id_?token|jwt|api_?key|client_?secret|cookie|session_?id|^sess(ao|ion)$|^pass$|(^|[_-])pass(word|wd|phrase)?$|pwd|^pin$|credencia|credential|^otp|[_-]otp|otp$|cvv|card_?number/i;
  }
  var RE_JWT = /eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{4,}/g;
  var RE_PARAM_URL = /^(sig|signature|code|key|apikey|auth|access_token|id_token|token)$/i;
  var RE_PARAM_SO_URL = /^state$/i;
  var RE_NOME_PAR_SESSAO = /sess|sid|csrf|xsrf|auth|token|jwt|secret|senha|passw|pwd|api[_-]?key|credenc|credential/i;
  var NOMES_PAR_NEUTROS = { ':authority': 1, authority: 1, author: 1, authors: 1, autor: 1 };
  var CHAVES_NOME_PAR = ['name', 'Name', 'key', 'Key'];
  var CHAVES_VALOR_PAR = ['value', 'Value'];

  var rede = (qa.rede = []);
  var seq = 0;
  var seqQuadro = 0;
  var esperas = [];
  var esperasQuadro = [];

  function agora() {
    return typeof performance !== 'undefined' && performance.now ? performance.now() : Date.now();
  }

  function horaLocal(d) {
    function p(n, k) {
      return String(n).padStart(k || 2, '0');
    }
    return p(d.getHours()) + ':' + p(d.getMinutes()) + ':' + p(d.getSeconds()) + '.' + p(d.getMilliseconds(), 3);
  }

  function urlAbsoluta(u) {
    try {
      return new URL(String(u), location.href).href;
    } catch (e) {
      return String(u);
    }
  }

  function caminho(u) {
    try {
      var x = new URL(u, location.href);
      return x.origin === location.origin ? x.pathname + x.search : x.href;
    } catch (e) {
      return u;
    }
  }

  function caminhoPuro(u) {
    try {
      var x = new URL(u, location.href);
      return x.pathname + x.search;
    } catch (e) {
      return String(u);
    }
  }

  function chaveSecreta(k) {
    if (!config.mascarar) return false;
    config.mascarar.lastIndex = 0;
    return config.mascarar.test(k);
  }

  function nivelNomePar(nome) {
    if (!config.mascarar || typeof nome !== 'string') return 0;
    var n = nome.trim().toLowerCase();
    if (!n || NOMES_PAR_NEUTROS[n]) return 0;
    if (chaveSecreta(n) || RE_PARAM_URL.test(n) || n.indexOf('.aspnetcore.') === 0) return 2;
    return RE_NOME_PAR_SESSAO.test(n) ? 1 : 0;
  }

  function primeiraChave(o, lista, exigirTexto) {
    for (var i = 0; i < lista.length; i++) {
      if (Object.prototype.hasOwnProperty.call(o, lista[i]) && (!exigirTexto || typeof o[lista[i]] === 'string')) {
        return lista[i];
      }
    }
    return null;
  }

  function valorDoParSecreto(o) {
    var kn = primeiraChave(o, CHAVES_NOME_PAR, true);
    var kv = primeiraChave(o, CHAVES_VALOR_PAR, false);
    if (!kn || !kv || kn === kv) return null;
    var v = o[kv];
    if (v === null || v === '' || typeof v === 'object' || typeof v === 'boolean') return null;
    var nivel = nivelNomePar(o[kn]);
    if (nivel === 2 || (nivel === 1 && !/\s/.test(String(v).trim()))) return kv;
    return null;
  }

  function mascararTextoAninhado(s, profundidade) {
    var t = s.trim();
    var c0 = t.charAt(0);
    var c1 = t.charAt(t.length - 1);
    if (profundidade > 20 || !((c0 === '{' && c1 === '}') || (c0 === '[' && c1 === ']'))) return s;
    try {
      return JSON.stringify(mascararObjeto(JSON.parse(t), profundidade));
    } catch (e) {
      return s;
    }
  }

  function mascararObjeto(o, profundidade) {
    if (!config.mascarar || o === null || typeof o !== 'object' || profundidade > 20) return o;
    if (Array.isArray(o)) {
      for (var i = 0; i < o.length; i++) {
        o[i] =
          typeof o[i] === 'string'
            ? mascararTextoAninhado(o[i], profundidade + 1)
            : mascararObjeto(o[i], profundidade + 1);
      }
      return o;
    }
    var chaveDoPar = valorDoParSecreto(o);
    Object.keys(o).forEach(function (k) {
      if (k === chaveDoPar) o[k] = '***';
      else if (chaveSecreta(k) && o[k] !== null && typeof o[k] !== 'object') o[k] = '***';
      else if (typeof o[k] === 'string') o[k] = mascararTextoAninhado(o[k], profundidade + 1);
      else o[k] = mascararObjeto(o[k], profundidade + 1);
    });
    return o;
  }

  function parametroSecreto(k) {
    if (!config.mascarar) return false;
    return chaveSecreta(k) || RE_PARAM_URL.test(k);
  }

  function mascararParametros(texto) {
    var mudou = false;
    var saida = texto
      .split('&')
      .map(function (par) {
        var i = par.indexOf('=');
        if (i < 1) return par;
        var k = par.slice(0, i);
        var nome = k;
        try {
          nome = decodeURIComponent(k.replace(/\+/g, ' '));
        } catch (e) {}
        if (!parametroSecreto(nome) && !RE_PARAM_SO_URL.test(nome)) return par;
        mudou = true;
        return k + '=***';
      })
      .join('&');
    return mudou ? saida : texto;
  }

  function mascararUrl(u) {
    var s = String(u);
    if (!config.mascarar) return s;
    try {
      var x = new URL(s, location.href);
      if (x.username || x.password) {
        if (x.username) x.username = '***';
        if (x.password) x.password = '***';
      }
      if (x.search.length > 1) x.search = '?' + mascararParametros(x.search.slice(1));
      if (x.hash.length > 1 && x.hash.indexOf('=') !== -1) x.hash = '#' + mascararParametros(x.hash.slice(1));
      return mascararJwt(x.href);
    } catch (e) {
      return mascararJwt(s.replace(/\/\/[^\/\s@]*@/, '//***@'));
    }
  }

  function mascararJwt(s) {
    if (typeof s !== 'string' || !config.mascarar) return s;
    return s.replace(RE_JWT, '***jwt');
  }

  function mascararTexto(s) {
    if (typeof s !== 'string' || !config.mascarar) return s;
    var t = s.trim();
    if (t.charAt(0) === '{' || t.charAt(0) === '[') {
      try {
        return mascararJwt(JSON.stringify(mascararObjeto(JSON.parse(t), 0)));
      } catch (e) {
        return mascararJwt(s);
      }
    }
    if (/^[^=&\s]+=[^&]*(&[^=&\s]+=[^&]*)*$/.test(t)) {
      return mascararJwt(
        t
          .split('&')
          .map(function (par) {
            var k = '';
            try {
              k = decodeURIComponent(par.split('=')[0] || '');
            } catch (e) {
              k = par.split('=')[0] || '';
            }
            return parametroSecreto(k) ? par.split('=')[0] + '=***' : par;
          })
          .join('&')
      );
    }
    return mascararJwt(s);
  }

  function truncar(s, limite) {
    if (typeof s !== 'string') return s;
    var lim = Number(limite == null ? config.limite : limite) || 0;
    if (lim > 0 && s.length > lim) return s.slice(0, lim) + '...[+' + (s.length - lim) + ' caracteres]';
    return s;
  }

  function descreverCorpo(b) {
    try {
      if (b == null) return null;
      if (typeof b === 'string') return truncar(mascararTexto(b));
      if (typeof URLSearchParams !== 'undefined' && b instanceof URLSearchParams) return truncar(mascararTexto(b.toString()));
      if (typeof FormData !== 'undefined' && b instanceof FormData) {
        var obj = {};
        b.forEach(function (v, k) {
          var val =
            typeof File !== 'undefined' && v instanceof File
              ? '[arquivo ' + v.name + ', ' + v.size + ' bytes, ' + (v.type || 'sem tipo') + ']'
              : chaveSecreta(k)
              ? '***'
              : mascararJwt(String(v));
          if (k in obj) obj[k] = [].concat(obj[k], val);
          else obj[k] = val;
        });
        return truncar('FormData ' + JSON.stringify(obj));
      }
      if (typeof Blob !== 'undefined' && b instanceof Blob) return '[Blob ' + b.size + ' bytes, ' + (b.type || 'sem tipo') + ']';
      if (typeof ArrayBuffer !== 'undefined' && (b instanceof ArrayBuffer || ArrayBuffer.isView(b))) {
        return '[binario ' + (b.byteLength || 0) + ' bytes]';
      }
      if (typeof ReadableStream !== 'undefined' && b instanceof ReadableStream) return '[stream]';
      return truncar(mascararTexto(JSON.stringify(b)));
    } catch (e) {
      return '[corpo nao serializavel: ' + e.message + ']';
    }
  }

  function casa(r, filtro) {
    if (filtro == null || filtro === '') return true;
    if (typeof filtro === 'function') return !!filtro(r);
    var alvos = [r.metodo + ' ' + r.url, r.metodo + ' ' + caminhoPuro(r.url)];
    if (filtro instanceof RegExp) {
      return alvos.some(function (a) {
        filtro.lastIndex = 0;
        return filtro.test(a);
      });
    }
    var f = String(filtro).toLowerCase();
    return alvos.some(function (a) {
      return a.toLowerCase().indexOf(f) !== -1;
    });
  }

  function registrar(via, metodo, url, enviado) {
    seq += 1;
    var r = {
      n: seq,
      t: new Date().toISOString(),
      hora: horaLocal(new Date()),
      via: via,
      metodo: String(metodo || 'GET').toUpperCase(),
      url: mascararUrl(urlAbsoluta(url)),
      status: null,
      ms: null,
      enviado: enviado,
      recebido: null,
      pendente: true,
      erro: null,
      _inicio: agora()
    };
    rede.push(r);
    var max = Number(config.maxRegistros) || 0;
    if (max > 0 && rede.length > max) rede.splice(0, rede.length - max);
    return r;
  }

  function concluir(r, status, recebido, erro) {
    if (!r.pendente) return;
    r.status = status;
    r.ms = Math.round(agora() - r._inicio);
    r.recebido = recebido;
    r.erro = erro || null;
    r.pendente = false;
    esperas.slice().forEach(function (w) {
      if ((r.n > w.desde || w.pendentes[r.n]) && casa(r, w.filtro)) {
        esperas.splice(esperas.indexOf(w), 1);
        clearTimeout(w.timer);
        w.resolver(publico(r));
      }
    });
  }

  function publico(r) {
    var c = {};
    Object.keys(r).forEach(function (k) {
      if (k.charAt(0) !== '_') c[k] = Array.isArray(r[k]) ? r[k].slice() : r[k];
    });
    return c;
  }

  function ehConexao(r) {
    return r.via === 'ws' || r.via === 'sse';
  }

  function descreverQuadro(d) {
    try {
      if (typeof d === 'string') return truncar(mascararTexto(d), config.limiteQuadro);
      if (typeof Blob !== 'undefined' && d instanceof Blob) return '[Blob ' + d.size + ' bytes, ' + (d.type || 'sem tipo') + ']';
      if (typeof ArrayBuffer !== 'undefined' && (d instanceof ArrayBuffer || ArrayBuffer.isView(d))) {
        return '[binario ' + (d.byteLength || 0) + ' bytes]';
      }
      return truncar(mascararTexto(String(d)), config.limiteQuadro);
    } catch (e) {
      return '[quadro ilegivel: ' + e.message + ']';
    }
  }

  function novaConexao(via, metodo, url) {
    var r = registrar(via, metodo, url, null);
    r.quadros = [];
    r.enviados = 0;
    r.recebidos = 0;
    r.aberto = false;
    return r;
  }

  function anotarQuadro(r, lado, dado, evento) {
    if (lado === 'enviado') r.enviados += 1;
    else r.recebidos += 1;
    seqQuadro += 1;
    var q = { n: seqQuadro, lado: lado, hora: horaLocal(new Date()), ms: Math.round(agora() - r._inicio), dado: descreverQuadro(dado) };
    if (evento && evento !== 'message') q.evento = evento;
    r.quadros.push(q);
    var max = Number(config.maxQuadros) || 0;
    if (max > 0 && r.quadros.length > max) r.quadros.splice(0, r.quadros.length - max);
    esperasQuadro.slice().forEach(function (w) {
      if (q.n > w.desde && casa(r, w.filtro) && (!w.texto || String(q.dado).toLowerCase().indexOf(w.texto) !== -1)) {
        esperasQuadro.splice(esperasQuadro.indexOf(w), 1);
        clearTimeout(w.timer);
        var c = {};
        Object.keys(q).forEach(function (k) {
          c[k] = q[k];
        });
        c.conexao = r.n;
        c.url = r.url;
        w.resolver(c);
      }
    });
  }

  function resumoQuadros(r) {
    return r.enviados + ' quadro(s) enviado(s), ' + r.recebidos + ' recebido(s)';
  }

  function corpoXhr(xhr) {
    try {
      var tipo = xhr.responseType;
      if (tipo === '' || tipo === 'text') return truncar(mascararTexto(xhr.responseText));
      if (tipo === 'json') return truncar(mascararTexto(JSON.stringify(xhr.response)));
      if (tipo === 'blob' && xhr.response) return '[Blob ' + xhr.response.size + ' bytes, ' + (xhr.response.type || 'sem tipo') + ']';
      if (tipo === 'arraybuffer' && xhr.response) return '[binario ' + xhr.response.byteLength + ' bytes]';
      return '[responseType ' + tipo + ']';
    } catch (e) {
      return '[corpo ilegivel: ' + e.message + ']';
    }
  }

  var XHR = window.XMLHttpRequest;
  if (XHR && XHR.prototype) {
    var abrirOriginal = XHR.prototype.open;
    var enviarOriginal = XHR.prototype.send;

    XHR.prototype.open = function (metodo, url) {
      this.__qaMetodo = metodo;
      this.__qaUrl = url;
      return abrirOriginal.apply(this, arguments);
    };

    XHR.prototype.send = function (corpo) {
      var xhr = this;
      var r = registrar('xhr', xhr.__qaMetodo, xhr.__qaUrl, descreverCorpo(corpo));
      var motivo = null;
      xhr.addEventListener('error', function () {
        motivo = 'erro de rede';
      });
      xhr.addEventListener('abort', function () {
        motivo = 'abortada';
      });
      xhr.addEventListener('timeout', function () {
        motivo = 'timeout';
      });
      xhr.addEventListener('loadend', function () {
        concluir(r, xhr.status, motivo ? null : corpoXhr(xhr), motivo);
      });
      return enviarOriginal.apply(this, arguments);
    };
  }

  function resumirEventStream(r, texto, motivoFim) {
    var eventos = [];
    texto.split(/\r?\n\r?\n/).forEach(function (bloco) {
      if (!bloco.trim()) return;
      var nome = 'message';
      var dados = [];
      bloco.split(/\r?\n/).forEach(function (l) {
        if (l.indexOf('event:') === 0) nome = l.slice(6).trim();
        else if (l.indexOf('data:') === 0) dados.push(l.slice(5).replace(/^ /, ''));
      });
      if (dados.length) eventos.push((nome !== 'message' ? nome + ': ' : '') + mascararTexto(dados.join('\n')));
    });
    r.eventos = eventos.length;
    return truncar(
      '[event-stream: ' + eventos.length + ' evento(s)' + (motivoFim ? ', leitura parada pelo ' + motivoFim : '') + ']\n' + eventos.join('\n')
    );
  }

  function lerEventStream(r, resp, statusResp, tipo) {
    var copia;
    try {
      copia = resp.clone().body;
    } catch (e) {
      copia = null;
    }
    if (!copia || typeof copia.getReader !== 'function' || typeof TextDecoder === 'undefined') {
      concluir(r, statusResp, '[' + tipo + ': corpo nao legivel por clone]');
      return;
    }
    var leitor = copia.getReader();
    var decodificador = new TextDecoder();
    var bytes = 0;
    var texto = '';
    var motivoFim = null;
    var limiteBytes = Number(config.limiteStream) || 20000;
    var limiteMs = Number(config.tempoStream) || 30000;
    function parar(motivo) {
      if (!motivoFim) motivoFim = motivo;
      try {
        leitor.cancel();
      } catch (e) {}
    }
    var relogio = setTimeout(function () {
      parar('teto de tempo (' + limiteMs + ' ms)');
    }, limiteMs);
    function fim(erro) {
      clearTimeout(relogio);
      concluir(r, statusResp, resumirEventStream(r, texto, motivoFim), erro || null);
    }
    function passo() {
      leitor.read().then(
        function (p) {
          if (p.done) {
            fim();
            return;
          }
          bytes += p.value ? p.value.byteLength : 0;
          texto += decodificador.decode(p.value, { stream: true });
          if (bytes >= limiteBytes) {
            parar('teto de bytes (' + limiteBytes + ')');
            fim();
            return;
          }
          passo();
        },
        function (e) {
          fim(motivoFim ? null : 'leitura do stream: ' + ((e && e.message) || e));
        }
      );
    }
    passo();
  }

  var fetchOriginal = window.fetch;
  if (typeof fetchOriginal === 'function') {
    window.fetch = function (entrada, opcoes) {
      var ehRequest = typeof Request !== 'undefined' && entrada instanceof Request;
      var metodo = (opcoes && opcoes.method) || (ehRequest ? entrada.method : 'GET');
      var url = ehRequest ? entrada.url : entrada;
      var r = registrar('fetch', metodo, url, null);

      if (opcoes && 'body' in opcoes) {
        r.enviado = descreverCorpo(opcoes.body);
      } else if (ehRequest && entrada.body) {
        try {
          entrada
            .clone()
            .text()
            .then(function (t) {
              r.enviado = truncar(mascararTexto(t));
            })
            .catch(function () {});
        } catch (e) {
          r.enviado = '[corpo do Request ilegivel]';
        }
      }

      var promessa = fetchOriginal.apply(this, arguments);
      promessa.then(
        function (resp) {
          var tipo = (resp.headers && resp.headers.get('content-type')) || '';
          var statusResp = resp.status;
          r.msCabecalho = Math.round(agora() - r._inicio);
          if (/event-stream/i.test(tipo)) {
            lerEventStream(r, resp, statusResp, tipo);
            return;
          }
          if (/octet-stream|^image\/|^audio\/|^video\/|application\/pdf|zip/i.test(tipo)) {
            concluir(r, statusResp, '[' + (tipo || 'binario') + ']');
            return;
          }
          resp
            .clone()
            .text()
            .then(function (t) {
              concluir(r, statusResp, truncar(mascararTexto(t)));
            })
            .catch(function (e) {
              concluir(r, statusResp, '[corpo ilegivel: ' + e.message + ']');
            });
        },
        function (e) {
          concluir(r, 0, null, String((e && e.message) || e));
        }
      );
      return promessa;
    };
  }

  function construir(Original, args, alvo) {
    if (typeof Reflect !== 'undefined' && typeof Reflect.construct === 'function') {
      return Reflect.construct(Original, args, alvo);
    }
    return args.length > 1 ? new Original(args[0], args[1]) : new Original(args[0]);
  }

  function copiarEstaticos(destino, origem, nomes) {
    nomes.forEach(function (k) {
      try {
        Object.defineProperty(destino, k, { value: origem[k], enumerable: true });
      } catch (e) {}
    });
  }

  var WSOriginal = window.WebSocket;
  if (typeof WSOriginal === 'function' && !WSOriginal.__qaEspiao) {
    var registroWs = function (ws) {
      if (ws.__qaRegistro) return ws.__qaRegistro;
      var r = novaConexao('ws', 'WS', ws.url);
      r.aberto = ws.readyState === 1;
      if (r.aberto) r.status = 101;
      try {
        Object.defineProperty(ws, '__qaRegistro', { value: r, enumerable: false });
      } catch (e) {
        ws.__qaRegistro = r;
      }
      ws.addEventListener('open', function () {
        r.aberto = true;
        r.status = 101;
      });
      ws.addEventListener('message', function (ev) {
        anotarQuadro(r, 'recebido', ev.data);
      });
      ws.addEventListener('error', function () {
        r.erro = 'erro no socket';
      });
      ws.addEventListener('close', function (ev) {
        r.aberto = false;
        concluir(r, ev.code, resumoQuadros(r), ev.wasClean ? null : 'fechado sem limpeza (codigo ' + ev.code + ')');
      });
      return r;
    };
    var WSEspiao = function WebSocket(url, protocolos) {
      var alvo = (typeof new.target === 'function' && new.target) || WSEspiao;
      var ws = construir(WSOriginal, Array.prototype.slice.call(arguments), alvo);
      registroWs(ws);
      return ws;
    };
    WSEspiao.prototype = WSOriginal.prototype;
    copiarEstaticos(WSEspiao, WSOriginal, ['CONNECTING', 'OPEN', 'CLOSING', 'CLOSED']);
    var enviarWs = WSOriginal.prototype.send;
    if (typeof enviarWs === 'function' && !enviarWs.__qaEspiao) {
      var enviarEspiao = function send(dado) {
        try {
          anotarQuadro(registroWs(this), 'enviado', dado);
        } catch (e) {}
        return enviarWs.apply(this, arguments);
      };
      Object.defineProperty(enviarEspiao, '__qaEspiao', { value: true });
      WSOriginal.prototype.send = enviarEspiao;
    }
    Object.defineProperty(WSEspiao, '__qaEspiao', { value: true });
    window.WebSocket = WSEspiao;
  }

  var ESOriginal = window.EventSource;
  if (typeof ESOriginal === 'function' && !ESOriginal.__qaEspiao) {
    var ESEspiao = function EventSource(url, opcoesEs) {
      var alvo = (typeof new.target === 'function' && new.target) || ESEspiao;
      var es = construir(ESOriginal, Array.prototype.slice.call(arguments), alvo);
      var r = novaConexao('sse', 'SSE', es.url || url);
      var adicionar = es.addEventListener;
      var ouvidos = {};
      var ouvir = function (tipo) {
        if (ouvidos[tipo]) return;
        ouvidos[tipo] = true;
        adicionar.call(es, tipo, function (ev) {
          anotarQuadro(r, 'recebido', ev.data, tipo);
        });
      };
      ouvir('message');
      adicionar.call(es, 'open', function () {
        r.aberto = true;
        r.status = 200;
      });
      adicionar.call(es, 'error', function () {
        if (es.readyState === 2) {
          r.aberto = false;
          concluir(r, r.status, resumoQuadros(r), 'fechado pelo servidor ou pela rede');
        } else {
          r.erro = 'reconectando';
        }
      });
      es.addEventListener = function (tipo) {
        if (tipo !== 'open' && tipo !== 'error') ouvir(String(tipo));
        return adicionar.apply(es, arguments);
      };
      var fechar = es.close;
      es.close = function () {
        var x = fechar.apply(es, arguments);
        r.aberto = false;
        concluir(r, r.status, resumoQuadros(r), null);
        return x;
      };
      return es;
    };
    ESEspiao.prototype = ESOriginal.prototype;
    copiarEstaticos(ESEspiao, ESOriginal, ['CONNECTING', 'OPEN', 'CLOSED']);
    Object.defineProperty(ESEspiao, '__qaEspiao', { value: true });
    window.EventSource = ESEspiao;
  }

  qa.limpar = function () {
    var antes = rede.length;
    var mantidos = rede.filter(function (r) {
      return ehConexao(r) && r.pendente;
    });
    mantidos.forEach(function (r) {
      r.quadros.length = 0;
      r.enviados = 0;
      r.recebidos = 0;
    });
    rede.length = 0;
    Array.prototype.push.apply(rede, mantidos);
    return (
      antes - mantidos.length +
      ' chamada(s) removida(s)' +
      (mantidos.length ? '; ' + mantidos.length + ' conexao(oes) WS/SSE aberta(s) mantida(s), com os quadros zerados' : '') +
      '; o espiao continua ativo.'
    );
  };

  qa.resumo = function (filtro) {
    var linhas = rede
      .filter(function (r) {
        return casa(r, filtro);
      })
      .map(function (r) {
        if (ehConexao(r)) {
          var estado = r.pendente
            ? (r.aberto ? 'ABERTO' : 'CONECTANDO') + ' ha ' + Math.round(agora() - r._inicio) + 'ms'
            : 'FECHADO ' + r.status + ' ' + r.ms + 'ms';
          return '#' + r.n + ' ' + r.metodo + ' ' + estado + ' (' + resumoQuadros(r) + ')' + (r.erro ? ' (' + r.erro + ')' : '') + ' ' + caminho(r.url);
        }
        var st = r.pendente ? 'PENDENTE ha ' + Math.round(agora() - r._inicio) + 'ms' : r.status + ' ' + r.ms + 'ms';
        var ev = r.eventos != null ? ' [' + r.eventos + ' evento(s) SSE]' : '';
        return '#' + r.n + ' ' + r.metodo + ' ' + st + ev + (r.erro ? ' (' + r.erro + ')' : '') + ' ' + caminho(r.url);
      });
    return linhas.length ? linhas.join('\n') : 'nenhuma chamada registrada' + (filtro ? ' para o filtro' : '');
  };

  qa.ultimo = function (filtro) {
    for (var i = rede.length - 1; i >= 0; i--) if (casa(rede[i], filtro)) return publico(rede[i]);
    return null;
  };

  qa.json = function (n, lado) {
    var r = null;
    for (var i = 0; i < rede.length; i++) if (rede[i].n === n) r = rede[i];
    if (!r) return 'chamada #' + n + ' nao encontrada';
    var corpo = lado === 'enviado' ? r.enviado : r.recebido;
    try {
      return JSON.parse(corpo);
    } catch (e) {
      return corpo;
    }
  };

  qa.quadros = function (filtro) {
    var linhas = [];
    rede.forEach(function (r) {
      if (!ehConexao(r) || !casa(r, filtro)) return;
      r.quadros.forEach(function (q) {
        linhas.push(
          '#' + r.n + '.' + q.n + ' ' + r.metodo + ' ' + (q.lado === 'enviado' ? '->' : '<-') + ' ' + q.hora + (q.evento ? ' [' + q.evento + ']' : '') + ' ' + truncar(String(q.dado), 200)
        );
      });
    });
    return linhas.length ? linhas.join('\n') : 'nenhum quadro WS/SSE registrado' + (filtro ? ' para o filtro' : '');
  };

  qa.esperarQuadro = function (filtro, timeoutMs, trecho) {
    var limite = timeoutMs == null ? 20000 : timeoutMs;
    return new Promise(function (resolver) {
      var w = { filtro: filtro, texto: trecho ? String(trecho).toLowerCase() : '', desde: seqQuadro, resolver: resolver, timer: null };
      w.timer = setTimeout(function () {
        var i = esperasQuadro.indexOf(w);
        if (i !== -1) esperasQuadro.splice(i, 1);
        resolver('nenhum quadro novo casou com o filtro em ' + limite + 'ms');
      }, limite);
      esperasQuadro.push(w);
    });
  };

  qa.duplicadas = function (janelaMs) {
    var janela = janelaMs == null ? 2000 : janelaMs;
    var achadas = [];
    for (var i = 1; i < rede.length; i++) {
      var m = rede[i].metodo;
      if (m === 'GET' || m === 'HEAD' || m === 'OPTIONS' || ehConexao(rede[i])) continue;
      for (var j = i - 1; j >= 0; j--) {
        var dt = Date.parse(rede[i].t) - Date.parse(rede[j].t);
        if (dt > janela) break;
        if (rede[i].metodo === rede[j].metodo && rede[i].url === rede[j].url) {
          achadas.push('#' + rede[j].n + ' e #' + rede[i].n + ' ' + rede[i].metodo + ' ' + caminho(rede[i].url) + ' (' + dt + 'ms)');
          break;
        }
      }
    }
    return achadas.length
      ? achadas.concat('Confirme no banco antes de chamar de bug: espiao instalado duas vezes tambem produz isto.').join('\n')
      : 'nenhuma escrita repetida dentro de ' + janela + 'ms';
  };

  qa.esperarRede = function (filtro, timeoutMs) {
    var limite = timeoutMs == null ? 20000 : timeoutMs;
    return new Promise(function (resolver) {
      var pendentes = {};
      rede.forEach(function (r) {
        if (r.pendente) pendentes[r.n] = true;
      });
      var w = { filtro: filtro, desde: seq, pendentes: pendentes, resolver: resolver, timer: null };
      w.timer = setTimeout(function () {
        var i = esperas.indexOf(w);
        if (i !== -1) esperas.splice(i, 1);
        var pend = rede.filter(function (r) {
          return r.pendente && casa(r, filtro);
        });
        resolver(
          pend.length
            ? 'ainda pendente apos ' + limite + 'ms: ' + qa.resumo(function (r) { return pend.indexOf(r) !== -1; }) + ' (repita a espera; nao clique de novo)'
            : 'nenhuma chamada nova casou com o filtro em ' + limite + 'ms'
        );
      }, limite);
      esperas.push(w);
    });
  };

  qa.exportar = function (filtro) {
    return JSON.stringify(
      {
        pagina: mascararUrl(location.href),
        exportadoEm: new Date().toISOString(),
        chamadas: rede
          .filter(function (r) {
            return casa(r, filtro);
          })
          .map(publico)
      },
      null,
      2
    );
  };

  qa.espiaoRedeVersao = '1.2';
  var api = {};
  ['rede', 'config', 'limpar', 'resumo', 'ultimo', 'json', 'quadros', 'esperarQuadro', 'duplicadas', 'esperarRede', 'exportar', 'espiaoRedeVersao'].forEach(function (k) {
    api[k] = qa[k];
  });
  Object.defineProperty(window, MARCA, { value: api, enumerable: false });
  return (
    'xhr-spy instalado em ' + location.href + ' (XHR: ' + !!XHR + ', fetch: ' + (typeof fetchOriginal === 'function') +
    ', WebSocket: ' + (typeof WSOriginal === 'function') + ', EventSource: ' + (typeof ESOriginal === 'function') + ').'
  );
})();

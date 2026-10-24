#!/usr/bin/env python3
"""_mascara.py - mascara segredos em texto livre (modulo comum da skill qa-total).

Usado por cobertura.py, painel.py, provas.py, gerar_pdf.py, mensagens.py e entregas.py, para que
nenhum entregavel (painel, PDF, relatorio, mensagem, patch listado) leve token, senha ou chave em
claro. As regras de formato vem do segredos.py (importado, nao copiado), inclusive Basic auth, cookie
de sessao e credencial em opcao de linha de comando (curl -u, mysql -p, sqlcmd -P, redis-cli -a,
--password); aqui ficam so as regras de texto livre (chave=valor, "Bearer ...", JWT e JWE, bloco PEM,
"senha <valor>", JSON escapado, par nome/valor, code/state em URL).

Cabecalho Cookie/Set-Cookie: cada par 'nome=valor' e conferido (nao so o primeiro); o VALOR vira
[REMOVIDO] quando tem 16+ caracteres ou o nome e de sessao/autenticacao (sess, sid, auth, token,
identity, login, remember, jwt, .AspNetCore.*, *_session). Os atributos do Set-Cookie (Path, Domain,
Expires, SameSite, Max-Age, Secure, HttpOnly) e o par curto e neutro (lang=pt-BR) ficam intactos. A
regra que decide e a mesma do segredos.py (pares_secretos_cookie).

Par nome/valor (HAR, lista de cabecalhos, cookies, queryString, params): {"name": N, "value": V} (ou
"key"/"Name"/"Value") tem V trocado quando N e sensivel (password, token, sessionid..., qualquer valor) ou
de cookie de sessao (contem sess, sid, csrf, xsrf, auth, token, ou comeca por .AspNetCore.; aqui so valor sem
espaco: "Entrar na conta" sob "auth.titulo" fica); N = Cookie/Set-Cookie tem
cada par do valor conferido; N = Authorization mantem o esquema (Bearer, Basic) e troca o resto. Dentro de
queryString/params, code e state tambem contam; dentro de cookies, valor de 16+ caracteres tambem.

API:
  mascarar(texto, estrito=False) -> (texto_mascarado, n)    n = quantos trechos foram trocados
  mascarar_com_tipos(texto, estrito=False) -> (texto_mascarado, [tipos])
  tipos_de_segredo(texto) -> [tipos]       sem alterar nada (para recusar entrada); usa o modo estrito,
                                           entao recusa o mesmo que mascarar(estrito=True) troca
  mascarar_estrutura(obj, pular=(), estrito=True) -> (copia, n)   percorre dict/list; chaves em `pular`
                                           ficam como estao; no modo estrito, valor de chave 'cookie' ou
                                           'set-cookie' tem cada par conferido, valor de chave sensivel
                                           ('password', 'token', 'authorization'...) vira [REMOVIDO], par
                                           nome/valor segue a regra acima e texto que e JSON valido ({...} ou
                                           [...]) e carregado, percorrido e serializado de novo
  mascarar_texto_de_arquivo(texto, sufixo) -> (texto, n)   .json/.har: carrega e usa mascarar_estrutura;
                                           .jsonl/.ndjson: linha a linha; nao e JSON valido: mascara de texto
  estrutura_de_arquivo(texto, sufixo) -> (bruto, limpo, n) | None   so a parte de estrutura, com o JSON sem e
                                           com a mascara nas mesmas linhas (para cortar a prova e contar)

Modo estrito (payload, log, prova textual e todo entregavel): todo valor nao vazio de chave sensivel
em JSON ("password", "pass", "pin", "token", "cookie"...), inclusive JSON escapado dentro de string
(\\"senha\\": \\"...\\") e valor com aspa escapada, em chave=valor ou entre aspas depois de "senha:" vira
[REMOVIDO], mesmo curto; "senha <valor>" no meio da frase tambem, quando o valor tem cara de senha
(digito, simbolo ou maiuscula no meio). Com conector ("token do localStorage", "senha do admin e X"), o
valor so conta com digito ou simbolo e 6+ caracteres (4+ para pin): camelCase so de letras nao conta.

Valor que ja vem mascarado pelo segredos.py ("sk_live_...(39 caracteres)", "****(15 caracteres)") ou
por este modulo ("[REMOVIDO]") nao e trocado nem contado de novo.

O valor trocado vira "[REMOVIDO]"; o rotulo (Password=, "token":, Bearer) fica, para dizer o tipo de
dado sem expor o valor. Nunca devolve nem imprime o valor original.

Somente biblioteca padrao. Python 3.9+.
"""
from __future__ import annotations

import json
import re
import sys
from pathlib import Path

_AQUI = Path(__file__).resolve().parent
if str(_AQUI) not in sys.path:
    sys.path.insert(0, str(_AQUI))
try:
    import segredos as _seg
except Exception:
    _seg = None

MARCA = "[REMOVIDO]"

RE_PEM = re.compile(r"-----BEGIN [A-Z ]*PRIVATE KEY(?: BLOCK)?-----[\s\S]*?(?:-----END [A-Z ]*PRIVATE KEY(?: BLOCK)?-----|$)")
RE_JWT = re.compile(r"\beyJ[A-Za-z0-9_-]{8,}\.(?:[A-Za-z0-9_-]*\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}"
                    r"(?:\.[A-Za-z0-9_-]{4,})?|[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{4,})")
RE_BEARER = re.compile(r"(?i)\b(bearer\s+)([A-Za-z0-9._~+/=-]{12,})")
RE_SK = re.compile(r"\b(sk-[A-Za-z0-9_-]{20,})")
RE_PREFIXO_COLADO = re.compile(
    r"(?<=[A-Za-z0-9_])((?:gh[pousr]_[A-Za-z0-9]{36,})|(?:github_pat_[A-Za-z0-9_]{22,})|(?:glpat-[A-Za-z0-9_-]{20,})|"
    r"(?:xox[abposr]-[A-Za-z0-9-]{10,})|(?:(?:AKIA|ASIA)[A-Z0-9]{16}(?![A-Za-z0-9])))")
RE_CHAVE_VALOR = re.compile(
    r"(?i)(?<![A-Za-z0-9_.-])([A-Za-z0-9_.-]*?(?:password|passwd|pwd|senha|secret|segredo|api[_-]?key|apikey|"
    r"client[_-]?secret|access[_-]?token|refresh[_-]?token|auth[_-]?token|private[_-]?key|chave[_-]?api|"
    r"(?:signing|jwt|encryption|hmac)[_-]?key|token)[A-Za-z0-9_.-]*)"
    r"([\"']?\s*[:=]\s*[\"']?)([^\s\"'`,;&<>|)\]}]+)")

NOMES_JSON_SENSIVEIS = (r"password|senha|passwd|pass|pwd|pin|secret|segredo|token|access_?token|refresh_?token|"
                        r"id_?token|api_?key|client_?secret|authorization|cookie|set-cookie|credential|credentials|"
                        r"credencial|session_?id|sessionid")
RE_JSON_SENSIVEL = re.compile(
    r"(?i)(\"(?:" + NOMES_JSON_SENSIVEIS + r")\"\s*:\s*\")((?:[^\"\\]|\\[\s\S])+)(\")")
RE_JSON_ESCAPADO_SENSIVEL = re.compile(
    r"(?i)(\\\"(?:" + NOMES_JSON_SENSIVEIS + r")\\\"\s*:\s*\\\")((?:\\\\(?:\\[\\\"]|[^\\\"])|\\[^\\\"]|[^\\\"])+)")
RE_KV_SENSIVEL = re.compile(r"(?i)(?<![A-Za-z0-9_])((?:password|passwd|pass|senha|pwd|pin|secret|token|api_?key)"
                            r"\s*=\s*)([^;&\s\"']+)")
RE_SENHA_NATURAL = re.compile(
    r"(?i)(?<![A-Za-z0-9_])(?P<palavra>senha|password|passwd|pass|pwd|pin|token|api[_ -]?key)(?![A-Za-z0-9_])"
    r"(?:\s+(?P<dono>(?:do|da|de|dos|das)\s+[^\s\"',;:<>`]{1,40}))?"
    r"(?:\s+(?P<conector>de|do|da|e|eh|é|era|vale|fica)(?![A-Za-z0-9_]))?"
    r"(?:\s*(?P<sep>[:=])\s*|\s+)"
    r"(?:\"(?P<aspas2>[^\"\n]{3,})\"|'(?P<aspas1>[^'\n]{3,})'|(?P<solto>[^\s\"',;:<>`]{4,}))")
RE_PARAM_URL = re.compile(r"(?i)[?&#;](code|state|sig|signature|id_token|auth)=([^&#\s\"'<>\\]+)")
NOME_PAR = r"\"((?:[^\"\\\n]|\\.){1,120})\""
VALOR_PAR = r"\"((?:[^\"\\\n]|\\.)*)\""
RE_PAR_NOME_VALOR = re.compile(r"(?i)\"(?:name|key)\"\s*:\s*" + NOME_PAR + r"[^{}\[\]]*?\"value\"\s*:\s*" + VALOR_PAR)
RE_PAR_VALOR_NOME = re.compile(r"(?i)\"value\"\s*:\s*" + VALOR_PAR + r"[^{}\[\]]*?\"(?:name|key)\"\s*:\s*" + NOME_PAR)
RE_NOME_PAR_SESSAO = re.compile(r"(?i)sess|sid|csrf|xsrf|auth|token|jwt|secret|segredo|senha|passw|pwd|"
                                r"api[_-]?key|apikey|credenc|credential")
NOMES_PAR_NEUTROS = {":authority", "authority", "author", "authors", "autor"}
RE_ESQUEMA_AUTH = re.compile(r"(?i)^\s*(?:bearer|basic|digest|token|negotiate|ntlm|hmac|aws4-hmac-sha256)\s+")
CHAVES_AUTORIZACAO = {"authorization", "proxy-authorization"}
CONTEXTO_URL = {"querystring", "query_string", "query", "params", "queryparams", "query_params"}
CONTEXTO_COOKIE = {"cookies"}
RE_JA_MASCARADO = re.compile(r"^(?:\[REMOVIDO|[^\s\"'`]{0,12}\.\.\.\(\d+ caracteres\)|\*{4}\(\d+ caracteres\))")
RE_PALAVRA = re.compile(r"[^\W\d_]+(?:[-_.=/][^\W\d_]+)*")
RE_SIMBOLO_SENHA = re.compile(r"[!@#$%^&*+?~|]")

REGRAS_COM_CHAVE = {"senha-em-config", "string-conexao-senha", "npmrc-auth", "url-com-credencial"}
REGRA_PUBLICA = getattr(_seg, "ID_PUBLICA", "chave-publica-cliente")

RE_PRE_FILTRO = re.compile(
    r"(?i)password|passwd|pwd|pass\b|senha|secret|segredo|token|key|bearer|basic|auth|cookie|session|sid|"
    r"\bpin\b|chave|aws|service_account|credencia|credential|csrf|xsrf|aspnetcore|"
    r"accountendpoint|sig=|signature=|code=|state=|://[^\s/]*@|-----begin|eyj|akia|asia|agpa|aida|aroa|aipa|anpa|"
    r"anva|aiza|gh[pousr]_|github_pat_|glpat-|xox|k_live_|k_test_|sg\.|sib-|sk-|sk\.|npm_|pypi-|discord|hooks\.slack|"
    r"\d{8,10}:aa|sk[0-9a-f]{32}|curl|wget|http|\bxhs?\b|mysql|mariadb|sqlcmd|\bbcp\b|osql|isql|redis-cli|mongo|"
    r"sshpass|--user|\blogin\b")


def _placeholder(v: str) -> bool:
    if MARCA in v or "[REMOVIDO" in v:
        return True
    if RE_JA_MASCARADO.match(v.strip()):
        return True
    if _seg is not None:
        return _seg.eh_placeholder(v)
    return bool(re.fullmatch(r"[*xX.\-_=?<>{}$%]+", v.strip()))


def _eh_codigo(v: str) -> bool:
    return _seg is not None and bool(_seg.RE_CODIGO.match(v.strip()))


def _ja_mascarado(texto: str, ini: int) -> bool:
    return bool(RE_JA_MASCARADO.match(texto[ini:ini + 80]))


def _valor_secreto(valor: str) -> bool:
    v = (valor or "").strip().strip("'\"`").rstrip(".,;:)]}")
    if len(v) < 6 or _placeholder(v):
        return False
    if re.search(r"\s", v):
        return False
    if _seg is not None and _seg.RE_CODIGO.match(v):
        return False
    if re.match(r"^(?:https?:)?//", v) or v.startswith(("/", "./", "../")):
        return False
    if re.fullmatch(r"[^\W\d_]+(?:[-_.][^\W\d_]+)*", v):
        return False
    return True


def _cara_de_senha(valor: str) -> bool:
    """Valor solto depois de 'senha ' (sem aspas nem ':'/'='): so conta se nao parece palavra comum."""
    v = (valor or "").strip().rstrip(".,;:!?)]}")
    if len(v) < 4 or _placeholder(v):
        return False
    if _seg is not None and _seg.RE_CODIGO.match(v):
        return False
    if re.match(r"^(?:https?:)?//", v) or v.startswith(("/", "./", "../")):
        return False
    if v.isdigit():
        return len(v) >= 6
    if RE_PALAVRA.fullmatch(v) and not re.search(r"[a-zà-ÿ][A-Z]", v):
        return False
    return bool(re.search(r"\d", v) or RE_SIMBOLO_SENHA.search(v) or re.search(r"[a-z][A-Z]", v))


def _cara_de_senha_com_conector(valor: str, palavra: str) -> bool:
    """'senha do admin e X', 'token do localStorage': com conector o valor so conta com digito ou simbolo e
    6+ caracteres (4+ para pin). camelCase so de letras (localStorage, sessionStorage, httpOnly) nao conta."""
    v = (valor or "").strip().rstrip(".,;:!?)]}")
    minimo = 4 if (palavra or "").lower() == "pin" else 6
    if len(v) < minimo or _placeholder(v):
        return False
    if _seg is not None and _seg.RE_CODIGO.match(v):
        return False
    if re.match(r"^(?:https?:)?//", v) or v.startswith(("/", "./", "../")):
        return False
    return bool(re.search(r"\d", v) or RE_SIMBOLO_SENHA.search(v))


def _valor_parametro_url(valor: str) -> bool:
    """code, state, sig... em query string: troca so o que parece gerado (6+ caracteres com digito, simbolo ou
    maiuscula no meio); 'state=closed' e 'state=open' ficam."""
    v = (valor or "").strip()
    if len(v) < 6 or _placeholder(v):
        return False
    return bool(re.search(r"\d", v) or re.search(r"[^A-Za-z\-_]", v) or re.search(r"[a-z][A-Z]", v))


def _linha_de(texto: str, pos: int) -> str:
    ini = texto.rfind("\n", 0, pos) + 1
    fim = texto.find("\n", pos)
    return texto[ini:fim if fim >= 0 else len(texto)]


def _regras_do_segredos() -> list:
    if _seg is None:
        return []
    saida = []
    for rg in _seg.REGRAS:
        if rg.get("aplica") is not None or rg["id"] == REGRA_PUBLICA:
            continue
        saida.append(rg)
    return saida


def _trocar_grupo(texto: str, rx, grupo: int, aceitar) -> tuple:
    partes, pos, n = [], 0, 0
    for m in rx.finditer(texto):
        g = grupo if grupo <= (m.re.groups or 0) else 0
        valor = m.group(g)
        if not valor or MARCA in valor:
            continue
        ini, fim = m.span(g)
        if ini < pos or _ja_mascarado(texto, ini) or not aceitar(valor, texto, ini):
            continue
        partes.append(texto[pos:ini])
        partes.append(MARCA)
        pos = fim
        n += 1
    if not n:
        return texto, 0
    partes.append(texto[pos:])
    return "".join(partes), n


def _trocar_pares(texto: str, rx, grupo: int, refinar) -> tuple:
    """Regra do segredos.py com 'refinar' (cabecalho Cookie/Set-Cookie): troca o valor de CADA par secreto do
    grupo, inclusive depois de um par ja trocado por outra regra; o resto do cabecalho fica."""
    partes, pos, n = [], 0, 0
    for m in rx.finditer(texto):
        g = grupo if grupo <= (m.re.groups or 0) else 0
        valor = m.group(g)
        if not valor:
            continue
        base = m.start(g)
        for a, b in refinar(valor):
            ini, fim = base + a, base + b
            if ini < pos or MARCA in texto[ini:fim] or _ja_mascarado(texto, ini) or _placeholder(texto[ini:fim]):
                continue
            partes.append(texto[pos:ini])
            partes.append(MARCA)
            pos = fim
            n += 1
    if not n:
        return texto, 0
    partes.append(texto[pos:])
    return "".join(partes), n


def _trocar_senha_natural(texto: str) -> tuple:
    partes, pos, n = [], 0, 0
    for m in RE_SENHA_NATURAL.finditer(texto):
        separador = m.group("sep")
        conector = m.group("conector")
        for g in ("aspas2", "aspas1", "solto"):
            if m.group(g) is not None:
                break
        valor = m.group(g)
        ini, fim = m.span(g)
        if ini < pos or MARCA in valor or _ja_mascarado(texto, ini) or _placeholder(valor):
            continue
        if g == "solto":
            if conector and not separador:
                if not _cara_de_senha_com_conector(valor, m.group("palavra")):
                    continue
            elif not (_cara_de_senha(valor) or (separador and _valor_secreto(valor))):
                continue
        partes.append(texto[pos:ini])
        partes.append(MARCA)
        pos = fim
        n += 1
    if not n:
        return texto, 0
    partes.append(texto[pos:])
    return "".join(partes), n


def _nome_par_sensivel(nome: str, contexto: str | None = None) -> bool:
    """Nome de um par nome/valor (HAR, lista de cabecalhos, cookies, query): sensivel quando casa a lista de
    chaves sensiveis, comeca por .AspNetCore. ou contem sess, sid, csrf, xsrf, auth, token, jwt, secret, senha,
    passw, pwd, api key ou credencial (':authority' e 'author' ficam de fora). Em query/params, code e state
    tambem."""
    n = (nome or "").strip().lower()
    if not n or n in NOMES_PAR_NEUTROS:
        return False
    if contexto == "url" and n in ("code", "state"):
        return True
    if RE_CHAVE_SENSIVEL.match(n) or n.startswith(".aspnetcore."):
        return True
    return bool(RE_NOME_PAR_SESSAO.search(n))


def _nome_par_forte(nome: str, contexto: str | None = None) -> bool:
    """Nome que e credencial por si (password, token, sessionid, .AspNetCore.*; code/state em query): qualquer
    valor nao vazio vira [REMOVIDO]. Nome so 'parecido' (contem auth, sid, csrf...) exige valor sem espaco."""
    n = (nome or "").strip().lower()
    if contexto == "url" and n in ("code", "state"):
        return True
    return bool(RE_CHAVE_SENSIVEL.match(n) or n.startswith(".aspnetcore.") or n in ("csrftoken", "xsrf-token",
                                                                                    "x-csrf-token", "x-xsrf-token"))


def _spans_valor_par(nome: str, valor: str, contexto: str | None = None) -> list:
    """Spans (ini, fim) do valor de um par nome/valor que devem virar [REMOVIDO]."""
    if not valor or not valor.strip():
        return []
    n = (nome or "").strip().lower()
    if n in CHAVES_COOKIE:
        if _seg is not None and hasattr(_seg, "pares_secretos_cookie"):
            return list(_seg.pares_secretos_cookie(valor))
        return [(0, len(valor))]
    if n in CHAVES_AUTORIZACAO:
        m = RE_ESQUEMA_AUTH.match(valor)
        ini = m.end() if m else 0
        resto = valor[ini:]
        if not resto.strip() or _placeholder(resto):
            return []
        return [(ini, len(valor))]
    forte = _nome_par_forte(nome, contexto) or (contexto == "cookie" and len(valor.strip()) >= 16)
    if not forte and not (_nome_par_sensivel(nome, contexto) and not re.search(r"\s", valor.strip())):
        return []
    if _placeholder(valor):
        return []
    return [(0, len(valor))]


def _aplicar_spans(texto: str, spans: list) -> tuple:
    partes, pos, n = [], 0, 0
    for ini, fim in sorted(spans):
        if ini < pos or fim <= ini:
            continue
        trecho = texto[ini:fim]
        if MARCA in trecho or _ja_mascarado(texto, ini) or _placeholder(trecho):
            continue
        partes.append(texto[pos:ini])
        partes.append(MARCA)
        pos = fim
        n += 1
    if not n:
        return texto, 0
    partes.append(texto[pos:])
    return "".join(partes), n


def _trocar_pares_nome_valor(texto: str) -> tuple:
    """Texto com pares {"name": N, ..., "value": V} (HAR e afins, em qualquer ordem dentro do mesmo objeto)."""
    spans = []
    for rx, g_nome, g_valor in ((RE_PAR_NOME_VALOR, 1, 2), (RE_PAR_VALOR_NOME, 2, 1)):
        for m in rx.finditer(texto):
            base = m.start(g_valor)
            for a, b in _spans_valor_par(m.group(g_nome), m.group(g_valor)):
                spans.append((base + a, base + b))
    if not spans:
        return texto, 0
    return _aplicar_spans(texto, spans)


def mascarar_com_tipos(texto, estrito: bool = False) -> tuple:
    """estrito=True (payload, log, prova textual, entregavel): todo valor nao vazio de chave sensivel em JSON
    ("password": "...", "pass": "...", "authorization": "...", "cookie": "..."), inclusive JSON escapado dentro
    de string, em par nome/valor, em chave=valor ou entre aspas depois de 'senha:' vira [REMOVIDO], mesmo curto;
    e 'senha <valor com cara de senha>' tambem."""
    if not isinstance(texto, str) or not texto:
        return texto, []
    if not RE_PRE_FILTRO.search(texto):
        return texto, []
    s = texto
    tipos: list = []

    def anotar(n, nome):
        tipos.extend([nome] * n)

    s, n = RE_PEM.subn(MARCA, s)
    anotar(n, "chave privada")
    for rg in _regras_do_segredos():
        refinar = rg.get("refinar") or (getattr(_seg, "pares_secretos_cookie", None) if (
            rg["id"] == "cookie-sessao" and rg["descricao"] == getattr(_seg, "DESCRICAO_COOKIE_CABECALHO", None))
            else None)
        if refinar:
            s, n = _trocar_pares(s, rg["re"], rg["grupo"], refinar)
            anotar(n, rg["descricao"])
            continue

        def aceitar(valor, todo, ini, rg=rg):
            linha = _linha_de(todo, ini)
            if rg["filtro"] and not rg["filtro"](valor, linha):
                return False
            if rg["id"] in REGRAS_COM_CHAVE and not _valor_secreto(valor):
                return False
            return True
        s, n = _trocar_grupo(s, rg["re"], rg["grupo"], aceitar)
        anotar(n, rg["descricao"])
    s, n = _trocar_grupo(s, RE_PREFIXO_COLADO, 1, lambda v, t, i: True)
    anotar(n, "token de provedor colado ao texto")
    s, n = _trocar_grupo(s, RE_JWT, 0, lambda v, t, i: True)
    anotar(n, "token JWT")
    s, n = _trocar_grupo(s, RE_BEARER, 2, lambda v, t, i: not _placeholder(v))
    anotar(n, "token Bearer")
    s, n = _trocar_grupo(s, RE_SK, 1, lambda v, t, i: True)
    anotar(n, "chave de API (sk-)")
    s, n = _trocar_grupo(s, RE_CHAVE_VALOR, 3, lambda v, t, i: _valor_secreto(v))
    anotar(n, "credencial em chave=valor")
    s, n = _trocar_grupo(s, RE_PARAM_URL, 2, lambda v, t, i: _valor_parametro_url(v))
    anotar(n, "parametro de URL (code, state, sig)")
    if estrito:
        s, n = _trocar_pares_nome_valor(s)
        anotar(n, "campo sensivel em par nome/valor")
        s, n = _trocar_grupo(s, RE_JSON_SENSIVEL, 2, lambda v, t, i: not _placeholder(v))
        anotar(n, "campo sensivel em JSON")
        s, n = _trocar_grupo(s, RE_JSON_ESCAPADO_SENSIVEL, 2, lambda v, t, i: not _placeholder(v))
        anotar(n, "campo sensivel em JSON")
        s, n = _trocar_grupo(s, RE_KV_SENSIVEL, 2, lambda v, t, i: not _placeholder(v) and not _eh_codigo(v))
        anotar(n, "credencial em chave=valor")
        s, n = _trocar_senha_natural(s)
        anotar(n, "senha ou token no texto")
    return s, tipos


def mascarar(texto, estrito: bool = False) -> tuple:
    s, tipos = mascarar_com_tipos(texto, estrito)
    return s, len(tipos)


def tipos_de_segredo(texto) -> list:
    return sorted(set(mascarar_com_tipos(texto, estrito=True)[1]))


CHAVES_COOKIE = {"cookie", "set-cookie"}
RE_CHAVE_SENSIVEL = re.compile(r"(?i)^(password|senha|passwd|pass|pwd|pin|secret|segredo|token|access_?token|"
                               r"refresh_?token|id_?token|api_?key|client_?secret|authorization|credentials?|credencial|"
                               r"session_?id|sessionid|x-api-key|x-auth-token)$")
CHAVES_NOME_PAR = ("name", "Name", "key", "Key", "NAME", "KEY")
CHAVES_VALOR_PAR = ("value", "Value", "VALUE")
PROFUNDIDADE_JSON = 40


def _mascarar_valor_de_chave(chave: str, valor: str):
    """Modo estrito, dict com a chave do cabecalho ou do campo: 'cookie'/'set-cookie' tem cada par conferido como
    no cabecalho Cookie; chave sensivel (password, token, authorization...) tem o valor trocado inteiro."""
    nome = chave.strip().lower()
    if nome in CHAVES_COOKIE:
        prefixo = "Cookie: "
        s, n = mascarar(prefixo + valor, True)
        return s[len(prefixo):] if s.startswith(prefixo) else s, n
    if RE_CHAVE_SENSIVEL.match(nome) and valor.strip() and not _placeholder(valor):
        return MARCA, 1
    return None


def _par_da_estrutura(d: dict):
    """(chave do nome, nome, chave do valor) quando o dict e um par nome/valor; senao None."""
    chave_nome = next((k for k in CHAVES_NOME_PAR if isinstance(d.get(k), str)), None)
    chave_valor = next((k for k in CHAVES_VALOR_PAR if k in d), None)
    if chave_nome is None or chave_valor is None or chave_nome == chave_valor:
        return None
    return chave_nome, d[chave_nome], chave_valor


def _contexto_filho(chave, atual):
    if not isinstance(chave, str):
        return atual
    k = chave.strip().lower()
    if k in CONTEXTO_URL:
        return "url"
    if k in CONTEXTO_COOKIE:
        return "cookie"
    return atual


def mascarar_estrutura(obj, pular=(), estrito: bool = True) -> tuple:
    pular = set(pular or ())
    total = [0]

    def item(k, v, contexto, prof):
        if k in pular:
            return v
        if estrito and isinstance(k, str) and isinstance(v, str) and v:
            trocado = _mascarar_valor_de_chave(k, v)
            if trocado is not None:
                total[0] += trocado[1]
                return trocado[0]
        return andar(v, _contexto_filho(k, contexto), prof + 1)

    def valor_do_par(nome, valor, contexto):
        if isinstance(valor, bool) or valor is None:
            return None
        if isinstance(valor, (int, float)):
            if _nome_par_sensivel(nome, contexto) and (nome or "").strip().lower() not in CHAVES_COOKIE:
                total[0] += 1
                return MARCA
            return None
        if not isinstance(valor, str):
            return None
        spans = _spans_valor_par(nome, valor, contexto)
        if not spans:
            return None
        novo, n = _aplicar_spans(valor, spans)
        if not n:
            return None
        total[0] += n
        return andar(novo, contexto, 0)

    def texto_json(x, contexto, prof):
        t = x.strip()
        if prof > PROFUNDIDADE_JSON or len(t) < 2 or t[0] not in "{[" or t[-1] not in "}]":
            return None
        try:
            carregado = json.loads(t)
        except (ValueError, RecursionError):
            return None
        if not isinstance(carregado, (dict, list)):
            return None
        antes = total[0]
        novo = andar(carregado, contexto, prof + 1)
        if total[0] == antes:
            return None
        s = json.dumps(novo, ensure_ascii=False)
        s, n = mascarar(s, estrito)
        total[0] += n
        return s

    def andar(x, contexto=None, prof=0):
        if isinstance(x, str):
            if estrito:
                como_json = texto_json(x, contexto, prof)
                if como_json is not None:
                    return como_json
            s, n = mascarar(x, estrito)
            total[0] += n
            return s
        if isinstance(x, dict):
            par = _par_da_estrutura(x) if estrito else None
            trocado = valor_do_par(par[1], x[par[2]], contexto) if par else None
            saida = {}
            for k, v in x.items():
                if par and k == par[2] and trocado is not None and k not in pular:
                    saida[k] = trocado
                else:
                    saida[k] = item(k, v, contexto, prof)
            return saida
        if isinstance(x, list):
            return [andar(v, contexto, prof + 1) for v in x]
        if isinstance(x, tuple):
            return tuple(andar(v, contexto, prof + 1) for v in x)
        return x

    return andar(obj), total[0]


EXT_JSON_INTEIRO = (".json", ".har")
EXT_JSON_POR_LINHA = (".jsonl", ".ndjson")


def estrutura_de_arquivo(texto: str, sufixo: str = "", indentar: int | None = 2):
    """.json/.har (JSON inteiro) e .jsonl/.ndjson (um JSON por linha) carregados e passados por mascarar_estrutura.
    Devolve (bruto, limpo, n): o JSON serializado sem e com a mascara, nas MESMAS linhas (para cortar e contar), e
    quantos valores a estrutura trocou; None quando o arquivo nao e JSON valido."""
    if not isinstance(texto, str) or not texto:
        return None
    suf = (sufixo or "").lower()
    if suf in EXT_JSON_INTEIRO:
        try:
            dados = json.loads(texto)
        except (ValueError, RecursionError):
            return None
        if not isinstance(dados, (dict, list)):
            return None
        limpo, n = mascarar_estrutura(dados)
        return (json.dumps(dados, ensure_ascii=False, indent=indentar),
                json.dumps(limpo, ensure_ascii=False, indent=indentar), n)
    if suf in EXT_JSON_POR_LINHA:
        brutos, limpos, total, algum = [], [], 0, False
        for linha in texto.splitlines():
            try:
                dados = json.loads(linha) if linha.strip() else None
            except (ValueError, RecursionError):
                dados = None
            if isinstance(dados, (dict, list)):
                limpo, n = mascarar_estrutura(dados)
                brutos.append(json.dumps(dados, ensure_ascii=False))
                limpos.append(json.dumps(limpo, ensure_ascii=False))
                total += n
                algum = True
            else:
                brutos.append(linha)
                limpos.append(linha)
        return ("\n".join(brutos), "\n".join(limpos), total) if algum else None
    return None


def mascarar_texto_de_arquivo(texto: str, sufixo: str = "", indentar: int | None = 2,
                              texto_tambem: bool = True) -> tuple:
    """Prova textual vinda de arquivo: .json/.har e .jsonl/.ndjson sao carregados e mascarados como estrutura (par
    nome/valor, JSON dentro de string, chave sensivel) e depois, com texto_tambem, como texto; o que nao for JSON
    valido passa pela mascara de texto estrita (sem texto_tambem, volta como esta). Devolve (texto, n)."""
    if not isinstance(texto, str) or not texto:
        return texto, 0
    est = estrutura_de_arquivo(texto, sufixo, indentar)
    if est is None:
        return mascarar(texto, True) if texto_tambem else (texto, 0)
    _, limpo, n = est
    if not texto_tambem:
        return limpo, n
    s, n2 = mascarar(limpo, True)
    return s, n + n2


def avisar(n: int, onde: str, fluxo=None) -> None:
    if n:
        print(f"aviso: {n} segredo(s) mascarado(s) como {MARCA} em {onde}. O valor nao foi impresso; tire o dado "
              f"da fonte (ledger, spec, arquivo) e descreva so o tipo de dado.", file=fluxo or sys.stderr)


if __name__ == "__main__":
    print(__doc__)

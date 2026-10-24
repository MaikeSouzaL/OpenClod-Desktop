#!/usr/bin/env python3
"""gerar_pdf.py - HTML ou Markdown -> PDF pelo Chrome/Edge/Chromium/Brave headless (skill qa-total).

Markdown: usa a biblioteca `markdown` se existir (sem nl2br, que quebra frases no meio);
senao, um conversor embutido de titulos, paragrafos, listas, codigo, tabelas, citacoes e imagens.
O resultado vai num HTML com CSS de impressao A4 e e impresso pelo navegador.

Todo texto da entrada passa pela mascara comum de segredos (_mascara.py, modo estrito) antes de imprimir:
achou token, senha, chave, Basic ou cookie de sessao, o valor vira [REMOVIDO] no PDF, o aviso sai no stderr
(sem o valor) e a saida e 1. Marcador de template sem preencher ('{{', '}}', '[PREENCHA') tambem sai 1, sem
gerar o PDF (salvo --permitir-placeholder).

Somente biblioteca padrao (pypdf opcional, so para contar paginas). Python 3.9+.
"""
from __future__ import annotations

import argparse
import html
import json
import os
import re
import shutil
import subprocess
import sys
import tempfile
import time
from pathlib import Path

_AQUI = Path(__file__).resolve().parent
if str(_AQUI) not in sys.path:
    sys.path.insert(0, str(_AQUI))
import _mascara

EXIT_OK, EXIT_SEGREDO, EXIT_USO, EXIT_SEM_NAVEGADOR, EXIT_FALHA = 0, 1, 2, 3, 4

CSS_IMPRESSAO = """
@page { size: A4 __ORIENTACAO__; margin: 16mm; }
html { -webkit-print-color-adjust: exact; print-color-adjust: exact; }
body { font-family: "Segoe UI", -apple-system, "Helvetica Neue", Arial, "DejaVu Sans", sans-serif;
  font-size: 10.5pt; line-height: 1.5; color: #181B21; margin: 0; }
h1 { font-size: 20pt; margin: 0 0 8pt; line-height: 1.2; }
h2 { font-size: 14pt; margin: 18pt 0 6pt; padding-bottom: 3pt; border-bottom: 1px solid #E4E8EC; }
h3 { font-size: 12pt; margin: 14pt 0 4pt; }
h4, h5, h6 { font-size: 10.5pt; margin: 12pt 0 4pt; }
h1, h2, h3, h4, h5, h6 { break-after: avoid; page-break-after: avoid; }
p { margin: 0 0 7pt; }
ul, ol { margin: 0 0 7pt; padding-left: 18pt; }
li { margin: 1pt 0; }
table { border-collapse: collapse; width: 100%; margin: 6pt 0 10pt; font-size: 9pt; }
th, td { border: 1px solid #C7CED6; padding: 3pt 6pt; text-align: left; vertical-align: top; }
th { background: #F0F2F4; font-weight: 600; }
tbody tr:nth-child(even) td { background: #F9FAFB; }
td.dir, th.dir { text-align: right; font-variant-numeric: tabular-nums; }
td.centro, th.centro { text-align: center; }
tr, img, pre, blockquote, figure { break-inside: avoid; page-break-inside: avoid; }
code { font-family: Consolas, "SFMono-Regular", Menlo, "DejaVu Sans Mono", monospace; font-size: 8.8pt;
  background: #F0F2F4; padding: 0 3pt; border-radius: 3px; }
pre { background: #F0F2F4; padding: 7pt 9pt; border-radius: 4px; white-space: pre-wrap;
  word-break: break-word; font-size: 8.8pt; line-height: 1.4; }
pre code { background: none; padding: 0; }
img { max-width: 100%; height: auto; border: 1px solid #E4E8EC; }
blockquote { margin: 6pt 0 10pt; padding: 5pt 10pt; border-left: 3px solid #ACB6C3; background: #F9FAFB;
  color: #45505F; }
blockquote p:last-child { margin-bottom: 0; }
a { color: #0B6BCB; text-decoration: none; }
hr { border: 0; border-top: 1px solid #E4E8EC; margin: 14pt 0; }
"""

MODOS_HEADLESS = ("--headless=new", "--headless")
ARQUIVO_MODO = "qa-total-headless-modo.json"
TIMEOUT_PRIMEIRA = 30
RE_PLACEHOLDER = re.compile(r"\{\{|\}\}|\[PREENCHA", re.I)

NOMES_NO_PATH = ["google-chrome", "google-chrome-stable", "chrome", "chromium", "chromium-browser",
                 "msedge", "microsoft-edge", "microsoft-edge-stable", "brave", "brave-browser"]


class FormatadorPT(argparse.RawDescriptionHelpFormatter):
    def add_usage(self, usage, actions, groups, prefix=None):
        return super().add_usage(usage, actions, groups, prefix="uso: " if prefix is None else prefix)


class ParserPT(argparse.ArgumentParser):
    def __init__(self, *args, **kwargs):
        kwargs.setdefault("formatter_class", FormatadorPT)
        kwargs.setdefault("add_help", False)
        super().__init__(*args, **kwargs)
        self._positionals.title = "argumentos"
        self._optionals.title = "opcoes"
        self.add_argument("-h", "--help", action="help", default=argparse.SUPPRESS,
                          help="mostra esta ajuda e sai")

    def error(self, message):
        self.print_usage(sys.stderr)
        self.exit(EXIT_USO, f"{self.prog}: erro: {message}\n")


def configurar_saida() -> None:
    for fluxo in (sys.stdout, sys.stderr):
        try:
            if fluxo.isatty() or os.environ.get("PYTHONIOENCODING"):
                fluxo.reconfigure(errors="replace")
            else:
                fluxo.reconfigure(encoding="utf-8", errors="replace")
        except (AttributeError, ValueError):
            pass


def falhar(msg: str, codigo: int = EXIT_USO) -> None:
    print(f"erro: {msg}", file=sys.stderr)
    raise SystemExit(codigo)


def chromium_do_playwright() -> list:
    """Chromium que o Playwright instala (ms-playwright), da versao mais alta para a mais baixa. Nunca executa
    o navegador para descobrir a versao: le so o nome da pasta (chromium-NNNN)."""
    raizes = []
    env = os.environ.get("PLAYWRIGHT_BROWSERS_PATH")
    if env and env != "0":
        raizes.append(Path(env).expanduser())
    if sys.platform.startswith("win"):
        if os.environ.get("LOCALAPPDATA"):
            raizes.append(Path(os.environ["LOCALAPPDATA"]) / "ms-playwright")
        padroes = ["chromium-*/chrome-win*/chrome.exe"]
    elif sys.platform == "darwin":
        raizes.append(Path.home() / "Library" / "Caches" / "ms-playwright")
        padroes = ["chromium-*/chrome-mac*/Chromium.app/Contents/MacOS/Chromium",
                   "chromium-*/chrome-mac*/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing"]
    else:
        raizes.append(Path.home() / ".cache" / "ms-playwright")
        padroes = ["chromium-*/chrome-linux*/chrome"]
    achados = set()
    for raiz in raizes:
        if raiz.is_dir():
            for padrao in padroes:
                achados.update(str(x) for x in raiz.glob(padrao) if x.is_file())

    def versao(caminho: str) -> int:
        m = re.search(r"chromium-(\d+)", caminho.replace("\\", "/"))
        return int(m.group(1)) if m else 0
    return sorted(achados, key=versao, reverse=True)


def candidatos_navegador() -> list:
    lista = []
    if os.environ.get("QA_CHROME"):
        lista.append(os.environ["QA_CHROME"])
    for nome in NOMES_NO_PATH:
        achado = shutil.which(nome)
        if achado:
            lista.append(achado)
    if sys.platform.startswith("win"):
        raizes = [os.environ.get(v) for v in ("PROGRAMFILES", "PROGRAMFILES(X86)", "LOCALAPPDATA", "PROGRAMW6432")]
        relativos = [r"Google\Chrome\Application\chrome.exe",
                     r"Microsoft\Edge\Application\msedge.exe",
                     r"BraveSoftware\Brave-Browser\Application\brave.exe",
                     r"Chromium\Application\chrome.exe",
                     r"Google\Chrome Beta\Application\chrome.exe"]
        for raiz in raizes:
            if raiz:
                lista.extend(os.path.join(raiz, rel) for rel in relativos)
    elif sys.platform == "darwin":
        apps = ["Google Chrome.app/Contents/MacOS/Google Chrome",
                "Chromium.app/Contents/MacOS/Chromium",
                "Microsoft Edge.app/Contents/MacOS/Microsoft Edge",
                "Brave Browser.app/Contents/MacOS/Brave Browser",
                "Google Chrome Canary.app/Contents/MacOS/Google Chrome Canary"]
        for base in ("/Applications", os.path.expanduser("~/Applications")):
            lista.extend(os.path.join(base, a) for a in apps)
    else:
        lista += ["/usr/bin/google-chrome", "/usr/bin/google-chrome-stable", "/usr/bin/chromium",
                  "/usr/bin/chromium-browser", "/snap/bin/chromium", "/usr/bin/microsoft-edge",
                  "/usr/bin/microsoft-edge-stable", "/usr/bin/brave-browser", "/opt/google/chrome/chrome",
                  "/opt/brave.com/brave/brave", "/opt/microsoft/msedge/msedge"]
    lista.extend(chromium_do_playwright())
    vistos, saida = set(), []
    for c in lista:
        chave = os.path.normcase(os.path.abspath(c))
        if chave not in vistos:
            vistos.add(chave)
            saida.append(c)
    return saida


def localizar_navegador(explicito: str | None) -> str:
    if explicito:
        caminho = shutil.which(explicito) or explicito
        if not Path(caminho).exists():
            falhar(f"navegador informado nao existe: {explicito}", EXIT_SEM_NAVEGADOR)
        return caminho
    for c in candidatos_navegador():
        if Path(c).is_file():
            return c
    falhar("nenhum Chrome/Edge/Chromium/Brave encontrado. Instale um, ou aponte o executavel com "
           "--navegador ou com a variavel QA_CHROME.", EXIT_SEM_NAVEGADOR)


def slug(texto: str) -> str:
    s = re.sub(r"<[^>]+>", "", texto).lower()
    s = re.sub(r"[^\w\s-]", "", s, flags=re.UNICODE)
    return re.sub(r"[\s_]+", "-", s).strip("-") or "secao"


PADRAO_SEPARADOR_TABELA = re.compile(r"^\s*\|?\s*:?-{3,}:?\s*(\|\s*:?-{3,}:?\s*)*\|?\s*$")
PADRAO_ITEM_LISTA = re.compile(r"^(\s*)([-*+]|\d{1,9}[.)])\s+(.*)$")
PADRAO_TITULO = re.compile(r"^(#{1,6})\s+(.*?)\s*#*\s*$")
PADRAO_CERCA = re.compile(r"^(\s*)(`{3,}|~{3,})\s*([\w+#.-]*).*$")
PADRAO_REGUA = re.compile(r"^\s{0,3}((\*\s*){3,}|(-\s*){3,}|(_\s*){3,})$")
PADRAO_HTML_BLOCO = re.compile(r"^\s*<(/?)(div|p|table|img|figure|section|details|br|hr|h[1-6]|ul|ol|pre|!--)", re.I)


def inline(texto: str) -> str:
    guardados = []

    def guardar(valor: str) -> str:
        guardados.append(valor)
        return f"\x00{len(guardados) - 1}\x00"

    texto = re.sub(r"(`+)(.+?)\1", lambda m: guardar(f"<code>{html.escape(m.group(2).strip())}</code>"), texto)
    texto = re.sub(r"\\([\\`*_{}\[\]()#+\-.!|~>])", lambda m: guardar(html.escape(m.group(1))), texto)
    texto = html.escape(texto, quote=False)

    def imagem(m):
        alt, src, titulo = m.group(1), m.group(2), m.group(3)
        t = f' title="{html.escape(titulo, quote=True)}"' if titulo else ""
        return guardar(f'<img src="{html.escape(src, quote=True)}" alt="{html.escape(alt, quote=True)}"{t}>')

    texto = re.sub(r'!\[([^\]]*)\]\(\s*<?([^)\s>]+)>?(?:\s+"([^"]*)")?\s*\)', imagem, texto)

    def link(m):
        rotulo, href = m.group(1), m.group(2)
        return guardar(f'<a href="{html.escape(href, quote=True)}">') + rotulo + guardar("</a>")

    texto = re.sub(r'\[([^\]]+)\]\(\s*<?([^)\s>]+)>?(?:\s+"[^"]*")?\s*\)', link, texto)
    texto = re.sub(r"&lt;((?:https?|mailto):[^\s&]+)&gt;",
                   lambda m: guardar(f'<a href="{m.group(1)}">{m.group(1)}</a>'), texto)
    texto = re.sub(r"\*\*(?=\S)(.+?)(?<=\S)\*\*", r"<strong>\1</strong>", texto)
    texto = re.sub(r"(?<![\w])__(?=\S)(.+?)(?<=\S)__(?![\w])", r"<strong>\1</strong>", texto)
    texto = re.sub(r"(?<![\w*])\*(?=[^\s*])(.+?)(?<=[^\s*])\*(?![\w*])", r"<em>\1</em>", texto)
    texto = re.sub(r"(?<![\w])_(?=[^\s_])(.+?)(?<=[^\s_])_(?![\w])", r"<em>\1</em>", texto)
    texto = re.sub(r"~~(?=\S)(.+?)(?<=\S)~~", r"<del>\1</del>", texto)
    while "\x00" in texto:
        novo = re.sub(r"\x00(\d+)\x00", lambda m: guardados[int(m.group(1))], texto)
        if novo == texto:
            break
        texto = novo
    return texto


def dividir_celulas(linha: str) -> list:
    s = linha.strip()
    if s.startswith("|"):
        s = s[1:]
    if s.endswith("|") and not s.endswith("\\|"):
        s = s[:-1]
    celulas, atual, em_codigo = [], [], False
    i = 0
    while i < len(s):
        ch = s[i]
        if ch == "\\" and i + 1 < len(s) and s[i + 1] == "|":
            atual.append("|")
            i += 2
            continue
        if ch == "`":
            em_codigo = not em_codigo
        if ch == "|" and not em_codigo:
            celulas.append("".join(atual).strip())
            atual = []
        else:
            atual.append(ch)
        i += 1
    celulas.append("".join(atual).strip())
    return celulas


def indentacao(linha: str) -> int:
    return len(linha.expandtabs(4)) - len(linha.expandtabs(4).lstrip(" "))


def converter_lista(linhas: list) -> str:
    m0 = PADRAO_ITEM_LISTA.match(linhas[0])
    ordenada = m0.group(2)[0].isdigit()
    base = indentacao(linhas[0])
    itens, atual = [], None
    for ln in linhas:
        m = PADRAO_ITEM_LISTA.match(ln)
        if m and indentacao(ln) <= base + 1 and (m.group(2)[0].isdigit()) == ordenada:
            if atual is not None:
                itens.append(atual)
            largura_marcador = len(m.group(1).expandtabs(4)) + len(m.group(2)) + 1
            atual = {"linhas": [m.group(3)], "recuo": largura_marcador, "inicio": m.group(2)}
        elif atual is not None:
            if ln.strip():
                corte = min(indentacao(ln), atual["recuo"])
                atual["linhas"].append(ln.expandtabs(4)[corte:])
            else:
                atual["linhas"].append("")
    if atual is not None:
        itens.append(atual)
    partes = []
    for it in itens:
        conteudo = it["linhas"]
        while conteudo and not conteudo[-1].strip():
            conteudo.pop()
        solta = any(not x.strip() for x in conteudo)
        corpo = converter_blocos(conteudo).strip()
        if not solta and corpo.startswith("<p>"):
            fim = corpo.find("</p>")
            corpo = corpo[3:fim] + corpo[fim + 4:]
        corpo = re.sub(r"^\[ \]\s", "&#9744; ", corpo)
        corpo = re.sub(r"^\[[xX]\]\s", "&#9745; ", corpo)
        partes.append(f"<li>{corpo}</li>")
    tag = "ol" if ordenada else "ul"
    inicio = ""
    if ordenada:
        numero = re.match(r"\d+", itens[0]["inicio"]).group(0) if itens else "1"
        if numero != "1":
            inicio = f' start="{int(numero)}"'
    return f"<{tag}{inicio}>\n" + "\n".join(partes) + f"\n</{tag}>"


def converter_tabela(cabecalho: str, separador: str, corpo: list) -> str:
    alinhamentos = []
    for c in dividir_celulas(separador):
        c = c.strip()
        if c.startswith(":") and c.endswith(":"):
            alinhamentos.append("centro")
        elif c.endswith(":"):
            alinhamentos.append("dir")
        else:
            alinhamentos.append("")
    def classe(i):
        a = alinhamentos[i] if i < len(alinhamentos) else ""
        return f' class="{a}"' if a else ""
    cab = dividir_celulas(cabecalho)
    saida = ["<table>", "<thead><tr>" + "".join(f"<th{classe(i)}>{inline(c)}</th>" for i, c in enumerate(cab)) + "</tr></thead>", "<tbody>"]
    for ln in corpo:
        cels = dividir_celulas(ln)
        cels += [""] * (len(cab) - len(cels))
        saida.append("<tr>" + "".join(f"<td{classe(i)}>{inline(c)}</td>" for i, c in enumerate(cels[:len(cab)])) + "</tr>")
    saida.append("</tbody></table>")
    return "\n".join(saida)


def converter_blocos(linhas: list) -> str:
    out = []
    paragrafo: list = []

    def fechar_paragrafo():
        if paragrafo:
            pedacos = []
            for k, ln in enumerate(paragrafo):
                quebra = ln.endswith("  ") or ln.endswith("\\")
                texto = inline(ln.rstrip().rstrip("\\").rstrip() if ln.endswith("\\") else ln.strip())
                pedacos.append(texto + ("<br>" if quebra and k < len(paragrafo) - 1 else ""))
            out.append("<p>" + "\n".join(pedacos) + "</p>")
            paragrafo.clear()

    i, n = 0, len(linhas)
    while i < n:
        ln = linhas[i]
        cerca = PADRAO_CERCA.match(ln)
        if cerca:
            fechar_paragrafo()
            marcador, linguagem = cerca.group(2), cerca.group(3)
            codigo = []
            i += 1
            while i < n and not linhas[i].strip().startswith(marcador[0] * len(marcador)):
                codigo.append(linhas[i])
                i += 1
            i += 1
            classe = f' class="language-{html.escape(linguagem)}"' if linguagem else ""
            out.append(f"<pre><code{classe}>{html.escape(chr(10).join(codigo))}</code></pre>")
            continue
        if not ln.strip():
            fechar_paragrafo()
            i += 1
            continue
        titulo = PADRAO_TITULO.match(ln)
        if titulo:
            fechar_paragrafo()
            nivel = len(titulo.group(1))
            conteudo = inline(titulo.group(2))
            out.append(f'<h{nivel} id="{slug(conteudo)}">{conteudo}</h{nivel}>')
            i += 1
            continue
        if PADRAO_REGUA.match(ln):
            fechar_paragrafo()
            out.append("<hr>")
            i += 1
            continue
        if "|" in ln and i + 1 < n and PADRAO_SEPARADOR_TABELA.match(linhas[i + 1]):
            fechar_paragrafo()
            cab, sep = ln, linhas[i + 1]
            i += 2
            corpo = []
            while i < n and linhas[i].strip() and "|" in linhas[i]:
                corpo.append(linhas[i])
                i += 1
            out.append(converter_tabela(cab, sep, corpo))
            continue
        if re.match(r"^\s{0,3}>", ln):
            fechar_paragrafo()
            citacao = []
            while i < n and (re.match(r"^\s{0,3}>", linhas[i]) or (linhas[i].strip() and citacao and citacao[-1].strip())):
                citacao.append(re.sub(r"^\s{0,3}> ?", "", linhas[i]))
                i += 1
            out.append("<blockquote>\n" + converter_blocos(citacao) + "\n</blockquote>")
            continue
        item = PADRAO_ITEM_LISTA.match(ln)
        if item and (not paragrafo or not item.group(2)[0].isdigit() or re.match(r"1[.)]", item.group(2))):
            fechar_paragrafo()
            bloco = [ln]
            i += 1
            base = indentacao(ln)
            ordenada = item.group(2)[0].isdigit()

            def irma_de_outro_tipo(linha):
                m = PADRAO_ITEM_LISTA.match(linha)
                return bool(m) and indentacao(linha) <= base + 1 and m.group(2)[0].isdigit() != ordenada

            while i < n:
                atual = linhas[i]
                if not atual.strip():
                    j = i + 1
                    while j < n and not linhas[j].strip():
                        j += 1
                    if j < n and not irma_de_outro_tipo(linhas[j]) and (
                            indentacao(linhas[j]) > base or
                            (PADRAO_ITEM_LISTA.match(linhas[j]) and indentacao(linhas[j]) <= base + 1)):
                        bloco.extend(linhas[i:j])
                        i = j
                        continue
                    break
                if irma_de_outro_tipo(atual):
                    break
                if indentacao(atual) > base or PADRAO_ITEM_LISTA.match(atual):
                    bloco.append(atual)
                    i += 1
                    continue
                if PADRAO_TITULO.match(atual) or PADRAO_CERCA.match(atual) or re.match(r"^\s{0,3}>", atual):
                    break
                bloco.append("  " * (base // 2 + 1) + atual.strip())
                i += 1
            out.append(converter_lista(bloco))
            continue
        if PADRAO_HTML_BLOCO.match(ln) and not paragrafo:
            bruto = []
            while i < n and linhas[i].strip():
                bruto.append(linhas[i])
                i += 1
            out.append("\n".join(bruto))
            continue
        paragrafo.append(ln)
        i += 1
    fechar_paragrafo()
    return "\n".join(out)


def md_para_html_interno(texto: str) -> str:
    linhas = texto.replace("\r\n", "\n").replace("\r", "\n").split("\n")
    return converter_blocos(linhas)


def md_para_html(texto: str, conversor: str) -> tuple:
    if conversor in ("auto", "markdown"):
        try:
            import markdown
            corpo = markdown.markdown(texto, extensions=["tables", "fenced_code", "sane_lists", "toc"],
                                      output_format="html5")
            return corpo, "markdown"
        except ImportError:
            if conversor == "markdown":
                falhar("biblioteca markdown nao instalada (python -m pip install markdown) ou use --conversor interno")
    return md_para_html_interno(texto), "interno"


def titulo_do_html(corpo: str, padrao: str) -> str:
    m = re.search(r"<h1[^>]*>(.*?)</h1>", corpo, re.S | re.I)
    if m:
        texto = html.unescape(re.sub(r"<[^>]+>", "", m.group(1))).strip()
        if texto:
            return texto
    return padrao


def envolver_html(corpo: str, titulo: str, paisagem: bool, css_extra: str, base_href: str = "") -> str:
    css = CSS_IMPRESSAO.replace("__ORIENTACAO__", "landscape" if paisagem else "portrait")
    base = f'<base href="{html.escape(base_href, quote=True)}">\n' if base_href else ""
    return ("<!doctype html>\n<html lang=\"pt-BR\">\n<head>\n<meta charset=\"utf-8\">\n" + base +
            f"<title>{html.escape(titulo)}</title>\n<style>{css}\n{css_extra}</style>\n</head>\n<body>\n"
            f"{corpo}\n</body>\n</html>\n")


def contar_paginas(pdf: Path):
    try:
        from pypdf import PdfReader
        return len(PdfReader(str(pdf)).pages), "pypdf"
    except Exception:
        pass
    try:
        from PyPDF2 import PdfReader as Leitor2
        return len(Leitor2(str(pdf)).pages), "PyPDF2"
    except Exception:
        pass
    try:
        dados = pdf.read_bytes()
    except OSError:
        return None, ""
    contagens = [int(x) for x in re.findall(rb"/Type\s*/Pages\b[^>]*?/Count\s+(\d+)", dados)]
    if contagens:
        return max(contagens), "aprox"
    paginas = len(re.findall(rb"/Type\s*/Page(?![s\w])", dados))
    return (paginas or None), "aprox"


def _arquivo_modo() -> Path:
    return Path(tempfile.gettempdir()) / ARQUIVO_MODO


def _chave_navegador(navegador: str) -> str:
    return os.path.normcase(os.path.abspath(navegador))


def modo_lembrado(navegador: str) -> str:
    """Modo headless que funcionou da ultima vez com este executavel (cache da sessao, na pasta temporaria)."""
    try:
        dados = json.loads(_arquivo_modo().read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return ""
    modo = dados.get(_chave_navegador(navegador)) if isinstance(dados, dict) else ""
    return modo if modo in MODOS_HEADLESS else ""


def lembrar_modo(navegador: str, modo: str) -> None:
    arq = _arquivo_modo()
    try:
        dados = json.loads(arq.read_text(encoding="utf-8"))
        if not isinstance(dados, dict):
            dados = {}
    except (OSError, ValueError):
        dados = {}
    dados[_chave_navegador(navegador)] = modo
    try:
        tmp = arq.with_name(arq.name + f".{os.getpid()}.tmp")
        tmp.write_text(json.dumps(dados, ensure_ascii=False, indent=1) + "\n", encoding="utf-8")
        os.replace(tmp, arq)
    except OSError:
        pass


def ordem_dos_modos(navegador: str) -> list:
    lembrado = modo_lembrado(navegador)
    return [lembrado] + [m for m in MODOS_HEADLESS if m != lembrado] if lembrado else list(MODOS_HEADLESS)


def pdf_pronto(caminho: Path) -> int:
    """Tamanho do PDF quando ele ja termina com %%EOF; 0 enquanto nao existe ou esta pela metade."""
    try:
        tamanho = caminho.stat().st_size
        if tamanho <= 0:
            return 0
        with open(caminho, "rb") as f:
            f.seek(max(0, tamanho - 2048))
            return tamanho if b"%%EOF" in f.read() else 0
    except OSError:
        return 0


def encerrar_processo(proc) -> None:
    if proc.poll() is not None:
        return
    if sys.platform.startswith("win"):
        subprocess.run(["taskkill", "/F", "/T", "/PID", str(proc.pid)], stdout=subprocess.DEVNULL,
                       stderr=subprocess.DEVNULL)
    else:
        proc.terminate()
    try:
        proc.wait(timeout=10)
    except subprocess.TimeoutExpired:
        proc.kill()
        try:
            proc.wait(timeout=5)
        except subprocess.TimeoutExpired:
            pass


def rodar_ate_o_pdf(cmd: list, temp_pdf: Path, limite: float, log_erro: Path) -> tuple:
    """Roda o navegador e consulta o PDF a cada 1 s: com o tamanho estavel por dois ciclos (e o %%EOF no fim),
    encerra o processo e da sucesso, sem esperar o navegador sair sozinho. Devolve (ok, motivo)."""
    with open(log_erro, "wb") as err:
        try:
            proc = subprocess.Popen(cmd, stdout=subprocess.DEVNULL, stderr=err)
        except OSError as e:
            return False, f"falha ao executar {cmd[0]}: {e}"
        inicio, anterior = time.monotonic(), 0
        try:
            while True:
                tamanho = pdf_pronto(temp_pdf)
                if tamanho and tamanho == anterior:
                    return True, ""
                anterior = tamanho
                if proc.poll() is not None:
                    time.sleep(0.3)
                    return (True, "") if pdf_pronto(temp_pdf) else (False, "o navegador saiu sem gerar o PDF")
                if time.monotonic() - inicio > limite:
                    return False, f"tempo esgotado ({limite:.0f}s)"
                time.sleep(1)
        finally:
            encerrar_processo(proc)


def imprimir_pdf(navegador: str, html_path: Path, destino: Path, espera_ms: int, timeout: int,
                 timeout_primeira: int = TIMEOUT_PRIMEIRA):
    perfil = Path(tempfile.mkdtemp(prefix="qa-pdf-perfil-"))
    pasta_temp = Path(tempfile.mkdtemp(prefix="qa-pdf-saida-"))
    temp_pdf = pasta_temp / "saida.pdf"
    log_erro = pasta_temp / "navegador-stderr.txt"
    ultimo_erro = ""
    lembrado = modo_lembrado(navegador)
    try:
        for i, modo in enumerate(ordem_dos_modos(navegador)):
            limite = timeout if i > 0 else min(timeout, max(5, timeout_primeira))
            try:
                temp_pdf.unlink()
            except OSError:
                pass
            cmd = [navegador, modo, "--disable-gpu", "--no-first-run", "--no-default-browser-check",
                   "--disable-extensions", "--hide-scrollbars", "--mute-audio",
                   f"--user-data-dir={perfil}", "--run-all-compositor-stages-before-draw",
                   "--no-pdf-header-footer", "--print-to-pdf-no-header",
                   f"--print-to-pdf={temp_pdf}"]
            if espera_ms > 0:
                cmd.append(f"--virtual-time-budget={espera_ms}")
            cmd.append(html_path.resolve().as_uri())
            ok, motivo = rodar_ate_o_pdf(cmd, temp_pdf, limite, log_erro)
            if not ok:
                try:
                    saida_nav = log_erro.read_bytes().decode("utf-8", "replace")[-1500:]
                except OSError:
                    saida_nav = ""
                ultimo_erro = f"{motivo} com {modo}" + (f"\n{saida_nav}" if saida_nav else "")
                if motivo.startswith("falha ao executar"):
                    break
                continue
            lembrar_modo(navegador, modo)
            destino.parent.mkdir(parents=True, exist_ok=True)
            for tentativa in range(5):
                try:
                    shutil.move(str(temp_pdf), str(destino))
                    return True, modo
                except PermissionError:
                    time.sleep(0.6)
            falhar(f"nao consegui gravar {destino}: o arquivo esta aberto em outro programa? Feche e rode de novo.",
                   EXIT_FALHA)
        return False, ultimo_erro
    finally:
        shutil.rmtree(perfil, ignore_errors=True)
        shutil.rmtree(pasta_temp, ignore_errors=True)


def achar_placeholders(texto: str) -> list:
    """[(linha, trecho)] de '{{', '}}' e '[PREENCHA' fora de <style>, <script> (CSS aninhado tem '}}') e de
    comentario HTML (o modelo do relatorio guarda instrucoes e variantes com '{{' em comentario)."""
    limpo = re.sub(r"(?is)(<(style|script)\b[^>]*>)(.*?)(</\2\s*>)",
                   lambda m: m.group(1) + "\n" * m.group(3).count("\n") + m.group(4), texto)
    limpo = re.sub(r"(?s)<!--.*?-->", lambda m: "\n" * m.group(0).count("\n"), limpo)
    achados = []
    for n, linha in enumerate(limpo.split("\n"), 1):
        for m in RE_PLACEHOLDER.finditer(linha):
            ini = max(0, m.start() - 30)
            achados.append((n, linha[ini:m.end() + 40].strip()))
    return achados


RE_DATA_URI = re.compile(r"(data:[\w/+.-]+;base64,[A-Za-z0-9+/=\s]+)")
RE_ATRIBUTO = re.compile(r"(\s[\w:.-]+\s*=\s*)([\"'])(.*?)\2", re.S)


def mascarar_fora_de_data(texto: str) -> tuple:
    partes = RE_DATA_URI.split(texto)
    total = 0
    for i in range(0, len(partes), 2):
        partes[i], n = _mascara.mascarar(partes[i], estrito=True)
        total += n
    return "".join(partes), total


def mascarar_html(texto: str) -> tuple:
    """Mascara segredos nos nos de texto e nos valores de atributo, sem tocar em data: URI nem quebrar tags."""
    partes = re.split(r"(<[^>]*>)", texto)
    total = 0
    for i, parte in enumerate(partes):
        if i % 2 == 0:
            partes[i], n = mascarar_fora_de_data(parte)
            total += n
            continue

        def troca(m):
            nonlocal total
            valor = m.group(3)
            if valor.lstrip().lower().startswith("data:"):
                return m.group(0)
            novo, n = _mascara.mascarar(html.unescape(valor), estrito=True)
            if not n:
                return m.group(0)
            total += n
            return m.group(1) + m.group(2) + html.escape(novo, quote=True) + m.group(2)
        partes[i] = RE_ATRIBUTO.sub(troca, parte)
    return "".join(partes), total


EPILOGO = """\
exemplos:
  gerar_pdf.py .qa/2026-09-30-clientes/relatorio/relatorio.html
  gerar_pdf.py relatorio.md -o relatorio/relatorio.pdf --paisagem
  gerar_pdf.py notas.md --so-html                     (so gera o HTML estilizado)

imagens relativas no .md/.html sao resolvidas a partir da pasta do arquivo de entrada.
o navegador roda headless com perfil temporario (nao toca no seu perfil nem na sessao logada) e nunca e
executado so para descobrir a versao.

navegador: --navegador, depois a variavel QA_CHROME, depois o PATH, depois os caminhos comuns de
Chrome, Edge, Chromium e Brave no Windows, macOS e Linux, e por fim o Chromium que o Playwright instala
(PLAYWRIGHT_BROWSERS_PATH, %LOCALAPPDATA%/ms-playwright, ~/.cache/ms-playwright ou
~/Library/Caches/ms-playwright; a versao mais alta).

segredo: o texto da entrada passa pela mascara comum (modo estrito) antes de imprimir; o que casar vira
[REMOVIDO] no PDF (o arquivo de entrada nao e alterado), o aviso sai no stderr sem o valor e a saida e 1.

placeholder: antes de imprimir, procura '{{', '}}' e '[PREENCHA' no HTML final (fora de <style>, <script> e
comentario HTML); achou, mostra os 5 primeiros com o numero da linha, nao gera o PDF e sai 1.
--permitir-placeholder imprime assim mesmo (rascunho).

tempo: o navegador roda em segundo plano e o PDF e conferido a cada 1 s; com o tamanho estavel e o %%EOF no
fim, o processo e encerrado e o PDF sai, sem esperar o navegador fechar sozinho. A primeira tentativa tem
--timeout-primeira segundos (padrao 30) e a segunda, com o outro modo e o mesmo perfil temporario, --timeout.
Medido com o Chromium do Playwright no Windows: o primeiro lancamento num perfil novo pode travar sem gerar
nada, em qualquer dos dois modos, e o segundo sai em cerca de 1 s; por isso a primeira tentativa e curta. O
modo que funcionou fica lembrado em <pasta temporaria>/qa-total-headless-modo.json, por executavel, e e o
primeiro da proxima vez (--headless=new quando nao ha nada lembrado).

codigos de saida: 0 ok | 1 PDF gerado, mas a entrada tinha segredo (mascarado), ou placeholder sem preencher
                  (PDF nao gerado) | 2 uso ou entrada invalida | 3 navegador nao encontrado | 4 falha na impressao
"""


def main(argv=None) -> int:
    configurar_saida()
    ap = ParserPT(prog="gerar_pdf.py",
                  description="Converte HTML ou Markdown em PDF A4 pelo navegador headless.",
                  epilog=EPILOGO)
    ap.add_argument("entrada", help="arquivo .html/.htm ou .md/.markdown")
    ap.add_argument("-o", "--saida", help="PDF de saida (padrao: mesmo nome com .pdf)")
    ap.add_argument("--navegador", help="executavel do Chrome/Edge/Chromium/Brave")
    ap.add_argument("--titulo", help="titulo do documento (Markdown; padrao: primeiro h1)")
    ap.add_argument("--css", help="arquivo CSS extra aplicado depois do padrao (Markdown)")
    ap.add_argument("--paisagem", action="store_true", help="A4 deitado (Markdown)")
    ap.add_argument("--conversor", choices=["auto", "markdown", "interno"], default="auto",
                    help="auto (padrao): lib markdown se existir, senao o interno")
    ap.add_argument("--so-html", action="store_true", help="para no HTML estilizado (nao abre navegador)")
    ap.add_argument("--manter-html", action="store_true", help="guarda o HTML intermediario ao lado do PDF")
    ap.add_argument("--espera-ms", type=int, default=10000,
                    help="tempo virtual para imagens/fontes carregarem (padrao 10000; 0 desliga)")
    ap.add_argument("--timeout", type=int, default=180,
                    help="limite em segundos da segunda tentativa (padrao 180)")
    ap.add_argument("--timeout-primeira", type=int, default=TIMEOUT_PRIMEIRA,
                    help=f"limite da primeira tentativa: o modo lembrado, ou --headless=new (padrao {TIMEOUT_PRIMEIRA})")
    ap.add_argument("--permitir-placeholder", action="store_true",
                    help="imprime mesmo com '{{', '}}' ou '[PREENCHA' no HTML final (rascunho)")
    args = ap.parse_args(argv)

    entrada = Path(args.entrada).expanduser()
    if not entrada.is_file():
        falhar(f"entrada nao encontrada: {entrada}")
    ext = entrada.suffix.lower()
    if ext not in (".html", ".htm", ".md", ".markdown"):
        falhar(f"extensao nao suportada: {ext} (use .html, .htm, .md ou .markdown)")
    saida = Path(args.saida).expanduser() if args.saida else entrada.with_suffix(".pdf")
    if saida.suffix.lower() != ".pdf" and not args.so_html:
        saida = saida.with_suffix(".pdf")

    html_para_imprimir = entrada
    html_temporario = None
    n_seg = 0
    if ext in (".md", ".markdown"):
        texto, n_seg = _mascara.mascarar(entrada.read_text(encoding="utf-8-sig"), estrito=True)
        corpo, usado = md_para_html(texto, args.conversor)
        css_extra = Path(args.css).read_text(encoding="utf-8-sig") if args.css else ""
        titulo = args.titulo or titulo_do_html(corpo, entrada.stem)
        documento = envolver_html(corpo, titulo, args.paisagem, css_extra)
        if args.so_html or args.manter_html:
            destino_html = (saida if args.so_html and saida.suffix.lower() in (".html", ".htm")
                            else saida.with_suffix(".html"))
            if destino_html.resolve() == entrada.resolve():
                destino_html = entrada.with_name(entrada.stem + ".gerado.html")
            if destino_html.resolve().parent != entrada.resolve().parent:
                documento = envolver_html(corpo, titulo, args.paisagem, css_extra,
                                          entrada.resolve().parent.as_uri() + "/")
            destino_html.parent.mkdir(parents=True, exist_ok=True)
            with open(destino_html, "w", encoding="utf-8", newline="\n") as f:
                f.write(documento)
            print(f"HTML ({usado}): {destino_html}")
            if args.so_html:
                if n_seg:
                    _mascara.avisar(n_seg, str(destino_html))
                    return EXIT_SEGREDO
                return EXIT_OK
            html_para_imprimir = destino_html
        else:
            html_temporario = entrada.with_name(f".~{entrada.stem}.qa-pdf.html")
            with open(html_temporario, "w", encoding="utf-8", newline="\n") as f:
                f.write(documento)
            html_para_imprimir = html_temporario
        print(f"markdown convertido com o conversor {usado}")
    elif args.so_html:
        falhar("--so-html so faz sentido com entrada Markdown")
    else:
        bruto = entrada.read_text(encoding="utf-8-sig", errors="replace")
        mascarado, n_seg = mascarar_html(bruto)
        if n_seg:
            html_temporario = entrada.with_name(f".~{entrada.stem}.qa-pdf-mascarado.html")
            with open(html_temporario, "w", encoding="utf-8", newline="\n") as f:
                f.write(mascarado)
            html_para_imprimir = html_temporario

    if not args.permitir_placeholder:
        try:
            final = html_para_imprimir.read_text(encoding="utf-8", errors="replace")
        except OSError:
            final = ""
        sobras = achar_placeholders(final)
        if sobras:
            if html_temporario is not None:
                try:
                    html_temporario.unlink()
                except OSError:
                    pass
            print(f"erro: {len(sobras)} linha(s) com marcador de template sem preencher no HTML final ('{{{{', '}}}}' "
                  f"ou '[PREENCHA'); o PDF NAO foi gerado. As primeiras:", file=sys.stderr)
            origem = entrada.name if html_temporario is None else f"HTML gerado de {entrada.name}"
            for n, trecho in sobras[:5]:
                print(f"  {origem}:{n}: {_mascara.mascarar(trecho, estrito=True)[0]}", file=sys.stderr)
            print("preencha (ou use --permitir-placeholder para imprimir um rascunho)", file=sys.stderr)
            return EXIT_SEGREDO

    try:
        navegador = localizar_navegador(args.navegador)
        ok, info = imprimir_pdf(navegador, html_para_imprimir, saida, args.espera_ms, args.timeout,
                                args.timeout_primeira)
    finally:
        if html_temporario is not None:
            try:
                html_temporario.unlink()
            except OSError:
                pass
    if not ok:
        print(f"erro: o navegador nao gerou o PDF ({navegador}).", file=sys.stderr)
        if info:
            print(f"saida do navegador:\n{info}", file=sys.stderr)
        return EXIT_FALHA
    paginas, metodo = contar_paginas(saida)
    tamanho_kb = saida.stat().st_size / 1024
    pag = f"{paginas} pagina(s){' aprox.' if metodo == 'aprox' else ''}" if paginas else "paginas: nao contadas"
    print(f"PDF gerado: {saida.resolve()} ({pag}, {tamanho_kb:.0f} KB) com {Path(navegador).name} {info}")
    if n_seg:
        _mascara.avisar(n_seg, f"{saida} (a entrada {entrada.name} continua com o valor: limpe a fonte)")
        return EXIT_SEGREDO
    return EXIT_OK


if __name__ == "__main__":
    sys.exit(main())

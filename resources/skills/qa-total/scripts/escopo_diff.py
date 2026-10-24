#!/usr/bin/env python3
"""escopo_diff.py - escopo de teste de uma branch, PR ou working tree (skill qa-total).

Lista o que mudou (arquivos, linhas e simbolos alterados) e o RAIO DE IMPACTO: quem importa
cada arquivo alterado, quem referencia os simbolos alterados, as telas (rotas) que montam
esses arquivos, os endpoints declarados ou chamados por eles e os testes automatizados que
os tocam. Gera Markdown, JSON e um ledger parcial com ids "<tipo>:<caminho>" para
`cobertura.py merge`. Com --ledger, cruza o escopo com o cobertura.json e mostra o que mudou
e ainda nao foi testado.

Heuristico de proposito: le imports e nomes por expressao regular, sem compilar o projeto.
Pega TS/JS (aliases do tsconfig/jsconfig e pacotes de workspace de monorepo), Python, C#,
Java/Kotlin e Go. Nao enxerga injecao de dependencia por configuracao, reflexao, rotas
montadas por string nem chaves de i18n: o que ele lista e o minimo a testar, nao o maximo.
Arquivo de outra linguagem (Dart, Swift, Rust, Ruby, PHP, C/C++, templates...) nao tem o raio
calculado: o script avisa, faz uma busca por nome (sem parser) como plano B e, no gate do
modo PR, sai 1 ate o raio ser completado a mao e aceito com --aceitar-raio-incompleto.

Com --tudo (sem diff) lista todas as telas e endpoints detectados no projeto, para conferir as
contagens do inventario contra o ledger.

Somente leitura. Python 3.9+, so biblioteca padrao. Windows, macOS e Linux.
"""
from __future__ import annotations

import argparse
import bisect
import fnmatch
import json
import os
import posixpath
import re
import subprocess
import sys
import unicodedata
from collections import defaultdict
from datetime import datetime
from pathlib import Path

EXIT_OK, EXIT_PENDENCIA, EXIT_USO = 0, 1, 2

LINGUAGEM = {
    ".ts": "ts", ".tsx": "ts", ".mts": "ts", ".cts": "ts",
    ".js": "js", ".jsx": "js", ".mjs": "js", ".cjs": "js", ".vue": "js", ".svelte": "js", ".astro": "js",
    ".py": "py", ".cs": "cs", ".java": "java", ".kt": "java", ".kts": "java", ".go": "go",
}
FAMILIA = {"ts": "js", "js": "js", "py": "py", "cs": "cs", "java": "java", "go": "go"}
COMPONENTE_EXT = (".tsx", ".jsx", ".vue", ".svelte", ".astro")
EXT_RESOLVER = [".ts", ".tsx", ".d.ts", ".js", ".jsx", ".mjs", ".cjs", ".vue", ".svelte", ".json"]
DIRS_PESADOS = {
    ".git", "node_modules", ".next", ".nuxt", ".svelte-kit", "dist", "build", "out", "bin", "obj",
    ".venv", "venv", "__pycache__", ".mypy_cache", ".pytest_cache", "target", "vendor", "coverage",
    ".gradle", ".idea", ".vs", ".turbo", ".cache", ".qa", ".playwright-mcp",
}
MAX_BYTES_INDICE = 1_500_000
EXT_SEM_PARSER = {
    ".dart": "Dart", ".swift": "Swift", ".rs": "Rust", ".rb": "Ruby", ".erb": "Ruby (ERB)", ".php": "PHP",
    ".c": "C", ".h": "C/C++", ".cc": "C++", ".cpp": "C++", ".cxx": "C++", ".hh": "C++", ".hpp": "C++",
    ".hxx": "C++", ".m": "Objective-C/MATLAB", ".mm": "Objective-C++", ".scala": "Scala", ".sc": "Scala",
    ".ex": "Elixir", ".exs": "Elixir", ".heex": "Elixir (HEEx)", ".erl": "Erlang", ".clj": "Clojure",
    ".cljs": "ClojureScript", ".lua": "Lua", ".pl": "Perl", ".pm": "Perl", ".r": "R", ".jl": "Julia",
    ".hs": "Haskell", ".fs": "F#", ".fsx": "F#", ".vb": "Visual Basic", ".groovy": "Groovy", ".elm": "Elm",
    ".zig": "Zig", ".nim": "Nim", ".cr": "Crystal", ".sol": "Solidity", ".ml": "OCaml", ".gd": "GDScript",
    ".razor": "Razor", ".cshtml": "Razor", ".html": "HTML/template", ".htm": "HTML/template", ".jinja": "Jinja",
    ".j2": "Jinja", ".twig": "Twig", ".hbs": "Handlebars", ".ejs": "EJS", ".pug": "Pug", ".liquid": "Liquid",
    ".haml": "Haml", ".slim": "Slim",
}
MAX_NOMES_SEM_PARSER = 60
MAX_ARQUIVOS_POR_NOME = 40

GLOBAIS = [
    "package.json", "package-lock.json", "yarn.lock", "pnpm-lock.yaml", "bun.lockb", "tsconfig*.json",
    "jsconfig.json", "next.config.*", "nuxt.config.*", "vite.config.*", "webpack.config.*", "babel.config.*",
    ".babelrc", "tailwind.config.*", "postcss.config.*", "svelte.config.*", "angular.json", "middleware.ts",
    "middleware.js", "proxy.ts", "*.csproj", "*.sln", "Directory.Build.props", "Directory.Packages.props",
    "appsettings*.json", "Program.cs", "Startup.cs", "web.config", "global.json", "requirements*.txt",
    "pyproject.toml", "setup.py", "setup.cfg", "Pipfile", "Pipfile.lock", "poetry.lock", "settings.py",
    "go.mod", "go.sum", "pom.xml", "build.gradle", "build.gradle.kts", "settings.gradle*",
    "application*.properties", "application*.yml", "Dockerfile*", "docker-compose*.yml", "compose*.yml",
    ".env*", "*.config.json", ".github/workflows/*", "azure-pipelines*.yml", ".gitlab-ci.yml", "Jenkinsfile",
]
RE_MIGRACAO = re.compile(r"(^|/)(migrations?|Migrations|migrate|db/migrate|alembic/versions|flyway)(/|$)|\.sql$", re.I)
RE_TEXTOS = re.compile(r"(^|/)(i18n|locales?|lang|languages|translations|messages)(/|$)|\.(po|resx|xlf)$", re.I)
RE_TESTE = re.compile(
    r"(^|/)(__tests__|tests?|spec|specs|e2e|cypress|playwright)(/)|\.(test|spec|e2e|cy)\.[a-z]+$|_test\.(go|py)$"
    r"|(^|/)test_[^/]+\.py$|Tests?\.(cs|java|kt)$|(^|/)[^/]*\.Tests?(/)", re.I)
RE_ESTILO = re.compile(r"\.(css|scss|sass|less|styl)$", re.I)

PALAVRAS_GENERICAS = {
    "get", "set", "post", "put", "delete", "update", "create", "remove", "save", "load", "init", "main", "index",
    "default", "props", "state", "data", "value", "item", "items", "list", "handle", "render", "run", "test",
    "setup", "config", "options", "params", "args", "result", "error", "name", "type", "key", "map", "filter",
    "find", "then", "app", "page", "layout", "home", "service", "controller", "program", "startup", "dispose",
    "tostring", "equals", "gethashcode", "constructor", "init", "new", "call", "apply", "next", "start", "stop",
    "open", "close", "reset", "clear", "show", "hide", "toggle", "change", "submit", "click", "fetch", "request",
    "response", "model", "view", "entity", "dto", "base", "utils", "helper", "helpers", "styles", "theme",
}
PALAVRAS_LINGUAGEM = {
    "self", "this", "super", "null", "none", "true", "false", "return", "const", "final", "static", "public",
    "private", "protected", "internal", "class", "struct", "void", "string", "async", "await", "import", "export",
    "package", "function", "func", "where", "match", "impl", "trait", "elif", "else", "while", "break", "continue",
    "yield", "lambda", "begin", "rescue", "ensure", "unless", "until", "require", "include", "extends",
    "implements", "override", "required", "late", "dynamic", "unsafe", "crate", "namespace", "using", "echo",
    "array", "then", "when", "case", "switch", "throw", "throws", "catch", "finally", "typeof", "instanceof",
    "bool", "double", "float", "char", "long", "short", "unsigned", "signed", "auto", "template", "typename",
    "union", "enum", "extern", "inline", "virtual", "friend", "operator", "sizeof", "volatile", "register",
    "goto", "define", "ifdef", "ifndef", "endif", "pragma", "println", "print", "printf", "some", "option",
    "self", "nil", "with", "from", "into", "each", "end", "elsif", "module", "protocol", "extension", "mixin",
    "widget", "context", "html", "head", "body", "span", "class", "style", "href", "type", "input", "button",
}
RE_IDENT = re.compile(r"[A-Za-z_][A-Za-z0-9_]*")
RE_DEF_GENERICA = re.compile(
    r"\b(?:class|struct|enum|trait|protocol|interface|extension|mixin|module|object|record|typedef|type|fn|func|"
    r"function|def|sub|impl|defmodule|defp?)\s+([A-Za-z_][A-Za-z0-9_]*)")
JUSTIFICATIVAS_GENERICAS = ("sem tempo", "nao deu tempo", "falta de tempo", "limite de tentativa",
                            "nao devolveu resultado", "sem resultado do agente", "orcamento esgotado")


def configurar_saida() -> None:
    for fluxo in (sys.stdout, sys.stderr):
        try:
            if fluxo.isatty() or os.environ.get("PYTHONIOENCODING"):
                fluxo.reconfigure(errors="replace")
            else:
                fluxo.reconfigure(encoding="utf-8", errors="replace")
        except (AttributeError, ValueError):
            pass


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


class ErroUso(Exception):
    pass


def git(raiz: Path, *args, binario=False, permitir_falha=False):
    try:
        r = subprocess.run(["git", "-C", str(raiz), "-c", "core.quotePath=false", *args],
                           capture_output=True, check=False)
    except FileNotFoundError:
        raise ErroUso("git nao encontrado no PATH")
    if r.returncode != 0:
        if permitir_falha:
            return None
        msg = r.stderr.decode("utf-8", "replace").strip()
        raise ErroUso(f"git {' '.join(args[:3])} falhou: {msg}")
    return r.stdout if binario else r.stdout.decode("utf-8", "replace")


def familia_de(caminho: str):
    ext = posixpath.splitext(caminho)[1].lower()
    if caminho.endswith(".d.ts"):
        return "js"
    lang = LINGUAGEM.get(ext)
    return FAMILIA.get(lang) if lang else None


def casa_glob(caminho: str, padroes) -> bool:
    nome = caminho.rsplit("/", 1)[-1]
    return any(fnmatch.fnmatch(caminho, p) or fnmatch.fnmatch(nome, p) for p in padroes)


def em_dir_pesado(caminho: str) -> bool:
    return any(seg in DIRS_PESADOS for seg in caminho.split("/")[:-1])


def linguagem_sem_parser(caminho: str):
    return EXT_SEM_PARSER.get(posixpath.splitext(caminho)[1].lower())


def sem_acento(texto: str) -> str:
    return "".join(c for c in unicodedata.normalize("NFD", texto) if unicodedata.category(c) != "Mn")


def justificativa_concreta(texto) -> bool:
    t = re.sub(r"\s+", " ", sem_acento(str(texto or "")).lower()).strip()
    if len(t) <= 20:
        return False
    return not any(g in t for g in JUSTIFICATIVAS_GENERICAS)


def marcas_do_arquivo(caminho: str):
    marcas = []
    if casa_glob(caminho, GLOBAIS):
        marcas.append("impacto-global")
    if RE_MIGRACAO.search(caminho):
        marcas.append("migracao")
    if RE_TEXTOS.search(caminho):
        marcas.append("textos")
    if RE_TESTE.search(caminho):
        marcas.append("teste")
    if RE_ESTILO.search(caminho):
        marcas.append("estilo")
    return marcas


def desescapar(caminho: str) -> str:
    if len(caminho) >= 2 and caminho[0] == '"' and caminho[-1] == '"':
        caminho = caminho[1:-1].replace('\\"', '"').replace("\\t", "\t").replace("\\\\", "\\")
    return caminho


RE_LINHA_GIT_STATUS = re.compile(r"^(?=.?[MADRCUT?!])([ MADRCUT?!]{2}) (\S.*)$")


def desaspar_status(c: str) -> str:
    """Caminho do git status entre aspas (core.quotePath): tira as aspas e desfaz \\ooo, \\t, \\n, \\" e \\\\."""
    c = c.strip()
    if len(c) < 2 or c[0] != '"' or c[-1] != '"':
        return c
    corpo, bruto, i = c[1:-1], bytearray(), 0
    simples = {"t": 9, "n": 10, "r": 13, '"': 34, "\\": 92, "a": 7, "b": 8, "f": 12, "v": 11}
    while i < len(corpo):
        ch = corpo[i]
        if ch == "\\" and i + 1 < len(corpo):
            seq = corpo[i + 1:i + 4]
            if re.fullmatch(r"[0-7]{3}", seq):
                bruto.append(int(seq, 8))
                i += 4
                continue
            if corpo[i + 1] in simples:
                bruto.append(simples[corpo[i + 1]])
                i += 2
                continue
        bruto.extend(ch.encode("utf-8"))
        i += 1
    return bruto.decode("utf-8", "replace")


def caminhos_status_inicial(pasta_rodada: Path) -> list:
    """Caminhos das linhas 'XY caminho' (git status --short/--porcelain) de <rodada>/notas/00-git-status-inicial.txt;
    num rename ('R  velho -> novo'), os dois. Ignora .qa/, a linha da branch e o git log."""
    try:
        texto = (pasta_rodada / "notas" / "00-git-status-inicial.txt").read_text(encoding="utf-8-sig", errors="replace")
    except OSError:
        return []
    saida = []
    for linha in texto.splitlines():
        m = RE_LINHA_GIT_STATUS.match(linha.rstrip("\r"))
        if not m:
            continue
        resto = m.group(2).strip()
        partes = resto.split(" -> ") if ("R" in m.group(1) or "C" in m.group(1)) and " -> " in resto else [resto]
        for parte in partes:
            c = desaspar_status(parte).replace("\\", "/").strip()
            while c.startswith("./"):
                c = c[2:]
            if not c or c == ".qa" or c.startswith(".qa/") or "/.qa/" in c:
                continue
            if c not in saida:
                saida.append(c)
    return saida


def preparar_excluir_arquivos(lista, raiz_in: Path, raiz: Path) -> tuple:
    """(exatos, pastas) relativos a raiz do repositorio para --excluir-arquivo: caminho exato (sem glob: '[id]' e
    literal) ou pasta terminada em '/'. Cada caminho vale como veio e tambem somado ao prefixo da --raiz (o git status
    da nota pode ter sido tirado dentro de uma subpasta do repositorio)."""
    try:
        prefixo = Path(os.path.relpath(str(raiz_in.resolve()), str(raiz.resolve()))).as_posix()
    except ValueError:
        prefixo = "."
    exatos, pastas = set(), []
    for bruto in lista or []:
        c = str(bruto or "").replace("\\", "/").strip()
        while c.startswith("./"):
            c = c[2:]
        if not c:
            continue
        pasta = c.endswith("/")
        candidatos = {c.rstrip("/")}
        if prefixo not in (".", ""):
            candidatos.add(posixpath.normpath(posixpath.join(prefixo, c.rstrip("/"))))
        for x in candidatos:
            if x.startswith("../") or x in ("", "."):
                continue
            if pasta:
                pastas.append(x + "/")
            else:
                exatos.add(x)
    return exatos, pastas


def excluido_por_arquivo(rel: str, exatos, pastas) -> bool:
    return rel in exatos or any(rel.startswith(p) for p in pastas)


# ----------------------------------------------------------------------------------------- diff

RE_HUNK = re.compile(r"^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@")


def ler_diff(texto: str):
    arquivos = {}
    atual = None
    de = para = None
    for linha in texto.splitlines():
        if linha.startswith("diff --git "):
            atual = {"hunks": [], "binario": False, "adicionadas": 0, "removidas": 0}
            de = para = None
            continue
        if atual is None:
            continue
        if linha.startswith("--- "):
            alvo = desescapar(linha[4:])
            de = None if alvo == "/dev/null" else (alvo[2:] if alvo.startswith("a/") else alvo)
            continue
        if linha.startswith("+++ "):
            alvo = desescapar(linha[4:])
            para = None if alvo == "/dev/null" else (alvo[2:] if alvo.startswith("b/") else alvo)
            arquivos[para or de] = atual
            continue
        if linha.startswith("rename to ") or linha.startswith("copy to "):
            chave = desescapar(linha.split(" to ", 1)[1])
            arquivos[chave] = atual
            continue
        if linha.startswith("Binary files ") or linha.startswith("GIT binary patch"):
            atual["binario"] = True
            m = re.match(r"Binary files (?:a/)?(.*?) and (?:b/)?(.*?) differ", linha)
            if m:
                chave = m.group(2) if m.group(2) != "/dev/null" else m.group(1)
                arquivos[desescapar(chave)] = atual
            continue
        m = RE_HUNK.match(linha)
        if m:
            atual["hunks"].append({
                "de_ini": int(m.group(1)), "de_qtd": int(m.group(2) if m.group(2) is not None else 1),
                "para_ini": int(m.group(3)), "para_qtd": int(m.group(4) if m.group(4) is not None else 1),
                "removidas": [], "adicionadas": []})
            continue
        if atual["hunks"]:
            if linha.startswith("+"):
                atual["hunks"][-1]["adicionadas"].append(linha[1:])
                atual["adicionadas"] += 1
            elif linha.startswith("-"):
                atual["hunks"][-1]["removidas"].append(linha[1:])
                atual["removidas"] += 1
    return arquivos


def ler_name_status(saida: bytes):
    tokens = [t for t in saida.decode("utf-8", "replace").split("\0")]
    itens, i = [], 0
    while i < len(tokens):
        st = tokens[i]
        if not st:
            i += 1
            continue
        letra = st[0]
        try:
            if letra in "RC":
                de, para = tokens[i + 1], tokens[i + 2]
                itens.append({"status": letra, "arquivo": para, "de": de})
                i += 3
            else:
                itens.append({"status": letra, "arquivo": tokens[i + 1], "de": None})
                i += 2
        except IndexError:
            break
    return itens


# ------------------------------------------------------------------------------- definicoes

RE_JS_DEFS = [
    (re.compile(r"^([ \t]*)(export\s+)?(?:default\s+)?(?:declare\s+)?(?:async\s+)?function\s*\*?\s*([A-Za-z_$][\w$]*)",
                re.M), "funcao"),
    (re.compile(r"^([ \t]*)(export\s+)?(?:default\s+)?(?:declare\s+)?(?:abstract\s+)?class\s+([A-Za-z_$][\w$]*)", re.M),
     "tipo"),
    (re.compile(r"^([ \t]*)(export\s+)?(?:declare\s+)?(?:const\s+)?(?:interface|type|enum)\s+([A-Za-z_$][\w$]*)", re.M),
     "tipo"),
    (re.compile(r"^([ \t]*)(export\s+)?(?:declare\s+)?(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*[:=]", re.M), "const"),
]
RE_JS_METODO = re.compile(
    r"^([ \t]+)(?:(?:public|private|protected|static|async|readonly|override|get|set)\s+)*([A-Za-z_$][\w$]*)\s*"
    r"(?:<[^>()]*>)?\([^()]*\)\s*(?::\s*[^={;]+)?\{", re.M)
PALAVRAS_JS = {"if", "for", "while", "switch", "catch", "function", "return", "with", "else", "do", "try", "constructor"}
RE_PY_DEF = re.compile(r"^([ \t]*)(?:async\s+)?(def|class)\s+([A-Za-z_]\w*)", re.M)
RE_PY_CONST = re.compile(r"^()([A-Z_][A-Z0-9_]{2,})\s*(?::[^=\n]+)?=", re.M)
RE_CS_TIPO = re.compile(
    r"^([ \t]*)(?:\[[^\]\n]*\]\s*)*((?:(?:public|internal|protected|private|static|sealed|abstract|partial|readonly|"
    r"ref|file|unsafe|new)\s+)*)(?:class|interface|enum|record(?:\s+struct|\s+class)?|struct)\s+([A-Za-z_]\w*)", re.M)
RE_CS_METODO = re.compile(
    r"^([ \t]*)((?:(?:public|internal|protected|private|static|virtual|override|async|abstract|sealed|new|extern|"
    r"partial|unsafe)\s+)+)(?:[^\s(=;{}]+(?:,\s*[^\s(=;{}]+)*\s+)?([A-Za-z_]\w*)\s*(?:<[^<>()\n]*>)?\s*\(", re.M)
RE_JAVA_TIPO = re.compile(
    r"^([ \t]*)(?:@\w+(?:\([^)\n]*\))?\s*)*((?:(?:public|protected|private|static|final|abstract|sealed|open|data|"
    r"internal|inner|value|annotation|enum)\s+)*)(?:class|interface|enum|record|object)\s+([A-Za-z_]\w*)", re.M)
RE_JAVA_METODO = re.compile(
    r"^([ \t]*)((?:(?:public|protected|private|static|final|abstract|synchronized|default|override|suspend|open|"
    r"internal|inline)\s+)*)(?:fun\s+(?:<[^>\n]+>\s+)?(?:[\w.]+\.)?|(?:<[^>\n]+>\s+)?[^\s(=;{}@]+\s+)([A-Za-z_]\w*)\s*\(",
    re.M)
PALAVRAS_JAVA = {"if", "for", "while", "switch", "catch", "return", "new", "else", "throw", "synchronized"}
RE_GO_FUNC = re.compile(r"^()func\s+(?:\(\s*\w*\s*\*?\s*([A-Za-z_]\w*)[^)]*\)\s*)?([A-Za-z_]\w*)\s*[\[(]", re.M)
RE_GO_TIPO = re.compile(r"^()type\s+([A-Za-z_]\w*)", re.M)
RE_GO_VAR = re.compile(r"^()(?:var|const)\s+([A-Za-z_]\w*)", re.M)


def _linha_de(texto: str, pos: int) -> int:
    return texto.count("\n", 0, pos) + 1


def exportados_js(texto: str):
    nomes = set()
    for m in re.finditer(r"export\s*\{([^}]*)\}", texto):
        for parte in m.group(1).split(","):
            parte = parte.strip()
            if not parte:
                continue
            pedacos = re.split(r"\s+as\s+", parte)
            nomes.add(pedacos[0].replace("type ", "").strip())
            nomes.add(pedacos[-1].strip())
    for m in re.finditer(r"export\s+default\s+([A-Za-z_$][\w$]*)\s*;?\s*$", texto, re.M):
        nomes.add(m.group(1))
    for m in re.finditer(r"(?:module\.)?exports\.([A-Za-z_$][\w$]*)\s*=", texto):
        nomes.add(m.group(1))
    m = re.search(r"module\.exports\s*=\s*\{([^}]*)\}", texto)
    if m:
        for parte in m.group(1).split(","):
            nome = parte.split(":")[0].strip()
            if re.fullmatch(r"[A-Za-z_$][\w$]*", nome):
                nomes.add(nome)
    return nomes


def definicoes(texto: str, familia: str, caminho: str):
    defs = []
    if familia == "js":
        exp = exportados_js(texto)
        for rx, tipo in RE_JS_DEFS:
            for m in rx.finditer(texto):
                nome = m.group(3)
                defs.append({"nome": nome, "tipo": tipo, "pos": m.start(), "linha": _linha_de(texto, m.start()),
                             "indent": len(m.group(1).expandtabs(4)), "dono": None,
                             "exportado": bool(m.group(2)) or nome in exp})
        for m in RE_JS_METODO.finditer(texto):
            nome = m.group(2)
            if nome in PALAVRAS_JS:
                continue
            defs.append({"nome": nome, "tipo": "metodo", "pos": m.start(), "linha": _linha_de(texto, m.start()),
                         "indent": len(m.group(1).expandtabs(4)), "dono": None, "exportado": False})
    elif familia == "py":
        for m in RE_PY_DEF.finditer(texto):
            defs.append({"nome": m.group(3), "tipo": "tipo" if m.group(2) == "class" else "funcao",
                         "pos": m.start(), "linha": _linha_de(texto, m.start()), "indent": len(m.group(1).expandtabs(4)), "dono": None,
                         "exportado": not m.group(3).startswith("_")})
        for m in RE_PY_CONST.finditer(texto):
            defs.append({"nome": m.group(2), "tipo": "const", "pos": m.start(), "linha": _linha_de(texto, m.start()), "indent": 0,
                         "dono": None, "exportado": True})
    elif familia == "cs":
        for m in RE_CS_TIPO.finditer(texto):
            mods = m.group(2) or ""
            defs.append({"nome": m.group(3), "tipo": "tipo", "pos": m.start(), "linha": _linha_de(texto, m.start()),
                         "indent": len(m.group(1).expandtabs(4)), "dono": None, "exportado": "private" not in mods})
        for m in RE_CS_METODO.finditer(texto):
            mods = m.group(2) or ""
            nome = m.group(3)
            if nome in PALAVRAS_JAVA or nome in ("class", "interface", "enum", "record", "struct"):
                continue
            defs.append({"nome": nome, "tipo": "metodo", "pos": m.start(), "linha": _linha_de(texto, m.start()),
                         "indent": len(m.group(1).expandtabs(4)), "dono": None,
                         "exportado": bool(re.search(r"\b(public|internal|protected)\b", mods))})
    elif familia == "java":
        for m in RE_JAVA_TIPO.finditer(texto):
            mods = m.group(2) or ""
            defs.append({"nome": m.group(3), "tipo": "tipo", "pos": m.start(), "linha": _linha_de(texto, m.start()),
                         "indent": len(m.group(1).expandtabs(4)), "dono": None, "exportado": "private" not in mods})
        for m in RE_JAVA_METODO.finditer(texto):
            mods = m.group(2) or ""
            nome = m.group(3)
            if nome in PALAVRAS_JAVA:
                continue
            defs.append({"nome": nome, "tipo": "metodo", "pos": m.start(), "linha": _linha_de(texto, m.start()),
                         "indent": len(m.group(1).expandtabs(4)), "dono": None, "exportado": "private" not in mods})
    elif familia == "go":
        for m in RE_GO_FUNC.finditer(texto):
            defs.append({"nome": m.group(3), "tipo": "metodo" if m.group(2) else "funcao",
                         "pos": m.start(), "linha": _linha_de(texto, m.start()), "indent": 0, "dono": m.group(2),
                         "exportado": m.group(3)[:1].isupper()})
        for rx, tipo in ((RE_GO_TIPO, "tipo"), (RE_GO_VAR, "const")):
            for m in rx.finditer(texto):
                defs.append({"nome": m.group(2), "tipo": tipo, "pos": m.start(), "linha": _linha_de(texto, m.start()), "indent": 0,
                             "dono": None, "exportado": m.group(2)[:1].isupper()})
    defs.sort(key=lambda d: (d["linha"], d["indent"]))
    vistos, unicos = set(), []
    for d in defs:
        chave = (d["nome"], d["linha"])
        if chave in vistos:
            continue
        vistos.add(chave)
        unicos.append(d)
    calcular_fins(texto, unicos, familia)
    for d in unicos:
        if d["dono"]:
            continue
        externos = [t for t in unicos if t is not d and t["tipo"] == "tipo" and t["linha"] <= d["linha"] <= t["fim"]
                    and (t["linha"], t["indent"]) < (d["linha"], d["indent"])]
        if externos and d["tipo"] in ("metodo", "funcao", "const"):
            d["dono"] = externos[-1]["nome"]
            if familia in ("py", "js") and d["tipo"] == "funcao":
                d["tipo"] = "metodo"
            if familia == "js" and d["tipo"] == "metodo":
                d["exportado"] = externos[-1]["exportado"]
    if familia == "js" and caminho.endswith((".vue", ".svelte", ".astro")):
        nome = posixpath.splitext(caminho.rsplit("/", 1)[-1])[0]
        if re.fullmatch(r"[A-Za-z_$][\w$]*", nome):
            unicos.insert(0, {"nome": nome, "tipo": "tipo", "pos": 0, "linha": 1, "indent": -1, "dono": None,
                              "exportado": True, "fim": texto.count("\n") + 1})
    return unicos


def eventos_de_chave(texto: str):
    eventos, i, n = [], 0, len(texto)
    while i < n:
        c = texto[i]
        if c in "\"'`":
            fim = i + 1
            while fim < n and texto[fim] != c:
                if texto[fim] == "\\":
                    fim += 1
                elif texto[fim] == "\n" and c != "`":
                    break
                fim += 1
            i = fim + 1
            continue
        if texto.startswith("//", i):
            fim = texto.find("\n", i)
            i = n if fim < 0 else fim
            continue
        if texto.startswith("/*", i):
            fim = texto.find("*/", i + 2)
            i = n if fim < 0 else fim + 2
            continue
        if c in "{};()[]":
            eventos.append((i, c))
        i += 1
    return eventos


CONTINUA_EXPRESSAO = ("=>", ".", "?.", "(", ":", "as ", "satisfies ", "<", "&&", "||", "?", "+")


def calcular_fins(texto: str, defs, familia: str) -> None:
    total = texto.count("\n") + 1
    if familia == "py":
        linhas = texto.splitlines()
        for d in defs:
            d["fim"] = total
            for j in range(d["linha"], len(linhas)):
                conteudo = linhas[j]
                recuo = len(conteudo) - len(conteudo.lstrip())
                if conteudo.strip() and not conteudo.lstrip().startswith(("#", ")", "]", "}")) \
                        and recuo <= max(d["indent"], 0):
                    d["fim"] = j
                    break
        return
    eventos = eventos_de_chave(texto)
    posicoes = [p for p, _ in eventos]
    inicios = sorted(d.get("pos", 0) for d in defs)
    for d in defs:
        pos = d.get("pos", 0)
        j = bisect.bisect_right(inicios, pos)
        proximo = inicios[j] if j < len(inicios) else len(texto) + 1
        k = bisect.bisect_left(posicoes, pos)
        fim_pos = None
        if d["tipo"] == "const":
            prof, abriu = 0, False
            while k < len(eventos):
                p, c = eventos[k]
                if not abriu and p >= proximo:
                    break
                if c in "([{":
                    prof, abriu = prof + 1, True
                elif c in ")]}":
                    prof -= 1
                    if prof < 0:
                        fim_pos = p
                        break
                    if prof == 0 and not texto[p + 1:p + 80].lstrip().startswith(CONTINUA_EXPRESSAO):
                        fim_pos = p
                        break
                elif c == ";" and prof == 0:
                    fim_pos = p
                    break
                k += 1
        else:
            par, prof, comecou = 0, 0, False
            while k < len(eventos):
                p, c = eventos[k]
                if not comecou and p >= proximo:
                    break
                if not comecou:
                    if c in "([":
                        par += 1
                    elif c in ")]":
                        par -= 1
                    elif c == "{" and par <= 0:
                        prof, comecou = 1, True
                    elif c == "}" and par <= 0:
                        break
                    elif c == ";" and par <= 0:
                        fim_pos = p
                        break
                else:
                    if c == "{":
                        prof += 1
                    elif c == "}":
                        prof -= 1
                        if prof == 0:
                            fim_pos = p
                            break
                k += 1
        d["fim"] = _linha_de(texto, fim_pos) if fim_pos is not None else d["linha"]


def envolvente(defs, linha: int):
    return sorted((d for d in defs if d["linha"] <= linha <= d.get("fim", d["linha"])),
                  key=lambda d: (d["linha"], d["indent"]))


def escolher_busca(cadeia):
    for d in reversed(cadeia):
        if buscavel(d):
            return d
    return None


def buscavel(s) -> bool:
    if s.get("familia") == "go" and s["tipo"] == "metodo":
        return False
    if s["tipo"] == "metodo" and (not s.get("dono") or s["nome"].startswith("_")):
        return False
    if not s["exportado"]:
        return False
    return len(s["nome"]) >= 4 and s["nome"].lower() not in PALAVRAS_GENERICAS


def eh_componente(d, caminho: str) -> bool:
    return (caminho.endswith(COMPONENTE_EXT) and d["tipo"] in ("funcao", "const", "tipo")
            and d["nome"][:1].isupper() and d["exportado"])


# ------------------------------------------------------------------------- indice do projeto

def ler_jsonc(texto: str):
    saida, i, n, em_str = [], 0, len(texto), False
    while i < n:
        c = texto[i]
        if em_str:
            saida.append(c)
            if c == "\\" and i + 1 < n:
                saida.append(texto[i + 1])
                i += 2
                continue
            if c == '"':
                em_str = False
            i += 1
            continue
        if c == '"':
            em_str = True
            saida.append(c)
            i += 1
            continue
        if texto.startswith("//", i):
            fim = texto.find("\n", i)
            i = n if fim < 0 else fim
            continue
        if texto.startswith("/*", i):
            fim = texto.find("*/", i + 2)
            i = n if fim < 0 else fim + 2
            continue
        saida.append(c)
        i += 1
    limpo = re.sub(r",(\s*[}\]])", r"\1", "".join(saida))
    return json.loads(limpo)


RE_LITERAL = re.compile(r'"(?:[^"\\\n]|\\.)*"|\'(?:[^\'\\\n]|\\.)*\'')
RE_SERVIDOR_JS = re.compile(r"\bexpress\b|\bRouter\(|\bfastify\b|\bnew Hono\b|\bkoa\b|@nestjs/|\bhapi\b")


class Indice:
    def __init__(self, raiz: Path, arquivos, extras_resolucao, excluir):
        self.raiz = raiz
        self.arquivos = [a for a in arquivos if not casa_glob(a, excluir)]
        self.conjunto = set(self.arquivos) | set(extras_resolucao)
        self.codigo = [a for a in self.arquivos if familia_de(a) and not em_dir_pesado(a)
                       and not a.endswith((".min.js", ".map"))]
        self._texto = {}
        self._sem_strings = {}
        self.importadores = defaultdict(set)
        self.avisos = []
        self._configs_js = {}
        self._workspaces = None
        self._mapa_py = None
        self._go_mods = None
        self._por_dir = defaultdict(list)
        for a in self.conjunto:
            self._por_dir[posixpath.dirname(a)].append(a)

    def texto(self, rel: str) -> str:
        if rel not in self._texto:
            p = self.raiz / rel
            try:
                if p.stat().st_size > MAX_BYTES_INDICE:
                    self._texto[rel] = ""
                else:
                    dados = p.read_bytes()
                    if dados.startswith(b"\xff\xfe") or dados.startswith(b"\xfe\xff"):
                        self._texto[rel] = dados.decode("utf-16", "replace")
                    else:
                        self._texto[rel] = dados.decode("utf-8", "replace")
            except OSError:
                self._texto[rel] = ""
        return self._texto[rel]

    def sem_strings(self, rel: str) -> str:
        if rel not in self._sem_strings:
            self._sem_strings[rel] = RE_LITERAL.sub('""', self.texto(rel))
        return self._sem_strings[rel]

    def config_js(self, importador: str):
        d = posixpath.dirname(importador)
        while True:
            if d in self._configs_js:
                return self._configs_js[d]
            for nome in ("tsconfig.json", "jsconfig.json"):
                cand = posixpath.join(d, nome) if d else nome
                if cand in self.conjunto:
                    cfg = self._carregar_tsconfig(cand, 0)
                    self._configs_js[d] = cfg
                    return cfg
            if not d:
                self._configs_js[d] = None
                return None
            d = posixpath.dirname(d)

    def _carregar_tsconfig(self, rel: str, profundidade: int):
        try:
            dados = ler_jsonc(self.texto(rel) or "{}")
        except (ValueError, json.JSONDecodeError):
            self.avisos.append(f"nao consegui ler {rel} (aliases de import ignorados)")
            return None
        base_dir = posixpath.dirname(rel)
        opcoes = {}
        ext = dados.get("extends")
        if isinstance(ext, str) and ext.startswith(".") and profundidade < 5:
            alvo = posixpath.normpath(posixpath.join(base_dir, ext))
            if not alvo.endswith(".json"):
                alvo += ".json"
            pai = self._carregar_tsconfig(alvo, profundidade + 1) if alvo in self.conjunto else None
            if pai:
                opcoes.update(pai)
        co = dados.get("compilerOptions") or {}
        if "baseUrl" in co:
            opcoes["baseUrl"] = posixpath.normpath(posixpath.join(base_dir, co["baseUrl"]))
        if "paths" in co and isinstance(co["paths"], dict):
            raiz_paths = opcoes.get("baseUrl") or base_dir
            opcoes["paths"] = [(k, [posixpath.normpath(posixpath.join(raiz_paths, v)) for v in vs if isinstance(v, str)])
                               for k, vs in co["paths"].items() if isinstance(vs, list)]
        return opcoes

    def _candidato(self, base: str):
        base = base.split("?", 1)[0]
        if base.startswith(".."):
            return None
        if base in self.conjunto and not base.endswith("/"):
            return base
        for ext in EXT_RESOLVER:
            if base + ext in self.conjunto:
                return base + ext
        for ext in EXT_RESOLVER:
            idx = posixpath.join(base, "index" + ext)
            if idx in self.conjunto:
                return idx
        for de, para in ((".js", ".ts"), (".js", ".tsx"), (".jsx", ".tsx"), (".mjs", ".mts")):
            if base.endswith(de) and base[: -len(de)] + para in self.conjunto:
                return base[: -len(de)] + para
        return None

    def resolver_js(self, spec: str, importador: str):
        bases = []
        if spec.startswith("."):
            bases.append(posixpath.normpath(posixpath.join(posixpath.dirname(importador), spec)))
        elif spec.startswith("/"):
            bases.append(spec.lstrip("/"))
        else:
            cfg = self.config_js(importador) or {}
            for padrao, alvos in cfg.get("paths", []):
                if padrao.endswith("*"):
                    pre = padrao[:-1]
                    if spec.startswith(pre):
                        resto = spec[len(pre):]
                        bases += [a.replace("*", resto) for a in alvos]
                elif spec == padrao:
                    bases += alvos
            if cfg.get("baseUrl") is not None:
                bases.append(posixpath.normpath(posixpath.join(cfg["baseUrl"], spec)))
        for b in bases:
            b = b[2:] if b.startswith("./") else b
            achado = self._candidato("" if b == "." else b)
            if achado:
                return achado
        if not spec.startswith((".", "/")):
            return self.resolver_workspace(spec)
        return None

    def _globs_workspace(self):
        globs = []
        for nome in ("package.json", "lerna.json"):
            if nome not in self.conjunto:
                continue
            try:
                dados = json.loads(self.texto(nome) or "{}")
            except ValueError:
                self.avisos.append(f"nao consegui ler {nome} (workspaces do monorepo ignorados)")
                continue
            ws = dados.get("workspaces") if nome == "package.json" else dados.get("packages")
            if isinstance(ws, dict):
                ws = ws.get("packages")
            if isinstance(ws, list):
                globs += [w for w in ws if isinstance(w, str)]
        for nome in ("pnpm-workspace.yaml", "pnpm-workspace.yml"):
            if nome not in self.conjunto:
                continue
            dentro = False
            for linha in self.texto(nome).splitlines():
                if re.match(r"^packages\s*:", linha):
                    dentro = True
                    continue
                if dentro and linha.strip() and not linha[:1].isspace() and not linha.startswith("-"):
                    dentro = False
                m = re.match(r"^\s*-\s*['\"]?([^'\"#]+?)['\"]?\s*(?:#.*)?$", linha) if dentro else None
                if m:
                    globs.append(m.group(1).strip())
        return globs

    def workspaces(self):
        if self._workspaces is None:
            mapa = {}
            globs = [g.strip().rstrip("/") for g in self._globs_workspace() if g.strip()]
            incluir = [g for g in globs if not g.startswith("!")]
            excluir = [g[1:] for g in globs if g.startswith("!")]

            def casa(d, g):
                g = g[2:] if g.startswith("./") else g
                return fnmatch.fnmatch(d, g) or (g.endswith("/**") and (d == g[:-3] or d.startswith(g[:-2])))

            if incluir:
                for a in sorted(self.conjunto):
                    if posixpath.basename(a) != "package.json" or a == "package.json" or em_dir_pesado(a):
                        continue
                    d = posixpath.dirname(a)
                    if not any(casa(d, g) for g in incluir) or any(casa(d, g) for g in excluir):
                        continue
                    try:
                        pkg = json.loads(self.texto(a) or "{}")
                    except ValueError:
                        continue
                    if isinstance(pkg, dict) and isinstance(pkg.get("name"), str) and pkg["name"].strip():
                        mapa.setdefault(pkg["name"].strip(), (d, pkg))
            self._workspaces = mapa
        return self._workspaces

    def resolver_workspace(self, spec: str):
        ws = self.workspaces()
        for nome in sorted(ws, key=len, reverse=True):
            if spec == nome or spec.startswith(nome + "/"):
                d, pkg = ws[nome]
                return self._entrada_pacote(d, pkg, spec[len(nome):].lstrip("/"))
        return None

    def _entrada_pacote(self, d: str, pkg: dict, resto: str):
        def alvos(v):
            if isinstance(v, str):
                return [v]
            if isinstance(v, list):
                return [x for item in v for x in alvos(item)]
            if isinstance(v, dict):
                ordem = ("source", "development", "types", "import", "module", "require", "node", "browser", "default")
                saida = [x for cond in ordem if cond in v for x in alvos(v[cond])]
                return saida + [x for k, item in v.items() if k not in ordem for x in alvos(item)]
            return []

        chave = "./" + resto if resto else "."
        cands = []
        exp = pkg.get("exports")
        if isinstance(exp, (str, list)) and not resto:
            cands += alvos(exp)
        elif isinstance(exp, dict):
            if any(str(k).startswith(".") for k in exp):
                if chave in exp:
                    cands += alvos(exp[chave])
                else:
                    for k, v in exp.items():
                        if str(k).endswith("*") and chave.startswith(str(k)[:-1]):
                            cands += [x.replace("*", chave[len(str(k)) - 1:]) for x in alvos(v)]
            elif not resto:
                cands += alvos(exp)
        if resto:
            cands += [resto, "src/" + resto, "lib/" + resto]
        else:
            cands += [pkg[c] for c in ("source", "module", "main", "types", "typings") if isinstance(pkg.get(c), str)]
            cands += ["src/index", "index", "lib/index"]
        for c in cands:
            c = c[2:] if c.startswith("./") else c
            achado = self._candidato(posixpath.normpath(posixpath.join(d, c)) if d else posixpath.normpath(c))
            if achado:
                return achado
            m = re.match(r"^(?:dist|build|lib|out|esm|cjs)/(.+)$", c)
            if m:
                sem_ext = re.sub(r"(\.d)?\.(m?js|cjs|ts|mts|cts|jsx|tsx)$", "", m.group(1))
                achado = self._candidato(posixpath.join(d, "src", sem_ext) if d else posixpath.join("src", sem_ext))
                if achado:
                    return achado
        return None

    def mapa_py(self):
        if self._mapa_py is None:
            mapa = defaultdict(set)
            for a in self.conjunto:
                if not a.endswith(".py"):
                    continue
                partes = a[:-3].split("/")
                if partes[-1] == "__init__":
                    partes = partes[:-1]
                for i in range(len(partes)):
                    mapa[".".join(partes[i:])].add(a)
            self._mapa_py = mapa
        return self._mapa_py

    def resolver_py(self, modulo: str, nomes, importador: str):
        alvos = set()
        if modulo.startswith("."):
            pontos = len(modulo) - len(modulo.lstrip("."))
            resto = modulo[pontos:]
            base = posixpath.dirname(importador)
            for _ in range(pontos - 1):
                base = posixpath.dirname(base)
            caminhos = []
            if resto:
                caminhos.append(posixpath.join(base, *resto.split(".")))
            else:
                caminhos += [posixpath.join(base, n) for n in nomes]
                caminhos.append(posixpath.join(base, "__init__"))
            for c in caminhos:
                c = c.lstrip("/")
                for cand in (c + ".py", c + "/__init__.py"):
                    if cand in self.conjunto:
                        alvos.add(cand)
            return alvos
        mapa = self.mapa_py()
        tentativas = [f"{modulo}.{n}" for n in nomes] + [modulo]
        for t in tentativas:
            if t in mapa:
                cand = mapa[t]
                if len(cand) > 1:
                    topo = importador.split("/", 1)[0]
                    mesmos = {c for c in cand if c.split("/", 1)[0] == topo}
                    cand = mesmos or cand
                alvos |= cand
                if t == modulo or alvos:
                    break
        return alvos

    def go_mods(self):
        if self._go_mods is None:
            mods = []
            for a in self.conjunto:
                if a == "go.mod" or a.endswith("/go.mod"):
                    m = re.search(r"^module\s+(\S+)", self.texto(a), re.M)
                    if m:
                        mods.append((m.group(1), posixpath.dirname(a)))
            self._go_mods = mods
        return self._go_mods

    def resolver_go(self, caminho_import: str):
        for modulo, d in self.go_mods():
            if caminho_import == modulo or caminho_import.startswith(modulo + "/"):
                resto = caminho_import[len(modulo):].lstrip("/")
                pasta = posixpath.join(d, resto) if d else resto
                return {a for a in self._por_dir.get(pasta, []) if a.endswith(".go") and not a.endswith("_test.go")}
        return set()

    def resolver_java(self, alvo: str):
        estrela = alvo.endswith(".*")
        partes = alvo[:-2].split(".") if estrela else alvo.split(".")
        if estrela:
            sufixo = "/".join(partes)
            return {a for d, arqs in self._por_dir.items() if d.endswith(sufixo) for a in arqs
                    if a.endswith((".java", ".kt"))}
        for corte in range(len(partes), 0, -1):
            sufixo = "/".join(partes[:corte])
            for ext in (".java", ".kt"):
                achados = {a for a in self.conjunto if a.endswith("/" + sufixo + ext) or a == sufixo + ext}
                if achados:
                    return achados
        return set()

    def construir_grafo(self):
        rx_js = re.compile(r"""(?:\bimport|\bexport)\s+(?:type\s+)?(?:[^'";]*?\sfrom\s+)?['"]([^'"\n]+)['"]"""
                           r"""|\brequire\(\s*['"]([^'"\n]+)['"]\s*\)|\bimport\(\s*['"]([^'"\n]+)['"]\s*\)""")
        rx_py_from = re.compile(r"^\s*from\s+(\.*[\w.]*)\s+import\s+\(?([^\n#)]*)", re.M)
        rx_py_imp = re.compile(r"^\s*import\s+([\w., \t]+)", re.M)
        rx_go_bloco = re.compile(r"^import\s*\((.*?)^\)", re.M | re.S)
        rx_go_um = re.compile(r'^import\s+(?:\w+\s+)?"([^"]+)"', re.M)
        rx_java = re.compile(r"^\s*import\s+(?:static\s+)?([\w.]+(?:\.\*)?)\s*;?", re.M)
        for rel in self.codigo:
            fam = familia_de(rel)
            texto = self.texto(rel)
            if not texto:
                continue
            alvos = set()
            if fam == "js":
                for m in rx_js.finditer(texto):
                    spec = m.group(1) or m.group(2) or m.group(3)
                    r = self.resolver_js(spec, rel)
                    if r:
                        alvos.add(r)
            elif fam == "py":
                for m in rx_py_from.finditer(texto):
                    nomes = [n.strip().split(" as ")[0].strip() for n in m.group(2).split(",") if n.strip()]
                    alvos |= self.resolver_py(m.group(1), [n for n in nomes if n != "*"], rel)
                for m in rx_py_imp.finditer(texto):
                    for mod in m.group(1).split(","):
                        mod = mod.strip().split(" as ")[0].strip()
                        if mod:
                            alvos |= self.resolver_py(mod, [], rel)
            elif fam == "go":
                imports = rx_go_um.findall(texto)
                for b in rx_go_bloco.findall(texto):
                    imports += re.findall(r'"([^"]+)"', b)
                for imp in imports:
                    alvos |= self.resolver_go(imp)
            elif fam == "java":
                for m in rx_java.finditer(texto):
                    alvos |= self.resolver_java(m.group(1))
            for alvo in alvos:
                if alvo != rel:
                    self.importadores[alvo].add(rel)

    def referenciadores(self, simbolos, familias, excluir_arquivos):
        if not simbolos:
            return {}
        nomes = sorted({s["nome"] for s in simbolos}, key=len, reverse=True)
        extras = sorted({"I" + s["nome"] for s in simbolos if s["familia"] == "cs" and s["tipo"] == "tipo"
                         and not s["nome"].startswith("I")}, key=len, reverse=True)
        rx = re.compile(r"(?<![\w$])(" + "|".join(re.escape(n) for n in nomes + extras) + r")(?![\w$])")
        por_nome = defaultdict(list)
        for s in simbolos:
            por_nome[s["nome"]].append(s)
            if s["familia"] == "cs" and s["tipo"] == "tipo":
                por_nome["I" + s["nome"]].append(s)
        achados = defaultdict(list)
        for rel in self.codigo:
            if rel in excluir_arquivos:
                continue
            fam = familia_de(rel)
            if fam not in familias:
                continue
            texto = self.sem_strings(rel)
            if not texto:
                continue
            encontrados = set(rx.findall(texto))
            if not encontrados:
                continue
            for nome in encontrados:
                for s in por_nome.get(nome, []):
                    if s["arquivo"] == rel or s["familia"] != fam:
                        continue
                    if s["tipo"] == "metodo":
                        dono = s.get("dono")
                        if not dono or not re.search(r"(?<![\w$])I?" + re.escape(dono) + r"(?![\w$])", texto):
                            continue
                        if not re.search(r"[.]\s*" + re.escape(nome) + r"\s*[(<]", texto):
                            continue
                    achados[rel].append(s)
        return achados


# ------------------------------------------------------------------------- telas e endpoints

PAGINAS_NEXT = {"page": "pagina", "layout": "layout", "template": "layout", "default": "pagina",
                "loading": "estado", "error": "estado", "not-found": "estado"}


def rota_de_arquivo(rel: str):
    partes = rel.split("/")
    nome = partes[-1]
    stem, ext = posixpath.splitext(nome)
    if ext.lower() not in (".tsx", ".ts", ".jsx", ".js", ".mdx", ".vue", ".svelte", ".md", ".astro"):
        return None
    if "+page" in stem or "+layout" in stem or "+server" in stem:
        if "routes" in partes:
            i = len(partes) - 1 - partes[::-1].index("routes")
            segs = [s for s in partes[i + 1:-1] if not (s.startswith("(") and s.endswith(")"))]
            tipo = "api" if "+server" in stem else ("layout" if "+layout" in stem else "pagina")
            return {"rota": "/" + "/".join(segs), "tipo": tipo}
        return None
    if "app" in partes and stem in PAGINAS_NEXT or (stem == "route" and "app" in partes):
        i = len(partes) - 1 - partes[::-1].index("app")
        segs, nota = [], ""
        for s in partes[i + 1:-1]:
            if s.startswith("(") and s.endswith(")"):
                if s.startswith("(.") or s.startswith("(..") or s.startswith("(..."):
                    nota = "rota interceptada (modal)"
                continue
            if s.startswith("@"):
                nota = "slot paralelo"
                continue
            if re.match(r"^\(\.+\)", s):
                nota = "rota interceptada (modal)"
                s = re.sub(r"^\(\.+\)", "", s)
            segs.append(s)
        tipo = "api" if stem == "route" else PAGINAS_NEXT[stem]
        return {"rota": "/" + "/".join(segs), "tipo": tipo, "nota": nota}
    if "pages" in partes:
        i = len(partes) - 1 - partes[::-1].index("pages")
        segs = partes[i + 1:-1]
        if stem in ("_app", "_document"):
            return {"rota": "/*", "tipo": "global", "nota": "envolve todas as telas"}
        if stem.startswith("_"):
            return None
        if stem != "index":
            segs = segs + [stem]
        tipo = "api" if segs[:1] == ["api"] else "pagina"
        return {"rota": "/" + "/".join(segs), "tipo": tipo}
    if "routes" in partes and posixpath.dirname(rel).endswith("app/routes"):
        segs = [s for s in stem.split(".") if s not in ("_index", "index", "route")]
        segs = [":" + s[1:] if s.startswith("$") else s for s in segs if not s.startswith("_")]
        return {"rota": "/" + "/".join(segs), "tipo": "pagina"}
    return None


RE_ROTA_DECLARADA = re.compile(r"""(?:\bpath\s*[:=]\s*|<Route\b[^>]*?\bpath=\{?)['"`](/[^'"`\s]*)['"`]""")
METODOS = ("GET", "POST", "PUT", "PATCH", "DELETE", "HEAD", "OPTIONS")


def juntar_rota(prefixo: str, rota: str, barra_e_absoluta: bool = False) -> str:
    if rota.startswith("~/"):
        return "/" + rota[2:].strip("/")
    if barra_e_absoluta and rota.startswith("/"):
        return "/" + rota.strip("/")
    partes = [p.strip("/") for p in (prefixo, rota) if p and p.strip("/")]
    return "/" + "/".join(partes)


RE_METODO_CRU = re.compile(
    r"\b(?:req|request)\.method\s*===?\s*['\"`](GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS)['\"`]"
    r"|['\"`](GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS)['\"`]\s*===?\s*(?:req|request)\.method\b")
RE_CAMINHO_CRU = re.compile(r"\b(?:pathname|url|path)\s*===?\s*['\"`](/[^'\"`\s]*)['\"`]"
                            r"|['\"`](/[^'\"`\s]*)['\"`]\s*===?\s*(?:[\w.]*\.)?(?:pathname|url|path)\b")
RE_MATCH_CRU = re.compile(r"\b(?:pathname|url|path)\s*\.\s*match\(\s*/((?:\\/|\\.|[^/\n\\])+)/[a-z]*\s*\)")
RE_SERVIDOR_CRU = re.compile(r"\bcreateServer\(|\.listen\(")
RE_HANDLER_INLINE = re.compile(r"\bcreateServer\(\s*(?:async\s+)?(?:function\b|\(|[A-Za-z_$][\w$]*\s*=>)")
RE_LE_REQUISICAO = re.compile(r"\b(?:req|request)\.(?:method|url)\b")


def regex_para_rota(rx: str) -> str:
    """'^\\/api\\/v1\\/itens\\/(\\d+)$' -> '/api/v1/itens/{id}'."""
    s = rx.strip()
    s = s[1:] if s.startswith("^") else s
    s = s[:-1] if s.endswith("$") and not s.endswith("\\$") else s
    s = re.sub(r"\(\?<[A-Za-z_]\w*>[^()]*\)", "{id}", s)
    s = re.sub(r"\(\?:[^()]*\)\??", "", s)
    s = re.sub(r"\((?!\?)[^()]*\)", "{id}", s)
    s = re.sub(r"\\(.)", r"\1", s)
    s = re.sub(r"/\?$", "", s)
    return s if s.startswith("/") else ""


def rotas_http_cru(rel: str, linhas: list) -> list:
    """Servidor Node sem framework: req.method === 'X' com pathname/url === '/...' ou pathname.match(/^...$/) na
    mesma linha, na seguinte ou na anterior."""
    saida = []

    def caminho_em(linha: str) -> str:
        m = RE_CAMINHO_CRU.search(linha)
        if m:
            return m.group(1) or m.group(2)
        m = RE_MATCH_CRU.search(linha)
        return regex_para_rota(m.group(1)) if m else ""

    for i, linha in enumerate(linhas):
        for m in RE_METODO_CRU.finditer(linha):
            metodo = m.group(1) or m.group(2)
            rota = caminho_em(linha)
            if not rota and i + 1 < len(linhas):
                rota = caminho_em(linhas[i + 1])
            if not rota and i > 0 and not RE_METODO_CRU.search(linhas[i - 1]):
                rota = caminho_em(linhas[i - 1])
            if rota:
                saida.append({"metodo": metodo, "rota": juntar_rota("", rota), "arquivo": rel, "linha": i + 1,
                              "origem": "declarado"})
    return saida


RE_SCRIPT_SRC = re.compile(r"<script\b[^>]*?\bsrc\s*=\s*['\"]([^'\"]+)['\"]", re.I)


def scripts_do_html(html_rel: str, texto: str, conjunto) -> list:
    """Arquivos do repositorio que um .html carrega por <script src> (relativo ao .html, ou absoluto a partir da
    raiz, da pasta do .html ou de qualquer pasta que termine no caminho)."""
    saida = []
    pasta = posixpath.dirname(html_rel)
    for src in RE_SCRIPT_SRC.findall(texto or ""):
        src = src.split("?", 1)[0].split("#", 1)[0].strip()
        if not src or re.match(r"^(?:[a-z][a-z0-9+.-]*:|//)", src, re.I):
            continue
        if src.startswith("/"):
            limpo = src.lstrip("/")
            candidatos = [posixpath.normpath(limpo), posixpath.normpath(posixpath.join(pasta, limpo))]
            candidatos += sorted(a for a in conjunto if a.endswith("/" + limpo))[:3]
        else:
            candidatos = [posixpath.normpath(posixpath.join(pasta, src))]
        for c in candidatos:
            if c in conjunto and c not in saida:
                saida.append(c)
                break
    return saida


RE_PY_HTTP_SERVER = re.compile(r"\bBaseHTTPRequestHandler\b|\bhttp\.server\b")
RE_PY_HANDLER_CLASSE = re.compile(r"class\s+\w+\s*\(\s*(?:[\w.]*\.)?BaseHTTPRequestHandler\b")
RE_PY_DO_METODO = re.compile(r"^([ \t]*)(?:async\s+)?def\s+do_(GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS)\s*\(", re.M)
_VAR_CAMINHO_PY = r"(?:self\.)?[\w.]*(?:path|rota|caminho|url)\w*"
RE_PY_PATH_IGUAL = re.compile(r"\b" + _VAR_CAMINHO_PY + r"\s*==\s*[rbu]?['\"](/[^'\"]*)['\"]"
                              r"|[rbu]?['\"](/[^'\"]*)['\"]\s*==\s*" + _VAR_CAMINHO_PY + r"\b")
RE_PY_PATH_PREFIXO = re.compile(r"\b" + _VAR_CAMINHO_PY + r"\s*\.\s*startswith\(\s*[rbu]?['\"](/[^'\"]*)['\"]")
RE_PY_PATH_EM = re.compile(r"\b" + _VAR_CAMINHO_PY + r"\s+in\s*[(\[{]([^)\]}]*)[)\]}]")
RE_PY_PATH_RE = re.compile(r"\bre\.(?:match|fullmatch|search)\(\s*r?['\"](\^?/[^'\"]+)['\"]\s*,\s*" + _VAR_CAMINHO_PY)
RE_PY_COMANDO = re.compile(r"\b(?:self\.)?command\s*==\s*['\"](GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS)['\"]")


def rotas_http_server_py(rel: str, linhas: list) -> list:
    """Python http.server (BaseHTTPRequestHandler): dentro de cada do_<METODO>, as comparacoes do caminho (path ==
    '/x', '/x' == path, path.startswith('/x/'), path in ('/a', '/b'), re.match(r'^/x/(\\d+)$', path)) viram
    endpoints com o metodo do do_<METODO> (ou o de self.command == 'X' na mesma linha)."""
    saida, atual = [], None
    for n, linha in enumerate(linhas, 1):
        m = RE_PY_DO_METODO.match(linha)
        if m:
            atual = (m.group(2), len(m.group(1).expandtabs(4)))
            continue
        limpa = linha.strip()
        expandida = linha.expandtabs(4)
        if atual is not None and limpa and not limpa.startswith(("#", ")", "]", "}")) \
                and len(expandida) - len(expandida.lstrip(" ")) <= atual[1]:
            atual = None
        if atual is None:
            continue
        mc = RE_PY_COMANDO.search(linha)
        metodo = mc.group(1) if mc else atual[0]
        rotas = []
        for mi in RE_PY_PATH_IGUAL.finditer(linha):
            rotas.append(mi.group(1) or mi.group(2))
        for mi in RE_PY_PATH_PREFIXO.finditer(linha):
            pref = mi.group(1)
            rotas.append(pref.rstrip("/") + "/{id}" if pref.endswith("/") and pref != "/" else pref)
        for mi in RE_PY_PATH_EM.finditer(linha):
            rotas += re.findall(r"['\"](/[^'\"]*)['\"]", mi.group(1))
        for mi in RE_PY_PATH_RE.finditer(linha):
            r_ = regex_para_rota(mi.group(1))
            if r_:
                rotas.append(r_)
        for r_ in rotas:
            if r_:
                saida.append({"metodo": metodo, "rota": juntar_rota("", r_.split("?", 1)[0]), "arquivo": rel,
                              "linha": n, "origem": "declarado"})
    return saida


def servidor_sem_rota(rel: str, texto: str) -> bool:
    """Arquivo que sobe servidor HTTP cru e do qual nenhuma rota foi reconhecida: o raio dele fica incompleto ate ser
    enumerado a mao. JS/TS: createServer com handler, ou createServer/listen lendo req.method ou req.url. Python:
    http.server/BaseHTTPRequestHandler com do_<METODO> ou classe que herda o handler (SimpleHTTPRequestHandler sem
    do_ e so arquivo estatico)."""
    if RE_TESTE.search(rel):
        return False
    fam = familia_de(rel)
    if fam == "py":
        if not RE_PY_HTTP_SERVER.search(texto):
            return False
        if not (RE_PY_DO_METODO.search(texto) or RE_PY_HANDLER_CLASSE.search(texto)):
            return False
        return not endpoints_declarados(rel, texto)
    if fam != "js" or not RE_SERVIDOR_CRU.search(texto):
        return False
    if not (RE_HANDLER_INLINE.search(texto) or RE_LE_REQUISICAO.search(texto)):
        return False
    return not endpoints_declarados(rel, texto)


def endpoints_declarados(rel: str, texto: str):
    fam = familia_de(rel)
    saida = []
    linhas = texto.splitlines()
    if fam == "cs":
        prefixo, controlador, rota_pendente = "", "", None
        for n, linha in enumerate(linhas, 1):
            mr = re.search(r'\[Route\(\s*"([^"]*)"', linha)
            mh = re.search(r"\[Http(Get|Post|Put|Patch|Delete|Head|Options)(?:\(\s*(?:template\s*:\s*)?\"([^\"]*)\")?",
                           linha)
            mc = re.search(r"^\s*(?:(?:public|internal|private|protected|sealed|abstract|partial|static)\s+)*"
                           r"class\s+([A-Za-z_]\w*)", linha)
            if mc and not mh:
                controlador = re.sub(r"Controller$", "", mc.group(1))
                prefixo, rota_pendente = (rota_pendente or ""), None
                continue
            if mr and not mh:
                rota_pendente = mr.group(1)
                continue
            if mh:
                rota = mh.group(2) if mh.group(2) is not None else (mr.group(1) if mr else (rota_pendente or ""))
                rota_pendente = None
                base = prefixo.replace("[controller]", controlador)
                saida.append({"metodo": mh.group(1).upper(),
                              "rota": juntar_rota(base, rota.replace("[controller]", controlador), True),
                              "arquivo": rel, "linha": n, "origem": "declarado"})
                continue
            mm = re.search(r'\.Map(Get|Post|Put|Patch|Delete)\(\s*"([^"]+)"', linha)
            if mm:
                saida.append({"metodo": mm.group(1).upper(), "rota": juntar_rota("", mm.group(2)), "arquivo": rel,
                              "linha": n, "origem": "declarado"})
    elif fam == "js":
        prefixo = ""
        mc = re.search(r"@Controller\(\s*['\"`]?([^'\"`)]*)", texto)
        if mc:
            prefixo = mc.group(1)
        servidor = bool(RE_SERVIDOR_JS.search(texto))
        for n, linha in enumerate(linhas, 1):
            m = re.search(r"\b(?:app|router|server|api|route|r|fastify|hono)\.(get|post|put|patch|delete|all|options|head)"
                          r"\(\s*['\"`](/[^'\"`]*)['\"`]\s*,", linha) if servidor else None
            if m:
                saida.append({"metodo": m.group(1).upper().replace("ALL", "*"), "rota": juntar_rota("", m.group(2)),
                              "arquivo": rel, "linha": n, "origem": "declarado"})
            m = re.search(r"@(Get|Post|Put|Patch|Delete|All|Options|Head)\(\s*(?:['\"`]([^'\"`]*)['\"`])?\s*\)", linha)
            if m and servidor:
                saida.append({"metodo": m.group(1).upper().replace("ALL", "*"),
                              "rota": juntar_rota(prefixo, m.group(2) or ""), "arquivo": rel, "linha": n,
                              "origem": "declarado"})
        saida.extend(rotas_http_cru(rel, linhas))
        info = rota_de_arquivo(rel)
        if info and info["tipo"] == "api":
            achados = set(re.findall(r"export\s+(?:async\s+)?(?:function|const)\s+(GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS)\b",
                                     texto))
            for met in sorted(achados) or ["*"]:
                saida.append({"metodo": met, "rota": info["rota"], "arquivo": rel, "linha": 1, "origem": "declarado"})
    elif fam == "py":
        prefixo = ""
        mp = re.search(r"APIRouter\([^)]*prefix\s*=\s*['\"]([^'\"]+)", texto)
        if mp:
            prefixo = mp.group(1)
        for n, linha in enumerate(linhas, 1):
            m = re.search(r"@\w+\.(get|post|put|patch|delete|options|head|api_route|websocket)\(\s*['\"]([^'\"]*)",
                          linha)
            if m:
                met = m.group(1).upper() if m.group(1) not in ("api_route", "websocket") else "*"
                saida.append({"metodo": met, "rota": juntar_rota(prefixo, m.group(2)), "arquivo": rel, "linha": n,
                              "origem": "declarado"})
                continue
            m = re.search(r"@\w+\.route\(\s*['\"]([^'\"]+)['\"](.*)", linha)
            if m:
                mets = re.findall(r"['\"](GET|POST|PUT|PATCH|DELETE)['\"]", m.group(2), re.I) or ["GET"]
                for met in mets:
                    saida.append({"metodo": met.upper(), "rota": juntar_rota("", m.group(1)), "arquivo": rel,
                                  "linha": n, "origem": "declarado"})
                continue
            m = re.search(r"\b(?:re_)?path\(\s*r?['\"]([^'\"]*)['\"]\s*,", linha)
            if m and rel.endswith("urls.py"):
                saida.append({"metodo": "*", "rota": juntar_rota("", m.group(1)), "arquivo": rel, "linha": n,
                              "origem": "declarado"})
        if RE_PY_DO_METODO.search(texto):
            vistos_py = {(e["metodo"], e["rota"], e["linha"]) for e in saida}
            for e in rotas_http_server_py(rel, linhas):
                if (e["metodo"], e["rota"], e["linha"]) not in vistos_py:
                    vistos_py.add((e["metodo"], e["rota"], e["linha"]))
                    saida.append(e)
    elif fam == "java":
        prefixo = ""
        mc = re.search(r"@RequestMapping\(\s*(?:value\s*=\s*|path\s*=\s*)?\{?\s*\"([^\"]*)\"", texto)
        classe_pos = re.search(r"\b(class|interface)\s+\w+", texto)
        if mc and classe_pos and mc.start() < classe_pos.start():
            prefixo = mc.group(1)
        mjax = re.search(r"@Path\(\s*\"([^\"]*)\"", texto)
        for n, linha in enumerate(linhas, 1):
            m = re.search(r"@(Get|Post|Put|Patch|Delete)Mapping(?:\(\s*(?:value\s*=\s*|path\s*=\s*)?\{?\s*\"([^\"]*)\")?",
                          linha)
            if m:
                saida.append({"metodo": m.group(1).upper(), "rota": juntar_rota(prefixo, m.group(2) or ""),
                              "arquivo": rel, "linha": n, "origem": "declarado"})
            m = re.search(r"@(GET|POST|PUT|PATCH|DELETE)\b", linha)
            if m and mjax:
                saida.append({"metodo": m.group(1), "rota": juntar_rota("", mjax.group(1)), "arquivo": rel,
                              "linha": n, "origem": "declarado"})
    elif fam == "go":
        for n, linha in enumerate(linhas, 1):
            m = re.search(r"\bHandle(?:Func)?\(\s*\"(?:(GET|POST|PUT|PATCH|DELETE)\s+)?(/[^\"]*)\"", linha)
            if m:
                saida.append({"metodo": m.group(1) or "*", "rota": m.group(2), "arquivo": rel, "linha": n,
                              "origem": "declarado"})
                continue
            m = re.search(r"\.(GET|POST|PUT|PATCH|DELETE|Get|Post|Put|Patch|Delete)\(\s*\"(/[^\"]*)\"", linha)
            if m:
                saida.append({"metodo": m.group(1).upper(), "rota": m.group(2), "arquivo": rel, "linha": n,
                              "origem": "declarado"})
    return saida


RE_CHAMADA = re.compile(
    r"\b(?:axios|api|http|client|httpClient|request|instance|\$http|this\.http|this\.httpClient)\s*\.\s*"
    r"(get|post|put|patch|delete)\s*(?:<[^>()]*>)?\(\s*([`'\"])((?:(?!\2).){1,300})\2", re.I)
RE_FETCH = re.compile(r"\bfetch\(\s*([`'\"])((?:(?!\1).){1,300})\1(?P<resto>[^;]{0,200})")
RE_CHAMADA_WRAPPER = re.compile(
    r"(?<![\w$.])([A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)*)\(\s*(['\"])(GET|POST|PUT|PATCH|DELETE)\2\s*,\s*"
    r"([`'\"])(/(?:(?!\4).){0,299})\4", re.I)
NAO_E_WRAPPER = {"if", "while", "for", "switch", "return", "typeof", "fetch", "require", "import", "console.log",
                 "console.error", "console.warn", "alert", "t", "i18n.t"}
RE_SCRIPT_BLOCO = re.compile(r"<script\b([^>]*)>(.*?)</script\s*>", re.I | re.S)
RE_ATRIBUTO_EVENTO = re.compile(r"\son[a-z]+\s*=\s*(\"[^\"]*\"|'[^']*')", re.I)
TIPOS_SCRIPT_JS = ("", "text/javascript", "application/javascript", "module", "text/babel", "text/jsx")


def js_inline_do_html(texto: str) -> str:
    """O JS de um .html: blocos <script> sem src (tipo JS ou module) e valores de atributo on*="...". O resto vira
    espaco, mantendo as quebras de linha: a linha de cada chamada continua a do .html."""
    def apagar(trecho: str) -> str:
        return re.sub(r"[^\n]", " ", trecho)

    def so_eventos(trecho: str) -> str:
        partes, pos = [], 0
        for m in RE_ATRIBUTO_EVENTO.finditer(trecho):
            partes.append(apagar(trecho[pos:m.start(1) + 1]))
            partes.append(m.group(1)[1:-1])
            pos = m.end(1) - 1
        partes.append(apagar(trecho[pos:]))
        return "".join(partes)

    saida, pos = [], 0
    for m in RE_SCRIPT_BLOCO.finditer(texto or ""):
        atributos = m.group(1)
        tipo = re.search(r"\btype\s*=\s*['\"]?([^'\"\s>]+)", atributos, re.I)
        eh_js = not re.search(r"\bsrc\s*=", atributos, re.I) and (tipo.group(1).lower() if tipo else "") in TIPOS_SCRIPT_JS
        saida.append(so_eventos(texto[pos:m.start(2)]))
        saida.append(m.group(2) if eh_js else apagar(m.group(2)))
        pos = m.end(2)
    saida.append(so_eventos((texto or "")[pos:]))
    return "".join(saida)


def chamadas_front(rel: str, texto: str, prefixo_api: str, js: bool = False):
    """Chamadas HTTP do front com caminho literal: cliente.metodo('/x'), fetch('/x', {method}) e wrapper de um
    nivel api('PUT', '/x/' + id). js=True le o texto como JS mesmo fora de arquivo .js (o JS inline de um .html)."""
    if familia_de(rel) != "js" and not js:
        return []
    consts = dict(re.findall(r"\b(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*['\"`]([^'\"`$\n]{1,120})['\"`]", texto))

    def normalizar(caminho: str, depois: str, cliente_com_base: bool) -> str:
        def troca(m):
            nome = m.group(1).strip()
            return consts.get(nome, "{" + (re.sub(r"[^\w]", "", nome.split(".")[-1]) or "x") + "}")
        caminho = re.sub(r"\$\{([^}]*)\}", troca, caminho)
        if depois.lstrip().startswith("+"):
            caminho = caminho.rstrip("/") + "/{x}"
        caminho = caminho.split("?", 1)[0]
        if re.match(r"^https?://", caminho):
            caminho = "/" + caminho.split("/", 3)[-1] if caminho.count("/") >= 3 else "/"
        elif cliente_com_base or not caminho.startswith("/"):
            pref, sem_barra = prefixo_api.strip("/"), caminho.lstrip("/")
            if pref and (sem_barra == pref or sem_barra.startswith(pref + "/")):
                caminho = "/" + sem_barra
            else:
                caminho = juntar_rota(prefixo_api, caminho)
        return caminho

    saida = []
    for n, linha in enumerate(texto.splitlines(), 1):
        for m in RE_CHAMADA.finditer(linha):
            saida.append({"metodo": m.group(1).upper(), "rota": normalizar(m.group(3), linha[m.end():], True),
                          "arquivo": rel, "linha": n, "origem": "chamada-front"})
        for m in RE_FETCH.finditer(linha):
            met = re.search(r"method\s*:\s*['\"](\w+)['\"]", m.group("resto") or "")
            alvo = m.group(2)
            if not (alvo.startswith("/") or alvo.startswith("http") or alvo.startswith("${")):
                continue
            saida.append({"metodo": (met.group(1).upper() if met else "GET"),
                          "rota": normalizar(alvo, m.group("resto") or "", False), "arquivo": rel,
                          "linha": n, "origem": "chamada-front"})
        for m in RE_CHAMADA_WRAPPER.finditer(linha):
            if m.group(1).lower() in NAO_E_WRAPPER:
                continue
            saida.append({"metodo": m.group(3).upper(), "rota": normalizar(m.group(5), linha[m.end():], False),
                          "arquivo": rel, "linha": n, "origem": "chamada-front"})
    return saida


EXT_HTML = (".html", ".htm")
DIRS_HTML_NAO_TELA = {"templates", "template", "partials", "partial", "includes", "include", "_includes", "layouts",
                      "_layouts", "emails", "email", "mail", "mails", "fixtures", "fixture", "htmlcov", "_build",
                      "site-packages", "playwright-report", "test-results", "storybook-static", "snapshots",
                      "__snapshots__", "reports", "report"}
RE_HTML_DOCUMENTO = re.compile(r"<!doctype\s+html|<html[\s>]", re.I)
RE_HTML_TEMPLATE_SERVIDOR = re.compile(r"\{%|<%|\{\{#|\{#|@extends\b|@section\b|\{\{>")


def html_e_tela(rel: str, texto: str) -> bool:
    """--tudo: .html que e pagina servida (documento inteiro), e nao template de servidor, parcial, e-mail, componente
    de framework, relatorio gerado nem teste."""
    if not rel.lower().endswith(EXT_HTML) or em_dir_pesado(rel) or RE_TESTE.search(rel):
        return False
    partes = rel.lower().split("/")
    if any(p in DIRS_HTML_NAO_TELA for p in partes[:-1]):
        return False
    if re.search(r"\.(component|tpl|template|partial|built)\.html?$", partes[-1]):
        return False
    return bool(RE_HTML_DOCUMENTO.search((texto or "")[:4000])) and not RE_HTML_TEMPLATE_SERVIDOR.search(texto or "")


# ------------------------------------------------------------- linguagem sem parser (plano B)

EXT_BINARIAS = {
    ".png", ".jpg", ".jpeg", ".gif", ".webp", ".ico", ".bmp", ".svgz", ".pdf", ".zip", ".gz", ".tgz", ".7z",
    ".jar", ".war", ".woff", ".woff2", ".ttf", ".otf", ".eot", ".mp3", ".mp4", ".mov", ".avi", ".wasm", ".so",
    ".dll", ".exe", ".class", ".pyc", ".lockb", ".keystore", ".jks", ".p12", ".pfx", ".db", ".sqlite",
}


def _recuo(linha: str) -> int:
    t = linha.expandtabs(4)
    return len(t) - len(t.lstrip())


def nomes_sem_parser(rel: str, texto_atual: str, hunks, status: str):
    vistos, defs, idents = set(), [], []

    def add(lista, nome):
        if (nome and nome not in vistos and len(nome) >= 4 and nome.lower() not in PALAVRAS_GENERICAS
                and nome.lower() not in PALAVRAS_LINGUAGEM):
            vistos.add(nome)
            lista.append(nome)

    base = posixpath.basename(rel)
    add(defs, base.split(".", 1)[0])
    linhas = texto_atual.splitlines()
    if status == "A" and texto_atual:
        for m in RE_DEF_GENERICA.finditer(texto_atual):
            add(defs, m.group(1))
    for h in hunks:
        for linha in list(h.get("adicionadas", [])) + list(h.get("removidas", [])):
            for m in RE_DEF_GENERICA.finditer(linha):
                add(defs, m.group(1))
            for tok in RE_IDENT.findall(RE_LITERAL.sub(" ", linha)):
                add(idents, tok)
        if not linhas:
            continue
        ini = min(max(1, h.get("para_ini", 1)), len(linhas))
        fim = min(len(linhas), ini - 1 + max(h.get("para_qtd", 0), 1))
        k = ini - 1
        while k < fim - 1 and not linhas[k].strip():
            k += 1
        limite = _recuo(linhas[k]) if linhas[k].strip() else 0
        for j in range(ini - 2, -1, -1):
            if limite <= 0:
                break
            linha = linhas[j]
            if not linha.strip() or _recuo(linha) >= limite:
                continue
            m = RE_DEF_GENERICA.search(linha)
            if m:
                add(defs, m.group(1))
            limite = _recuo(linha)
    idents.sort(key=len, reverse=True)
    nomes = defs[:30]
    nomes += idents[:max(0, MAX_NOMES_SEM_PARSER - len(nomes))]
    return nomes, [base]


def buscar_por_nome(indice, sem_suporte, ignorar):
    nomes = sorted({n for s in sem_suporte for n in s["nomes"]}, key=len, reverse=True)
    literais = sorted({n for s in sem_suporte for n in s["literais"]}, key=len, reverse=True)
    rx_nome = re.compile(r"(?<![\w$])(" + "|".join(map(re.escape, nomes)) + r")(?![\w$])") if nomes else None
    rx_lit = re.compile(r"(?<![\w$.-])(" + "|".join(map(re.escape, literais)) + r")(?![\w$-])") if literais else None
    achados = defaultdict(set)
    for rel in indice.arquivos:
        if rel in ignorar or em_dir_pesado(rel) or posixpath.splitext(rel)[1].lower() in EXT_BINARIAS:
            continue
        texto = indice.texto(rel)
        if not texto or "\0" in texto[:4096]:
            continue
        for rx in (rx_nome, rx_lit):
            if rx is not None:
                for nome in set(rx.findall(texto)):
                    achados[nome].add(rel)
    return achados


# --------------------------------------------------------------------------------- analise

def conteudo_em(raiz: Path, ref: str, caminho: str) -> str:
    dados = git(raiz, "show", f"{ref}:{caminho}", binario=True, permitir_falha=True)
    return dados.decode("utf-8", "replace") if dados else ""


def analisar(args):
    raiz_in = Path(args.raiz).expanduser()
    if not raiz_in.is_dir():
        raise ErroUso(f"pasta nao encontrada: {raiz_in}")
    topo = git(raiz_in, "rev-parse", "--show-toplevel", permitir_falha=True)
    if not topo:
        raise ErroUso(f"{raiz_in} nao esta dentro de um repositorio git")
    raiz = Path(topo.strip())
    avisos = []
    tem_head = git(raiz, "rev-parse", "--verify", "-q", "HEAD^{commit}", permitir_falha=True) is not None
    if args.base:
        if git(raiz, "rev-parse", "--verify", "-q", f"{args.base}^{{commit}}", permitir_falha=True) is None:
            raise ErroUso(f"base inexistente: {args.base} (confira o nome da branch; para remota use origin/<nome>)")
        if git(raiz, "rev-parse", "--verify", "-q", f"{args.cabeca}^{{commit}}", permitir_falha=True) is None:
            raise ErroUso(f"cabeca inexistente: {args.cabeca}")
        mb = git(raiz, "merge-base", args.base, args.cabeca).strip()
        if args.incluir_working:
            if args.cabeca != "HEAD":
                raise ErroUso("--incluir-working so combina com --cabeca HEAD")
            faixa, ref_antiga, ref_nova = [mb], mb, None
            modo = f"{args.base}...HEAD + working tree (alteracoes nao commitadas)"
        else:
            faixa, ref_antiga, ref_nova = [mb, args.cabeca], mb, args.cabeca
            modo = f"{args.base}...{args.cabeca} (so commits)"
        cab_sha = git(raiz, "rev-parse", "--short", args.cabeca).strip()
        if args.cabeca != "HEAD" and git(raiz, "rev-parse", "HEAD", permitir_falha=True) != git(raiz, "rev-parse",
                                                                                                args.cabeca):
            avisos.append("o raio de impacto le os arquivos do disco, que estao em outro commit que --cabeca: "
                          "faca checkout da cabeca para um raio exato")
    else:
        if not tem_head:
            raise ErroUso("repositorio sem commit: nao ha HEAD para comparar")
        mb, faixa, ref_antiga, ref_nova = None, ["HEAD"], "HEAD", None
        cab_sha = git(raiz, "rev-parse", "--short", "HEAD").strip()
        modo = "working tree x HEAD (alteracoes nao commitadas, inclusive staged e arquivos novos)"

    ns = ler_name_status(git(raiz, "diff", "--name-status", "-z", "-M", *faixa, binario=True))
    diff = ler_diff(git(raiz, "diff", "-U0", "--no-color", "--no-ext-diff", "-M", *faixa))
    if ref_nova is None:
        novos = git(raiz, "ls-files", "--others", "--exclude-standard", "-z", binario=True).decode("utf-8", "replace")
        for a in [x for x in novos.split("\0") if x]:
            ns.append({"status": "?", "arquivo": a, "de": None})
    ns = [x for x in ns if not casa_glob(x["arquivo"], args.excluir) and not em_dir_pesado(x["arquivo"])]
    exatos, pastas_excl = preparar_excluir_arquivos(getattr(args, "excluir_arquivo", None) or [], raiz_in, raiz)
    excluidos_iniciais = sorted(x["arquivo"] for x in ns if excluido_por_arquivo(x["arquivo"], exatos, pastas_excl))
    ns = [x for x in ns if not excluido_por_arquivo(x["arquivo"], exatos, pastas_excl)]
    todo_o_diff_excluido = bool(excluidos_iniciais) and not ns

    arquivos_repo = [a for a in git(raiz, "ls-files", "-z", "--cached", "--others", "--exclude-standard",
                                    binario=True).decode("utf-8", "replace").split("\0") if a]
    removidos = [x["arquivo"] for x in ns if x["status"] == "D"] + [x["de"] for x in ns if x.get("de")]
    indice = Indice(raiz, arquivos_repo, removidos, args.excluir)

    alterados = []
    hunks_por_arquivo = {}
    for item in ns:
        rel, st = item["arquivo"], item["status"]
        fam = familia_de(rel)
        d = diff.get(rel) or (diff.get(item["de"]) if item.get("de") else None) or {}
        if st == "?":
            texto_novo = indice.texto(rel)
            n_linhas = len(texto_novo.splitlines())
            d = {"hunks": [{"para_ini": 1, "para_qtd": n_linhas, "removidas": [], "adicionadas": []}],
                 "adicionadas": n_linhas, "removidas": 0, "binario": "\0" in texto_novo[:4096]}
        hunks_por_arquivo[rel] = d.get("hunks", [])
        info = {"arquivo": rel, "status": {"?": "A"}.get(st, st), "novo_nao_rastreado": st == "?",
                "de": item.get("de"), "familia": fam or "", "adicionadas": d.get("adicionadas", 0),
                "removidas": d.get("removidas", 0), "binario": d.get("binario", False),
                "marcas": marcas_do_arquivo(rel), "simbolos": [], "usos_diretos": 0}
        if fam and not info["binario"]:
            marcados = {}

            def marcar(x, origem, buscar):
                chave = (x["nome"], x["tipo"], x.get("dono"))
                if chave not in marcados:
                    marcados[chave] = {"def": x, "origem": origem, "buscar": buscar}
                elif buscar:
                    marcados[chave]["buscar"] = True

            if st == "D":
                for x in definicoes(conteudo_em(raiz, ref_antiga, rel), fam, rel):
                    x["familia"] = fam
                    marcar(x, "removido", buscavel(x))
            else:
                texto_novo = indice.texto(rel) if ref_nova is None else conteudo_em(raiz, ref_nova, rel)
                defs = definicoes(texto_novo, fam, rel)
                for x in defs:
                    x["familia"] = fam
                origem_padrao = "novo" if st in ("A", "?") else "alterado"
                for h in d.get("hunks", []):
                    ini = max(1, h["para_ini"])
                    fim = ini + max(h["para_qtd"], 1) - 1
                    cadeias = [envolvente(defs, L) for L in sorted({ini, fim})]
                    cadeias += [envolvente(defs, x["linha"]) for x in defs if ini <= x["linha"] <= fim]
                    for cad in cadeias:
                        for x in cad:
                            marcar(x, origem_padrao, False)
                        alvo = escolher_busca(cad)
                        if alvo:
                            marcar(alvo, origem_padrao, True)
                    if h["removidas"]:
                        nomes_atuais = {e["nome"] for e in defs}
                        for x in definicoes("\n".join(h["removidas"]), fam, rel):
                            x["familia"] = fam
                            if x["nome"] not in nomes_atuais:
                                marcar(x, "removido", buscavel(x))
            for m in sorted(marcados.values(), key=lambda v: v["def"]["linha"]):
                x = m["def"]
                info["simbolos"].append({"nome": x["nome"], "tipo": x["tipo"], "dono": x.get("dono"),
                                         "exportado": x["exportado"], "origem": m["origem"], "linha": x["linha"],
                                         "arquivo": rel, "familia": fam, "componente": eh_componente(x, rel),
                                         "buscar": m["buscar"]})
        alterados.append(info)

    indice.construir_grafo()
    avisos += indice.avisos

    buscaveis = []
    genericos = set()
    if not args.sem_simbolos:
        for a in alterados:
            for sb in a["simbolos"]:
                if sb["buscar"]:
                    buscaveis.append(sb)
                elif sb["exportado"] and (len(sb["nome"]) < 4 or sb["nome"].lower() in PALAVRAS_GENERICAS):
                    genericos.add(sb["nome"])
    if genericos:
        avisos.append("simbolos de nome generico nao foram buscados por nome (o import ainda conta): "
                      + ", ".join(sorted(genericos)[:30]))

    impacto = {}
    pais = {}
    alterados_set = {a["arquivo"] for a in alterados}
    for a in alterados:
        pais[a["arquivo"]] = None

    def registrar(rel, nivel, motivo, pai):
        if rel in alterados_set:
            return False
        if rel not in impacto:
            if len(impacto) >= args.max_arquivos:
                return False
            impacto[rel] = {"arquivo": rel, "nivel": nivel, "motivos": [motivo], "teste": bool(RE_TESTE.search(rel))}
            pais[rel] = pai
            return True
        if motivo not in impacto[rel]["motivos"] and len(impacto[rel]["motivos"]) < 6:
            impacto[rel]["motivos"].append(motivo)
        return False

    fronteira = []
    for a in alterados:
        for imp in sorted(indice.importadores.get(a["arquivo"], ())):
            if registrar(imp, 1, f"importa {a['arquivo']}", a["arquivo"]):
                fronteira.append(imp)
            a["usos_diretos"] += 1
    refs = indice.referenciadores(buscaveis, {"js", "py", "cs", "java", "go"}, set())
    for rel, lista in sorted(refs.items()):
        for s in lista:
            dono = f"{s['dono']}." if s.get("dono") else ""
            novo = registrar(rel, 1, f"usa {dono}{s['nome']} ({s['arquivo']})", s["arquivo"])
            if novo:
                fronteira.append(rel)
        for a in alterados:
            if any(s["arquivo"] == a["arquivo"] for s in lista) and rel not in indice.importadores.get(a["arquivo"], ()):
                a["usos_diretos"] += 1

    sem_suporte = []
    for a in alterados:
        lingua = linguagem_sem_parser(a["arquivo"])
        if a["familia"] or a["binario"] or not lingua:
            continue
        rel = a["arquivo"]
        if a["status"] == "D":
            texto_atual = ""
        elif ref_nova is None:
            texto_atual = indice.texto(rel)
        else:
            texto_atual = conteudo_em(raiz, ref_nova, rel)
        nomes, literais = nomes_sem_parser(rel, texto_atual, hunks_por_arquivo.get(rel, []), a["status"])
        sem_suporte.append({"arquivo": rel, "linguagem": lingua, "nomes": nomes, "literais": literais,
                            "comuns_demais": [], "achados": []})
    if sem_suporte:
        por_nome = buscar_por_nome(indice, sem_suporte, alterados_set)
        for s in sem_suporte:
            achados = set()
            for nome in s["nomes"] + s["literais"]:
                arqs = por_nome.get(nome, set()) - {s["arquivo"]}
                if len(arqs) > MAX_ARQUIVOS_POR_NOME:
                    s["comuns_demais"].append(f"{nome} ({len(arqs)} arquivos)")
                    continue
                for rel in sorted(arqs):
                    achados.add(rel)
                    if registrar(rel, 1, f"por nome (sem parser): {nome} ({s['arquivo']})", s["arquivo"]) \
                            and familia_de(rel):
                        fronteira.append(rel)
            s["achados"] = sorted(achados)
            next(a for a in alterados if a["arquivo"] == s["arquivo"])["usos_diretos"] += len(achados)
        linguas = ", ".join(sorted({s["linguagem"] for s in sem_suporte}))
        avisos.append(f"linguagem sem suporte ({linguas}): raio NAO calculado por parser para {len(sem_suporte)} "
                      f"arquivo(s); o plano B por nome (sem parser) achou "
                      f"{len({x for s in sem_suporte for x in s['achados']})} arquivo(s), so no nivel 1. Complete o "
                      "raio a mao lendo o diff; no gate do modo PR, aceite com --aceitar-raio-incompleto")
    nivel = 1
    estourou = False
    while fronteira and nivel < args.profundidade:
        nivel += 1
        proxima = []
        tipos_cs_java = []
        for rel in fronteira:
            for imp in sorted(indice.importadores.get(rel, ())):
                if registrar(imp, nivel, f"importa {rel}", rel):
                    proxima.append(imp)
            fam = familia_de(rel)
            if fam in ("cs", "java"):
                for d in definicoes(indice.texto(rel), fam, rel):
                    if d["tipo"] == "tipo" and d["exportado"] and len(d["nome"]) >= 4 \
                            and d["nome"].lower() not in PALAVRAS_GENERICAS:
                        tipos_cs_java.append({"nome": d["nome"], "tipo": "tipo", "dono": None, "arquivo": rel,
                                              "familia": fam})
        if tipos_cs_java:
            for ref_rel, lista in sorted(indice.referenciadores(tipos_cs_java, {"cs", "java"}, set()).items()):
                for s in lista:
                    if registrar(ref_rel, nivel, f"usa {s['nome']} ({s['arquivo']})", s["arquivo"]):
                        proxima.append(ref_rel)
        if len(impacto) >= args.max_arquivos:
            estourou = True
            break
        fronteira = proxima
    if estourou or len(impacto) >= args.max_arquivos:
        avisos.append(f"raio cortado em --max-arquivos={args.max_arquivos}: aumente o limite ou reduza --profundidade")
    if fronteira and nivel >= args.profundidade:
        avisos.append(f"a busca parou na profundidade {args.profundidade}; ha {len(fronteira)} arquivo(s) cujo "
                      "impacto nao foi seguido (aumente --profundidade se precisar das telas mais distantes)")

    def cadeia(rel):
        saida, atual, guarda = [], rel, 0
        while atual is not None and guarda < 50:
            saida.append(atual)
            atual = pais.get(atual)
            guarda += 1
        return saida

    escopo = [a["arquivo"] for a in alterados if a["status"] != "D"] + sorted(impacto)
    telas, vistos_t = [], set()
    for rel in escopo:
        info = rota_de_arquivo(rel)
        if info and info["tipo"] != "api":
            chave = (info["rota"], rel)
            if chave not in vistos_t:
                vistos_t.add(chave)
                telas.append({"rota": info["rota"], "tipo": info["tipo"], "arquivo": rel, "nota": info.get("nota", ""),
                              "cadeia": cadeia(rel)})
        if familia_de(rel) == "js":
            for n, linha in enumerate(indice.texto(rel).splitlines(), 1):
                for m in RE_ROTA_DECLARADA.finditer(linha):
                    chave = (m.group(1), rel)
                    if chave not in vistos_t:
                        vistos_t.add(chave)
                        telas.append({"rota": m.group(1), "tipo": "declarada", "arquivo": f"{rel}:{n}",
                                      "nota": "rota declarada num arquivo do escopo", "cadeia": cadeia(rel)})
    endpoints, vistos_e = [], set()
    for rel in escopo:
        texto = indice.texto(rel)
        if not texto:
            continue
        inline = chamadas_front(rel, js_inline_do_html(texto), args.prefixo_api, js=True) \
            if rel.lower().endswith(EXT_HTML) else []
        for e in endpoints_declarados(rel, texto) + chamadas_front(rel, texto, args.prefixo_api) + inline:
            chave = (e["metodo"], e["rota"], e["origem"], e["arquivo"])
            if chave in vistos_e:
                continue
            vistos_e.add(chave)
            e["cadeia"] = cadeia(rel)
            endpoints.append(e)

    conjunto_escopo = set(escopo)
    for html_rel in sorted(a for a in arquivos_repo if a.lower().endswith((".html", ".htm")) and not em_dir_pesado(a)
                           and not casa_glob(a, args.excluir)):
        motivo = None
        if html_rel in alterados_set:
            motivo = "o proprio .html mudou", html_rel
        else:
            for js in scripts_do_html(html_rel, indice.texto(html_rel), indice.conjunto):
                if js in conjunto_escopo:
                    motivo = f"carrega {js} por <script src>", js
                    break
        if motivo and ("/" + html_rel, html_rel) not in vistos_t:
            vistos_t.add(("/" + html_rel, html_rel))
            telas.append({"rota": "/" + html_rel, "tipo": "html", "arquivo": html_rel, "nota": motivo[0],
                          "cadeia": [html_rel] + (cadeia(motivo[1]) if motivo[1] != html_rel else [])})

    servidores_crus = []
    for a in alterados:
        if a["status"] != "D" and servidor_sem_rota(a["arquivo"], indice.texto(a["arquivo"])):
            servidores_crus.append(a["arquivo"])
            avisos.append(f"servidor sem rota reconhecida em {a['arquivo']}: enumere a mao (o raio fica incompleto "
                          f"ate --aceitar-raio-incompleto)")

    testes = sorted({a["arquivo"] for a in alterados if "teste" in a["marcas"]} | {r for r, v in impacto.items() if v["teste"]})

    if any("impacto-global" in a["marcas"] for a in alterados):
        avisos.append("ha arquivo de build/configuracao no diff (marca impacto-global): o raio real e o projeto inteiro; "
                      "rode build, a suite e um smoke dos fluxos principais")
    if any("migracao" in a["marcas"] for a in alterados):
        avisos.append("ha migracao/SQL no diff: rode as invariantes do banco antes e depois (modulos-avancados, modulo 3)")
    if any(a["familia"] == "cs" for a in alterados):
        avisos.append("C#: o raio usa nomes de tipo (e I<Tipo>), nao 'using'; registro de injecao de dependencia e "
                      "chamadas por reflexao ficam de fora")

    return {
        "ferramenta": "escopo_diff.py",
        "gerado_em": datetime.now().astimezone().isoformat(timespec="seconds"),
        "repositorio": str(raiz),
        "modo": modo, "base": args.base, "merge_base": (mb[:10] if mb else None), "cabeca": args.cabeca,
        "commit_cabeca": cab_sha,
        "comando": "escopo_diff.py " + " ".join(sys.argv[1:]),
        "alterados": alterados,
        "impacto": sorted(impacto.values(), key=lambda v: (v["nivel"], v["arquivo"])),
        "telas": sorted(telas, key=lambda t: (t["rota"], t["arquivo"])),
        "endpoints": sorted(endpoints, key=lambda e: (e["origem"], e["rota"], e["metodo"])),
        "testes_no_escopo": testes,
        "sem_suporte": sem_suporte,
        "raio_incompleto": [s["arquivo"] for s in sem_suporte] + servidores_crus,
        "excluidos": {"status_inicial": excluidos_iniciais, "globs": list(args.excluir),
                      "todo_o_diff": todo_o_diff_excluido},
        "avisos": avisos,
    }


def listar_sem_git(raiz: Path):
    arquivos = []
    for pasta, dirs, nomes in os.walk(raiz):
        dirs[:] = sorted(d for d in dirs if d not in DIRS_PESADOS)
        for nome in sorted(nomes):
            arquivos.append(Path(pasta, nome).relative_to(raiz).as_posix())
    return arquivos


def analisar_tudo(args):
    raiz_in = Path(args.raiz).expanduser()
    if not raiz_in.is_dir():
        raise ErroUso(f"pasta nao encontrada: {raiz_in}")
    avisos = []
    topo = git(raiz_in, "rev-parse", "--show-toplevel", permitir_falha=True)
    if topo:
        raiz = Path(topo.strip())
        arquivos = [a for a in git(raiz, "ls-files", "-z", "--cached", "--others", "--exclude-standard",
                                   binario=True).decode("utf-8", "replace").split("\0") if a]
        commit = (git(raiz, "rev-parse", "--short", "HEAD", permitir_falha=True) or "").strip() or None
    else:
        raiz = raiz_in.resolve()
        arquivos = listar_sem_git(raiz)
        commit = None
        avisos.append("pasta fora de repositorio git: arquivos listados do disco, sem .gitignore (pastas pesadas puladas)")
    indice = Indice(raiz, arquivos, [], args.excluir)
    candidatos = [a for a in indice.arquivos if not em_dir_pesado(a)]
    telas, vistos_t = [], set()
    for rel in candidatos:
        info = rota_de_arquivo(rel)
        if info and info["tipo"] != "api" and (info["rota"], rel) not in vistos_t:
            vistos_t.add((info["rota"], rel))
            telas.append({"rota": info["rota"], "tipo": info["tipo"], "arquivo": rel, "nota": info.get("nota", ""),
                          "cadeia": [rel]})
    htmls = [a for a in candidatos if a.lower().endswith(EXT_HTML)]
    endpoints, vistos_e = [], set()
    for rel in htmls:
        texto = indice.texto(rel)
        if html_e_tela(rel, texto) and ("/" + rel, rel) not in vistos_t:
            vistos_t.add(("/" + rel, rel))
            telas.append({"rota": "/" + rel, "tipo": "html", "arquivo": rel,
                          "nota": "pagina .html do projeto (documento inteiro)", "cadeia": [rel]})
        for e in chamadas_front(rel, js_inline_do_html(texto), args.prefixo_api, js=True):
            chave = (e["metodo"], e["rota"], e["origem"], e["arquivo"])
            if chave not in vistos_e:
                vistos_e.add(chave)
                e["cadeia"] = [rel]
                endpoints.append(e)
    for rel in indice.codigo:
        texto = indice.texto(rel)
        if not texto:
            continue
        if familia_de(rel) == "js":
            for n, linha in enumerate(texto.splitlines(), 1):
                for m in RE_ROTA_DECLARADA.finditer(linha):
                    if (m.group(1), rel) not in vistos_t:
                        vistos_t.add((m.group(1), rel))
                        telas.append({"rota": m.group(1), "tipo": "declarada", "arquivo": f"{rel}:{n}",
                                      "nota": "rota declarada no codigo", "cadeia": [rel]})
        for e in endpoints_declarados(rel, texto) + chamadas_front(rel, texto, args.prefixo_api):
            chave = (e["metodo"], e["rota"], e["origem"], e["arquivo"])
            if chave not in vistos_e:
                vistos_e.add(chave)
                e["cadeia"] = [rel]
                endpoints.append(e)
    avisos += indice.avisos
    outros = detectar_por_tipo(indice, candidatos)
    documentados = comandos_documentados(indice, candidatos, outros)
    if documentados:
        avisos.append(f"{len(documentados)} subcomando(s) citado(s) no README/docs sem parser que os declare: "
                      + ", ".join(o["id"] for o in documentados[:8]) + (" ..." if len(documentados) > 8 else ""))
        outros += documentados
    servidores_crus = []
    for rel in indice.codigo:
        if servidor_sem_rota(rel, indice.texto(rel)):
            servidores_crus.append(rel)
            avisos.append(f"servidor sem rota reconhecida em {rel}: enumere a mao (o gate sai 1 ate "
                          f"--aceitar-raio-incompleto)")
    sem_parser = sorted({linguagem_sem_parser(a) for a in candidatos if linguagem_sem_parser(a)})
    if sem_parser:
        avisos.append("ha arquivos de linguagem sem suporte (" + ", ".join(sem_parser) + "): rotas e endpoints "
                      "declarados nelas nao sao detectados; enumere-os pelo roteador e pelo menu, a mao")
    return {
        "ferramenta": "escopo_diff.py",
        "gerado_em": datetime.now().astimezone().isoformat(timespec="seconds"),
        "repositorio": str(raiz),
        "modo": "projeto inteiro (--tudo): telas e endpoints detectados, sem diff",
        "tudo": True, "base": None, "merge_base": None, "cabeca": None, "commit_cabeca": commit,
        "comando": "escopo_diff.py " + " ".join(sys.argv[1:]),
        "arquivos_lidos": len(indice.codigo),
        "alterados": [], "impacto": [],
        "telas": sorted(telas, key=lambda t: (t["rota"], t["arquivo"])),
        "endpoints": sorted(endpoints, key=lambda e: (e["origem"], e["rota"], e["metodo"])),
        "outros": sorted(outros, key=lambda o: (o["tipo"], o["id"])),
        "testes_no_escopo": sorted(a for a in candidatos if RE_TESTE.search(a)),
        "sem_suporte": [], "raio_incompleto": servidores_crus,
        "avisos": avisos,
    }


# ------------------------------------------------------- superficie por tipo de projeto (--tudo)

RE_EXPORT_JS = re.compile(r"^\s*export\s+(?:default\s+)?(?:async\s+)?(?:function\*?|const|let|var|class)\s+"
                          r"([A-Za-z_$][\w$]*)", re.M)
RE_ARGPARSE_SUB = re.compile(r"\.add_parser\(\s*['\"]([\w:.-]+)['\"]")
RE_ARGPARSE_PROG = re.compile(r"ArgumentParser\([^)]*?\bprog\s*=\s*['\"]([\w.-]+)['\"]", re.S)
RE_CLICK_CMD = re.compile(r"@[\w.]*\bcommand\(\s*(?:name\s*=\s*)?(?:['\"]([\w:.-]+)['\"])?[^)]*\)\s*\n"
                          r"(?:\s*@[^\n]*\n)*\s*(?:async\s+)?def\s+(\w+)")
RE_COMMANDER = re.compile(r"\.command\(\s*['\"`]([\w:.-]+)")
RE_COBRA_USE = re.compile(r"\bUse:\s*\"([\w:.-]+)")
RE_PY_ALL = re.compile(r"^__all__\s*=\s*[\[(]([^\])]*)[\])]", re.M | re.S)
RE_RUST_PUB_FN = re.compile(r"^pub\s+(?:const\s+)?(?:async\s+)?(?:unsafe\s+)?fn\s+(\w+)", re.M)
RE_CELERY_TASK = re.compile(r"@(?:[\w.]+\.)?(?:task|shared_task|periodic_task)\b(?:\([^)]*\))?\s*\n"
                            r"(?:\s*@[^\n]*\n)*\s*(?:async\s+)?def\s+(\w+)")
RE_BEAT_TASK = re.compile(r"['\"]task['\"]\s*:\s*['\"]([\w.:-]+)['\"]")
RE_HANGFIRE = re.compile(r"RecurringJob\.AddOrUpdate(?:<(\w+)>)?\(\s*(?:\"([^\"]+)\")?")
RE_NEST_CRON = re.compile(r"@(?:Cron|Interval|Timeout)\([^)]*\)\s*\n\s*(?:public\s+|private\s+|protected\s+)?"
                          r"(?:async\s+)?(\w+)\s*\(")
RE_NODE_CRON = re.compile(r"\bcron\.schedule\(\s*['\"`]([^'\"`]+)['\"`]")
RE_BULLMQ = re.compile(r"\bnew\s+(?:Worker|Queue|QueueScheduler|FlowProducer)\(\s*['\"`]([\w.:-]+)['\"`]")
RE_SIDEKIQ = re.compile(r"class\s+(\w+)[^\n]*\n(?:[^\n]*\n){0,3}?\s*include\s+Sidekiq::(?:Worker|Job)\b")
RE_IPC_MAIN = re.compile(r"\bipcMain\.(?:handle|handleOnce|on|once)\(\s*['\"`]([\w:./-]+)['\"`]")
RE_EXPOSE = re.compile(r"\bexposeInMainWorld\(\s*['\"`]([\w$]+)['\"`]")
RE_TAURI_CMD = re.compile(r"#\[tauri::command[^\]]*\]\s*\n(?:\s*#\[[^\n]*\n)*\s*(?:pub\s+)?(?:async\s+)?fn\s+(\w+)")
RE_RN_SCREEN = re.compile(r"<\w+\.Screen\b[^>]*?\bname=\{?\s*['\"`]([^'\"`]+)['\"`]", re.S)
RE_GOROUTE = re.compile(r"\bGoRoute\(\s*(?:[^()]*?)\bpath:\s*['\"]([^'\"]+)['\"]", re.S)
RE_FLUTTER_ROTA = re.compile(r"['\"](/[\w/:.-]*)['\"]\s*:\s*\(\s*(?:_|context|ctx|BuildContext\s+\w+)\s*\)")
TIPO_ITEM_DO_PROJETO = {"cli": ("comando",), "biblioteca": ("funcao",), "jobs": ("job",), "desktop": ("ipc",),
                        "mobile": ("tela-mobile",)}
TIPOS_SEM_DETECTOR = ("llm", "jogo")
MODOS_CONTAGEM = {"cli": {"comando"}, "biblioteca": {"funcao"}, "jobs": {"job", "fila", "consumidor"},
                  "desktop": {"ipc", "janela", "menu"}, "mobile": {"tela"}, "llm": {"prompt", "ferramenta", "fonte"},
                  "jogo": {"cena"}}


def _modulo_py(rel: str) -> str:
    sem_ext = rel[:-3] if rel.endswith(".py") else rel
    partes = [p for p in sem_ext.split("/") if p not in ("src", "lib")]
    if partes and partes[-1] == "__init__":
        partes = partes[:-1]
    return ".".join(partes) or sem_ext


def _modulo_rs(rel: str) -> str:
    sem_ext = rel[:-3] if rel.endswith(".rs") else rel
    partes = [p for p in sem_ext.split("/") if p != "src"]
    if partes and partes[-1] in ("lib", "mod"):
        partes = partes[:-1]
    return "::".join(partes) or "crate"


def _linha(texto: str, pos: int) -> int:
    return texto.count("\n", 0, pos) + 1


def detectar_por_tipo(indice, candidatos):
    """Superficie que nao e tela web nem endpoint: subcomandos de CLI, exports publicos, jobs agendados, canais de
    IPC e telas mobile. Heuristico: o que ele acha e o minimo; o que ele nao acha se enumera a mao (e se conta)."""
    achados, vistos = [], set()

    def add(tipo, ident, rel, n, origem):
        chave = (tipo, ident)
        if ident and chave not in vistos:
            vistos.add(chave)
            achados.append({"tipo": tipo, "id": f"{'tela' if tipo == 'tela-mobile' else tipo}:{ident}",
                            "arquivo": rel, "linha": n, "origem": origem})

    pacotes_com_expo = False
    bins = {}
    for rel in candidatos:
        if rel.rsplit("/", 1)[-1] != "package.json" or em_dir_pesado(rel):
            continue
        try:
            pkg = json.loads(indice.texto(rel) or "{}")
        except (json.JSONDecodeError, ValueError):
            continue
        if not isinstance(pkg, dict):
            continue
        deps = {}
        for k in ("dependencies", "devDependencies", "peerDependencies"):
            if isinstance(pkg.get(k), dict):
                deps.update(pkg[k])
        if "expo-router" in deps:
            pacotes_com_expo = True
        nome = str(pkg.get("name") or posixpath.dirname(rel) or "pacote")
        pasta = posixpath.dirname(rel)
        b = pkg.get("bin")
        if isinstance(b, str):
            bins[nome.split("/")[-1]] = rel
            add("comando", nome.split("/")[-1], rel, 1, "package.json bin")
        elif isinstance(b, dict):
            for k in b:
                bins[k] = rel
                add("comando", k, rel, 1, "package.json bin")
        entradas = []
        if isinstance(pkg.get("main"), str):
            entradas.append(pkg["main"])
        ex = pkg.get("exports")
        pilha = [ex]
        while pilha:
            x = pilha.pop()
            if isinstance(x, str):
                entradas.append(x)
            elif isinstance(x, dict):
                pilha.extend(x.values())
            elif isinstance(x, list):
                pilha.extend(x)
        if not entradas or pkg.get("private") is True and not ex:
            continue
        for ent in dict.fromkeys(entradas):
            alvo = posixpath.normpath(posixpath.join(pasta, ent[2:] if ent.startswith("./") else ent))
            candidatos_ent = [alvo] + [alvo.replace("/dist/", "/src/").replace("/lib/", "/src/")]
            candidatos_ent += [posixpath.splitext(c)[0] + e for c in list(candidatos_ent)
                               for e in (".ts", ".tsx", ".js", ".mjs")]
            real = next((c for c in candidatos_ent if c in indice.conjunto), None)
            if not real:
                add("funcao", f"{nome}", rel, 1, f"package.json exports/main ({ent})")
                continue
            texto = indice.texto(real)
            nomes = sorted(set(RE_EXPORT_JS.findall(texto)) | set(exportados_js(texto)))
            if not nomes:
                add("funcao", f"{nome}", real, 1, "package.json exports/main")
            for nm in nomes:
                add("funcao", f"{nome}.{nm}", real, 1, "export publico (package.json exports/main)")
    for rel in candidatos:
        if em_dir_pesado(rel) or RE_TESTE.search(rel):
            continue
        ext = posixpath.splitext(rel)[1].lower()
        if ext not in (".py", ".js", ".jsx", ".ts", ".tsx", ".mjs", ".cjs", ".go", ".rs", ".cs", ".dart", ".rb"):
            continue
        texto = indice.texto(rel)
        if not texto:
            continue
        stem = posixpath.splitext(rel.rsplit("/", 1)[-1])[0]
        if ext == ".py":
            if "ArgumentParser(" in texto:
                mp = RE_ARGPARSE_PROG.search(texto)
                prog = mp.group(1) if mp else stem
                subs = list(RE_ARGPARSE_SUB.finditer(texto))
                for m in subs:
                    add("comando", f"{prog} {m.group(1)}", rel, _linha(texto, m.start()), "argparse add_parser")
                if not subs:
                    add("comando", prog, rel, _linha(texto, texto.find("ArgumentParser(")), "argparse")
            if re.search(r"^\s*(?:import|from)\s+(?:click|typer)\b", texto, re.M):
                for m in RE_CLICK_CMD.finditer(texto):
                    nome = m.group(1) or m.group(2).replace("_", "-")
                    add("comando", f"{stem} {nome}", rel, _linha(texto, m.start()), "click/typer command")
            for m in RE_PY_ALL.finditer(texto):
                for nm in re.findall(r"['\"]([\w]+)['\"]", m.group(1)):
                    add("funcao", f"{_modulo_py(rel)}.{nm}", rel, _linha(texto, m.start()), "__all__")
            if re.search(r"\b(?:celery|Celery|shared_task)\b", texto):
                for m in RE_CELERY_TASK.finditer(texto):
                    add("job", m.group(1), rel, _linha(texto, m.start()), "celery task")
            if "beat_schedule" in texto or "CELERY_BEAT_SCHEDULE" in texto:
                for m in RE_BEAT_TASK.finditer(texto):
                    add("job", m.group(1), rel, _linha(texto, m.start()), "celery beat_schedule")
        elif ext in (".js", ".jsx", ".ts", ".tsx", ".mjs", ".cjs"):
            if re.search(r"['\"](?:commander|yargs)['\"]", texto):
                mn = re.search(r"\.name\(\s*['\"`]([\w.-]+)['\"`]", texto)
                prog = mn.group(1) if mn else (next(iter(bins)) if len(bins) == 1 else stem)
                for m in RE_COMMANDER.finditer(texto):
                    add("comando", f"{prog} {m.group(1)}", rel, _linha(texto, m.start()), "commander/yargs command")
            for m in RE_NEST_CRON.finditer(texto):
                add("job", m.group(1), rel, _linha(texto, m.start()), "@Cron/@Interval")
            for m in RE_NODE_CRON.finditer(texto):
                add("job", f"{stem}#{slug(m.group(1)) or 'cron'}", rel, _linha(texto, m.start()), "node-cron")
            if "bullmq" in texto or "bull" in texto:
                for m in RE_BULLMQ.finditer(texto):
                    add("job", m.group(1), rel, _linha(texto, m.start()), "BullMQ Worker/Queue")
            for m in RE_IPC_MAIN.finditer(texto):
                add("ipc", m.group(1), rel, _linha(texto, m.start()), "ipcMain")
            for m in RE_EXPOSE.finditer(texto):
                add("ipc", m.group(1), rel, _linha(texto, m.start()), "contextBridge.exposeInMainWorld")
            for m in RE_RN_SCREEN.finditer(texto):
                add("tela-mobile", m.group(1), rel, _linha(texto, m.start()), "React Navigation Screen")
        elif ext == ".go":
            if "cobra" in texto:
                for m in RE_COBRA_USE.finditer(texto):
                    add("comando", m.group(1), rel, _linha(texto, m.start()), "cobra Use")
        elif ext == ".rs":
            if not rel.endswith("main.rs") and "/bin/" not in rel:
                for m in RE_RUST_PUB_FN.finditer(texto):
                    add("funcao", f"{_modulo_rs(rel)}::{m.group(1)}", rel, _linha(texto, m.start()), "pub fn")
            for m in RE_TAURI_CMD.finditer(texto):
                add("ipc", m.group(1), rel, _linha(texto, m.start()), "#[tauri::command]")
        elif ext == ".cs":
            for m in RE_HANGFIRE.finditer(texto):
                ident = m.group(2) or m.group(1)
                if ident:
                    add("job", ident, rel, _linha(texto, m.start()), "Hangfire RecurringJob")
        elif ext == ".dart":
            for m in RE_GOROUTE.finditer(texto):
                add("tela-mobile", m.group(1), rel, _linha(texto, m.start()), "GoRoute")
            for m in RE_FLUTTER_ROTA.finditer(texto):
                add("tela-mobile", m.group(1), rel, _linha(texto, m.start()), "MaterialApp routes")
        elif ext == ".rb":
            for m in RE_SIDEKIQ.finditer(texto):
                add("job", m.group(1), rel, _linha(texto, m.start()), "Sidekiq")
    if pacotes_com_expo:
        for rel in candidatos:
            partes = rel.split("/")
            if "app" not in partes or em_dir_pesado(rel):
                continue
            stem, ext = posixpath.splitext(partes[-1])
            if ext not in (".tsx", ".jsx", ".ts", ".js") or stem.startswith("_") or stem.startswith("+"):
                continue
            i = len(partes) - 1 - partes[::-1].index("app")
            segs = [s for s in partes[i + 1:-1] if not (s.startswith("(") and s.endswith(")"))]
            if stem != "index":
                segs.append(stem)
            add("tela-mobile", "/" + "/".join(segs), rel, 1, "Expo Router")
    return achados


RE_PYPROJECT_SECAO = re.compile(r"^\s*\[(project\.scripts|tool\.poetry\.scripts)\]\s*$")
RE_PYPROJECT_SCRIPT = re.compile(r"^\s*['\"]?([\w.-]+)['\"]?\s*=\s*['\"]([\w.]+)(?::[\w.]+)?['\"]")


def scripts_do_pyproject(indice, candidatos) -> dict:
    """{nome do comando instalado: ultimo componente do modulo} de [project.scripts] e [tool.poetry.scripts]."""
    saida = {}
    for rel in candidatos:
        if rel.rsplit("/", 1)[-1] != "pyproject.toml" or em_dir_pesado(rel):
            continue
        secao = False
        for linha in (indice.texto(rel) or "").splitlines():
            if re.match(r"^\s*\[", linha):
                secao = bool(RE_PYPROJECT_SECAO.match(linha))
                continue
            m = RE_PYPROJECT_SCRIPT.match(linha) if secao else None
            if m:
                saida[m.group(1)] = m.group(2).rsplit(".", 1)[-1]
    return saida


def comandos_documentados(indice, candidatos, outros) -> list:
    """Subcomando citado em bloco de codigo do README ou de docs/ ('<prog> <sub>') que nenhum parser declara: vira
    item comando:<prog> <sub> com descoberto_por docs. So para programas com subcomando detectado."""
    subs = defaultdict(set)
    for o in outros:
        if o.get("tipo") != "comando":
            continue
        partes = o["id"].split(":", 1)[1].split()
        if len(partes) >= 2:
            subs[partes[0]].add(partes[1])
        elif partes:
            subs.setdefault(partes[0], set())
    apelidos = {}
    for nome, modulo in scripts_do_pyproject(indice, candidatos).items():
        if modulo in subs and nome not in subs:
            apelidos[nome] = modulo
    progs = {p: p for p, s in subs.items() if s}
    progs.update({nome: alvo for nome, alvo in apelidos.items() if subs.get(alvo)})
    if not progs:
        return []
    docs = [a for a in candidatos if not em_dir_pesado(a) and (
        re.match(r"(?i)^readme(?:\.[\w-]+)?$", a.rsplit("/", 1)[-1])
        or (a.lower().endswith((".md", ".markdown")) and (a.startswith("docs/") or "/docs/" in a)))]
    vistos = {o["id"] for o in outros}
    achados = []
    regras = [(p, re.compile(r"(?<![\w./-])" + re.escape(p) + r"[ \t]+([a-z][\w:-]*)(?![\w.:/=-])")) for p in progs]
    for rel in sorted(docs):
        em_bloco = False
        for n, linha in enumerate((indice.texto(rel) or "").splitlines(), 1):
            if re.match(r"^\s*(```|~~~)", linha):
                em_bloco = not em_bloco
                continue
            if not em_bloco:
                continue
            for prog, rx in regras:
                for m in rx.finditer(linha):
                    sub = m.group(1)
                    ident = f"comando:{prog} {sub}"
                    if sub in subs.get(progs[prog], set()) or ident in vistos:
                        continue
                    vistos.add(ident)
                    achados.append({"tipo": "comando", "id": ident, "arquivo": rel, "linha": n,
                                    "origem": "documentado sem parser", "descoberto_por": ["docs"]})
    return achados


TIPOS_WEB_DETECTOR = ("front-web", "full-stack", "api")
MODOS_CONTAGEM_WEB = {"rota", "tela", "api", "endpoint"}


def falta_de_detector(r, dados_ledger) -> list:
    """Tipos declarados no ledger para os quais o detector nao achou nada e nao ha contagem: os nao web sem item do
    tipo, e front-web, full-stack e api com 0 tela e 0 endpoint detectados."""
    rodada = dados_ledger.get("rodada") if isinstance(dados_ledger.get("rodada"), dict) else {}
    tipos = rodada.get("tipos_projeto") if isinstance(rodada.get("tipos_projeto"), list) else []
    if not tipos and rodada.get("tipo_projeto"):
        tipos = [rodada.get("tipo_projeto")]
    contagens = [c for c in rodada.get("contagens") or [] if isinstance(c, dict)]
    achados = r.get("outros") or []
    faltas = []
    n_telas = len([t for t in r.get("telas") or [] if t.get("tipo") != "estado"]) + \
        sum(1 for a in achados if a.get("tipo") == "tela")
    n_endpoints = len(r.get("endpoints") or [])
    for t in tipos:
        t = str(t)
        if t in TIPOS_WEB_DETECTOR:
            if n_telas or n_endpoints:
                continue
            if any(str(c.get("modo") or "") in ({t} | MODOS_CONTAGEM_WEB) for c in contagens):
                continue
            faltas.append(f"detector nao achou rota nem endpoint em {t}: enumere a mao e registre cobertura.py rodada "
                          f"<rodada> --contagem \"api|<fonte>|N|N\" (ou rota|tela|endpoint)")
            continue
        if t not in TIPO_ITEM_DO_PROJETO and t not in TIPOS_SEM_DETECTOR:
            continue
        n = sum(1 for a in achados if a["tipo"] in TIPO_ITEM_DO_PROJETO.get(t, ()))
        if n:
            continue
        aceitos = {t} | MODOS_CONTAGEM.get(t, set())
        if any(str(c.get("modo") or "") in aceitos for c in contagens):
            continue
        faltas.append(f"detector nao cobre {t}: enumere a mao e registre a contagem (cobertura.py rodada <rodada> "
                      f"--contagem \"<{'|'.join(sorted(aceitos))}>|<fonte>|<N no codigo>|<N no ledger>\")")
    return faltas


# ------------------------------------------------------------------------- ledger e saidas

def slug(texto: str) -> str:
    return re.sub(r"[^a-z0-9]+", "-", texto.lower()).strip("-")


def itens_ledger(r):
    itens = {}

    def add(item):
        if item["id"] not in itens:
            itens[item["id"]] = item

    sem_raio = {s["arquivo"]: s["linguagem"] for s in r.get("sem_suporte", [])}
    tudo = bool(r.get("tudo"))
    origem_item = "tudo" if tudo else "diff"
    for a in r["alterados"]:
        simb = ", ".join(sorted({s["nome"] for s in a["simbolos"]}))[:400]
        add({"id": f"arquivo:{a['arquivo']}", "tipo": "arquivo",
             "titulo": f"Alterado no diff ({a['status']}, +{a['adicionadas']} -{a['removidas']})",
             "origem": a["arquivo"] + (f" (renomeado de {a['de']})" if a.get("de") else ""),
             "descoberto_por": ["diff"], "escopo": "dentro",
             "notas": "; ".join(filter(None, [f"marcas: {', '.join(a['marcas'])}" if a["marcas"] else "",
                                             f"simbolos: {simb}" if simb else "",
                                             f"usos diretos: {a['usos_diretos']}",
                                             (f"raio NAO calculado (linguagem sem suporte: {sem_raio[a['arquivo']]}); "
                                              "complete a mao") if a["arquivo"] in sem_raio else ""]))})
        for s in a["simbolos"]:
            if s["componente"]:
                add({"id": f"componente:{s['nome']}", "tipo": "componente",
                     "titulo": f"Componente {s['origem']} no diff", "pai": f"arquivo:{a['arquivo']}",
                     "origem": f"{a['arquivo']}:{s['linha']}", "descoberto_por": ["diff"], "escopo": "dentro",
                     "notas": f"{a['usos_diretos']} uso(s) direto(s); teste ao menos um uso real de cada configuracao"})
    for v in r["impacto"]:
        pai = None
        for m in v["motivos"]:
            if m.startswith("importa "):
                pai = m[len("importa "):]
                break
            mm = re.search(r"\(([^()]+)\)$", m)
            if mm:
                pai = mm.group(1)
                break
        por_nome = any(m.startswith("por nome (sem parser)") for m in v["motivos"])
        add({"id": f"arquivo:{v['arquivo']}", "tipo": "arquivo",
             "titulo": f"No raio de impacto (nivel {v['nivel']}{', por nome, sem parser' if por_nome else ''})"
                       + (" - teste automatizado" if v["teste"] else ""),
             "pai": f"arquivo:{pai}" if pai else None, "origem": v["arquivo"],
             "descoberto_por": ["raio-de-impacto"], "escopo": "dentro", "notas": "; ".join(v["motivos"])})
    for t in r["telas"]:
        if t["tipo"] == "estado" or (t["tipo"] == "declarada" and not tudo):
            continue
        if tudo:
            titulo = "Rota declarada no codigo (--tudo)" if t["tipo"] == "declarada" else f"Tela do projeto ({t['tipo']}, --tudo)"
            notas = t.get("nota", "")
        else:
            titulo = f"Tela afetada pelo diff ({t['tipo']})"
            via = " <- ".join(t["cadeia"][1:4]) if len(t["cadeia"]) > 1 else "o proprio arquivo mudou"
            notas = ("; ".join(filter(None, [t.get("nota", ""), f"monta via: {via}"])))[:500]
        add({"id": f"tela:{t['rota']}", "tipo": "tela", "titulo": titulo,
             "origem": t["arquivo"], "descoberto_por": [origem_item], "escopo": "dentro", "notas": notas})
    onde = "no projeto (--tudo)" if tudo else "no escopo do diff"
    for e in r["endpoints"]:
        add({"id": f"api:{e['metodo']} {e['rota']}", "tipo": "api",
             "titulo": f"Endpoint declarado {onde}" if e["origem"] == "declarado"
             else f"Endpoint chamado pelo front {onde}",
             "origem": f"{e['arquivo']}:{e['linha']}",
             "descoberto_por": [origem_item if e["origem"] == "declarado" else f"{origem_item}-chamada-front"],
             "escopo": "dentro",
             "notas": "confirme a rota real na aba de rede" if e["origem"] == "chamada-front" else ""})
    for o in r.get("outros") or []:
        doc = o.get("descoberto_por") == ["docs"]
        add({"id": o["id"], "tipo": o["id"].split(":", 1)[0],
             "titulo": "documentado sem parser" if doc else f"Detectado no projeto (--tudo): {o['origem']}",
             "origem": f"{o['arquivo']}:{o['linha']}", "descoberto_por": list(o.get("descoberto_por") or [origem_item]),
             "escopo": "dentro"})
    ids = set(itens)
    for it in itens.values():
        if it.get("pai") and it["pai"] not in ids:
            it["pai"] = None
        if not it.get("notas"):
            it.pop("notas", None)
        if it.get("pai") is None:
            it.pop("pai", None)
    return list(itens.values())


def ler_ledger(caminho_ledger: str):
    p = Path(caminho_ledger)
    if p.is_dir():
        p = p / "cobertura.json"
    if not p.exists():
        raise ErroUso(f"ledger nao encontrado: {p}")
    try:
        dados = json.loads(p.read_text(encoding="utf-8-sig"))
    except json.JSONDecodeError as e:
        raise ErroUso(f"JSON invalido em {p}: {e}")
    if not isinstance(dados, dict):
        raise ErroUso(f"a raiz de {p} precisa ser um objeto JSON")
    return p, dados


def escopo_do_ledger(dados) -> dict:
    rodada = dados.get("rodada") if isinstance(dados.get("rodada"), dict) else {}
    return rodada.get("escopo_diff") if isinstance(rodada.get("escopo_diff"), dict) else {}


def prefixo_do_ledger(dados) -> str | None:
    valor = escopo_do_ledger(dados).get("prefixo_api")
    return valor if isinstance(valor, str) else None


def arquivos_sujos(raiz_in: Path) -> list:
    """Alteracoes nao commitadas (staged, unstaged, nao rastreadas), fora de .qa/."""
    saida = git(raiz_in, "status", "--porcelain", "-z", "--untracked-files=all", binario=True, permitir_falha=True)
    if not saida:
        return []
    caminhos, partes, i = [], saida.decode("utf-8", "replace").split("\0"), 0
    while i < len(partes):
        e = partes[i]
        i += 1
        if len(e) < 4:
            continue
        estado, caminho = e[:2], e[3:]
        if "R" in estado or "C" in estado:
            i += 1
        if caminho.startswith(".qa/") or "/.qa/" in caminho:
            continue
        caminhos.append(caminho)
    return caminhos


def raiz_relativa(repositorio: str, args) -> str:
    """Raiz do repositorio relativa a pasta do ledger quando possivel (para o cobertura.py reaproveitar)."""
    ref = None
    if args.ledger:
        p = Path(args.ledger).expanduser()
        ref = p if p.is_dir() else p.parent
    elif args.parcial:
        pp = Path(args.parcial).expanduser().resolve().parent
        ref = pp.parent if pp.name == "parciais" else pp
    if ref is not None:
        try:
            return Path(os.path.relpath(repositorio, str(ref.resolve()))).as_posix()
        except ValueError:
            pass
    return Path(repositorio).as_posix()


def _segmentos_api(rota: str):
    segs = []
    for s in rota.split("?", 1)[0].strip("/").split("/"):
        if not s:
            continue
        segs.append("{}" if (s.startswith("{") and s.endswith("}")) or s.startswith(":") else s.lower())
    return segs


def _api_id(iid: str):
    resto = iid[len("api:"):].strip()
    metodo, _, rota = resto.partition(" ")
    return metodo.upper(), _segmentos_api(rota)


def casar_api_por_sufixo(iid: str, itens_l):
    metodo, segs = _api_id(iid)
    achados = []
    for k in itens_l:
        if not isinstance(k, str) or not k.startswith("api:") or k == iid:
            continue
        m2, s2 = _api_id(k)
        if metodo != m2 and "*" not in (metodo, m2):
            continue
        curto, longo = (segs, s2) if len(segs) <= len(s2) else (s2, segs)
        if curto and any(s != "{}" for s in curto) and longo[-len(curto):] == curto:
            achados.append(k)
    return achados


def _chave_tela(iid: str) -> str:
    return str(iid)[len("tela:"):].strip().lstrip("/")


def casar_tela_ledger(iid: str, itens_l) -> tuple:
    """(mesma tela so com a barra inicial diferente: tela:index.html == tela:/index.html, pagina .html em que um caminho
    e sufixo do outro em fronteira de '/': static/index.html x /index.html)."""
    k = _chave_tela(iid)
    mesma, sufixo = [], []
    for x in itens_l:
        if not isinstance(x, str) or not x.startswith("tela:") or x == iid:
            continue
        k2 = _chave_tela(x)
        if k2 == k:
            mesma.append(x)
        elif k and k2 and k.lower().endswith(EXT_HTML) and k2.lower().endswith(EXT_HTML) \
                and (k.endswith("/" + k2) or k2.endswith("/" + k)):
            sufixo.append(x)
    return mesma, sufixo


def origem_cita(caminho: str, origem) -> bool:
    """A origem do item cita o arquivo (src/a.ts nao casa com src/a.tsx)."""
    return bool(re.search(re.escape(caminho) + r"(?![\w.-])", str(origem or "")))


def falha_corrigida(casos: list, dados) -> list:
    """D-NNN de cada caso falhou, quando todos tem defeito retestado-ok ou retratado e regressao que passou."""
    defeitos = {d.get("id"): d for d in dados.get("defeitos", []) if isinstance(d, dict)}
    regressao_ok = {c.get("defeito_id") for c in dados.get("casos", []) if isinstance(c, dict)
                    and c.get("tecnica") == "regressao" and c.get("status") == "passou"}
    ids = []
    for c in casos:
        if c.get("status") != "falhou":
            continue
        did = c.get("defeito_id")
        d = defeitos.get(did) if did else None
        if not d:
            return []
        if (d.get("tipo") or "defeito") == "retratado":
            ids.append(did)
            continue
        if d.get("status") != "retestado-ok" or did not in regressao_ok:
            return []
        ids.append(did)
    return sorted(set(ids))


def cruzar_ledger(r, p: Path, dados, so_inventario: bool = False):
    itens_l = {i.get("id"): i for i in dados.get("itens", []) if isinstance(i, dict)}
    casos_por_item = defaultdict(list)
    for c in dados.get("casos", []):
        if isinstance(c, dict):
            casos_por_item[c.get("item_id")].append(c)
    declarados = defaultdict(set)
    for e in r.get("endpoints") or []:
        if e.get("origem") == "declarado":
            declarados[e.get("arquivo")].add(f"api:{e['metodo']} {e['rota']}")
    linhas, avisos = [], []
    for it in r["itens_ledger"]:
        iid = it["id"]
        do_diff = any("diff" in str(o) for o in it.get("descoberto_por") or [])
        relacionados = [iid] if iid in itens_l else []
        herdados = []
        if iid.startswith("arquivo:"):
            caminho = iid[len("arquivo:"):]
            for k, v in itens_l.items():
                if k == iid or not origem_cita(caminho, v.get("origem")):
                    continue
                if str(k).startswith("api:") and k not in declarados.get(caminho, set()):
                    herdados.append(k)
                else:
                    relacionados.append(k)
        elif iid.startswith("tela:") and not relacionados:
            mesma, por_sufixo_tela = casar_tela_ledger(iid, itens_l)
            relacionados += mesma + por_sufixo_tela
            if por_sufixo_tela:
                avisos.append(f"{iid} casado por sufixo de caminho com {', '.join(por_sufixo_tela)} do ledger (pagina "
                              "servida de subpasta): confira se e a mesma pagina")
        elif iid.startswith("api:") and not relacionados:
            por_sufixo = casar_api_por_sufixo(iid, itens_l)
            if por_sufixo:
                relacionados += por_sufixo
                avisos.append(f"{iid} casado por sufixo de caminho com {', '.join(por_sufixo)} do ledger: confira "
                              "se e o mesmo endpoint e passe o mesmo --prefixo-api usado no --parcial")
        casos = [c for k in relacionados for c in casos_por_item.get(k, [])]
        cont = defaultdict(int)
        for c in casos:
            cont[c.get("status") or "pendente"] += 1
        cont_herdados = defaultdict(int)
        for k in herdados:
            for c in casos_por_item.get(k, []):
                cont_herdados[c.get("status") or "pendente"] += 1
        descoberto = True
        if so_inventario and (relacionados or herdados):
            situacao, descoberto = "no ledger (--so-inventario: casos conferidos nas fases 8 e 9)", False
        elif not relacionados and herdados:
            situacao = "nao coberto (so casos herdados de api: derivados; o arquivo nao foi exercitado por item proprio)"
        elif not relacionados:
            situacao = "nao coberto (sem item no ledger)"
        elif not casos:
            situacao = ("nao coberto (item sem caso proprio; os de api: derivados so contam como herdados)"
                        if cont_herdados else "nao coberto (item sem caso)")
        elif cont.get("pendente"):
            situacao = "pendente"
        elif cont.get("falhou"):
            corrigidas = falha_corrigida(casos, dados)
            if corrigidas:
                situacao, descoberto = f"testado (falha corrigida: {', '.join(corrigidas)})", False
            else:
                situacao, descoberto = "com falha", False
        elif cont.get("passou"):
            situacao, descoberto = "testado", False
        elif do_diff:
            situacao = "sem prova: item do diff so com bloqueado/nao-validado/nao-aplicavel (conta como descoberto)"
        elif all(justificativa_concreta(c.get("justificativa")) for c in casos):
            situacao, descoberto = "sem prova (so bloqueado/nao-validado/nao-aplicavel, com motivo concreto)", False
        else:
            situacao = "sem prova: justificativa generica ou curta (conta como descoberto)"
        linhas.append({"item": iid, "itens_relacionados": relacionados, "casos": dict(cont), "situacao": situacao,
                       "descoberto": descoberto, "itens_herdados": herdados, "herdados": dict(cont_herdados)})
    return {"ledger": str(p), "linhas": linhas, "avisos": avisos,
            "descobertos": sum(1 for x in linhas if x["descoberto"]),
            "raio_incompleto": list(r.get("raio_incompleto") or [])}


def celula(texto) -> str:
    return str(texto).replace("|", "\\|").replace("\n", " ")


def gerar_md(r) -> str:
    alt = r["alterados"]
    por_status = defaultdict(int)
    for a in alt:
        por_status[a["status"]] += 1
    niveis = defaultdict(int)
    for v in r["impacto"]:
        niveis[v["nivel"]] += 1
    if r.get("tudo"):
        return gerar_md_tudo(r)
    sem_suporte = r.get("sem_suporte") or []
    linhas = [f"# Escopo do diff - {Path(r['repositorio']).name}", "",
              f"- Gerado em: {r['gerado_em']}",
              f"- Modo: {r['modo']}",
              f"- Base: {r['base'] or '-'} (merge-base {r['merge_base'] or '-'}) | cabeca: {r['cabeca']} ({r['commit_cabeca']})",
              f"- Comando: `{r['comando']}`", "", "## Resumo", "", "| | |", "|---|---|",
              f"| Arquivos alterados | {len(alt)} ({', '.join(f'{k} {v}' for k, v in sorted(por_status.items()))}) |",
              f"| Linhas | +{sum(a['adicionadas'] for a in alt)} -{sum(a['removidas'] for a in alt)} |",
              f"| Simbolos alterados | {sum(len(a['simbolos']) for a in alt)} |",
              f"| Arquivos no raio de impacto | {len(r['impacto'])} ("
              + (", ".join(f"nivel {k}: {v}" for k, v in sorted(niveis.items())) or "nenhum") + ") |",
              f"| Arquivos sem raio calculado (linguagem sem suporte) | {len(sem_suporte)} |",
              f"| Telas e rotas afetadas | {len([t for t in r['telas'] if t['tipo'] != 'estado'])} |",
              f"| Endpoints (declarados / chamados pelo front) | "
              f"{sum(1 for e in r['endpoints'] if e['origem'] == 'declarado')} / "
              f"{sum(1 for e in r['endpoints'] if e['origem'] == 'chamada-front')} |",
              f"| Testes automatizados no escopo | {len(r['testes_no_escopo'])} |",
              f"| Itens para o ledger | {len(r['itens_ledger'])} |",
              f"| Fora da conta (git status inicial / --excluir-arquivo) | "
              f"{len((r.get('excluidos') or {}).get('status_inicial') or [])} |", ""]
    if r["avisos"]:
        linhas += ["## Avisos", ""] + [f"- {celula(a)}" for a in r["avisos"]] + [""]
    excl_ini = (r.get("excluidos") or {}).get("status_inicial") or []
    if excl_ini:
        linhas += ["## Fora da conta: ja alterados no inicio (outra sessao)", "",
                   "Estes arquivos estavam no git status inicial da rodada (ou vieram em --excluir-arquivo): nao contam "
                   "como alterados nem como itens do diff e ficam fora da entrega (se usarem o que mudou, podem aparecer "
                   "no raio). Para testar justamente essas alteracoes, rode com --manter-status-inicial.", ""]
        linhas += [f"- `{celula(a)}`" for a in excl_ini[:40]]
        if len(excl_ini) > 40:
            linhas.append(f"- ... e mais {len(excl_ini) - 40}")
        if (r.get("excluidos") or {}).get("todo_o_diff"):
            linhas.append("")
            linhas.append("**Todo o diff saiu da conta:** nada foi conferido (com --falhar-se-descoberto, sai 1).")
        linhas.append("")
    if sem_suporte:
        linhas += [f"## Linguagem sem suporte: raio NAO calculado para "
                   f"{', '.join(celula(s['arquivo']) for s in sem_suporte[:10])}"
                   + (f" e mais {len(sem_suporte) - 10}" if len(sem_suporte) > 10 else ""), "",
                   "O script nao segue import nem simbolo nestas linguagens. O plano B procurou, por palavra inteira, "
                   "os identificadores das linhas +/- dos hunks, as definicoes que envolvem cada hunk, o nome e o "
                   "nome do arquivo em todos os arquivos de texto do repositorio: o que achou esta no raio como "
                   "'por nome (sem parser)', so no nivel 1. Nome achado em mais de "
                   f"{MAX_ARQUIVOS_POR_NOME} arquivos foi descartado por ser comum demais. Complete o raio a mao "
                   "(quem usa o que mudou, ate a tela) antes de fechar o plano; o gate do modo PR sai 1 ate isso ser "
                   "aceito com --aceitar-raio-incompleto.", "",
                   "| Arquivo | Linguagem | Nomes buscados | Achados por nome | Descartados (comuns demais) |",
                   "|---|---|---|---|---|"]
        for s in sem_suporte:
            nomes = ", ".join(s["literais"] + s["nomes"][:15]) + (" ..." if len(s["nomes"]) > 15 else "")
            linhas.append(f"| `{celula(s['arquivo'])}` | {celula(s['linguagem'])} | {celula(nomes)} | "
                          f"{len(s['achados'])} | {celula(', '.join(s['comuns_demais'][:8])) or '-'} |")
        linhas.append("")
    linhas += ["## 1. Arquivos alterados", "",
               "| Arquivo | Status | +/- | Marcas | Simbolos alterados | Usos diretos |", "|---|---|---|---|---|---|"]
    for a in alt:
        simb = ", ".join(f"{s['dono'] + '.' if s.get('dono') else ''}{s['nome']}"
                         + (" (removido)" if s["origem"] == "removido" else "") for s in a["simbolos"][:12])
        if len(a["simbolos"]) > 12:
            simb += f" ... (+{len(a['simbolos']) - 12})"
        nome = a["arquivo"] + (f" (de {a['de']})" if a.get("de") else "") + (" [novo, nao rastreado]" if a["novo_nao_rastreado"] else "")
        linhas.append(f"| `{celula(nome)}` | {a['status']} | +{a['adicionadas']} -{a['removidas']}"
                      f"{' (binario)' if a['binario'] else ''} | {', '.join(a['marcas']) or '-'} | {celula(simb) or '-'} "
                      f"| {a['usos_diretos']} |")
    linhas += ["", "## 2. Raio de impacto", ""]
    if not r["impacto"] and sem_suporte:
        linhas += [f"Nenhum arquivo encontrado, mas o raio NAO foi calculado para {len(sem_suporte)} arquivo(s) de "
                   "linguagem sem suporte (secao acima): isto nao prova que ninguem usa o que mudou.", ""]
    elif not r["impacto"]:
        linhas += ["Nenhum arquivo encontrado que importe ou referencie o que mudou.", ""]
    for nv in sorted(niveis):
        linhas += [f"### Nivel {nv}", "", "| Arquivo | Por que entrou |", "|---|---|"]
        for v in r["impacto"]:
            if v["nivel"] == nv:
                marca = " (teste)" if v["teste"] else ""
                linhas.append(f"| `{celula(v['arquivo'])}`{marca} | {celula('; '.join(v['motivos']))} |")
        linhas.append("")
    linhas += ["## 3. Telas e rotas afetadas", ""]
    telas = [t for t in r["telas"] if t["tipo"] != "estado"]
    if telas:
        linhas += ["| Rota | Tipo | Arquivo | Monta o que mudou via |", "|---|---|---|---|"]
        for t in telas:
            via = " <- ".join(t["cadeia"][1:4]) if len(t["cadeia"]) > 1 else "o proprio arquivo mudou"
            linhas.append(f"| `{celula(t['rota'])}` | {t['tipo']}{(' - ' + t['nota']) if t.get('nota') else ''} | "
                          f"`{celula(t['arquivo'])}` | {celula(via)} |")
    else:
        linhas.append("Nenhuma rota reconhecida no escopo (o projeto pode montar rotas de outro jeito: procure a tela "
                      "que usa os arquivos do nivel mais alto do raio).")
    linhas += ["", "## 4. Endpoints no escopo", ""]
    if r["endpoints"]:
        linhas += ["| Metodo | Rota | Origem | Arquivo |", "|---|---|---|---|"]
        for e in r["endpoints"]:
            linhas.append(f"| {e['metodo']} | `{celula(e['rota'])}` | {e['origem']} | `{celula(e['arquivo'])}:{e['linha']}` |")
    else:
        linhas.append("Nenhum endpoint declarado nem chamada HTTP literal nos arquivos do escopo.")
    linhas += ["", "## 5. Testes automatizados no escopo (rode-os)", ""]
    linhas += [f"- `{t}`" for t in r["testes_no_escopo"]] or ["Nenhum teste automatizado toca o escopo."]
    linhas += ["", "## 6. Itens para o ledger", "",
               f"{len(r['itens_ledger'])} itens no formato `<tipo>:<caminho>`. Com `--parcial ARQ`, viram um ledger "
               "parcial para `cobertura.py merge <rodada> ARQ`. Cada item precisa de caso: o arquivo alterado prova a "
               "mudanca; o do raio prova que a vizinhanca nao regrediu (tecnica `regressao`).", ""]
    linhas += [f"- `{celula(i['id'])}` - {celula(i['titulo'])}" for i in r["itens_ledger"][:200]]
    if len(r["itens_ledger"]) > 200:
        linhas.append(f"- ... e mais {len(r['itens_ledger']) - 200} (lista completa no JSON)")
    linhas += secao_cobertura(r, "7. Mudou x testado")
    linhas += ["", "---", "", "Heuristico: injecao de dependencia por configuracao, reflexao, rotas por string, chaves de "
               "i18n e eventos por nome nao aparecem aqui. Leia o diff e complete o raio a mao antes de fechar o plano."]
    return "\n".join(linhas) + "\n"


def secao_cobertura(r, titulo: str):
    cob = r.get("cobertura")
    if not cob:
        return []
    linhas = ["", f"## {titulo}", "", f"Ledger: `{cob['ledger']}` - {cob['descobertos']} item(ns) descobertos: sem item, "
              "sem caso, com caso pendente, ou sem prova onde ela e exigida (item do diff so com bloqueado/"
              "nao-validado/nao-aplicavel; demais itens com justificativa generica ou de ate 20 caracteres)."]
    if cob.get("raio_incompleto"):
        aceito = " Aceito com --aceitar-raio-incompleto." if r.get("raio_incompleto_aceito") else (
            " O gate sai 1 enquanto isso nao for completado a mao e aceito com --aceitar-raio-incompleto.")
        linhas.append(f"Raio NAO calculado (linguagem sem suporte ou servidor sem rota reconhecida) para: "
                      f"{', '.join(celula(a) for a in cob['raio_incompleto'])}.{aceito}")
    for falta in cob.get("sem_detector") or []:
        linhas.append(f"- {celula(falta)}")
    linhas += ["", "Casos herdados: os dos itens `api:` que saem do arquivo (chamada do front). Eles nao contam como "
               "teste do arquivo: um front so exercitado por chamada direta a API continua descoberto.",
               "", "| Item do escopo | Casos | Herdados | Situacao |", "|---|---|---|---|"]
    for x in cob["linhas"]:
        casos = ", ".join(f"{k} {v}" for k, v in sorted(x["casos"].items())) or "-"
        herd = x.get("herdados") or {}
        herdados = (", ".join(f"{k} {v}" for k, v in sorted(herd.items())) + " (" + ", ".join(
            f"`{celula(i)}`" for i in (x.get("itens_herdados") or [])[:3]) + ")") if herd else "-"
        linhas.append(f"| `{celula(x['item'])}` | {casos} | {herdados} | {x['situacao']} |")
    return linhas


def gerar_md_tudo(r) -> str:
    telas = [t for t in r["telas"] if t["tipo"] != "estado"]
    linhas = [f"# Superficie detectada (--tudo) - {Path(r['repositorio']).name}", "",
              f"- Gerado em: {r['gerado_em']}",
              f"- Modo: {r['modo']}",
              f"- Commit: {r['commit_cabeca'] or '-'}",
              f"- Comando: `{r['comando']}`", "", "## Resumo", "", "| | |", "|---|---|",
              f"| Arquivos lidos | {r.get('arquivos_lidos', 0)} |",
              f"| Telas e rotas detectadas | {len(telas)} |",
              f"| Endpoints (declarados / chamados pelo front) | "
              f"{sum(1 for e in r['endpoints'] if e['origem'] == 'declarado')} / "
              f"{sum(1 for e in r['endpoints'] if e['origem'] == 'chamada-front')} |",
              f"| Outras superficies (comando, funcao, job, ipc, tela mobile) | {len(r.get('outros') or [])} |",
              f"| Testes automatizados no projeto | {len(r['testes_no_escopo'])} |",
              f"| Itens para o ledger | {len(r['itens_ledger'])} |", ""]
    if r["avisos"]:
        linhas += ["## Avisos", ""] + [f"- {celula(a)}" for a in r["avisos"]] + [""]
    linhas += ["## 1. Telas e rotas", ""]
    if telas:
        linhas += ["| Rota | Tipo | Arquivo |", "|---|---|---|"]
        for t in telas:
            linhas.append(f"| `{celula(t['rota'])}` | {t['tipo']}{(' - ' + t['nota']) if t.get('nota') else ''} | "
                          f"`{celula(t['arquivo'])}` |")
    else:
        linhas.append("Nenhuma rota reconhecida (o projeto pode montar rotas de outro jeito: enumere pelo menu e pelo "
                      "roteador, a mao).")
    linhas += ["", "## 2. Endpoints", ""]
    if r["endpoints"]:
        linhas += ["| Metodo | Rota | Origem | Arquivo |", "|---|---|---|---|"]
        for e in r["endpoints"]:
            linhas.append(f"| {e['metodo']} | `{celula(e['rota'])}` | {e['origem']} | `{celula(e['arquivo'])}:{e['linha']}` |")
    else:
        linhas.append("Nenhum endpoint declarado nem chamada HTTP literal reconhecidos.")
    outros = r.get("outros") or []
    linhas += ["", "## 2b. Outras superficies (CLI, biblioteca, jobs, IPC, mobile)", ""]
    if outros:
        linhas += ["| Item | Origem | Arquivo |", "|---|---|---|"]
        for o in outros:
            linhas.append(f"| `{celula(o['id'])}` | {celula(o['origem'])} | `{celula(o['arquivo'])}:{o['linha']}` |")
    else:
        linhas.append("Nenhum subcomando, export publico, job, canal de IPC ou tela mobile reconhecido. Projeto desses "
                      "tipos: enumere a mao e registre a contagem (cobertura.py rodada --contagem).")
    linhas += ["", "## 3. Itens para o ledger", "",
               f"{len(r['itens_ledger'])} itens. Com `--parcial ARQ`, viram um ledger parcial para "
               "`cobertura.py merge`; com `--ledger`, o quadro abaixo mostra o que o ledger ainda nao tem.", ""]
    linhas += [f"- `{celula(i['id'])}` - {celula(i['titulo'])}" for i in r["itens_ledger"][:300]]
    if len(r["itens_ledger"]) > 300:
        linhas.append(f"- ... e mais {len(r['itens_ledger']) - 300} (lista completa no JSON)")
    linhas += secao_cobertura(r, "4. Detectado x ledger")
    linhas += ["", "---", "", "Heuristico: rota montada por string, roteador configurado em runtime, endpoint registrado "
               "por reflexao ou por convencao do framework nao aparecem aqui. A contagem do script e o minimo: confira "
               "com o menu, o roteador e a aba de rede."]
    return "\n".join(linhas) + "\n"


def gravar(caminho: str, texto: str) -> None:
    p = Path(caminho)
    p.parent.mkdir(parents=True, exist_ok=True)
    with open(p, "w", encoding="utf-8", newline="\n") as f:
        f.write(texto)


def montar_parser():
    p = ParserPT(
        prog="escopo_diff.py",
        description=(
            "Escopo de teste de uma branch/PR ou do working tree: arquivos e simbolos alterados, quem\n"
            "importa ou usa cada um (raio de impacto), telas que montam esses arquivos, endpoints\n"
            "declarados ou chamados, testes automatizados no escopo. Saida em Markdown e JSON, e um\n"
            "ledger parcial (itens \"<tipo>:<caminho>\") para o cobertura.py merge."),
        epilog=(
            "exemplos:\n"
            "  python escopo_diff.py                                working tree x HEAD (o que nao foi commitado)\n"
            "  python escopo_diff.py --base origin/develop          o que a branch atual traz em relacao a develop\n"
            "  python escopo_diff.py --base develop --incluir-working   commits da branch + o que nao foi commitado\n"
            "  python escopo_diff.py --base develop --md .qa/R/notas/escopo-diff.md --json .qa/R/rede/escopo.json \\\n"
            "                        --parcial .qa/R/parciais/escopo-diff.json\n"
            "  python escopo_diff.py --base develop --incluir-working --prefixo-api api/v1 --ledger .qa/R \\\n"
            "                        --falhar-se-descoberto\n"
            "                        mudou x testado (gate do modo PR; o --prefixo-api e o mesmo do --parcial; o\n"
            "                        --incluir-working traz a correcao do QA ainda nao commitada)\n"
            "  python escopo_diff.py --tudo --so-inventario --prefixo-api api/v1 --ledger .qa/R --falhar-se-descoberto\n"
            "                        fase 3: toda superficie detectada tem item no ledger (casos ainda nao contam)\n"
            "  python escopo_diff.py --tudo --prefixo-api api/v1 --ledger .qa/R --falhar-se-descoberto\n"
            "                        fases 8 e 9: superficie detectada x ledger, com caso concluido\n"
            "\n"
            "--prefixo-api api/v1: api.get('cliente') vira api:GET /api/v1/cliente; api.get('api/v1/cliente') e\n"
            "api.get('/api/v1/cliente') tambem viram api:GET /api/v1/cliente (o prefixo que ja esta no caminho nao\n"
            "e somado de novo). Rotas declaradas (controller, router) nunca recebem o --prefixo-api.\n"
            "--tudo tambem detecta, por tipo de projeto: subcomandos de argparse, click, typer, commander, yargs e\n"
            "cobra e o 'bin' do package.json (comando:); exports publicos ('exports'/'main' do package.json,\n"
            "__all__, pub fn) (funcao:); Celery task e beat_schedule, Hangfire, @Cron, node-cron, BullMQ e\n"
            "Sidekiq (job:); ipcMain.handle, exposeInMainWorld e #[tauri::command] (ipc:); <X.Screen name>,\n"
            "Expo Router e GoRoute (tela:); pagina .html servida (documento inteiro; fora templates/, parciais,\n"
            "e-mail, *.component.html, relatorio gerado e teste) vira tela:/<caminho do .html>. Com --ledger e\n"
            "--falhar-se-descoberto, tipo de projeto nao web declarado no ledger (cli, biblioteca, jobs,\n"
            "desktop, mobile, llm, jogo) sem nenhum item detectado e sem rodada.contagens desse tipo sai 1:\n"
            "'detector nao cobre <tipo>: enumere a mao e registre a contagem' (cobertura.py rodada --contagem);\n"
            "front-web, full-stack ou api com 0 tela e 0 endpoint detectados e sem contagem do tipo (ou rota, tela,\n"
            "api, endpoint) sai 1: 'detector nao achou rota nem endpoint em <tipo>'.\n"
            "Endpoints tambem: Python http.server (dentro de do_GET/do_POST/...: path == '/x', path.startswith('/x/'),\n"
            "path in ('/a', '/b'), re.match(r'^/x/(\\d+)$', path)); chamadas do JS inline de .html (<script> sem src\n"
            "e atributos on*=\"...\") e por wrapper de um nivel (api(\"PUT\", \"/api/itens/\" + id)).\n"
            "\n"
            "o que conta como descoberto no --ledger: item sem item no ledger, sem caso ou com caso pendente;\n"
            "item do diff (arquivo alterado e tela/api derivadas do diff) so com nao-aplicavel/bloqueado/\n"
            "nao-validado; item do raio ou do --tudo so com esses status e alguma justificativa generica\n"
            "(ate 20 caracteres, 'sem tempo', 'limite de tentativas', 'nao devolveu resultado'...).\n"
            "--parcial grava o --prefixo-api, a base e a raiz do repositorio (relativa a pasta da rodada) em\n"
            "rodada.escopo_diff; com --ledger e sem --prefixo-api, o script le o prefixo do ledger. Com --ledger,\n"
            "sem --base e sem --tudo, usa a base gravada (modo diff) somando o working tree, com aviso; sem base\n"
            "gravada sai 2 ('modo PR sem --base'). Com --base explicito, --ledger e --falhar-se-descoberto, sem\n"
            "--incluir-working e com alteracao nao commitada fora de .qa/, avisa que a correcao do QA fica fora.\n"
            "Item api: sem par exato no ledger casa por sufixo de caminho (/cliente == /api/v1/cliente), com aviso.\n"
            "Modo diff com --ledger (ou com --parcial em <rodada>/parciais/): o que esta em\n"
            "notas/00-git-status-inicial.txt da rodada (linhas 'XY caminho' do\n"
            "git status --short; rename, os dois) sai do diff sozinho, como --excluir-arquivo, e os globs de\n"
            "rodada.escopo_diff.excluir (gravados pelo --parcial a partir do --excluir) entram como --excluir: o\n"
            "gate do modo PR faz o mesmo. --manter-status-inicial desliga a primeira parte. Se todo o diff sair da\n"
            "conta assim, --falhar-se-descoberto sai 1 (nada foi conferido).\n"
            "No quadro, os casos dos itens api: que saem de um arquivo (chamada do front) aparecem na coluna\n"
            "Herdados e nao cobrem o arquivo; falha cujo defeito foi retestado-ok (ou retratado), com caso de\n"
            "regressao que passou, aparece como 'testado (falha corrigida: D-NNN)'.\n"
            "servidor Node sem framework: req.method === 'X' com pathname/url === '/...' ou pathname.match(/^...$/)\n"
            "vira api:X /rota ((\\d+) vira {id}); arquivo com createServer/listen tratando req.method ou req.url e\n"
            "nenhuma rota reconhecida avisa 'servidor sem rota reconhecida' e entra no raio incompleto; o mesmo vale\n"
            "para .py com http.server/BaseHTTPRequestHandler (do_<METODO> ou classe do handler) sem rota\n"
            "reconhecida. Modo diff: .html que carrega por <script src> um .js do raio (ou que mudou) vira\n"
            "tela:/<caminho do .html>. No --ledger, tela:index.html e tela:/index.html sao a mesma tela, e pagina\n"
            ".html em que um caminho e sufixo do outro em fronteira de '/' (static/index.html x /index.html) casa,\n"
            "com aviso.\n"
            "--tudo: subcomando citado em bloco de codigo do README ou de docs/ ('<prog> <sub>', prog do parser,\n"
            "do 'bin' ou de [project.scripts]) sem parser que o declare vira comando:<prog> <sub>, descoberto_por\n"
            "docs, titulo 'documentado sem parser' (so para programas com subcomando detectado).\n"
            "linguagem sem suporte (Dart, Swift, Rust, Ruby, PHP, C/C++, templates...): raio NAO calculado;\n"
            "plano B por nome (sem parser), so nivel 1; o gate sai 1 ate --aceitar-raio-incompleto.\n"
            "monorepo: pacotes do workspace (package.json workspaces, pnpm-workspace.yaml, lerna.json)\n"
            "resolvem '@escopo/pacote' e '@escopo/pacote/sub' para o arquivo de entrada do pacote.\n"
            "\n"
            "codigos de saida: 0 ok | 1 vazio com --falhar-se-vazio; com --falhar-se-descoberto, item\n"
            "descoberto ou arquivo sem raio calculado sem --aceitar-raio-incompleto | 2 uso ou estado\n"
            "invalido (fora de repositorio, base inexistente, ledger ilegivel)"))
    p.add_argument("--raiz", default=".", help="pasta dentro do repositorio (padrao: a atual)")
    p.add_argument("--base", help="branch/commit base da PR (ex. develop, origin/main); usa o merge-base")
    p.add_argument("--cabeca", default="HEAD", help="ponta a comparar com a base (padrao: HEAD)")
    p.add_argument("--incluir-working", action="store_true",
                   help="com --base: soma as alteracoes nao commitadas (staged, unstaged e arquivos novos)")
    p.add_argument("--profundidade", type=int, default=4, help="niveis de importadores a seguir (padrao 4)")
    p.add_argument("--max-arquivos", type=int, default=1500, help="teto de arquivos no raio (padrao 1500)")
    p.add_argument("--sem-simbolos", action="store_true", help="nao procura referencias por nome de simbolo (so imports)")
    p.add_argument("--tudo", action="store_true",
                   help="sem diff: lista todas as telas e endpoints detectados no projeto (nao combina com --base, "
                        "--cabeca nem --incluir-working)")
    p.add_argument("--prefixo-api", default=None, metavar="PREFIXO",
                   help="prefixo das chamadas relativas do front, para casar com os ids do ledger; escreva sem a "
                        "barra inicial (ex. api/v1): no Git Bash, /api/v1 vira um caminho do Windows. Ausente com "
                        "--ledger: usa o rodada.escopo_diff.prefixo_api gravado pelo --parcial")
    p.add_argument("--excluir", action="append", default=[], metavar="GLOB",
                   help="glob de caminho a ignorar (repetivel); o --parcial grava a lista em rodada.escopo_diff.excluir "
                        "e o gate do modo PR a repete")
    p.add_argument("--excluir-arquivo", dest="excluir_arquivo", action="append", default=[], metavar="CAMINHO",
                   help="modo diff: tira do diff este caminho exato, relativo a raiz (sem glob: '[id]' e literal; "
                        "terminado em / = a pasta inteira); repetivel. Com --ledger (ou --parcial em "
                        "<rodada>/parciais/), os caminhos de notas/00-git-status-inicial.txt da rodada entram sozinhos "
                        "(o que ja estava alterado e de outra sessao)")
    p.add_argument("--manter-status-inicial", dest="manter_status_inicial", action="store_true",
                   help="modo diff: NAO tira do diff o que esta em notas/00-git-status-inicial.txt (o "
                        "pedido e testar justamente essas alteracoes); o --parcial grava "
                        "rodada.escopo_diff.manter_status_inicial e o gate respeita")
    p.add_argument("--md", metavar="ARQ", help="grava o relatorio Markdown")
    p.add_argument("--json", metavar="ARQ", help="grava o resultado completo em JSON")
    p.add_argument("--parcial", metavar="ARQ", help="grava um ledger parcial (so itens) para cobertura.py merge")
    p.add_argument("--ledger", metavar="ARQ", help="cobertura.json (ou a pasta da rodada) para o quadro mudou x testado")
    p.add_argument("--formato", choices=["md", "json", "nenhum"], default="md",
                   help="o que imprimir no stdout (padrao: md)")
    p.add_argument("--falhar-se-vazio", action="store_true",
                   help="sai 1 se nada mudou (com --tudo: se nenhuma tela nem endpoint foi detectado)")
    p.add_argument("--falhar-se-descoberto", action="store_true",
                   help="com --ledger: sai 1 se algum item do escopo esta descoberto (ver acima) ou se ha arquivo "
                        "de linguagem sem suporte (raio nao calculado) sem --aceitar-raio-incompleto")
    p.add_argument("--so-inventario", action="store_true",
                   help="com --ledger: so 'sem item no ledger' conta como descoberto (item sem caso ou pendente nao "
                        "conta): o criterio da fase 3, quando os casos ainda nao existem. Nas fases 8 e 9 rode sem")
    p.add_argument("--aceitar-raio-incompleto", action="store_true",
                   help="com --falhar-se-descoberto: aceita arquivo sem raio calculado, depois de completar o raio a "
                        "mao (registre na nota o que foi acrescentado)")
    return p


def main(argv=None) -> int:
    configurar_saida()
    args = montar_parser().parse_args(argv)
    if args.profundidade < 1 or args.max_arquivos < 1:
        print("erro: --profundidade e --max-arquivos precisam ser >= 1", file=sys.stderr)
        return EXIT_USO
    if args.incluir_working and not args.base:
        print("erro: --incluir-working so faz sentido com --base (sem --base o working tree ja e o padrao)",
              file=sys.stderr)
        return EXIT_USO
    if args.falhar_se_descoberto and not args.ledger:
        print("erro: --falhar-se-descoberto exige --ledger", file=sys.stderr)
        return EXIT_USO
    if args.so_inventario and not args.ledger:
        print("erro: --so-inventario exige --ledger", file=sys.stderr)
        return EXIT_USO
    if args.aceitar_raio_incompleto and not args.falhar_se_descoberto:
        print("erro: --aceitar-raio-incompleto so faz sentido com --falhar-se-descoberto", file=sys.stderr)
        return EXIT_USO
    if args.tudo and (args.base or args.incluir_working or args.cabeca != "HEAD"):
        print("erro: --tudo nao combina com --base, --cabeca nem --incluir-working (ele nao usa diff)",
              file=sys.stderr)
        return EXIT_USO
    try:
        ledger = ler_ledger(args.ledger) if args.ledger else None
        if ledger:
            rz = escopo_do_ledger(ledger[1]).get("raiz")
            if isinstance(rz, str) and rz.strip() and not Path(rz.strip()).is_absolute():
                alvo = (ledger[0].resolve().parent / rz.strip()).resolve()
                if args.raiz in (".", rz.strip()) and alvo.is_dir():
                    args.raiz = str(alvo)
        base_explicita = bool(args.base)
        if ledger and not args.tudo and not args.base:
            ed = escopo_do_ledger(ledger[1])
            if ed.get("modo") == "diff" and isinstance(ed.get("base"), str) and ed["base"].strip():
                args.base = ed["base"].strip()
                args.incluir_working = True
                print(f"aviso: usando --base {args.base} gravado no ledger, com o working tree", file=sys.stderr)
            else:
                raise ErroUso("modo PR sem --base: passe --base <destino> ou gere o parcial com --base (so o "
                              "working tree: --base HEAD --incluir-working); o fechamento sem --base comparava o "
                              "working tree com o HEAD e deixava os commits da branch de fora")
        pasta_rodada = None
        if ledger:
            pasta_rodada = ledger[0].resolve().parent
        elif args.parcial:
            pp = Path(args.parcial).expanduser().resolve().parent
            candidata = pp.parent if pp.name == "parciais" else pp
            if (candidata / "notas" / "00-git-status-inicial.txt").is_file():
                pasta_rodada = candidata
        if pasta_rodada is not None and not args.tudo:
            ed_l = escopo_do_ledger(ledger[1]) if ledger else {}
            manter = args.manter_status_inicial or ed_l.get("manter_status_inicial") is True
            args.manter_status_inicial = manter
            if manter:
                if args.excluir_arquivo:
                    print("aviso: --manter-status-inicial: os --excluir-arquivo passados continuam valendo",
                          file=sys.stderr)
            else:
                iniciais = caminhos_status_inicial(pasta_rodada)
                novos = [c for c in iniciais if c not in args.excluir_arquivo]
                args.excluir_arquivo = list(args.excluir_arquivo) + novos
                if novos:
                    print(f"aviso: {len(novos)} caminho(s) de notas/00-git-status-inicial.txt fora do diff (ja estavam "
                          f"alterados: outra sessao); para testar justamente essas alteracoes, --manter-status-inicial",
                          file=sys.stderr)
            globs_l = [str(g).strip() for g in (ed_l.get("excluir") if isinstance(ed_l.get("excluir"), list) else [])
                       if str(g or "").strip()]
            globs_novos = [g for g in globs_l if g not in args.excluir]
            if globs_novos:
                args.excluir = list(args.excluir) + globs_novos
                print(f"aviso: usando --excluir {', '.join(globs_novos)} gravado no ledger (rodada.escopo_diff.excluir)",
                      file=sys.stderr)
        if base_explicita and ledger and args.falhar_se_descoberto and not args.incluir_working:
            sujos = arquivos_sujos(Path(args.raiz).expanduser())
            if sujos:
                print(f"aviso: ha alteracao nao commitada fora do diff ({len(sujos)} arquivo(s), ex.: "
                      f"{', '.join(sujos[:3])}): rode com --incluir-working para incluir a correcao do QA",
                      file=sys.stderr)
        if args.prefixo_api is None and ledger:
            gravado = prefixo_do_ledger(ledger[1])
            if gravado is not None:
                args.prefixo_api = gravado
                if gravado.strip():
                    print(f"aviso: usando --prefixo-api {gravado} gravado no ledger (rodada.escopo_diff.prefixo_api)",
                          file=sys.stderr)
        if args.prefixo_api is None:
            args.prefixo_api = ""
        args.prefixo_api = args.prefixo_api.strip()
        r = analisar_tudo(args) if args.tudo else analisar(args)
        r["prefixo_api"] = args.prefixo_api
        r["raio_incompleto_aceito"] = bool(args.aceitar_raio_incompleto and r.get("raio_incompleto"))
        r["itens_ledger"] = itens_ledger(r)
        if ledger:
            r["cobertura"] = cruzar_ledger(r, *ledger, so_inventario=args.so_inventario)
            if r.get("tudo"):
                r["cobertura"]["sem_detector"] = falta_de_detector(r, ledger[1])
            for a in r["cobertura"]["avisos"]:
                print(f"aviso: {a}", file=sys.stderr)
                r["avisos"].append(a)
    except ErroUso as e:
        print(f"erro: {e}", file=sys.stderr)
        return EXIT_USO
    md = gerar_md(r)
    js = json.dumps(r, ensure_ascii=False, indent=2) + "\n"
    if args.md:
        gravar(args.md, md)
    if args.json:
        gravar(args.json, js)
    if args.parcial:
        escopo = {"prefixo_api": args.prefixo_api, "modo": "tudo" if r.get("tudo") else "diff", "base": r["base"],
                  "commit_cabeca": r["commit_cabeca"], "gerado_em": r["gerado_em"],
                  "raiz": raiz_relativa(r["repositorio"], args),
                  "raio_incompleto": r.get("raio_incompleto") or [],
                  "excluir": list(dict.fromkeys(str(g) for g in args.excluir if str(g or "").strip()))}
        if not r.get("tudo"):
            escopo["manter_status_inicial"] = bool(args.manter_status_inicial)
        parcial = {"versao": 1, "rodada": {"escopo_diff": escopo}, "itens": r["itens_ledger"], "casos": [],
                   "defeitos": [], "sujeira": []}
        gravar(args.parcial, json.dumps(parcial, ensure_ascii=False, indent=2) + "\n")
    if args.formato == "md":
        sys.stdout.write(md)
    elif args.formato == "json":
        sys.stdout.write(js)
    gravados = [x for x in (args.md, args.json, args.parcial) if x]
    if gravados:
        print("gravado: " + ", ".join(gravados), file=sys.stderr)
    vazio = not (r["telas"] or r["endpoints"] or r.get("outros")) if r.get("tudo") else not r["alterados"]
    if args.falhar_se_vazio and vazio:
        return EXIT_PENDENCIA
    if args.falhar_se_descoberto:
        cob = r.get("cobertura", {})
        reprovou = False
        if cob.get("raio_incompleto") and not args.aceitar_raio_incompleto:
            print("raio NAO calculado (linguagem sem suporte ou servidor sem rota reconhecida) para: "
                  + ", ".join(cob["raio_incompleto"])
                  + ". Complete o raio a mao e rode de novo com --aceitar-raio-incompleto", file=sys.stderr)
            reprovou = True
        if cob.get("descobertos"):
            print(f"{cob['descobertos']} item(ns) do escopo descobertos (quadro no Markdown)", file=sys.stderr)
            reprovou = True
        for falta in cob.get("sem_detector") or []:
            print(falta, file=sys.stderr)
            reprovou = True
        excl = r.get("excluidos") or {}
        if excl.get("todo_o_diff"):
            print(f"todo o diff ({len(excl.get('status_inicial') or [])} arquivo(s)) ja estava alterado no git status "
                  "inicial e saiu da conta: nada foi conferido. Se o pedido e testar essas alteracoes, rode com "
                  "--manter-status-inicial (e grave o parcial com ele); senao, confira a --base", file=sys.stderr)
            reprovou = True
        if reprovou:
            return EXIT_PENDENCIA
    return EXIT_OK


if __name__ == "__main__":
    sys.exit(main())

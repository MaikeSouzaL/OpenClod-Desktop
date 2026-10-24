#!/usr/bin/env python3
"""entregas.py - separa o trabalho acumulado em entregas por branch (skill qa-total).

Le o `git diff HEAD` de um ou varios repositorios e divide por TRECHO (hunk), segundo um mapa
JSON, em blocos de assunto. Cada bloco vira uma pasta <saida>/NN-<branch com / -> __>/ com
<repo>.patch, COMMIT-<repo>.txt, APLICAR.txt e PR.md. Depois prova a separacao: cada patch
aplica sozinho na base, a soma de todos reproduz byte a byte os arquivos alterados e, se pedido,
o typecheck de cada bloco numa copia limpa revela as dependencias entre blocos.

O que este script NUNCA faz: criar branch, commit, push, merge ou PR; mexer no indice real, no
working tree ou no stash do repositorio. Tudo que aplica patch roda com GIT_INDEX_FILE e
GIT_OBJECT_DIRECTORY temporarios (nada e gravado no .git) ou numa copia fora do repositorio. Os
comandos de git que mudam algo vao como TEXTO no APLICAR.txt, para o usuario rodar.

Somente biblioteca padrao. Python 3.9+. Windows, macOS e Linux.
"""
from __future__ import annotations

import argparse
import fnmatch
import hashlib
import json
import os
import re
import shutil
import stat
import subprocess
import sys
import tarfile
import tempfile
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime
from pathlib import Path

_AQUI = Path(__file__).resolve().parent
if str(_AQUI) not in sys.path:
    sys.path.insert(0, str(_AQUI))
import _mascara
import segredos as _segredos

VERSAO_MAPA = 1
EXIT_OK, EXIT_FALHA, EXIT_USO, EXIT_AMBIENTE = 0, 1, 2, 3
DONO_FORA = "fora"
DONO_PENDENTE = "?"
CONTEXTO_PADRAO = 3
CONTAR_PADRAO = r"\berror\b"
NOME_MANIFESTO = "entrega.json"
PASTA_FORA = "00-fora"
PASTA_BACKUP = "00-backup"
PASTA_TYPECHECK = "00-typecheck"
MARCA_COPIA = ".entregas-copia-temporaria"
ENV_GIT_LIMPAR = ("GIT_INDEX_FILE", "GIT_DIR", "GIT_WORK_TREE", "GIT_OBJECT_DIRECTORY",
                  "GIT_ALTERNATE_OBJECT_DIRECTORIES", "GIT_COMMON_DIR", "GIT_PREFIX",
                  "GIT_EXTERNAL_DIFF", "GIT_DIFF_OPTS")


class Falha(Exception):
    def __init__(self, mensagem: str, codigo: int = EXIT_FALHA):
        super().__init__(mensagem)
        self.codigo = codigo


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
            fluxo.reconfigure(encoding="utf-8", errors="replace")
        except (AttributeError, ValueError):
            pass


def agora_iso() -> str:
    return datetime.now().astimezone().isoformat(timespec="seconds")


def agora_carimbo() -> str:
    return datetime.now().strftime("%Y-%m-%d_%H%M%S")


def escrever_texto(caminho: Path, texto: str) -> None:
    caminho.parent.mkdir(parents=True, exist_ok=True)
    with open(caminho, "w", encoding="utf-8", newline="\n") as fh:
        fh.write(texto)


def escrever_bytes(caminho: Path, dados: bytes) -> None:
    caminho.parent.mkdir(parents=True, exist_ok=True)
    with open(caminho, "wb") as fh:
        fh.write(dados)


def escrever_json(caminho: Path, dados) -> None:
    escrever_texto(caminho, json.dumps(dados, ensure_ascii=False, indent=2) + "\n")


def textos_do_mapa(titulo, blocos: list):
    yield "-", "titulo", titulo
    for b in blocos:
        bid = b.get("id") or "?"
        for campo in ("titulo", "resumo", "branch"):
            yield bid, campo, b.get(campo)
        for campo in ("itens", "nao_validado", "atencao", "fora_do_bloco"):
            for i, x in enumerate(b.get(campo) or []):
                yield bid, f"{campo}[{i}]", x
        c = b.get("commit")
        if isinstance(c, dict):
            for repo, msg in c.items():
                yield bid, f"commit[{repo}]", msg
        else:
            yield bid, "commit", c
        seg = b.get("segurar") or {}
        if isinstance(seg, dict):
            yield bid, "segurar.causa", seg.get("causa")
            for i, x in enumerate(seg.get("saidas") or []):
                yield bid, f"segurar.saidas[{i}]", x


def mascarar_mapa(titulo, blocos: list) -> list:
    """Segredo no texto do mapa (titulo, resumo, itens, nao_validado, atencao, fora_do_bloco, commit, segurar):
    devolve [(bloco, campo, tipos)] sem o valor. O mapa e escrito a mao a partir da causa dos defeitos e vira
    COMMIT (historico e remoto), PR.md, APLICAR.txt, COMO-APLICAR.md e provas.json."""
    achados = []
    for bid, campo, valor in textos_do_mapa(titulo, blocos):
        if not isinstance(valor, str) or not valor:
            continue
        _, tipos = _mascara.mascarar_com_tipos(valor, estrito=True)
        if tipos:
            achados.append((bid, campo, sorted(set(tipos))))
    return achados


class EscritaMascarada:
    """Defesa extra do 'comandos': todo texto gravado passa pela mascara estrita; o que trocar vira saida 1."""

    def __init__(self):
        self.trocas: list = []

    def texto(self, caminho: Path, conteudo: str) -> str:
        limpo, n = _mascara.mascarar(conteudo, estrito=True)
        if n:
            self.trocas.append((caminho, n))
        escrever_texto(caminho, limpo)
        return limpo

    def json(self, caminho: Path, dados) -> None:
        limpo, n = _mascara.mascarar_estrutura(dados)
        if n:
            self.trocas.append((caminho, n))
        escrever_json(caminho, limpo)


def apagar_pasta(pasta: Path) -> None:
    def tirar_somente_leitura(func, caminho, _exc):
        try:
            os.chmod(caminho, stat.S_IWRITE | stat.S_IREAD)
            func(caminho)
        except OSError:
            pass
    if not os.path.isdir(pasta):
        return
    if sys.version_info >= (3, 12):
        shutil.rmtree(pasta, onexc=tirar_somente_leitura)
    else:
        shutil.rmtree(pasta, onerror=tirar_somente_leitura)


def ambiente_git(extra: dict | None = None) -> dict:
    env = {k: v for k, v in os.environ.items() if k not in ENV_GIT_LIMPAR}
    env["GIT_TERMINAL_PROMPT"] = "0"
    env["GIT_OPTIONAL_LOCKS"] = "0"
    if extra:
        env.update(extra)
    return env


def git(raiz, *args, extra: dict | None = None, entrada: bytes | None = None,
        aceitar=(0,)) -> subprocess.CompletedProcess:
    cmd = ["git", "-c", "core.quotepath=false", "-c", "core.longpaths=true", "-c", "diff.noprefix=false",
           "-c", "diff.mnemonicPrefix=false", "-c", "diff.suppressBlankEmpty=false", *args]
    try:
        r = subprocess.run(cmd, cwd=str(raiz) if raiz else None, input=entrada,
                           capture_output=True, env=ambiente_git(extra))
    except FileNotFoundError:
        raise Falha("git nao encontrado no PATH", EXIT_AMBIENTE)
    if r.returncode not in aceitar:
        erro = r.stderr.decode("utf-8", "replace").strip()
        raise Falha(f"git {' '.join(args[:3])} falhou em {raiz}: {erro}", EXIT_AMBIENTE)
    return r


def texto_git(raiz, *args, **kw) -> str:
    return git(raiz, *args, **kw).stdout.decode("utf-8", "replace").strip()


# --------------------------------------------------------------------------------------------
# Diff: leitura e quebra em trechos
# --------------------------------------------------------------------------------------------

class Trecho:
    def __init__(self, cabeca: bytes):
        self.cabeca = cabeca
        self.linhas: list[bytes] = []

    @property
    def mais(self) -> int:
        return sum(1 for l in self.linhas if l.startswith(b"+"))

    @property
    def menos(self) -> int:
        return sum(1 for l in self.linhas if l.startswith(b"-"))

    @property
    def assinatura(self) -> str:
        return hashlib.sha1(b"\n".join(self.linhas)).hexdigest()[:10]

    def resumo(self, maximo: int = 3, largura: int = 90) -> str:
        """Linhas +/- do trecho, ja mascaradas. A mascara roda no BLOCO inteiro (chave privada, JSON e frase que
        atravessam linhas), e toda linha entre BEGIN e END de chave privada vira [REMOVIDO], inclusive quando o
        bloco comeca antes do trecho (END sem BEGIN) ou termina depois dele (BEGIN sem END)."""
        textos = [l[1:].decode("utf-8", "replace").replace("\r", "") for l in self.linhas]
        na_chave = linhas_de_chave_privada(textos)
        alteradas = [(i, self.linhas[i][:1].decode()) for i in range(len(self.linhas))
                     if self.linhas[i][:1] in (b"+", b"-")]
        if not alteradas:
            return ""
        brutos = [_mascara.MARCA if i in na_chave else textos[i] for i, _ in alteradas]
        limpo, _ = _mascara.mascarar("\n".join(brutos), estrito=True)
        limpos = limpo.split("\n")
        if len(limpos) != len(brutos):
            limpos = [_mascara.mascarar(t, estrito=True)[0] for t in brutos]
        partes = []
        for (_, sinal), t in zip(alteradas, limpos):
            t = re.sub(r"\s+", " ", t.replace("\t", " ")).strip()
            if not t:
                continue
            partes.append(f"{sinal} {t[:largura]}")
            if len(partes) >= maximo:
                break
        return " | ".join(partes)


RE_PEM_INICIO = re.compile(r"-----BEGIN [A-Z0-9 ]*PRIVATE KEY(?: BLOCK)?-----")
RE_PEM_FIM = re.compile(r"-----END [A-Z0-9 ]*PRIVATE KEY(?: BLOCK)?-----")
RE_LINHA_BASE64 = re.compile(r"\s*[A-Za-z0-9+/=]{40,}\s*")


def linhas_de_chave_privada(textos: list) -> set:
    """Indices das linhas (de todo o trecho, contexto inclusive) que pertencem a um bloco de chave privada:
    de BEGIN a END; do inicio do trecho ate um END sem BEGIN; de um BEGIN sem END ate o fim; e toda linha que
    e so base64 longo (corpo de chave sem marcador no trecho)."""
    marcadas, aberto, depois_do_ultimo_fim = set(), False, 0
    for i, t in enumerate(textos):
        if RE_PEM_INICIO.search(t):
            aberto = True
        if aberto:
            marcadas.add(i)
        if RE_PEM_FIM.search(t):
            if not aberto:
                marcadas.update(range(depois_do_ultimo_fim, i + 1))
            aberto = False
            depois_do_ultimo_fim = i + 1
        if RE_LINHA_BASE64.fullmatch(t):
            marcadas.add(i)
    return marcadas


class Arquivo:
    def __init__(self, linha_diff: bytes):
        self.cabecalho: list[bytes] = [linha_diff]
        self.trechos: list[Trecho] = []
        self.caminho = ""
        self.binario = False
        self.novo = False
        self.apagado = False

    def unidades(self) -> list[int]:
        return list(range(len(self.trechos))) if self.trechos else [0]

    def fim_de_linha(self) -> str:
        crlf_menos = lf_menos = crlf_mais = lf_mais = 0
        for t in self.trechos:
            for l in t.linhas:
                if l[:1] in (b" ", b"-"):
                    if l.endswith(b"\r"):
                        crlf_menos += 1
                    else:
                        lf_menos += 1
                if l[:1] in (b" ", b"+"):
                    if l.endswith(b"\r"):
                        crlf_mais += 1
                    else:
                        lf_mais += 1
        if self.binario:
            return "binario"

        def rotulo(crlf, lf):
            if crlf and lf:
                return "misto"
            if crlf:
                return "CRLF"
            if lf:
                return "LF"
            return "-"
        antes, depois = rotulo(crlf_menos, lf_menos), rotulo(crlf_mais, lf_mais)
        if antes == depois or "-" in (antes, depois):
            return depois if antes == "-" else antes
        return f"{antes}->{depois}"

    def patch(self, indices: list[int], com_modo: bool) -> bytes:
        saida: list[bytes] = []
        for l in self.cabecalho:
            if l.startswith(b"index ") and self.trechos and not self.binario:
                continue
            if (l.startswith(b"old mode ") or l.startswith(b"new mode ")) and not com_modo:
                continue
            saida.append(l)
        for i in sorted(indices):
            if i < len(self.trechos):
                saida.append(self.trechos[i].cabeca)
                saida.extend(self.trechos[i].linhas)
        return b"\n".join(saida) + b"\n"


def desaspar_c(b: bytes) -> bytes:
    if not (b.startswith(b'"') and b.endswith(b'"')):
        return b
    corpo, saida, i = b[1:-1], bytearray(), 0
    escapes = {ord("n"): 10, ord("t"): 9, ord("r"): 13, ord('"'): 34, ord("\\"): 92,
               ord("a"): 7, ord("b"): 8, ord("f"): 12, ord("v"): 11}
    while i < len(corpo):
        c = corpo[i]
        if c == 92 and i + 1 < len(corpo):
            n = corpo[i + 1]
            if re.match(rb"[0-7]{3}", corpo[i + 1:i + 4]):
                saida.append(int(corpo[i + 1:i + 4], 8) & 0xFF)
                i += 4
                continue
            saida.append(escapes.get(n, n))
            i += 2
            continue
        saida.append(c)
        i += 1
    return bytes(saida)


def caminho_da_linha_diff(l: bytes) -> bytes:
    resto = l[len(b"diff --git "):]
    if resto.startswith(b'"'):
        m = re.match(rb'("(?:[^"\\]|\\.)*")', resto)
        if m:
            return desaspar_c(m.group(1))[2:]
    meio = (len(resto) - 5) // 2
    if resto[:2] == b"a/" and resto[meio + 2:meio + 5] == b" b/":
        return resto[2:meio + 2]
    return resto[2:].split(b" b/")[0]


def ler_caminho(l: bytes, prefixo: bytes) -> bytes | None:
    resto = l[4:]
    if resto.startswith(b"/dev/null"):
        return None
    resto = desaspar_c(resto.split(b"\t")[0] if not resto.startswith(b'"') else resto)
    return resto[len(prefixo):] if resto.startswith(prefixo) else resto


def parsear_diff(raw: bytes) -> list[Arquivo]:
    arquivos: list[Arquivo] = []
    atual: Arquivo | None = None
    trecho: Trecho | None = None
    linhas = raw.split(b"\n")
    if linhas and linhas[-1] == b"":
        linhas.pop()
    for l in linhas:
        if l.startswith(b"diff --git "):
            atual = Arquivo(l)
            arquivos.append(atual)
            trecho = None
            continue
        if atual is None:
            continue
        if trecho is None and (atual.binario or not l.startswith(b"@@")):
            atual.cabecalho.append(l)
            if l.startswith(b"GIT binary patch") or l.startswith(b"Binary files "):
                atual.binario = True
            elif l.startswith(b"new file mode"):
                atual.novo = True
            elif l.startswith(b"deleted file mode"):
                atual.apagado = True
            continue
        if l.startswith(b"@@"):
            trecho = Trecho(l)
            atual.trechos.append(trecho)
            continue
        trecho.linhas.append(l)
    for a in arquivos:
        menos = mais = None
        for l in a.cabecalho:
            if l.startswith(b"--- "):
                menos = ler_caminho(l, b"a/")
            elif l.startswith(b"+++ "):
                mais = ler_caminho(l, b"b/")
        bruto = mais or menos or caminho_da_linha_diff(a.cabecalho[0])
        a.caminho = bruto.decode("utf-8", "surrogateescape").replace("\\", "/")
    return arquivos


class Repo:
    def __init__(self, nome: str, cfg: dict, base_dir: Path, contexto_global: int):
        self.nome = nome
        bruto = cfg.get("caminho") or ""
        if not bruto:
            raise Falha(f"repo '{nome}': falta 'caminho'", EXIT_USO)
        p = Path(os.path.expanduser(bruto))
        self.caminho = (p if p.is_absolute() else (base_dir / p)).resolve()
        self.base = cfg.get("base") or ""
        self.remoto = cfg.get("remoto") or "origin"
        self.incluir_novos = bool(cfg.get("incluir_novos", False))
        self.contexto = int(cfg.get("contexto", contexto_global))
        self.typecheck = cfg.get("typecheck") or None
        self._raiz: Path | None = None
        self._arquivos: list[Arquivo] | None = None
        self._nomes: set[str] = set()
        self._existe: dict[str, bool] = {}
        self._head = ""

    @property
    def raiz(self) -> Path:
        if self._raiz is None:
            if not self.caminho.is_dir():
                raise Falha(f"repo '{self.nome}': pasta nao existe: {self.caminho}", EXIT_AMBIENTE)
            r = git(self.caminho, "rev-parse", "--show-toplevel", aceitar=(0, 128))
            if r.returncode != 0:
                raise Falha(f"repo '{self.nome}': {self.caminho} nao e um repositorio git. Projeto sem VCS (zip, SVN, "
                            f"Perforce) nao tem branch: a entrega e um patch por assunto feito a mao, arquivo a arquivo "
                            f"(references/entregas-por-branch.md, secao 'Projeto sem VCS')", EXIT_AMBIENTE)
            self._raiz = Path(r.stdout.decode("utf-8", "replace").strip()).resolve()
            if git(self._raiz, "rev-parse", "--verify", "-q", "HEAD", aceitar=(0, 1, 128)).returncode != 0:
                raise Falha(f"repo '{self.nome}': sem commit (HEAD nao existe)", EXIT_AMBIENTE)
        return self._raiz

    @property
    def head(self) -> str:
        if not self._head:
            self._head = texto_git(self.raiz, "rev-parse", "HEAD")
        return self._head

    def branch_atual(self) -> str:
        r = git(self.raiz, "symbolic-ref", "-q", "--short", "HEAD", aceitar=(0, 1, 128))
        return r.stdout.decode("utf-8", "replace").strip() or "(HEAD destacado)"

    def tem_remoto(self) -> bool:
        if not hasattr(self, "_tem_remoto"):
            r = git(self.raiz, "remote", "get-url", self.remoto, aceitar=tuple(range(256)))
            self._tem_remoto = r.returncode == 0 and bool(r.stdout.strip())
        return self._tem_remoto

    def tem_upstream(self, base: str) -> bool:
        cache = self.__dict__.setdefault("_upstream", {})
        if base not in cache:
            r = git(self.raiz, "rev-parse", "--abbrev-ref", f"{base}@{{upstream}}", aceitar=tuple(range(256)))
            cache[base] = r.returncode == 0 and bool(r.stdout.strip())
        return cache[base]

    def objetos(self) -> str:
        r = git(self.raiz, "rev-parse", "--path-format=absolute", "--git-common-dir", aceitar=(0, 128, 129))
        comum = r.stdout.decode("utf-8", "replace").strip()
        if r.returncode != 0 or not comum:
            comum = texto_git(self.raiz, "rev-parse", "--git-common-dir")
            if not os.path.isabs(comum):
                comum = str((self.raiz / comum).resolve())
        return str(Path(comum) / "objects")

    def nao_rastreados(self) -> list[str]:
        out = git(self.raiz, "ls-files", "--others", "--exclude-standard", "-z").stdout
        return [p.decode("utf-8", "surrogateescape") for p in out.split(b"\0") if p]

    def diff_bruto(self) -> bytes:
        raw = git(self.raiz, "diff", "HEAD", "--no-color", "--no-ext-diff", "--no-textconv", "--no-renames",
                  "--binary", "--full-index", "--diff-algorithm=myers", "--ignore-submodules=all",
                  "--src-prefix=a/", "--dst-prefix=b/", f"-U{self.contexto}").stdout
        if self.incluir_novos:
            for p in self.nao_rastreados():
                r = git(self.raiz, "diff", "--no-index", "--no-color", "--no-ext-diff", "--no-textconv",
                        "--binary", "--full-index", "--src-prefix=a/", "--dst-prefix=b/",
                        f"-U{self.contexto}", "--", "/dev/null", p, aceitar=(0, 1))
                if r.stdout and not raw.endswith(b"\n") and raw:
                    raw += b"\n"
                raw += r.stdout
        return raw

    def arquivos(self) -> list[Arquivo]:
        if self._arquivos is None:
            self._arquivos = parsear_diff(self.diff_bruto())
            self._nomes = {a.caminho for a in self._arquivos}
        return self._arquivos

    def caminho_existe(self, caminho: str) -> bool:
        self.arquivos()
        if caminho in self._nomes:
            return True
        if caminho not in self._existe:
            self._existe[caminho] = (self.raiz / caminho).exists()
        return self._existe[caminho]

    def inflados_por_fim_de_linha(self) -> dict:
        def numstat(*extra):
            out = texto_git(self.raiz, "diff", "HEAD", "--numstat", "--no-renames", "--ignore-submodules=all", *extra)
            d = {}
            for l in out.splitlines():
                partes = l.split("\t", 2)
                if len(partes) == 3 and partes[0] != "-":
                    d[partes[2]] = int(partes[0]) + int(partes[1])
            return d
        bruto, sem_cr = numstat(), numstat("--ignore-cr-at-eol")
        return {p: (n, sem_cr.get(p, 0)) for p, n in bruto.items() if n != sem_cr.get(p, 0)}


# --------------------------------------------------------------------------------------------
# Mapa
# --------------------------------------------------------------------------------------------

def normalizar_id(v) -> str:
    s = str(v).strip()
    return s.zfill(2) if s.isdigit() else s


RE_ID_BLOCO = re.compile(r"[A-Za-z0-9][A-Za-z0-9._-]{0,30}")


def id_valido(bid: str) -> bool:
    return bool(RE_ID_BLOCO.fullmatch(bid)) and ".." not in bid


def nome_pasta(bloco: dict) -> str:
    slug = bloco["branch"].replace("/", "__")
    slug = re.sub(r'[<>:"\\|?*\s]', "_", slug)
    ident = re.sub(r'[<>:"/\\|?*\s]', "_", str(bloco["id"])).replace("..", "__")
    return f"{ident}-{slug}"


def pasta_do_bloco(mapa, bloco: dict) -> Path:
    """Pasta da entrega do bloco: sempre dentro de 'saida' (id ou branch com '..' nao tira a entrega de la)."""
    raiz = mapa.saida.resolve()
    pasta = (mapa.saida / nome_pasta(bloco)).resolve()
    try:
        pasta.relative_to(raiz)
    except ValueError:
        raise Falha(f"bloco {bloco['id']}: a pasta da entrega sairia de {raiz}: {pasta}", EXIT_USO)
    if pasta == raiz:
        raise Falha(f"bloco {bloco['id']}: nome de pasta invalido", EXIT_USO)
    return pasta


def checar_branch(nome: str) -> bool:
    try:
        r = subprocess.run(["git", "check-ref-format", "--branch", nome], capture_output=True, env=ambiente_git())
    except FileNotFoundError:
        raise Falha("git nao encontrado no PATH", EXIT_AMBIENTE)
    return r.returncode == 0


class Mapa:
    def __init__(self, caminho: str, repos_cli: list[str] | None = None, saida_cli: str | None = None):
        self.arquivo = Path(caminho).resolve()
        if not self.arquivo.is_file():
            raise Falha(f"mapa nao encontrado: {self.arquivo}", EXIT_USO)
        try:
            with open(self.arquivo, encoding="utf-8-sig") as fh:
                dados = json.load(fh)
        except json.JSONDecodeError as e:
            raise Falha(f"mapa com JSON invalido ({self.arquivo}): {e}", EXIT_USO)
        self.dados = dados
        self.base_dir = self.arquivo.parent
        erros: list[str] = []
        if not isinstance(dados, dict):
            raise Falha("mapa: o topo precisa ser um objeto", EXIT_USO)
        self.titulo = dados.get("titulo") or f"Entregas por branch - {datetime.now():%Y-%m-%d}"
        self.contexto = int(dados.get("contexto", CONTEXTO_PADRAO))
        if self.contexto < 1:
            erros.append("contexto precisa ser >= 1 (com 0 o git apply exige --unidiff-zero)")
        saida = saida_cli or dados.get("saida") or "entregas"
        p = Path(os.path.expanduser(saida))
        self.saida = (p if p.is_absolute() or saida_cli else self.base_dir / p).resolve()

        repos_cfg = dict(dados.get("repos") or {})
        for item in repos_cli or []:
            if "=" not in item:
                erros.append(f"--repo precisa ser nome=caminho: {item}")
                continue
            n, c = item.split("=", 1)
            cfg = dict(repos_cfg.get(n) or {})
            cfg["caminho"] = str(Path(c).resolve())
            repos_cfg[n] = cfg
        self.repos: dict[str, Repo] = {}
        for nome, cfg in repos_cfg.items():
            if nome.startswith("_"):
                continue
            if not re.match(r"^[A-Za-z0-9._-]+$", nome):
                erros.append(f"nome de repo invalido (vira nome de arquivo): '{nome}'")
                continue
            if not isinstance(cfg, dict):
                erros.append(f"repo '{nome}': precisa ser um objeto com 'caminho'")
                continue
            try:
                self.repos[nome] = Repo(nome, cfg, self.base_dir, self.contexto)
            except Falha as e:
                erros.append(str(e))
        if not self.repos:
            erros.append("mapa sem nenhum repo em 'repos'")

        self.blocos: list[dict] = []
        vistos_id, vistos_branch = set(), set()
        for i, b in enumerate(dados.get("blocos") or []):
            if not isinstance(b, dict):
                erros.append(f"blocos[{i}] precisa ser um objeto")
                continue
            bid = normalizar_id(b.get("id", ""))
            br = (b.get("branch") or "").strip()
            if not bid:
                erros.append(f"blocos[{i}] sem 'id'")
                continue
            if not id_valido(bid):
                erros.append(f"bloco {bid}: id inválido para nome de pasta (use letras, números, '.', '_' e '-', até "
                             f"31 caracteres, começando por letra ou número, sem '..')")
                continue
            if bid in (DONO_FORA, DONO_PENDENTE) or bid.startswith("_"):
                erros.append(f"bloco '{bid}': id reservado")
            if bid in vistos_id:
                erros.append(f"bloco '{bid}' repetido")
            if not br:
                erros.append(f"bloco '{bid}' sem 'branch'")
            elif not checar_branch(br):
                erros.append(f"bloco '{bid}': nome de branch invalido para o git: '{br}'")
            if br in vistos_branch:
                erros.append(f"branch '{br}' usada por dois blocos")
            vistos_id.add(bid)
            vistos_branch.add(br)
            seg = b.get("segurar")
            if seg and not isinstance(seg, dict):
                seg = {"causa": str(seg) if not isinstance(seg, bool) else "", "saidas": []}
            if seg and not (seg.get("causa") or "").strip():
                erros.append(f"bloco '{bid}': 'segurar' exige a causa (o que acontece se subir) e as saidas")
            repos_b = b.get("repos")
            if repos_b is not None:
                repos_b = list(repos_b)
                for r in repos_b:
                    if r not in self.repos:
                        erros.append(f"bloco '{bid}': repo '{r}' nao existe em 'repos'")
            self.blocos.append({
                "id": bid, "branch": br, "titulo": b.get("titulo") or br,
                "repos": repos_b, "deps": [normalizar_id(d) for d in (b.get("deps") or [])],
                "segurar": seg or None, "empilhar": bool(b.get("empilhar", False)),
                "commit": b.get("commit"), "resumo": b.get("resumo") or "",
                "itens": list(b.get("itens") or []),
                "nao_validado": None if b.get("nao_validado") is None else list(b.get("nao_validado")),
                "atencao": list(b.get("atencao") or []), "fora_do_bloco": list(b.get("fora_do_bloco") or []),
                "base": b.get("base"),
            })
        if not self.blocos:
            erros.append("mapa sem nenhum bloco em 'blocos'")
        ids = {b["id"] for b in self.blocos}
        for b in self.blocos:
            for d in b["deps"]:
                if d not in ids:
                    erros.append(f"bloco '{b['id']}': dependencia '{d}' nao existe")
                if d == b["id"]:
                    erros.append(f"bloco '{b['id']}' depende de si mesmo")
            if b["empilhar"] and not b["deps"]:
                erros.append(f"bloco '{b['id']}': 'empilhar' exige 'deps'")
        ordem = [normalizar_id(x) for x in (dados.get("ordem") or [])]
        if ordem:
            faltam = [b["id"] for b in self.blocos if b["id"] not in ordem]
            extras = [x for x in ordem if x not in ids]
            if faltam:
                erros.append(f"'ordem' nao cita os blocos: {', '.join(faltam)}")
            if extras:
                erros.append(f"'ordem' cita blocos inexistentes: {', '.join(extras)}")
        else:
            ordem = [b["id"] for b in self.blocos]
        self.ordem = ordem
        pos = {x: i for i, x in enumerate(ordem)}
        for b in self.blocos:
            for d in b["deps"]:
                if d in pos and b["id"] in pos and pos[d] > pos[b["id"]]:
                    erros.append(f"bloco '{b['id']}' vem antes da sua dependencia '{d}' na ordem")
        self._checar_ciclos(erros)

        self.regras: dict[str, dict] = {}
        mapa_arq = dados.get("mapa") or {}
        for nome, regras in mapa_arq.items():
            if nome.startswith("_"):
                continue
            if nome not in self.repos:
                erros.append(f"'mapa' cita o repo '{nome}', que nao esta em 'repos'")
                continue
            if not isinstance(regras, dict):
                erros.append(f"mapa.{nome} precisa ser um objeto arquivo -> bloco")
                continue
            self.regras[nome] = {k: v for k, v in regras.items() if not k.startswith("_")}
            for arq, v in self.regras[nome].items():
                for dono in self._donos_declarados(v):
                    if dono not in ids and dono not in (DONO_FORA, DONO_PENDENTE):
                        erros.append(f"mapa.{nome}['{arq}']: bloco '{dono}' nao existe")
                if isinstance(v, dict):
                    for k in v:
                        if k.startswith("_") or k == "*":
                            continue
                        if not re.match(r"^\d+(-\d+)?$", str(k)):
                            erros.append(f"mapa.{nome}['{arq}']: chave de trecho invalida '{k}' (use 0, 3 ou 2-5)")
                elif not isinstance(v, str):
                    erros.append(f"mapa.{nome}['{arq}']: valor precisa ser um id de bloco ou um objeto")
        if erros:
            raise Falha("mapa invalido:\n  - " + "\n  - ".join(erros), EXIT_USO)
        segredos = mascarar_mapa(self.titulo, self.blocos)
        if segredos:
            raise Falha("SEGREDO no mapa (o valor nao foi impresso; nada foi gravado: COMMIT, PR, APLICAR e provas "
                        "ficam como estavam). Tire o dado do mapa e descreva so o tipo:\n  - "
                        + "\n  - ".join(f"bloco {b} campo {c} ({', '.join(t)})" for b, c, t in segredos),
                        EXIT_FALHA)
        self.por_id = {b["id"]: b for b in self.blocos}

    @staticmethod
    def _donos_declarados(v) -> list[str]:
        if isinstance(v, str):
            return [normalizar_id(v)] if v not in (DONO_FORA, DONO_PENDENTE) else [v]
        if isinstance(v, dict):
            out = []
            for k, x in v.items():
                if k.startswith("_"):
                    continue
                if isinstance(x, str):
                    out.append(normalizar_id(x) if x not in (DONO_FORA, DONO_PENDENTE) else x)
            return out
        return []

    def _checar_ciclos(self, erros: list[str]) -> None:
        deps = {b["id"]: b["deps"] for b in self.blocos}
        estado: dict[str, int] = {}

        def visita(n, pilha):
            if estado.get(n) == 1:
                erros.append("dependencia circular: " + " -> ".join(pilha + [n]))
                return
            if estado.get(n) == 2:
                return
            estado[n] = 1
            for d in deps.get(n, []):
                visita(d, pilha + [n])
            estado[n] = 2
        for n in deps:
            visita(n, [])

    def fecho_deps(self, bid: str) -> list[str]:
        vistos: list[str] = []

        def visita(n):
            for d in self.por_id[n]["deps"]:
                if d not in vistos:
                    visita(d)
                    vistos.append(d)
        visita(bid)
        return sorted(vistos, key=self.ordem.index)

    def repos_do_bloco(self, bloco: dict, separacao: "Separacao") -> list[str]:
        if bloco["repos"] is not None:
            return bloco["repos"]
        return [r for r in self.repos if separacao.patch(bloco["id"], r)]


# --------------------------------------------------------------------------------------------
# Separacao por trecho
# --------------------------------------------------------------------------------------------

def casa_indice(chave: str, idx: int) -> bool:
    if "-" in chave:
        a, b = chave.split("-", 1)
        return int(a) <= idx <= int(b)
    return int(chave) == idx


def donos_de(valor, idx: int) -> list[str]:
    if not isinstance(valor, dict):
        return [str(valor)]
    explicitos = [str(x) for k, x in valor.items() if not k.startswith("_") and k != "*" and casa_indice(k, idx)]
    if explicitos:
        return explicitos
    return [str(valor["*"])] if "*" in valor else []


def eh_padrao(chave: str, repo: "Repo | None" = None) -> bool:
    if not any(c in chave for c in "*?["):
        return False
    return not (repo is not None and repo.caminho_existe(chave))


class Separacao:
    def __init__(self, mapa: Mapa, so_repos: list[str] | None = None):
        self.mapa = mapa
        self.erros: list[str] = []
        self.avisos: list[str] = []
        self.atrib: dict[str, list[tuple[Arquivo, int, str]]] = {}
        self.por_bloco: dict[str, dict[str, dict[str, list[int]]]] = {}
        self.fora: dict[str, dict[str, list[int]]] = {}
        self.arquivos: dict[str, dict[str, Arquivo]] = {}
        self._patches: dict[tuple[str, str], bytes] = {}
        for nome, repo in mapa.repos.items():
            if so_repos and nome not in so_repos:
                continue
            self._separar_repo(repo)
        self._checar_repos_declarados()

    def dono(self, repo: str, arq: Arquivo, idx: int) -> tuple[list[str], str]:
        regras = self.mapa.regras.get(repo, {})
        if arq.caminho in regras:
            valor = regras[arq.caminho]
            return [normalizar_id(x) if x not in (DONO_FORA, DONO_PENDENTE) else x for x in donos_de(valor, idx)], "exato"
        achados = []
        for chave, valor in regras.items():
            if eh_padrao(chave, self.mapa.repos[repo]) and fnmatch.fnmatchcase(arq.caminho, chave):
                for x in donos_de(valor, idx):
                    achados.append(normalizar_id(x) if x not in (DONO_FORA, DONO_PENDENTE) else x)
        return achados, "padrao"

    def _separar_repo(self, repo: Repo) -> None:
        arquivos = repo.arquivos()
        self.arquivos[repo.nome] = {a.caminho: a for a in arquivos}
        regras_meta = (self.mapa.dados.get("mapa") or {}).get(repo.nome) or {}
        lista = []
        for a in arquivos:
            meta = regras_meta.get(a.caminho)
            if isinstance(meta, dict):
                n = meta.get("_n")
                if n is not None and int(n) != len(a.unidades()):
                    self.erros.append(f"[{repo.nome}] {a.caminho}: o mapa foi feito com {n} trechos e agora sao "
                                      f"{len(a.unidades())}. O arquivo mudou: rode 'hunks --rascunho' e revise.")
                assin = meta.get("_assinaturas") or {}
                for k, v in assin.items():
                    i = int(k)
                    if i < len(a.trechos) and a.trechos[i].assinatura != v:
                        self.erros.append(f"[{repo.nome}] {a.caminho}: o trecho {i} mudou desde o rascunho "
                                          f"(assinatura {v} -> {a.trechos[i].assinatura}). Revise o dono dele.")
                for k in meta:
                    if k.startswith("_") or k == "*":
                        continue
                    topo = int(str(k).split("-")[-1])
                    if topo >= len(a.unidades()):
                        self.erros.append(f"[{repo.nome}] {a.caminho}: o mapa cita o trecho {k}, mas o arquivo tem "
                                          f"{len(a.unidades())} (indices 0..{len(a.unidades()) - 1}).")
            for idx in a.unidades():
                donos, origem = self.dono(repo.nome, a, idx)
                distintos = sorted(set(donos))
                if not distintos or distintos == [DONO_PENDENTE]:
                    self.erros.append(f"[{repo.nome}] SEM DONO: {a.caminho} trecho {idx}")
                    continue
                if len(distintos) > 1:
                    self.erros.append(f"[{repo.nome}] DOIS DONOS ({', '.join(distintos)}): {a.caminho} trecho {idx}")
                    continue
                d = distintos[0]
                lista.append((a, idx, d))
                if d == DONO_FORA:
                    self.fora.setdefault(repo.nome, {}).setdefault(a.caminho, []).append(idx)
                else:
                    self.por_bloco.setdefault(d, {}).setdefault(repo.nome, {}).setdefault(a.caminho, []).append(idx)
        self.atrib[repo.nome] = lista
        nomes = set(self.arquivos[repo.nome])
        for chave in self.mapa.regras.get(repo.nome, {}):
            if eh_padrao(chave, repo):
                if not any(fnmatch.fnmatchcase(n, chave) for n in nomes):
                    self.avisos.append(f"[{repo.nome}] padrao sem nenhum arquivo alterado: {chave}")
            elif chave not in nomes:
                self.avisos.append(f"[{repo.nome}] mapeado e sem diff (mapa velho?): {chave}")

    def _checar_repos_declarados(self) -> None:
        for b in self.mapa.blocos:
            tem = set(self.por_bloco.get(b["id"], {}))
            if b["repos"] is not None:
                sobra = tem - set(b["repos"])
                if sobra:
                    self.erros.append(f"bloco {b['id']} recebeu trechos de {', '.join(sorted(sobra))}, "
                                      f"mas 'repos' do bloco so declara {', '.join(b['repos']) or 'nada'}")
                vazio = [r for r in b["repos"] if r not in tem and r in self.arquivos]
                for r in vazio:
                    self.avisos.append(f"bloco {b['id']} declara '{r}' e nao recebeu nenhum trecho dele")
            if not tem and b["repos"] is None:
                self.avisos.append(f"bloco {b['id']} nao recebeu nenhum trecho")

    def patch(self, bid: str, repo: str) -> bytes:
        chave = (bid, repo)
        if chave not in self._patches:
            if bid == DONO_FORA:
                arqs = self.fora.get(repo, {})
            else:
                arqs = self.por_bloco.get(bid, {}).get(repo, {})
            partes = []
            for a in self.mapa.repos[repo].arquivos():
                if a.caminho in arqs:
                    idxs = arqs[a.caminho]
                    partes.append(a.patch(idxs, com_modo=(min(a.unidades()) in idxs)))
            self._patches[chave] = b"".join(partes)
        return self._patches[chave]

    def estatisticas(self, bid: str, repo: str) -> list[dict]:
        arqs = (self.fora.get(repo, {}) if bid == DONO_FORA else self.por_bloco.get(bid, {}).get(repo, {}))
        saida = []
        for caminho, idxs in arqs.items():
            a = self.arquivos[repo][caminho]
            mais = sum(a.trechos[i].mais for i in idxs if i < len(a.trechos))
            menos = sum(a.trechos[i].menos for i in idxs if i < len(a.trechos))
            saida.append({"caminho": caminho, "trechos": sorted(idxs), "de": len(a.unidades()),
                          "mais": mais, "menos": menos, "binario": a.binario, "novo": a.novo,
                          "apagado": a.apagado, "fim_de_linha": a.fim_de_linha()})
        return saida

    def compartilhados(self, repo: str) -> dict[str, list[str]]:
        donos: dict[str, set] = {}
        for a, _idx, d in self.atrib.get(repo, []):
            donos.setdefault(a.caminho, set()).add(d)
        return {c: sorted(s) for c, s in donos.items() if len(s) > 1}


# --------------------------------------------------------------------------------------------
# Indice temporario (nada e gravado no .git real)
# --------------------------------------------------------------------------------------------

class IndiceTemporario:
    def __init__(self, repo: Repo):
        self.repo = repo
        self.dir = Path(tempfile.mkdtemp(prefix="entregas-indice-"))
        self.indice = self.dir / "index"
        objetos = self.dir / "objects"
        objetos.mkdir()
        self.env = {"GIT_INDEX_FILE": str(self.indice), "GIT_OBJECT_DIRECTORY": str(objetos),
                    "GIT_ALTERNATE_OBJECT_DIRECTORIES": repo.objetos()}

    def __enter__(self):
        return self

    def __exit__(self, *exc):
        apagar_pasta(self.dir)

    def git(self, *args, **kw):
        assert self.env.get("GIT_INDEX_FILE"), "indice temporario obrigatorio"
        return git(self.repo.raiz, *args, extra=self.env, **kw)

    def reiniciar(self, rev: str) -> None:
        if self.indice.exists():
            self.indice.unlink()
        self.git("read-tree", rev)

    def aplicar(self, patch: Path, so_checar: bool = False) -> tuple[bool, str]:
        args = ["apply", "--cached"] + (["--check"] if so_checar else []) + [str(patch)]
        r = self.git(*args, aceitar=(0, 1, 128))
        return r.returncode == 0, r.stderr.decode("utf-8", "replace").strip()

    def entradas(self) -> dict[str, tuple[str, str]]:
        out = self.git("ls-files", "-s", "-z").stdout
        d = {}
        for reg in out.split(b"\0"):
            if not reg:
                continue
            meta, caminho = reg.split(b"\t", 1)
            modo, sha, _estagio = meta.split(b" ")
            d[caminho.decode("utf-8", "surrogateescape")] = (modo.decode(), sha.decode())
        return d

    def alterados_contra(self, rev: str) -> set[str]:
        out = self.git("diff-index", "--cached", "--name-only", "--no-renames", "-z", rev).stdout
        return {p.decode("utf-8", "surrogateescape") for p in out.split(b"\0") if p}


def hashes(repo: Repo, caminhos: list[str], filtros: bool) -> dict[str, str]:
    if not caminhos:
        return {}
    args = ["hash-object", "--stdin-paths"] + ([] if filtros else ["--no-filters"])
    entrada = "\n".join(caminhos).encode("utf-8", "surrogateescape") + b"\n"
    out = git(repo.raiz, *args, entrada=entrada).stdout.decode().split()
    return dict(zip(caminhos, out))


# --------------------------------------------------------------------------------------------
# Comandos
# --------------------------------------------------------------------------------------------

def imprimir_lista(titulo: str, itens: list[str], fluxo=sys.stdout) -> None:
    if itens:
        print(titulo, file=fluxo)
        for i in itens:
            print(f"  - {i}", file=fluxo)


def caminho_manifesto(mapa: Mapa) -> Path:
    return mapa.saida / NOME_MANIFESTO


def ler_manifesto(mapa: Mapa) -> dict:
    p = caminho_manifesto(mapa)
    if p.is_file():
        try:
            return json.loads(p.read_text(encoding="utf-8"))
        except json.JSONDecodeError:
            return {}
    return {}


def cmd_hunks(args) -> int:
    if args.mapa:
        mapa = Mapa(args.mapa, args.repo)
        repos = list(mapa.repos.values())
    else:
        if not args.repo:
            raise Falha("informe --mapa ou pelo menos um --repo nome=caminho", EXIT_USO)
        mapa = None
        repos = []
        for item in args.repo:
            if "=" not in item:
                raise Falha(f"--repo precisa ser nome=caminho: {item}", EXIT_USO)
            n, c = item.split("=", 1)
            repos.append(Repo(n, {"caminho": c}, Path.cwd(), args.contexto or CONTEXTO_PADRAO))
    if args.contexto:
        for r in repos:
            r.contexto = args.contexto
    sep = Separacao(mapa) if mapa else None
    saida_json = {"gerado_em": agora_iso(), "repos": {}}
    total_sem_dono = 0
    for repo in repos:
        arquivos = repo.arquivos()
        inflados = repo.inflados_por_fim_de_linha()
        n_trechos = sum(len(a.unidades()) for a in arquivos)
        print(f"== {repo.nome}  {repo.raiz}  (HEAD {repo.head[:9]}, branch {repo.branch_atual()}, "
              f"{len(arquivos)} arquivos, {n_trechos} trechos, contexto {repo.contexto})")
        novos = [] if repo.incluir_novos else repo.nao_rastreados()
        if novos:
            print(f"   ATENCAO: {len(novos)} arquivo(s) novo(s) nao rastreado(s) FORA do diff "
                  f"(use \"incluir_novos\": true no repo para entrarem): {', '.join(novos[:5])}"
                  + (" ..." if len(novos) > 5 else ""))
        rj = []
        for a in arquivos:
            tipo = "novo" if a.novo else "apagado" if a.apagado else ""
            extra = f", {tipo}" if tipo else ""
            print(f"-- {a.caminho}  [{a.fim_de_linha()}{extra}, {len(a.unidades())} trecho(s)]")
            if a.caminho in inflados:
                b, s = inflados[a.caminho]
                print(f"   ATENCAO: fim de linha trocado - {b} linhas no diff, {s} ignorando CR. "
                      f"Restaure o fim de linha original antes de separar.")
            fj = {"caminho": a.caminho, "fim_de_linha": a.fim_de_linha(), "binario": a.binario,
                  "novo": a.novo, "apagado": a.apagado, "trechos": []}
            for idx in a.unidades():
                t = a.trechos[idx] if a.trechos else None
                if t:
                    cab = _mascara.mascarar(t.cabeca.decode("utf-8", "replace"), estrito=True)[0].replace("\r", "")
                    cab_curta = cab.split("@@")[1].strip() if cab.count("@@") >= 2 else cab
                    linha = (f"   [{idx}] @@ {cab_curta} @@  +{t.mais} -{t.menos}  {t.assinatura}"
                             f"  :: {t.resumo(args.linhas)}")
                else:
                    linha = f"   [{idx}] (arquivo inteiro: {'binario' if a.binario else 'so cabecalho/modo'})"
                dono_txt = ""
                if sep:
                    donos, _ = sep.dono(repo.nome, a, idx)
                    distintos = sorted(set(donos))
                    if not distintos or distintos == [DONO_PENDENTE]:
                        dono_txt = "SEM DONO"
                        total_sem_dono += 1
                    elif len(distintos) > 1:
                        dono_txt = f"DOIS DONOS ({', '.join(distintos)})"
                        total_sem_dono += 1
                    else:
                        dono_txt = distintos[0]
                    linha += f"\n       -> {dono_txt}"
                print(linha)
                fj["trechos"].append({"indice": idx,
                                      "cabeca": _mascara.mascarar(t.cabeca.decode("utf-8", "replace"), estrito=True)[0]
                                      if t else "",
                                      "mais": t.mais if t else 0, "menos": t.menos if t else 0,
                                      "assinatura": t.assinatura if t else "",
                                      "resumo": t.resumo(args.linhas) if t else "", "dono": dono_txt})
            rj.append(fj)
        saida_json["repos"][repo.nome] = {"raiz": str(repo.raiz), "head": repo.head, "arquivos": rj}
        print()
    if args.json:
        escrever_json(Path(args.json).resolve(), saida_json)
        print(f"json: {Path(args.json).resolve()}")
    if args.rascunho:
        escrever_rascunho(Path(args.rascunho).resolve(), repos, mapa)
    if sep:
        imprimir_lista("avisos:", sep.avisos)
        outros = [e for e in sep.erros if "SEM DONO" not in e and "DOIS DONOS" not in e]
        imprimir_lista("ERROS:", outros, sys.stderr)
        if total_sem_dono or outros:
            print(f"\n{total_sem_dono} trecho(s) sem dono ou com dois donos. Complete o mapa antes de separar.")
            return EXIT_FALHA
    return EXIT_OK


def escrever_rascunho(destino: Path, repos: list[Repo], mapa: Mapa | None) -> None:
    if destino.exists():
        with open(destino, encoding="utf-8-sig") as fh:
            dados = json.load(fh)
        copia = destino.with_name(destino.name + f".bak-{agora_carimbo()}")
        shutil.copy2(destino, copia)
        print(f"rascunho: mapa existente preservado em {copia}")
    else:
        dados = {
            "_comentario": "Mapa de entregas por branch. Troque cada '?' pelo id do bloco dono do trecho, "
                           "ou 'fora' para o que nao entra na entrega. Chaves com _ sao metadados.",
            "versao": VERSAO_MAPA,
            "titulo": f"Entregas por branch - {datetime.now():%Y-%m-%d}",
            "saida": "entregas",
            "contexto": repos[0].contexto if repos else CONTEXTO_PADRAO,
            "repos": {},
            "blocos": [{"id": "01", "branch": "fix/defina-o-assunto", "titulo": "Defina o assunto do bloco",
                        "deps": [], "resumo": "", "itens": [], "nao_validado": []}],
            "mapa": {},
        }
    dados.setdefault("repos", {})
    dados.setdefault("mapa", {})
    novos_total = mudaram = 0
    for repo in repos:
        if repo.nome not in dados["repos"]:
            branch = repo.branch_atual()
            dados["repos"][repo.nome] = {"caminho": str(repo.raiz),
                                         "base": branch if not branch.startswith("(") else "",
                                         "remoto": "origin"}
        regras = dados["mapa"].setdefault(repo.nome, {})
        for a in repo.arquivos():
            if a.caminho in regras:
                meta = regras[a.caminho]
                if isinstance(meta, dict):
                    n = meta.get("_n")
                    assin = meta.get("_assinaturas") or {}
                    atual = {str(i): t.assinatura for i, t in enumerate(a.trechos)}
                    if (n is not None and int(n) != len(a.unidades())) or any(atual.get(k) != v for k, v in assin.items()):
                        mudaram += 1
                        print(f"rascunho: MUDOU desde o mapa, revise os donos: [{repo.nome}] {a.caminho}")
                continue
            if any(eh_padrao(k, repo) and fnmatch.fnmatchcase(a.caminho, k) for k in regras if not k.startswith("_")):
                continue
            entrada: dict = {str(i): DONO_PENDENTE for i in a.unidades()}
            entrada["_n"] = len(a.unidades())
            entrada["_eol"] = a.fim_de_linha()
            if a.trechos:
                entrada["_assinaturas"] = {str(i): t.assinatura for i, t in enumerate(a.trechos)}
                entrada["_resumo"] = {str(i): t.resumo(2, 70) for i, t in enumerate(a.trechos)}
            regras[a.caminho] = entrada
            novos_total += 1
        nomes = {a.caminho for a in repo.arquivos()}
        for k in list(regras):
            if not k.startswith("_") and not eh_padrao(k, repo) and k not in nomes:
                print(f"rascunho: sem diff agora (pode remover do mapa): [{repo.nome}] {k}")
    escrever_json(destino, dados)
    print(f"rascunho: {destino} ({novos_total} arquivo(s) novo(s) no mapa, {mudaram} mudado(s))")


def montar_manifesto(mapa: Mapa, sep: Separacao) -> dict:
    anterior = ler_manifesto(mapa)
    m = {
        "gerado_em": agora_iso(), "gerador": "entregas.py", "mapa": str(mapa.arquivo), "saida": str(mapa.saida),
        "titulo": mapa.titulo, "ordem": mapa.ordem, "repos": {}, "blocos": [],
        "verificacao": anterior.get("verificacao", {}), "typecheck": anterior.get("typecheck", {}),
    }
    for nome, repo in mapa.repos.items():
        if nome not in sep.arquivos:
            continue
        m["repos"][nome] = {
            "raiz": str(repo.raiz), "head": repo.head, "head_curto": repo.head[:9], "branch_atual": repo.branch_atual(),
            "base": repo.base, "remoto": repo.remoto, "arquivos_alterados": len(sep.arquivos[nome]),
            "trechos": sum(len(a.unidades()) for a in sep.arquivos[nome].values()),
            "compartilhados": sep.compartilhados(nome),
            "fora": sep.estatisticas(DONO_FORA, nome),
        }
    for b in mapa.blocos:
        repos_b = mapa.repos_do_bloco(b, sep)
        arquivos = {r: sep.estatisticas(b["id"], r) for r in repos_b}
        m["blocos"].append({
            "id": b["id"], "branch": b["branch"], "titulo": b["titulo"], "pasta": nome_pasta(b),
            "repos": repos_b, "deps": b["deps"], "empilhar": b["empilhar"], "segurar": b["segurar"],
            "resumo": b["resumo"], "itens": b["itens"], "nao_validado": b["nao_validado"],
            "atencao": b["atencao"], "fora_do_bloco": b["fora_do_bloco"],
            "base": {r: base_do_bloco(mapa, b, r) for r in repos_b},
            "arquivos": arquivos,
            "mais": sum(x["mais"] for l in arquivos.values() for x in l),
            "menos": sum(x["menos"] for l in arquivos.values() for x in l),
            "n_arquivos": sum(len(l) for l in arquivos.values()),
            "patches": {r: f"{nome_pasta(b)}/{r}.patch" for r in repos_b if sep.patch(b["id"], r)},
        })
    return m


def base_do_bloco(mapa: Mapa, bloco: dict, repo: str) -> str:
    if bloco["empilhar"] and bloco["deps"]:
        return mapa.por_id[bloco["deps"][-1]]["branch"]
    return bloco.get("base") or mapa.repos[repo].base or "<base>"


SENSIVEIS_POR_NOME = (".env", ".env.*", "*.env", "*.pem", "*.pfx", "*.p12", "*.key", "id_rsa*", "id_dsa*",
                      "id_ecdsa*", "id_ed25519*", "*.jks", "*.keystore", "*.kdbx", "*.tfstate", "credentials.json",
                      "service-account*.json", ".htpasswd")
EXEMPLOS_DE_ENV = (".env.example", ".env.sample", ".env.template", ".env.dist", ".env.defaults")
CABECALHO_PARA_USUARIO = ("PARA O USUÁRIO. Agente (Claude ou outro): não execute nenhum comando deste arquivo; "
                          "mostre-o ao usuário.")


def linhas_adicionadas(patch: bytes) -> list:
    """[(caminho, numero_da_linha_nova, texto)] das linhas + de um patch (pula patch binario)."""
    saida, caminho, num, binario = [], None, 0, False
    for bruto in patch.split(b"\n"):
        if bruto.startswith(b"diff --git "):
            caminho, binario = None, False
            continue
        if bruto.startswith(b"+++ "):
            alvo = ler_caminho(bruto, b"b/")
            caminho = alvo.decode("utf-8", "surrogateescape").replace("\\", "/") if alvo else None
            continue
        if bruto.startswith(b"GIT binary patch"):
            binario = True
            continue
        m = re.match(rb"^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@", bruto)
        if m:
            num = int(m.group(1))
            continue
        if binario or caminho is None:
            continue
        if bruto.startswith(b"+"):
            saida.append((caminho, num, bruto[1:].decode("utf-8", "replace").rstrip("\r")))
            num += 1
        elif bruto.startswith(b" "):
            num += 1
    return saida


def segredos_do_bloco(sep: "Separacao", bid: str, repo: str) -> list:
    """Problemas de segredo do bloco num repo: valor que casa uma regra do segredos.py nas linhas
    acrescentadas, ou arquivo de credencial pelo nome. Nunca inclui o valor."""
    problemas = []
    dados = sep.patch(bid, repo) if repo in sep.arquivos else b""
    por_arquivo: dict = {}
    for caminho, num, texto in linhas_adicionadas(dados or b""):
        por_arquivo.setdefault(caminho, []).append((num, texto))
    for caminho, linhas in por_arquivo.items():
        texto = "\n".join(t for _, t in linhas)
        for a in _segredos.varrer_texto(texto, caminho, False):
            if a["regra"] == getattr(_segredos, "ID_PUBLICA", "chave-publica-cliente"):
                continue
            num = linhas[a["linha"] - 1][0] if 0 < a["linha"] <= len(linhas) else 0
            problemas.append(f"SEGREDO no bloco {bid} [{repo}]: {caminho}:{num} {a['regra']} ({a['descricao']})")
    for caminho in sep.por_bloco.get(bid, {}).get(repo, {}):
        nome = caminho.rsplit("/", 1)[-1]
        if nome in EXEMPLOS_DE_ENV or nome.endswith((".example", ".sample", ".template")):
            continue
        if any(fnmatch.fnmatch(nome, padrao) for padrao in SENSIVEIS_POR_NOME):
            problemas.append(f"SEGREDO no bloco {bid} [{repo}]: {caminho}:0 arquivo-sensivel (arquivo de credencial "
                             f"pelo nome: mova para 'fora' no mapa ou tire do diff)")
        elif fnmatch.fnmatch(nome.lower(), "appsettings*.json") and any(
                re.search(r"(?i)password\s*=", tx) for _, tx in por_arquivo.get(caminho, [])):
            problemas.append(f"SEGREDO no bloco {bid} [{repo}]: {caminho}:0 appsettings-com-senha (Password= em "
                             f"string de conexao)")
    return problemas


def verificar_segredos(mapa: "Mapa", sep: "Separacao") -> dict:
    por_bloco: dict = {}
    for b in mapa.blocos:
        for repo in sep.arquivos:
            probs = segredos_do_bloco(sep, b["id"], repo)
            if probs:
                por_bloco.setdefault(b["id"], []).extend(probs)
    return por_bloco


def imprimir_segredos(seg: dict, cabecalho: str) -> None:
    imprimir_lista(cabecalho, [p for v in seg.values() for p in v], sys.stderr)
    print("o valor nao foi impresso. Tire o segredo do working tree (variavel de ambiente ou cofre) ou marque o "
          "arquivo como 'fora' no mapa, e rode de novo. Segredo que ja foi commitado precisa ser rotacionado.",
          file=sys.stderr)


def cmd_separar(args) -> int:
    mapa = Mapa(args.mapa, args.repo, args.saida)
    sep = Separacao(mapa)
    imprimir_lista("avisos:", sep.avisos)
    if not getattr(args, "aceitar_fim_de_linha", False):
        for nome, repo in mapa.repos.items():
            for caminho, (bruto, sem_cr) in repo.inflados_por_fim_de_linha().items():
                sep.erros.append(f"[{nome}] {caminho}: fim de linha trocado ({bruto} linhas no diff, {sem_cr} ignorando CR). "
                                 f"Restaure o fim de linha original ou use --aceitar-fim-de-linha se a troca e intencional.")
    if sep.erros:
        imprimir_lista("ERROS (nada foi gravado):", sep.erros, sys.stderr)
        return EXIT_FALHA
    seg = verificar_segredos(mapa, sep)
    if seg:
        imprimir_segredos(seg, "SEGREDOS (nada foi gravado):")
        return EXIT_FALHA
    print(f"{'bloco':<6} {'branch':<52} {'repos':<16} {'arq':>4} {'trechos':>7} {'+':>6} {'-':>6}")
    for b in mapa.blocos:
        repos_b = mapa.repos_do_bloco(b, sep)
        n_arq = n_tr = mais = menos = 0
        for r in repos_b:
            for e in sep.estatisticas(b["id"], r):
                n_arq += 1
                n_tr += len(e["trechos"])
                mais += e["mais"]
                menos += e["menos"]
        marca = "  SEGURAR" if b["segurar"] else ""
        print(f"{b['id']:<6} {b['branch'][:52]:<52} {','.join(repos_b)[:16]:<16} {n_arq:>4} {n_tr:>7} {mais:>6} {menos:>6}{marca}")
    for r in sep.fora:
        print(f"{'fora':<6} {'(fica fora da entrega)':<52} {r:<16} {len(sep.fora[r]):>4} "
              f"{sum(len(v) for v in sep.fora[r].values()):>7}")
    if args.simular:
        print("\n--simular: nada foi gravado.")
        return EXIT_OK
    mapa.saida.mkdir(parents=True, exist_ok=True)
    for b in mapa.blocos:
        pasta = pasta_do_bloco(mapa, b)
        pasta.mkdir(parents=True, exist_ok=True)
        for r in mapa.repos:
            destino = pasta / f"{r}.patch"
            dados = sep.patch(b["id"], r) if r in sep.arquivos else b""
            if dados:
                escrever_bytes(destino, dados)
            elif destino.exists() and r in sep.arquivos:
                destino.unlink()
    for r in mapa.repos:
        destino = mapa.saida / PASTA_FORA / f"{r}.patch"
        dados = sep.patch(DONO_FORA, r) if r in sep.arquivos else b""
        if dados:
            escrever_bytes(destino, dados)
        elif destino.exists() and r in sep.arquivos:
            destino.unlink()
    conhecidas = {nome_pasta(b) for b in mapa.blocos} | {PASTA_FORA, PASTA_BACKUP, PASTA_TYPECHECK}
    for p in sorted(mapa.saida.iterdir()):
        if p.is_dir() and re.match(r"^\d", p.name) and p.name not in conhecidas:
            print(f"aviso: pasta sem bloco no mapa (nao foi apagada): {p}")
    escrever_json(caminho_manifesto(mapa), montar_manifesto(mapa, sep))
    print(f"\npatches em {mapa.saida}  (manifesto: {NOME_MANIFESTO})")
    print("proximo passo: entregas.py verificar --mapa " + str(mapa.arquivo))
    return EXIT_OK


def verificar_repo(mapa: Mapa, sep: Separacao, repo: Repo, contra: list[str]) -> tuple[bool, dict]:
    ok = True
    rel = {"head": repo.head, "cada_bloco": {}, "contra": {}, "soma": {}, "desatualizados": []}
    blocos = [b for b in sorted(mapa.blocos, key=lambda x: mapa.ordem.index(x["id"]))]
    patches: dict[str, Path] = {}
    for b in blocos:
        p = pasta_do_bloco(mapa, b) / f"{repo.nome}.patch"
        esperado = sep.patch(b["id"], repo.nome)
        if p.is_file():
            patches[b["id"]] = p
            if p.read_bytes() != esperado:
                rel["desatualizados"].append(str(p))
        elif esperado:
            rel["desatualizados"].append(f"{p} (faltando)")
    pf = mapa.saida / PASTA_FORA / f"{repo.nome}.patch"
    fora = pf if pf.is_file() else None
    if bool(sep.patch(DONO_FORA, repo.nome)) != bool(fora) or (fora and fora.read_bytes() != sep.patch(DONO_FORA, repo.nome)):
        rel["desatualizados"].append(str(pf))
    if rel["desatualizados"]:
        ok = False
        print("  DESATUALIZADO: o working tree ou o mapa mudou depois do 'separar'. Rode 'separar' de novo:")
        for d in rel["desatualizados"]:
            print(f"    {d}")
    if not patches and not fora:
        print("  (nenhum patch deste repositorio)")
        return ok, rel

    revs = [("HEAD", repo.head)]
    for c in contra:
        r = git(repo.raiz, "rev-parse", "--verify", "-q", c + "^{commit}", aceitar=(0, 1, 128))
        sha = r.stdout.decode().strip()
        if r.returncode != 0 or not sha:
            print(f"  aviso: '{c}' nao resolve neste repo (faca git fetch se for remoto); pulado")
            rel["contra"][c] = "nao resolvido"
            continue
        if sha != repo.head:
            revs.append((c, sha))

    with IndiceTemporario(repo) as idx:
        for rotulo, sha in revs:
            print(f"  cada bloco sozinho sobre {rotulo} ({sha[:9]}):")
            res = {}
            for b in blocos:
                if b["id"] not in patches:
                    continue
                idx.reiniciar(sha)
                pilha = []
                if b["empilhar"]:
                    for d in mapa.fecho_deps(b["id"]):
                        if d in patches:
                            pilha.append(d)
                            idx.aplicar(patches[d])
                sucesso, erro = idx.aplicar(patches[b["id"]], so_checar=True)
                extra = f" (empilhado sobre {', '.join(pilha)})" if pilha else ""
                if sucesso:
                    print(f"    OK     {b['id']} {b['branch']}{extra}")
                    res[b["id"]] = "ok"
                    continue
                ok = False
                diag = ""
                deps = [d for d in mapa.fecho_deps(b["id"]) if d in patches]
                if deps and not b["empilhar"]:
                    idx.reiniciar(sha)
                    for d in deps:
                        idx.aplicar(patches[d])
                    if idx.aplicar(patches[b["id"]], so_checar=True)[0]:
                        diag = (f" - aplica so depois de {', '.join(deps)}: junte os trechos num bloco so ou "
                                f"declare \"empilhar\": true")
                print(f"    FALHA  {b['id']} {b['branch']}{extra}{diag}")
                for l in erro.splitlines()[:6]:
                    print(f"           {l}")
                res[b["id"]] = "falha" + diag
            if rotulo == "HEAD":
                rel["cada_bloco"] = res
            else:
                rel["contra"][rotulo] = res

        print("  soma de todos os blocos, na ordem" + (" + trechos 'fora'" if fora else "") + ":")
        idx.reiniciar(repo.head)
        soma_ok = True
        for b in blocos:
            if b["id"] in patches:
                s, erro = idx.aplicar(patches[b["id"]])
                if not s:
                    soma_ok = False
                    print(f"    FALHA ao somar o bloco {b['id']}: {erro.splitlines()[0] if erro else ''}")
        if fora:
            s, erro = idx.aplicar(fora)
            if not s:
                soma_ok = False
                print(f"    FALHA ao somar os trechos 'fora': {erro.splitlines()[0] if erro else ''}")
        arquivos = sep.arquivos[repo.nome]
        entradas = idx.entradas()
        tocados = idx.alterados_contra(repo.head)
        existentes = [c for c, a in arquivos.items() if not a.apagado]
        bytes_wt = hashes(repo, [c for c in existentes if (repo.raiz / c).exists()], filtros=False)
        filtro_wt = None
        iguais_bytes = iguais_filtro = 0
        diferentes: list[str] = []
        for c, a in arquivos.items():
            if a.apagado:
                if c in entradas or (repo.raiz / c).exists():
                    diferentes.append(f"{c} (deveria estar apagado)")
                else:
                    iguais_bytes += 1
                continue
            if c not in entradas:
                diferentes.append(f"{c} (nao ficou no indice)")
                continue
            sha_idx = entradas[c][1]
            if bytes_wt.get(c) == sha_idx:
                iguais_bytes += 1
                continue
            if filtro_wt is None:
                filtro_wt = hashes(repo, [x for x in existentes if (repo.raiz / x).exists()], filtros=True)
            if filtro_wt.get(c) == sha_idx:
                iguais_filtro += 1
            else:
                diferentes.append(c)
        extras = sorted(tocados - set(arquivos))
        for e in extras:
            diferentes.append(f"{e} (alterado pela soma e fora do diff)")
        if diferentes or not soma_ok:
            ok = False
            print(f"    DIFERENTES: {len(diferentes)} de {len(arquivos)}")
            for d in diferentes[:30]:
                print(f"      DIF {d}")
        else:
            via = f" ({iguais_filtro} so depois do filtro de fim de linha do git)" if iguais_filtro else ""
            print(f"    IDENTICAS: {iguais_bytes + iguais_filtro} arquivo(s) alterado(s), "
                  f"comparados com git hash-object arquivo a arquivo{via}")
        rel["soma"] = {"ok": soma_ok and not diferentes, "arquivos": len(arquivos), "iguais_bytes": iguais_bytes,
                       "iguais_via_filtro": iguais_filtro, "diferentes": diferentes,
                       "trechos": sum(len(a.unidades()) for a in arquivos.values())}
    return ok, rel


def cmd_verificar(args) -> int:
    mapa = Mapa(args.mapa, args.repo, args.saida)
    sep = Separacao(mapa)
    if sep.erros:
        imprimir_lista("ERROS no mapa x diff atual:", sep.erros, sys.stderr)
        return EXIT_FALHA
    tudo_ok = True
    relatorio = {"em": agora_iso(), "repos": {}}
    seg = verificar_segredos(mapa, sep)
    if seg:
        imprimir_segredos(seg, "SEGREDOS nos blocos (a separacao nao vale enquanto houver):")
        relatorio["segredos"] = {b: len(v) for b, v in seg.items()}
        tudo_ok = False
    for nome, repo in mapa.repos.items():
        contra = list(args.contra or [])
        if repo.base and repo.base not in contra:
            contra.append(repo.base)
        print(f"=== {nome}  {repo.raiz}")
        ok, rel = verificar_repo(mapa, sep, repo, contra)
        tudo_ok = tudo_ok and ok
        relatorio["repos"][nome] = rel
    relatorio["ok"] = tudo_ok
    man = ler_manifesto(mapa) or montar_manifesto(mapa, sep)
    man["verificacao"] = relatorio
    escrever_json(caminho_manifesto(mapa), man)
    print("\nRESULTADO: " + ("separacao provada (cada bloco aplica sozinho e a soma reproduz o working tree)"
                             if tudo_ok else "REPROVADA - veja as linhas FALHA/DIF/DESATUALIZADO acima"))
    return EXIT_OK if tudo_ok else EXIT_FALHA


# --------------------------------------------------------------------------------------------
# Typecheck por bloco numa copia limpa
# --------------------------------------------------------------------------------------------

def criar_link(origem: Path, destino: Path) -> bool:
    if os.name == "nt" and origem.is_dir():
        try:
            import _winapi
            _winapi.CreateJunction(str(origem), str(destino))
            return True
        except Exception:
            pass
        r = subprocess.run(["cmd", "/c", "mklink", "/J", str(destino), str(origem)], capture_output=True)
        if r.returncode == 0:
            return True
    try:
        os.symlink(str(origem), str(destino), target_is_directory=origem.is_dir())
        return True
    except OSError:
        if origem.is_file():
            shutil.copy2(origem, destino)
            return False
        raise Falha(f"nao consegui ligar {origem} na copia (junction/symlink); use --dentro-do-repo", EXIT_AMBIENTE)


def remover_link(destino: Path) -> None:
    if not os.path.lexists(destino):
        return
    try:
        os.rmdir(destino)
    except OSError:
        os.unlink(destino)
    if os.path.lexists(destino):
        raise Falha(f"nao consegui remover o link {destino}; NAO apaguei a copia para nao seguir o link",
                    EXIT_AMBIENTE)


def apagar_copia(pasta: Path, links: list[Path], raiz_permitida: Path) -> None:
    for l in links:
        remover_link(l)
    pasta = pasta.resolve()
    if raiz_permitida.resolve() not in pasta.parents and pasta != raiz_permitida.resolve():
        raise Falha(f"recusei apagar {pasta}: fora da pasta temporaria {raiz_permitida}", EXIT_AMBIENTE)
    for raiz, dirs, _ in os.walk(pasta):
        for d in dirs:
            p = Path(raiz) / d
            if os.path.islink(p) or (os.name == "nt" and _eh_juncao(p)):
                raise Falha(f"link inesperado dentro da copia ({p}); nao apaguei {pasta}", EXIT_AMBIENTE)
    apagar_pasta(pasta)


def _eh_juncao(p: Path) -> bool:
    try:
        st = os.lstat(p)
    except OSError:
        return False
    return bool(getattr(st, "st_file_attributes", 0) & 0x400)


def extrair_arvore(repo: Repo, rev: str, caminhos: list[str], destino: Path, tmp: Path) -> None:
    tar = tmp / "arvore.tar"
    args = ["archive", "--format=tar", "-o", str(tar), rev]
    if caminhos:
        args += ["--"] + caminhos
    git(repo.raiz, *args)
    destino.mkdir(parents=True, exist_ok=True)
    with tarfile.open(tar) as t:
        try:
            t.extractall(destino, filter="tar")
        except TypeError:
            t.extractall(destino)
    tar.unlink()


def contar(texto: str, padrao: str) -> int:
    rx = re.compile(padrao)
    return sum(1 for l in texto.splitlines() if rx.search(l))


def cmd_typecheck(args) -> int:
    mapa = Mapa(args.mapa, args.repo, args.saida)
    sep = Separacao(mapa)
    if sep.erros:
        imprimir_lista("ERROS no mapa x diff atual:", sep.erros, sys.stderr)
        return EXIT_FALHA
    alvos = []
    for nome, repo in mapa.repos.items():
        if args.so_repo and nome not in args.so_repo:
            continue
        cfg = dict(repo.typecheck or {})
        if args.comando:
            cfg["comando"] = args.comando
        if not cfg.get("comando"):
            if args.so_repo:
                raise Falha(f"repo '{nome}' sem comando de typecheck (use --comando ou repos.{nome}.typecheck.comando)", EXIT_USO)
            continue
        alvos.append((repo, cfg))
    if not alvos:
        raise Falha("nenhum repo com typecheck configurado (repos.<nome>.typecheck.comando) e sem --comando", EXIT_USO)
    so = [normalizar_id(x) for x in (args.so or [])]
    pior = EXIT_OK
    man = ler_manifesto(mapa) or montar_manifesto(mapa, sep)
    man.setdefault("typecheck", {})
    for repo, cfg in alvos:
        print(f"=== typecheck {repo.nome}: {cfg['comando']}")
        cod, rel = typecheck_repo(mapa, sep, repo, cfg, so, args)
        man["typecheck"][repo.nome] = rel
        pior = max(pior, cod)
    escrever_json(caminho_manifesto(mapa), man)
    return pior


def typecheck_repo(mapa: Mapa, sep: Separacao, repo: Repo, cfg: dict, so: list[str], args) -> tuple[int, dict]:
    padrao = args.contar or cfg.get("contar") or CONTAR_PADRAO
    timeout = int(args.timeout or cfg.get("timeout") or 1800)
    links = args.links if args.links is not None else cfg.get("links", ["node_modules"])
    arquivos_cfg = args.arquivos if args.arquivos is not None else cfg.get("arquivos", [])
    dentro = args.dentro_do_repo or cfg.get("dentro_do_repo")
    logs = mapa.saida / PASTA_TYPECHECK / repo.nome
    logs.mkdir(parents=True, exist_ok=True)

    blocos = [b for b in sorted(mapa.blocos, key=lambda x: mapa.ordem.index(x["id"]))
              if sep.patch(b["id"], repo.nome)]
    patches = {b["id"]: pasta_do_bloco(mapa, b) / f"{repo.nome}.patch" for b in blocos}
    for bid, p in patches.items():
        if not p.is_file() or p.read_bytes() != sep.patch(bid, repo.nome):
            raise Falha(f"patch ausente ou desatualizado: {p}. Rode 'separar' antes.", EXIT_FALHA)

    execucoes: list[tuple[str, list[str]]] = [("base", [])]
    for b in blocos:
        if so and b["id"] not in so:
            continue
        execucoes.append((b["id"], [b["id"]]))
        deps = [d for d in mapa.fecho_deps(b["id"]) if d in patches]
        if deps:
            execucoes.append((f"{b['id']}+deps", deps + [b["id"]]))
    if not so and len(blocos) > 1:
        execucoes.append(("todos", [b["id"] for b in blocos]))

    caminhos = list(arquivos_cfg)
    if caminhos:
        tocados = set()
        for b in blocos:
            for e in sep.estatisticas(b["id"], repo.nome):
                tocados.add(e["caminho"])
        for c in sorted(tocados):
            if git(repo.raiz, "cat-file", "-e", f"HEAD:{c}", aceitar=(0, 1, 128)).returncode == 0 \
                    and not any(c == x or c.startswith(x.rstrip("/") + "/") for x in caminhos):
                caminhos.append(c)

    if dentro:
        raiz_tmp = (repo.raiz / dentro).resolve()
        if repo.raiz not in raiz_tmp.parents:
            raise Falha(f"--dentro-do-repo precisa ficar dentro de {repo.raiz}", EXIT_USO)
        teste = raiz_tmp / "x"
        ign = git(repo.raiz, "check-ignore", "-q", str(teste.relative_to(repo.raiz)).replace("\\", "/"), aceitar=(0, 1))
        if ign.returncode != 0:
            raise Falha(f"{dentro} nao e ignorado pelo git: a copia apareceria no status e no typecheck da raiz", EXIT_USO)
        if raiz_tmp.exists():
            if (raiz_tmp / MARCA_COPIA).exists():
                print(f"  aviso: sobra de rodada anterior em {raiz_tmp}; apagando (ela infla o typecheck da raiz)")
                apagar_copia(raiz_tmp, [], raiz_tmp)
            else:
                raise Falha(f"{raiz_tmp} ja existe e nao e uma copia deste script; escolha outra pasta", EXIT_USO)
        criados_pais = [p for p in raiz_tmp.parents if repo.raiz in p.parents and not p.exists()]
        raiz_tmp.mkdir(parents=True)
    else:
        criados_pais = []
        raiz_tmp = Path(tempfile.mkdtemp(prefix="entregas-tc-")).resolve()
    (raiz_tmp / MARCA_COPIA).write_text("copia temporaria do entregas.py; pode apagar\n", encoding="utf-8")
    resultados: dict[str, dict] = {}
    try:
        base = raiz_tmp / "base"
        extrair_arvore(repo, repo.head, caminhos, base, raiz_tmp)
        print(f"  copia limpa de HEAD {repo.head[:9]} em {raiz_tmp}" + (f" (so {len(caminhos)} caminho(s))" if caminhos else ""))

        def executar(rotulo: str, aplicar: list[str]) -> dict:
            pasta = raiz_tmp / ("r-" + re.sub(r"[^A-Za-z0-9_.-]", "_", rotulo))
            shutil.copytree(base, pasta, symlinks=True)
            criados = []
            try:
                for nome in links:
                    origem = repo.raiz / nome
                    destino = pasta / nome
                    if not origem.exists():
                        continue
                    if os.path.lexists(destino):
                        continue
                    if criar_link(origem, destino):
                        criados.append(destino)
                env = ambiente_git({"GIT_CEILING_DIRECTORIES": str(pasta.parent)})
                for bid in aplicar:
                    r = subprocess.run(["git", "-c", "core.longpaths=true", "apply", "-p1", "--whitespace=nowarn",
                                        str(patches[bid])],
                                       cwd=str(pasta), capture_output=True, env=env)
                    if r.returncode != 0:
                        return {"rotulo": rotulo, "aplicados": aplicar, "erro_apply": bid,
                                "detalhe": r.stderr.decode("utf-8", "replace").strip()[:500]}
                try:
                    r = subprocess.run(cfg["comando"], shell=True, cwd=str(pasta), capture_output=True, timeout=timeout,
                                       env=ambiente_git())
                    saida = r.stdout.decode("utf-8", "replace") + "\n" + r.stderr.decode("utf-8", "replace")
                    codigo = r.returncode
                except subprocess.TimeoutExpired:
                    saida, codigo = f"TIMEOUT depois de {timeout}s", -1
                log = logs / f"{rotulo}.txt"
                escrever_texto(log, saida)
                return {"rotulo": rotulo, "aplicados": aplicar, "erros": contar(saida, padrao),
                        "codigo_saida": codigo, "log": str(log)}
            finally:
                apagar_copia(pasta, criados, raiz_tmp)

        n = max(1, int(args.paralelo or 1))
        primeira = executar(*execucoes[0])
        resultados["base"] = primeira
        print(f"  base (HEAD, sem patch): {primeira.get('erros')} erro(s)  [log {primeira.get('log')}]")
        with ThreadPoolExecutor(max_workers=n) as ex:
            for r in ex.map(lambda e: executar(*e), execucoes[1:]):
                resultados[r["rotulo"]] = r
    finally:
        if not args.manter:
            apagar_copia(raiz_tmp, [], raiz_tmp)
        else:
            print(f"  --manter: copia preservada em {raiz_tmp} (apague depois; os links ja foram removidos)")
        if dentro and not args.manter and raiz_tmp.exists():
            raise Falha(f"a copia {raiz_tmp} ficou para tras dentro do repo: apague antes de medir o typecheck da raiz",
                        EXIT_AMBIENTE)
        if not args.manter:
            for p in criados_pais:
                try:
                    p.rmdir()
                except OSError:
                    pass

    base_n = resultados["base"].get("erros", 0)
    cod = EXIT_OK
    if base_n == 0 and resultados["base"].get("codigo_saida", 0) != 0:
        cod = EXIT_AMBIENTE
        print("  MEDICAO QUEBRADA: a base saiu com erro e zero linhas contadas. Nenhum numero abaixo vale ate "
              "corrigir o comando ou o --contar (veja o log da base).")
    linhas = []
    for rotulo, r in resultados.items():
        if rotulo == "base":
            continue
        if "erro_apply" in r:
            cod = max(cod, EXIT_FALHA)
            primeira_linha = (r["detalhe"].splitlines() or [""])[0][:160]
            linhas.append(f"  {rotulo:<14} FALHA ao aplicar o bloco {r['erro_apply']}: {primeira_linha}")
            r["veredito"] = "falha-apply"
            continue
        n_err = r["erros"]
        delta = n_err - base_n
        if r.get("codigo_saida") == -1:
            cod = max(cod, EXIT_FALHA)
            r["veredito"] = "timeout"
            linhas.append(f"  {rotulo:<14} TIMEOUT: aumente --timeout; sem numero valido")
            continue
        if rotulo.endswith("+deps") or rotulo == "todos":
            v = "igual a base" if delta == 0 else f"{delta:+d} contra a base"
        elif delta == 0:
            v = "igual a base: nenhum erro novo"
        elif delta < 0:
            v = (f"{delta:+d}: abaixo da base. Confira se o bloco corrige erros antigos ou se quebrou a sintaxe "
                 f"(erro de sintaxe interrompe a analise e esconde o resto)")
        else:
            com = resultados.get(f"{rotulo}+deps")
            if com and "erros" in com and com["erros"] <= base_n:
                v = (f"{delta:+d} sozinho; com as dependencias ({', '.join(mapa.fecho_deps(rotulo))}) "
                     f"{com['erros']}: depende delas, declare a ordem")
            else:
                v = f"{delta:+d}: ERRO NOVO. Declare a dependencia que falta ou corrija antes de entregar"
                cod = max(cod, EXIT_FALHA)
        r["delta"] = delta
        r["veredito"] = v
        linhas.append(f"  {rotulo:<14} {n_err:>6}  {v}")
    print(f"  {'execucao':<14} {'erros':>6}")
    print(f"  {'base':<14} {base_n:>6}  divida de tipos que ja existe em HEAD")
    for l in linhas:
        print(l)
    return cod, {"em": agora_iso(), "comando": cfg["comando"], "contar": padrao, "head": repo.head,
                 "base": base_n, "execucoes": resultados}


# --------------------------------------------------------------------------------------------
# Comandos para o usuario (texto), commit, PR e COMO-APLICAR
# --------------------------------------------------------------------------------------------

def aspas(p) -> str:
    s = str(p)
    return f'"{s}"' if re.search(r"[^A-Za-z0-9_\-.:/\\~+@]", s) else s


def sem_tags(t: str) -> str:
    t = re.sub(r"</?b>", "**", t or "")
    return re.sub(r"<[^>]+>", "", t)


def mensagem_commit(mapa: Mapa, b: dict, repo: str) -> tuple[str, bool]:
    c = b["commit"]
    if isinstance(c, dict):
        c = c.get(repo)
    if c:
        return c.rstrip("\n") + "\n", True
    prefixo = b["branch"].split("/", 1)[0] if "/" in b["branch"] else "chore"
    linhas = [f"{prefixo}: {sem_tags(b['titulo']).replace('**', '')}"]
    if b["resumo"]:
        linhas += ["", sem_tags(b["resumo"]).replace("**", "")]
    if b["itens"]:
        linhas += [""] + [f"- {sem_tags(x).replace('**', '')}" for x in b["itens"]]
    if b["nao_validado"]:
        linhas += ["", "Não validado:"] + [f"- {sem_tags(x).replace('**', '')}" for x in b["nao_validado"]]
    return "\n".join(linhas) + "\n", False


def texto_aplicar(mapa: Mapa, sep: Separacao, b: dict) -> str:
    pasta = pasta_do_bloco(mapa, b)
    l = [f"# {CABECALHO_PARA_USUARIO}", "#",
         f"# Bloco {b['id']} - {b['branch']}", f"# {sem_tags(b['titulo']).replace('**', '')}",
         f"# Gerado por entregas.py em {agora_iso()}. O script NÃO executa nada disto: o usuário roda,",
         "# um comando por vez, na ordem. Nada foi commitado nem enviado.", "#",
         "# Passo 0 (uma vez só, antes do primeiro bloco): guardar o que está aberto.",
         "# Ver COMO-APLICAR.md na raiz da entrega.", "#"]
    if b["deps"]:
        l.append(f"# Depende de: {', '.join('bloco ' + d + ' (' + mapa.por_id[d]['branch'] + ')' for d in b['deps'])}")
        l.append("#   " + ("crie esta branch A PARTIR da branch da dependência (empilhada)." if b["empilhar"]
                         else "suba e faça o merge da dependência antes desta."))
    else:
        l.append("# Depende de: nenhum bloco")
    if b["segurar"]:
        l += ["#", "# !!! SEGURAR: NÃO ABRA PR AINDA.", f"# Causa: {sem_tags(b['segurar'].get('causa', ''))}"]
        for s in b["segurar"].get("saidas") or []:
            l.append(f"# Saída possível: {sem_tags(s)}")
    l.append("")
    for r in mapa.repos_do_bloco(b, sep):
        patch = pasta / f"{r}.patch"
        if not sep.patch(b["id"], r):
            continue
        repo = mapa.repos[r]
        base = base_do_bloco(mapa, b, r)
        commit = pasta / f"COMMIT-{r}.txt"
        tem_remoto = repo.tem_remoto()
        l += [f"# ===== {r}  ({repo.raiz})", f"cd {aspas(repo.raiz)}",
              "# o status abaixo precisa sair vazio (se não, faça o Passo 0)", "git status --short",
              f"git checkout {base}"]
        if not b["empilhar"]:
            if base.startswith("<"):
                l.append("git pull")
            elif not tem_remoto:
                l.append(f"# sem remoto {repo.remoto}: pull omitido")
            elif not repo.tem_upstream(base):
                l.append("# base sem upstream: pull omitido")
            else:
                l.append("git pull")
        l += [f"git checkout -b {b['branch']}",
              "# --check primeiro: se a base andou e o patch não encaixa, nada é alterado",
              f"git apply --index --check {aspas(patch)}",
              "# --index aplica e já deixa no índice SÓ os arquivos do patch (não use git add -A)",
              f"git apply --index {aspas(patch)}",
              "git diff --cached --stat",
              f"git commit -F {aspas(commit)}"]
        l += [f"git push -u {repo.remoto} {b['branch']}" if tem_remoto
              else f"# sem remoto {repo.remoto}: suba quando houver", ""]
    return "\n".join(l).rstrip("\n") + "\n"


def texto_pr(mapa: Mapa, sep: Separacao, b: dict) -> str:
    repos_b = mapa.repos_do_bloco(b, sep)
    bases = sorted({base_do_bloco(mapa, b, r) for r in repos_b}) or ["<base>"]
    l = [f"# {sem_tags(b['titulo'])}", "", f"Branch: `{b['branch']}` → `{' / '.join(bases)}`", ""]
    if b["segurar"]:
        l += [f"> **SEGURAR: não fazer merge ainda.** {sem_tags(b['segurar'].get('causa', ''))}", ">"]
        for s in b["segurar"].get("saidas") or []:
            l.append(f"> - Saída: {sem_tags(s)}")
        l.append("")
    if b["resumo"]:
        l += [sem_tags(b["resumo"]), ""]
    l += ["## O que muda", ""]
    l += [f"- {sem_tags(x)}" for x in b["itens"]] or ["- (descreva os itens no campo \"itens\" do bloco no mapa)"]
    l += ["", "## Arquivos", "", "| Repo | Arquivo | + | − |", "|---|---|---:|---:|"]
    for r in repos_b:
        for e in sep.estatisticas(b["id"], r):
            n_t = len(e["trechos"])
            parcial = ("" if n_t == e["de"] else
                       f" — só {'o trecho' if n_t == 1 else 'os trechos'} {', '.join(map(str, e['trechos']))}"
                       f" dos {e['de']} do arquivo")
            l.append(f"| {r} | `{e['caminho']}`{parcial} | {e['mais']} | {e['menos']} |")
    if b["nao_validado"] is None:
        nv = ["⚠️ Não informado no mapa. Preencha `nao_validado` do bloco (lista vazia = tudo foi validado com prova)."]
    else:
        nv = [f"- {sem_tags(x)}" for x in b["nao_validado"]] or ["Nenhum: todos os itens foram testados, com prova."]
    l += ["", "## Ainda não validado", ""] + nv
    l += ["", "## Atenção do revisor", ""] + ([f"- {sem_tags(x)}" for x in b["atencao"]] or ["Nenhum."])
    l += ["", "## Fora deste bloco", ""] + ([f"- {sem_tags(x)}" for x in b["fora_do_bloco"]] or ["Nenhum."])
    l += ["", "## Depende de", ""] + ([f"- bloco {d} (`{mapa.por_id[d]['branch']}`)" for d in b["deps"]] or ["Nenhum."])
    l += ["", f"Provas (prints antes/depois): `{nome_pdf_bloco(b)}.pdf` (gerado pelo provas.py nesta pasta)", ""]
    return "\n".join(l)


def texto_como_aplicar(mapa: Mapa, sep: Separacao) -> str:
    data = f"{datetime.now():%Y-%m-%d}"
    l = [f"# {CABECALHO_PARA_USUARIO}", "", f"# {mapa.titulo}", ""]
    bases = []
    for nome, repo in mapa.repos.items():
        if nome in sep.arquivos:
            bases.append(f"{nome} `{repo.base or '<base>'}` (HEAD `{repo.head[:9]}`)")
    l += ["Base: " + " · ".join(bases) + ".", "",
          "Cada pasta é uma branch. Dentro dela: `<repo>.patch`, `COMMIT-<repo>.txt`, `APLICAR.txt`, `PR.md` e o PDF",
          "de provas (nome da branch na capa e no rodapé de cada página). **Nada foi commitado nem enviado:** quem cria",
          "as branches, commita e sobe é o usuário, com os comandos de cada `APLICAR.txt`, que o usuário roda.", "",
          "## Passo 0 — uma vez só, antes do primeiro bloco", "",
          "Hoje o working tree tem TODAS as mudanças abertas. Para criar cada branch limpa a partir da base, guarde tudo",
          f"primeiro (o backup em `{PASTA_BACKUP}/` é uma segunda cópia; `-u` guarda também os arquivos novos):", "", "```"]
    for nome, repo in mapa.repos.items():
        if nome in sep.arquivos:
            l += [f"cd {aspas(repo.raiz)}", f'git stash push -u -m "entregas-{data}-antes-das-branches"']
    l += ["```", "", "Depois, para cada bloco na ordem abaixo, siga o `APLICAR.txt` da pasta. Se a base andar entre um bloco e",
          "outro, o `git apply --check` avisa antes de mexer em qualquer arquivo.", ""]
    compart = {r: sep.compartilhados(r) for r in sep.arquivos}
    n_comp = sum(len(v) for v in compart.values())
    l += ["⚠️ Use o `git apply` com o patch — **não copie arquivos inteiros** do working tree."]
    if n_comp:
        l += ["", f"{n_comp} arquivo(s) têm trechos de mais de um bloco:", ""]
        for r, d in compart.items():
            for c, donos in sorted(d.items()):
                l.append(f"- {r}: `{c}` — blocos {', '.join(donos)}")
    l += ["", "⚠️ Trocar de branch muda os arquivos que o servidor de desenvolvimento e a IDE estão usando.", "",
          "## Ordem sugerida", ""]
    n = 0
    segurar = []
    for bid in mapa.ordem:
        b = mapa.por_id[bid]
        if b["segurar"]:
            segurar.append(b)
            continue
        if not any(sep.patch(bid, r) for r in sep.arquivos):
            continue
        n += 1
        dep = f" (depois do {', '.join(b['deps'])}{', empilhada' if b['empilhar'] else ''})" if b["deps"] else ""
        l.append(f"{n}. `{b['branch']}`{dep} — {sem_tags(b['titulo'])}")
    l += ["", "## Segurar", ""]
    if segurar:
        for b in segurar:
            l.append(f"- `{b['branch']}` (bloco {b['id']}) — {sem_tags(b['segurar'].get('causa', ''))}")
            for s in b["segurar"].get("saidas") or []:
                l.append(f"  - saída: {sem_tags(s)}")
    else:
        l.append("Nenhum.")
    l += ["", "## Fora da entrega", ""]
    algum = False
    for r in sep.arquivos:
        est = sep.estatisticas(DONO_FORA, r)
        if est:
            algum = True
            l.append(f"- {r}: {len(est)} arquivo(s), {sum(len(e['trechos']) for e in est)} trecho(s) marcados `fora` "
                     f"(patch em `{PASTA_FORA}/{r}.patch`; continuam no stash e no backup).")
    if not algum:
        l.append("Nenhum.")
    l += ["", "## Depois de subir tudo", "",
          "O stash continua guardado (`git stash list`). Quando todas as branches estiverem no remoto e conferidas,",
          "ele pode ser descartado com `git stash drop`, ou mantido como cópia de segurança. Blocos segurados e trechos",
          "`fora` continuam no stash e no backup até a decisão.", ""]
    return "\n".join(l)


def linhas_comandos(mapa: Mapa, sep: Separacao, b: dict) -> list[str]:
    linhas: list[str] = []
    for l in texto_aplicar(mapa, sep, b).splitlines():
        if l.strip() and not l.startswith("#"):
            linhas.append(l)
    return linhas


def linhas_verificacao(mapa: Mapa, sep: Separacao, b: dict, man: dict) -> list[str]:
    ver = (man.get("verificacao") or {}).get("repos") or {}
    tc = man.get("typecheck") or {}
    n_blocos = len([x for x in mapa.blocos if any(sep.patch(x["id"], r) for r in sep.arquivos)])
    saida: list[str] = []
    for r in mapa.repos_do_bloco(b, sep):
        if not sep.patch(b["id"], r):
            continue
        rv = ver.get(r)
        if not rv:
            saida.append(f"{r}: separação ainda não verificada (rode `entregas.py verificar`).")
            continue
        head = (rv.get("head") or "")[:9]
        res = (rv.get("cada_bloco") or {}).get(b["id"])
        if res == "ok":
            pilha = " por cima das dependências" if b["empilhar"] else " sem mais nada aplicado"
            saida.append(f"`git apply --check` do `{r}.patch` sobre a base ({r} `{head}`){pilha}: **OK**.")
        elif res:
            saida.append(f"`git apply --check` do `{r}.patch` sobre a base ({r} `{head}`): **FALHOU** ({res}).")
        for rev, resc in (rv.get("contra") or {}).items():
            if isinstance(resc, dict) and b["id"] in resc:
                saida.append(f"Também sobre `{rev}`: **{'OK' if resc[b['id']] == 'ok' else 'FALHOU'}**.")
        soma = rv.get("soma") or {}
        if soma.get("ok"):
            filtro = (f" ({soma['iguais_via_filtro']} só depois do filtro de fim de linha do git)"
                      if soma.get("iguais_via_filtro") else "")
            saida.append(f"A soma dos {n_blocos} blocos, aplicada em ordem, reproduz byte a byte os "
                         f"{soma.get('arquivos')} arquivos alterados do {r}{filtro}; {soma.get('trechos')} trechos, "
                         f"nenhum sem dono nem com dois donos.")
        elif soma:
            saida.append(f"A soma dos blocos **não** reproduz o working tree do {r}: "
                         f"{len(soma.get('diferentes') or [])} arquivo(s) diferente(s).")
        t = tc.get(r)
        if t and (t.get("execucoes") or {}).get(b["id"]):
            ex = t["execucoes"]
            so = ex[b["id"]]
            if "erros" in so:
                txt = (f"`{t.get('comando')}` numa cópia limpa: base **{t.get('base')}**; este bloco sozinho "
                       f"**{so['erros']}** ({so['erros'] - t.get('base', 0):+d})")
                com = ex.get(f"{b['id']}+deps")
                if com and "erros" in com:
                    txt += f"; com {', '.join(mapa.fecho_deps(b['id']))} **{com['erros']}**"
                saida.append(txt + ".")
    return saida


def nome_pdf_bloco(b: dict) -> str:
    return f"{b['id']}-{b['branch'].replace('/', '__')}"


def spec_provas(mapa: Mapa, sep: Separacao, b: dict, man: dict) -> dict:
    repos_b = [r for r in mapa.repos_do_bloco(b, sep) if sep.patch(b["id"], r)]
    bases = " · ".join(f"{r} `{mapa.repos[r].head[:9]}`" for r in repos_b)
    base_nome = sorted({base_do_bloco(mapa, b, r) for r in repos_b})
    ordem = []
    if len(repos_b) > 1:
        ordem.append("Aplicar na ordem: " + ", depois ".join(repos_b) + ".")
    if b["deps"]:
        ordem.append(("Criar a partir da branch do bloco " if b["empilhar"] else "Subir depois do bloco ")
                     + ", ".join(b["deps"]) + ".")
    if not ordem:
        ordem.append("Pode subir sozinho.")
    msgs = {r: mensagem_commit(mapa, b, r)[0] for r in repos_b}
    spec = {
        "_ajuda": ("Gerado por entregas.py (mapa + entrega.json). Preencha 'itens' (ANTES · POR QUE · DEPOIS · "
                   "STATUS, com as provas) e 'nao_validado'; depois: provas.py gerar provas.json --pr --conferir. "
                   "'entregas.py comandos --atualizar-provas' renova base, patches, comandos e verificacao sem "
                   "tocar no resto."),
        "id": b["id"], "nome": nome_pdf_bloco(b), "titulo": sem_tags(b["titulo"]), "rotulo": f"Bloco {b['id']} · branch",
        "branch": b["branch"],
        "resumo": b["resumo"], "rodape": f"{b['branch']} · bloco {b['id']}", "repos": repos_b,
        "base": f"`{' / '.join(base_nome)}` — {bases}",
        "depende": [f"bloco {d} (`{mapa.por_id[d]['branch']}`)" for d in b["deps"]],
        "ordem": " ".join(ordem),
        "patches": [{"repo": r, "arquivo": f"{r}.patch"} for r in repos_b],
        "itens": [], "_itens_do_mapa": b["itens"],
        "atencao": b["atencao"], "fora": b["fora_do_bloco"],
        "comandos": linhas_comandos(mapa, sep, b),
        "commit": msgs,
        "verificacao": linhas_verificacao(mapa, sep, b, man),
        "pr": {"destino": " / ".join(base_nome)},
    }
    if b["nao_validado"] is not None:
        spec["nao_validado"] = b["nao_validado"]
    if b["segurar"]:
        saidas = b["segurar"].get("saidas") or []
        causa = sem_tags(b["segurar"].get("causa", "")).strip()
        if causa and causa[-1] not in ".!?":
            causa += "."
        texto = f"NÃO ABRIR PR AINDA. {causa}"
        if saidas:
            texto += " Saídas: " + "; ".join(f"({chr(97 + i)}) {sem_tags(x)}" for i, x in enumerate(saidas)) + "."
        spec["alerta"] = [texto]
    spec["_verificacao_auto"] = spec["verificacao"]
    return spec


def cmd_comandos(args) -> int:
    mapa = Mapa(args.mapa, args.repo, args.saida)
    sep = Separacao(mapa)
    if sep.erros:
        imprimir_lista("ERROS no mapa x diff atual:", sep.erros, sys.stderr)
        return EXIT_FALHA
    rascunhos = []
    sem_nv: list[str] = []
    man = ler_manifesto(mapa) or montar_manifesto(mapa, sep)
    seg = verificar_segredos(mapa, sep)
    esc = EscritaMascarada()
    for b in mapa.blocos:
        pasta = pasta_do_bloco(mapa, b)
        repos_b = [r for r in mapa.repos_do_bloco(b, sep) if sep.patch(b["id"], r)]
        if not repos_b:
            continue
        for r in repos_b:
            if not (pasta / f"{r}.patch").is_file():
                raise Falha(f"falta {pasta / (r + '.patch')}: rode 'separar' antes", EXIT_FALHA)
        if b["id"] in seg:
            if (pasta / "APLICAR.txt").exists():
                (pasta / "APLICAR.txt").unlink()
            print(f"bloco {b['id']}: APLICAR.txt NAO gerado (segredo no bloco)", file=sys.stderr)
        else:
            esc.texto(pasta / "APLICAR.txt", texto_aplicar(mapa, sep, b))
        for r in repos_b:
            msg, do_mapa = mensagem_commit(mapa, b, r)
            msg = _mascara.mascarar(msg, estrito=True)[0]
            destino = pasta / f"COMMIT-{r}.txt"
            if destino.exists() and destino.read_text(encoding="utf-8") != msg and not args.sobrescrever:
                print(f"aviso: {destino} difere do mapa e foi mantido (use --sobrescrever para trocar)")
            else:
                esc.texto(destino, msg)
            if not do_mapa:
                rascunhos.append(f"{b['id']}/{r}")
        pr = pasta / "PR.md"
        if not pr.exists() or args.sobrescrever:
            esc.texto(pr, texto_pr(mapa, sep, b))
        sp = pasta / "provas.json"
        nova = spec_provas(mapa, sep, b, man)
        if not sp.exists():
            esc.json(sp, nova)
        elif getattr(args, "atualizar_provas", False):
            try:
                atual = json.loads(sp.read_text(encoding="utf-8"))
            except json.JSONDecodeError:
                raise Falha(f"{sp} com JSON invalido; corrija antes de --atualizar-provas", EXIT_USO)
            auto_antigo = atual.get("_verificacao_auto") or []
            manuais = [x for x in (atual.get("verificacao") or []) if x not in auto_antigo]
            for k in ("base", "patches", "comandos", "repos", "rodape", "branch"):
                atual[k] = nova[k]
            atual.setdefault("nome", nova["nome"])
            atual["verificacao"] = nova["verificacao"] + manuais
            atual["_verificacao_auto"] = nova["verificacao"]
            esc.json(sp, atual)
        if b["nao_validado"] is None:
            sem_nv.append(b["id"])
    esc.texto(mapa.saida / "COMO-APLICAR.md", texto_como_aplicar(mapa, sep))
    print(f"APLICAR.txt, COMMIT-*.txt, PR.md, provas.json e COMO-APLICAR.md em {mapa.saida}")
    if not (man.get("verificacao") or {}).get("repos"):
        print("aviso: sem verificacao no entrega.json; o provas.json diz 'ainda nao verificada'. "
              "Rode verificar e depois 'comandos --atualizar-provas'.")
    if sem_nv:
        print("blocos sem 'nao_validado' no mapa (o PR.md avisa; preencha, lista vazia = tudo validado): "
              + ", ".join(sem_nv))
    if rascunhos:
        print("mensagem de commit gerada como RASCUNHO (sem 'commit' no mapa), revise: " + ", ".join(rascunhos))
    print("lembrete: o script nao criou branch nem commit. Quem roda os comandos e o usuario.")
    for caminho, n in esc.trocas:
        _mascara.avisar(n, str(caminho))
    if seg:
        imprimir_segredos(seg, "SEGREDOS nos blocos (APLICAR.txt desses blocos nao foi gerado):")
        return EXIT_FALHA
    if esc.trocas:
        return EXIT_FALHA
    return EXIT_OK


def cmd_backup(args) -> int:
    mapa = Mapa(args.mapa, args.repo, args.saida)
    destino = mapa.saida / PASTA_BACKUP
    destino.mkdir(parents=True, exist_ok=True)
    antigos = [p for p in destino.iterdir() if p.is_file()]
    if antigos:
        guarda = destino / f"anterior-{agora_carimbo()}"
        guarda.mkdir()
        for p in antigos:
            shutil.move(str(p), str(guarda / p.name))
        for p in [x for x in destino.iterdir() if x.is_dir() and x.name.endswith("-novos")]:
            shutil.move(str(p), str(guarda / p.name))
        print(f"backup anterior movido para {guarda}")
    for nome, repo in mapa.repos.items():
        raw = git(repo.raiz, "diff", "HEAD", "--binary", "--full-index", "--no-color", "--no-ext-diff",
                  "--no-textconv", "--no-renames", "--src-prefix=a/", "--dst-prefix=b/").stdout
        escrever_bytes(destino / f"{nome}-tudo.patch", raw)
        status = git(repo.raiz, "status", "--porcelain=v1", "-uall").stdout
        escrever_bytes(destino / f"{nome}-status.txt", status)
        escrever_texto(destino / f"{nome}-head.txt",
                       f"repo: {repo.raiz}\nhead: {repo.head}\nbranch: {repo.branch_atual()}\nem: {agora_iso()}\n"
                       f"reaplicar tudo: git apply --index {aspas(destino / (nome + '-tudo.patch'))}\n")
        novos = repo.nao_rastreados()
        if novos:
            pasta = destino / f"{nome}-novos"
            for p in novos:
                origem = repo.raiz / p
                if origem.is_file():
                    alvo = pasta / p
                    alvo.parent.mkdir(parents=True, exist_ok=True)
                    shutil.copy2(origem, alvo)
        print(f"{nome}: {len(raw)} bytes de diff, {len(novos)} arquivo(s) novo(s) copiado(s) -> {destino}")
        sensiveis = []
        for caminho, num, texto in linhas_adicionadas(raw):
            if any(a["regra"] != getattr(_segredos, "ID_PUBLICA", "") for a in _segredos.varrer_texto(texto, caminho, False)):
                sensiveis.append(f"{caminho}:{num}")
        sensiveis += [p for p in novos if any(fnmatch.fnmatch(p.rsplit("/", 1)[-1], pd) for pd in SENSIVEIS_POR_NOME)
                      and p.rsplit("/", 1)[-1] not in EXEMPLOS_DE_ENV]
        if sensiveis:
            print(f"aviso: o backup de {nome} guarda segredo do working tree ({', '.join(sensiveis[:6])}"
                  f"{' ...' if len(sensiveis) > 6 else ''}; valor nao impresso): e copia local, nao compartilhe "
                  f"{destino}", file=sys.stderr)
    return EXIT_OK


def cmd_validar(args) -> int:
    mapa = Mapa(args.mapa, args.repo, args.saida)
    print(f"mapa ok: {len(mapa.blocos)} bloco(s), {len(mapa.repos)} repo(s), saida {mapa.saida}")
    for bid in mapa.ordem:
        b = mapa.por_id[bid]
        extras = []
        if b["deps"]:
            extras.append("depende de " + ", ".join(b["deps"]) + (" (empilhada)" if b["empilhar"] else ""))
        if b["segurar"]:
            extras.append("SEGURAR")
        print(f"  {bid}  {b['branch']}" + (f"  [{'; '.join(extras)}]" if extras else ""))
    for nome, regras in mapa.regras.items():
        print(f"  mapa.{nome}: {len(regras)} regra(s) de arquivo")
    print("(o diff atual nao foi lido; 'hunks --mapa' mostra trecho a trecho)")
    return EXIT_OK


def cmd_tudo(args) -> int:
    pior = EXIT_OK
    args.so_repo = None
    args.comando = None
    args.so = None
    passos = [cmd_backup, cmd_separar, cmd_verificar] + ([cmd_typecheck] if args.typecheck else []) + [cmd_comandos]
    for passo in passos:
        print(f"\n##### {passo.__name__.replace('cmd_', '')}")
        cod = passo(args)
        pior = max(pior, cod)
        if passo is cmd_separar and cod != EXIT_OK:
            return cod
    return pior


def _chave_ficticia() -> list:
    """Corpo de chave privada FICTICIO (base64 de texto fixo): so para o autoteste."""
    import base64
    corpo = base64.b64encode(b"chave-ficticia-do-autoteste-entregas-qa-total-" * 6).decode()
    return [corpo[i:i + 64] for i in range(0, len(corpo), 64)]


def casos_autoteste_resumo() -> list:
    corpo = _chave_ficticia()
    inicio, fim = "-----BEGIN RSA PRIVATE KEY-----", "-----END RSA PRIVATE KEY-----"

    def trecho(linhas):
        t = Trecho(b"@@ -1,3 +1,12 @@")
        t.linhas = [l.encode("utf-8") for l in linhas]
        return t
    return [
        ("chave inteira no trecho", trecho(["+" + inicio] + ["+" + c for c in corpo] + ["+" + fim, "+x = 1"]), corpo),
        ("BEGIN no contexto", trecho([" " + inicio] + ["+" + c for c in corpo[:3]] + [" " + c for c in corpo[3:]]
                                    + [" " + fim]), corpo[:3]),
        ("END sem BEGIN", trecho(["+" + c[:30] for c in corpo[:2]] + [" " + fim, "+y = 2"]),
         [c[:30] for c in corpo[:2]]),
        ("BEGIN sem END", trecho(["+z = 3", "+" + inicio] + ["+" + c[:30] for c in corpo[:2]]),
         [c[:30] for c in corpo[:2]]),
        ("senha em JSON quebrado em linhas", trecho(['+  "password":', '+    "Pr4ia#Verde2026"']), ["Pr4ia#Verde2026"]),
    ]


def cmd_autoteste(args) -> int:
    falhas, falhos = [], set()
    casos = casos_autoteste_resumo()
    for rotulo, t, segredos_do_caso in casos:
        for largura in (90, 70):
            r = t.resumo(40, largura)
            vazou = [x for x in segredos_do_caso if x[:12] in r or x[-12:] in r]
            if vazou:
                falhos.add(rotulo)
                falhas.append(f"resumo ({rotulo}, largura {largura}) deixou {len(vazou)} linha(s) da chave/senha "
                              f"em claro")
    neutro = Trecho(b"@@ -1 +1 @@")
    neutro.linhas = [b"-const total = soma(itens)", b"+const total = somar(itens)"]
    if neutro.resumo() != "- const total = soma(itens) | + const total = somar(itens)":
        falhos.add("neutro")
        falhas.append("resumo alterou um trecho sem segredo")
    for f in falhas:
        print(f"FALHOU: {f}")
    total = len(casos) + 1
    print(f"autoteste: {total - len(falhos)} de {total} casos do resumo mascarado ok")
    return EXIT_FALHA if falhas else EXIT_OK


# --------------------------------------------------------------------------------------------
# CLI
# --------------------------------------------------------------------------------------------

AJUDA = """\
Separa o trabalho acumulado (git diff HEAD) em entregas por branch, por TRECHO, e prova a separacao.
Nunca cria branch, commit, push, merge ou PR: os comandos que mudam o repo saem como texto no APLICAR.txt.

fluxo tipico:
  entregas.py hunks --repo front=E:/proj/front --rascunho mapa.json   # ve os trechos e cria o mapa
  (edite mapa.json: blocos, e cada trecho -> id do bloco ou "fora")
  entregas.py validar    --mapa mapa.json     # checa o mapa sem ler o diff
  entregas.py backup     --mapa mapa.json     # 00-backup/ com o diff inteiro e os arquivos novos
  entregas.py separar    --mapa mapa.json     # NN-<branch>/<repo>.patch + entrega.json
  entregas.py verificar  --mapa mapa.json     # cada bloco sozinho + soma byte a byte
  entregas.py typecheck  --mapa mapa.json     # opcional: tipos por bloco numa copia limpa
  entregas.py comandos   --mapa mapa.json     # APLICAR.txt, COMMIT-*.txt, PR.md, provas.json, COMO-APLICAR.md
  provas.py gerar <pasta-do-bloco>/provas.json --pr --conferir      # PDF, depois de preencher os itens
  entregas.py tudo       --mapa mapa.json [--typecheck]
  entregas.py autoteste                       # casos embutidos do resumo mascarado (sai 1 se algum falhar)

mapa (JSON):
  {"saida": "entregas", "contexto": 3,
   "repos": {"front": {"caminho": "E:/proj/front", "base": "develop", "remoto": "origin",
                       "typecheck": {"comando": "npx tsc --noEmit --incremental false -p .", "contar": "error TS"}}},
   "blocos": [{"id": "01", "branch": "fix/assunto", "titulo": "...", "repos": ["front"], "deps": [],
               "segurar": {"causa": "...", "saidas": ["..."]}}],
   "mapa": {"front": {"src/a.ts": "01", "src/i18n/pt.ts": {"*": "02", "0": "01", "3-5": "fora"},
                      "src/ui/*": "02"}}}
  trecho = indice do hunk no `hunks`; "*" = os demais; "a-b" = intervalo; "fora" = nao entra na entrega;
  "?" = sem dono (bloqueia). Caminho exato vence padrao com *; dois padroes com donos diferentes = erro.

segredo: separar, verificar e comandos varrem as linhas acrescentadas de cada patch com as regras do
segredos.py e recusam arquivo de credencial pelo nome (.env*, *.pem, *.pfx, *.p12, *.key, id_rsa*,
appsettings*.json com Password=...) num bloco; o que estiver em "fora" nao entra. Achou: "SEGREDO no bloco
NN: arquivo:linha regra" (sem o valor), separar nao grava nada e comandos nao gera o APLICAR.txt do bloco.
hunks, o --json e o _resumo do rascunho mostram cada trecho ja mascarado.
O texto do proprio mapa (titulo, resumo, itens, nao_validado, atencao, fora_do_bloco, commit, segurar) passa
pela mascara estrita ao ler o mapa: achou token, JWT, chave ou senha, sai 1 com "SEGREDO no mapa: bloco NN
campo <campo> (<tipo>)", sem o valor, e nenhum COMMIT, PR, APLICAR ou provas e gravado. Como defesa extra,
todo arquivo que o comandos grava passa pela mesma mascara; o que trocar vira [REMOVIDO] e saida 1.

projeto sem git (zip, SVN, Perforce): nao ha branch; veja references/entregas-por-branch.md, "Projeto sem VCS".

APLICAR.txt e COMO-APLICAR.md abrem com "PARA O USUARIO": nenhum agente executa os comandos deles.

codigos de saida: 0 ok | 1 verificacao reprovou (sem dono, dois donos, nao aplica, soma diferente,
                  erro novo de tipo, patch desatualizado, segredo no bloco ou no mapa) | 2 uso ou mapa invalido |
                  3 ambiente (git, pasta)
"""


def montar_parser() -> argparse.ArgumentParser:
    ap = ParserPT(prog="entregas.py", description=AJUDA)
    sub = ap.add_subparsers(dest="comando_sub", metavar="COMANDO", title="comandos", parser_class=ParserPT)

    def comum(p, mapa_obrigatorio=True):
        p.add_argument("--mapa", required=mapa_obrigatorio, help="mapa JSON dos blocos (ver templates/blocos.exemplo.json)")
        p.add_argument("--repo", action="append", metavar="NOME=CAMINHO",
                       help="define ou sobrescreve o caminho de um repo (pode repetir)")
        p.add_argument("--saida", help="pasta da entrega (padrao: 'saida' do mapa, relativa ao mapa)")

    p = sub.add_parser("hunks", help="lista os trechos de cada arquivo alterado, com indice, resumo e dono")
    comum(p, mapa_obrigatorio=False)
    p.add_argument("--contexto", type=int, help="linhas de contexto do diff (padrao 3; menor = trechos menores)")
    p.add_argument("--linhas", type=int, default=3, help="linhas alteradas no resumo de cada trecho (padrao 3)")
    p.add_argument("--json", help="grava a lista em JSON neste arquivo")
    p.add_argument("--rascunho", help="cria ou completa este mapa com os trechos sem dono ('?'), sem apagar o que existe")
    p.set_defaults(func=cmd_hunks)

    p = sub.add_parser("validar", help="checa o mapa (blocos, branches, deps, ordem, donos) sem ler o diff")
    comum(p)
    p.set_defaults(func=cmd_validar)

    p = sub.add_parser("separar", help="gera <saida>/NN-<branch>/<repo>.patch por bloco (erra com trecho sem dono ou com dois donos)")
    comum(p)
    p.add_argument("--simular", action="store_true", help="so mostra a divisao, sem gravar nada")
    p.add_argument("--aceitar-fim-de-linha", action="store_true",
                   help="aceita arquivo cujo diff inteiro e troca de fim de linha (padrao: recusa, porque infla o diff)")
    p.set_defaults(func=cmd_separar)

    p = sub.add_parser("verificar", help="cada bloco aplica sozinho na base; a soma reproduz byte a byte os arquivos alterados")
    comum(p)
    p.add_argument("--contra", action="append", metavar="REV",
                   help="tambem checa cada bloco sozinho sobre esta revisao (ex.: origin/develop depois de um fetch)")
    p.set_defaults(func=cmd_verificar)

    p = sub.add_parser("typecheck", help="roda o typecheck em copia limpa: base, cada bloco sozinho, com deps e todos")
    comum(p)
    p.add_argument("--so-repo", action="append", help="so este repo (pode repetir)")
    p.add_argument("--comando", help="comando de typecheck, rodado na raiz da copia (ex.: \"npx tsc --noEmit --incremental false -p .\")")
    p.add_argument("--contar", help=f"regex das linhas que contam como erro (padrao {CONTAR_PADRAO!r}; tsc: 'error TS')")
    p.add_argument("--so", action="append", help="so estes blocos (pode repetir)")
    p.add_argument("--links", nargs="*", help="pastas do repo real ligadas na copia (padrao: node_modules)")
    p.add_argument("--arquivos", nargs="*", help="so estes caminhos entram na copia (padrao: a arvore inteira)")
    p.add_argument("--dentro-do-repo", help="cria a copia nesta subpasta IGNORADA do repo, em vez da pasta temporaria do sistema")
    p.add_argument("--paralelo", type=int, default=1, help="execucoes simultaneas (padrao 1)")
    p.add_argument("--timeout", type=int, help="segundos por execucao (padrao 1800)")
    p.add_argument("--manter", action="store_true", help="nao apaga a copia no fim (so para depurar)")
    p.set_defaults(func=cmd_typecheck)

    p = sub.add_parser("comandos", help="escreve APLICAR.txt, COMMIT-<repo>.txt, PR.md e provas.json por bloco e o COMO-APLICAR.md (texto; nao executa)")
    comum(p)
    p.add_argument("--sobrescrever", action="store_true", help="troca COMMIT-*.txt e PR.md que ja existem")
    p.add_argument("--atualizar-provas", action="store_true",
                   help="no provas.json existente, renova base, patches, comandos e verificacao (mantem itens e textos)")
    p.set_defaults(func=cmd_comandos)

    p = sub.add_parser("backup", help="copia o diff inteiro, o status e os arquivos novos de cada repo para 00-backup/")
    comum(p)
    p.set_defaults(func=cmd_backup)

    p = sub.add_parser("tudo", help="backup + separar + verificar (+ typecheck com --typecheck) + comandos")
    comum(p)
    p.add_argument("--simular", action="store_true", help=argparse.SUPPRESS)
    p.add_argument("--aceitar-fim-de-linha", action="store_true", help="repassado ao separar")
    p.add_argument("--contra", action="append", metavar="REV", help="repassado ao verificar")
    p.add_argument("--sobrescrever", action="store_true", help="repassado ao comandos")
    p.add_argument("--atualizar-provas", action="store_true", help="repassado ao comandos")
    p.add_argument("--typecheck", action="store_true", help="roda tambem o typecheck dos repos configurados")
    p.add_argument("--contar", help=argparse.SUPPRESS)
    p.add_argument("--links", nargs="*", help=argparse.SUPPRESS)
    p.add_argument("--arquivos", nargs="*", help=argparse.SUPPRESS)
    p.add_argument("--dentro-do-repo", help=argparse.SUPPRESS)
    p.add_argument("--paralelo", type=int, default=1, help=argparse.SUPPRESS)
    p.add_argument("--timeout", type=int, help=argparse.SUPPRESS)
    p.add_argument("--manter", action="store_true", help=argparse.SUPPRESS)
    p.set_defaults(func=cmd_tudo)

    p = sub.add_parser("autoteste", help="roda os casos embutidos do resumo mascarado (chave privada em varias linhas, "
                                         "senha em JSON quebrado) e sai; nao le repositorio")
    p.set_defaults(func=cmd_autoteste)
    return ap


def main(argv=None) -> int:
    configurar_saida()
    ap = montar_parser()
    args = ap.parse_args(argv)
    if not getattr(args, "func", None):
        ap.print_help()
        return EXIT_USO
    try:
        return args.func(args)
    except Falha as e:
        print(f"erro: {e}", file=sys.stderr)
        return e.codigo
    except KeyboardInterrupt:
        print("interrompido", file=sys.stderr)
        return EXIT_FALHA


if __name__ == "__main__":
    sys.exit(main())

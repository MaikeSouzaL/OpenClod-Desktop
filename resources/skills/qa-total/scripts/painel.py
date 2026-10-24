#!/usr/bin/env python3
"""painel.py - painel HTML interativo da cobertura do QA (skill qa-total).

Le o cobertura.json de uma rodada (e das rodadas vizinhas, para a evolucao) e gera UM arquivo HTML
autocontido: gate, numeros por status, % de cobertura, defeitos por severidade e status, tabela de
casos com busca e filtros (status, tecnica, item, tela ou area), itens sem caso, sujeira, evolucao entre
rodadas em SVG e links relativos para as evidencias. Sem CDN: CSS e JS embutidos, funciona offline.
O HTML sai bem formado (abre tambem como XML), para poder ser validado por maquina.
Todo texto do ledger passa pela mascara comum de segredos (_mascara.py) antes de ir para o HTML.

Somente biblioteca padrao. Python 3.9+. Windows, macOS e Linux.
"""
from __future__ import annotations

import argparse
import base64
import copy
import html
import json
import mimetypes
import os
import re
import sys
import unicodedata
from collections import Counter, defaultdict
from datetime import datetime
from pathlib import Path
from urllib.parse import quote

_AQUI = Path(__file__).resolve().parent
if str(_AQUI) not in sys.path:
    sys.path.insert(0, str(_AQUI))
import _mascara

NOME_LEDGER = "cobertura.json"
STATUS_CASO = ["pendente", "passou", "falhou", "bloqueado", "nao-aplicavel", "retratado", "nao-validado"]
ROTULO_STATUS = {
    "pendente": "pendente", "passou": "passou", "falhou": "falhou", "bloqueado": "bloqueado",
    "nao-aplicavel": "não aplicável", "retratado": "retratado", "nao-validado": "não validado",
}
STATUS_EXIGE_JUSTIFICATIVA = {"bloqueado", "nao-aplicavel", "nao-validado", "retratado"}
STATUS_EXIGE_EVIDENCIA = {"passou", "falhou"}
GRAVIDADE_CASO = {"falhou": 6, "bloqueado": 5, "nao-validado": 4, "pendente": 3,
                  "retratado": 2, "nao-aplicavel": 1, "passou": 0}
SEVERIDADES = ["critico", "alto", "medio", "baixo"]
ROTULO_SEVERIDADE = {"critico": "crítico", "alto": "alto", "medio": "médio", "baixo": "baixo"}
STATUS_DEFEITO = ["aberto", "corrigido", "retestado-ok", "nao-corrigido"]
ROTULO_STATUS_DEFEITO = {"aberto": "aberto", "corrigido": "corrigido", "retestado-ok": "retestado ok",
                         "nao-corrigido": "não corrigido"}
ROTULO_TIPO_DEFEITO = {"defeito": "defeito", "melhoria": "melhoria",
                       "decisao-de-produto": "decisão de produto", "retratado": "retratado"}
EXT_IMAGEM = {".png", ".jpg", ".jpeg", ".gif", ".webp", ".svg", ".bmp"}
RE_ORACULO = re.compile(r"^\s*oraculo\s*:", re.I)

EXIT_OK, EXIT_FALHA, EXIT_USO = 0, 1, 2


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


def agora_iso() -> str:
    return datetime.now().astimezone().isoformat(timespec="seconds")


def vazio(valor) -> bool:
    if valor is None:
        return True
    if isinstance(valor, str):
        return not valor.strip()
    if isinstance(valor, (list, dict, tuple, set)):
        return len(valor) == 0
    return False


def texto(valor) -> str:
    if valor is None:
        return ""
    if isinstance(valor, (list, tuple)):
        return "; ".join(texto(v) for v in valor if not vazio(v))
    if isinstance(valor, dict):
        return "; ".join(f"{k}: {texto(v)}" for k, v in valor.items() if not vazio(v))
    return str(valor)


def chave_busca(*valores) -> str:
    s = " ".join(texto(v) for v in valores)
    s = unicodedata.normalize("NFKD", s)
    s = "".join(ch for ch in s if not unicodedata.combining(ch))
    return re.sub(r"\s+", " ", s.lower()).strip()


def resumir(valor, limite: int = 90) -> str:
    s = re.sub(r"\s+", " ", texto(valor)).strip()
    return s if len(s) <= limite else s[: limite - 1] + "…"


RE_CONTROLE = re.compile(r"[\x00-\x08\x0b\x0c\x0e-\x1f￾￿]")


def esc(valor) -> str:
    return html.escape(RE_CONTROLE.sub("", texto(valor)), quote=True)


def caminho_ledger(alvo: str) -> Path:
    p = Path(alvo).expanduser()
    if p.suffix.lower() == ".json":
        return p
    return p / NOME_LEDGER


def problemas_de_esquema(dados) -> list:
    if not isinstance(dados, dict):
        return ["a raiz precisa ser um objeto JSON"]
    erros = []
    if dados.get("rodada") is not None and not isinstance(dados.get("rodada"), dict):
        erros.append('"rodada" precisa ser objeto')
    for chave in ("itens", "casos", "defeitos", "sujeira"):
        v = dados.get(chave)
        if v is not None and not isinstance(v, list):
            erros.append(f'"{chave}" precisa ser lista (veio {type(v).__name__})')
    return erros


def carregar(p: Path, estrito: bool = True) -> dict | None:
    if not p.exists():
        falhar(f"ledger nao encontrado: {p}  (crie com: cobertura.py init <pasta-rodada> --alvo ...)")
    try:
        dados = json.loads(p.read_text(encoding="utf-8-sig"))
    except json.JSONDecodeError as e:
        if not estrito:
            print(f"aviso: {p} ignorado na evolucao (JSON invalido)", file=sys.stderr)
            return None
        falhar(f"JSON invalido em {p}: linha {e.lineno}, coluna {e.colno}: {e.msg}")
    except OSError as e:
        if not estrito:
            print(f"aviso: {p} ignorado na evolucao ({e})", file=sys.stderr)
            return None
        falhar(f"nao consegui ler {p}: {e}")
    erros = problemas_de_esquema(dados)
    if erros:
        if not estrito:
            print(f"aviso: {p} ignorado na evolucao (esquema invalido: {'; '.join(erros)})", file=sys.stderr)
            return None
        falhar(f"esquema invalido em {p}: {'; '.join(erros)}")
    if not isinstance(dados.get("rodada"), dict):
        dados["rodada"] = {}
    for chave in ("itens", "casos", "defeitos", "sujeira"):
        if not isinstance(dados.get(chave), list):
            dados[chave] = []
        dados[chave] = [x for x in dados[chave] if isinstance(x, dict)]
    return dados


def lista_evidencias(valor) -> list:
    if valor is None:
        return []
    if isinstance(valor, (str, dict)):
        return [valor]
    if isinstance(valor, list):
        return valor
    return [valor]


def evidencias_de_defeito(d: dict) -> dict:
    ev = d.get("evidencias")
    saida = {"antes": [], "depois": [], "reteste": [], "outras": []}
    if isinstance(ev, dict):
        for chave, valor in ev.items():
            destino = chave if chave in saida else "outras"
            saida[destino].extend(lista_evidencias(valor))
    else:
        for e in lista_evidencias(ev):
            nome = Path(str(caminho_evidencia(e) or "")).name.upper()
            if "-ANTES" in nome or "-REPRO" in nome:
                saida["antes"].append(e)
            elif "-RETESTE" in nome:
                saida["reteste"].append(e)
            elif "-CORRIGIDO" in nome or "-DEPOIS" in nome:
                saida["depois"].append(e)
            else:
                saida["outras"].append(e)
    return saida


def caminho_evidencia(e):
    if isinstance(e, str):
        return e
    if isinstance(e, dict):
        for chave in ("arquivo", "caminho", "path"):
            if not vazio(e.get(chave)):
                return str(e[chave])
    return None


def parece_arquivo(s: str) -> bool:
    if re.match(r"^[a-z][a-z0-9+.-]*://", s, re.I):
        return False
    return "/" in s or "\\" in s or bool(re.search(r"\.[A-Za-z0-9]{2,5}$", s))


def href_relativo(alvo: Path, pasta_saida: Path) -> str:
    try:
        rel = os.path.relpath(str(alvo), str(pasta_saida))
        return quote(rel.replace(os.sep, "/"), safe="/._-~")
    except ValueError:
        return alvo.resolve().as_uri()


SUBPASTAS_PROVA = ("evidencias", "rede", "notas", "relatorio")
MARCADOR_FORA_RODADA = "ARQUIVO FORA DA RODADA"


SUBPASTAS_LINK_AVISADAS: set = set()


def _mesmo_caminho(a: Path, b: Path) -> bool:
    return os.path.normcase(str(a)) == os.path.normcase(str(b))


def dentro_da_rodada(p: Path, rodada: Path) -> bool:
    """Evidencia so e linkada ou embutida se resolve dentro de evidencias/, rede/, notas/ ou relatorio/ da rodada.
    Subpasta que e link ou junction (resolve para outro lugar) conta como fora, com aviso unico; arquivo que e
    link para fora tambem."""
    try:
        alvo = p.resolve()
        raiz = rodada.resolve()
    except (OSError, RuntimeError):
        return False
    for sub in SUBPASTAS_PROVA:
        pasta = raiz / sub
        try:
            real = pasta.resolve()
        except (OSError, RuntimeError):
            continue
        if not _mesmo_caminho(real, pasta):
            if str(pasta) not in SUBPASTAS_LINK_AVISADAS:
                SUBPASTAS_LINK_AVISADAS.add(str(pasta))
                print(f"aviso: subpasta {sub} e link para fora da rodada ({raiz.name}): o que esta nela conta como "
                      f"fora da rodada", file=sys.stderr)
            continue
        try:
            alvo.relative_to(pasta)
            return True
        except (ValueError, OSError):
            continue
    return False


class Evidencias:
    def __init__(self, pasta_saida: Path, embutir: bool, limite_kb: int):
        self.pasta_saida = pasta_saida
        self.embutir = embutir
        self.limite = limite_kb * 1024
        self.cache: dict = {}
        self.ausentes = 0
        self.embutidas = 0
        self.fora = 0

    def resolver(self, e, pasta_rodada: Path) -> dict | None:
        c = caminho_evidencia(e)
        if vazio(c):
            return None
        c = str(c).strip()
        chave = (str(pasta_rodada), c)
        if chave in self.cache:
            return self.cache[chave]
        info = {"rotulo": c, "href": "", "src": "", "existe": False, "imagem": False, "arquivo": parece_arquivo(c),
                "fora": False}
        eh_url = re.match(r"^[a-z][a-z0-9+.-]*://", c, re.I)
        fora = bool(eh_url and c.lower().startswith("file:"))
        if not eh_url and info["arquivo"]:
            bruto = Path(c)
            fora = ".." in Path(c.replace("\\", "/")).parts or not dentro_da_rodada(
                bruto if bruto.is_absolute() else pasta_rodada / bruto, pasta_rodada)
        if fora:
            nome = _mascara.mascarar(Path(c.replace("\\", "/")).name or c, estrito=True)[0]
            info.update(rotulo=f"{MARCADOR_FORA_RODADA}: {nome}", arquivo=False, fora=True)
            self.fora += 1
        elif eh_url:
            info.update(href=c, existe=True)
        elif info["arquivo"]:
            bruto = Path(c)
            alvo = bruto if bruto.is_absolute() else pasta_rodada / bruto
            info["existe"] = alvo.exists()
            info["imagem"] = alvo.suffix.lower() in EXT_IMAGEM
            info["href"] = href_relativo(alvo, self.pasta_saida)
            info["src"] = info["href"]
            if not info["existe"]:
                self.ausentes += 1
            elif self.embutir and info["imagem"]:
                try:
                    tamanho = alvo.stat().st_size
                    if tamanho <= self.limite:
                        tipo = mimetypes.guess_type(alvo.name)[0] or "application/octet-stream"
                        dados = base64.b64encode(alvo.read_bytes()).decode("ascii")
                        info["src"] = f"data:{tipo};base64,{dados}"
                        self.embutidas += 1
                except OSError:
                    pass
        self.cache[chave] = info
        return info


def data_da_rodada(dados: dict, pasta: Path) -> str:
    r = dados.get("rodada", {})
    for chave in ("inicio", "fim"):
        v = r.get(chave)
        if isinstance(v, str) and re.match(r"^\d{4}-\d{2}-\d{2}", v.strip()):
            return v.strip()
    m = re.match(r"^(\d{4}-\d{2}-\d{2})", pasta.name)
    if m:
        return m.group(1)
    try:
        return datetime.fromtimestamp((pasta / NOME_LEDGER).stat().st_mtime).astimezone().isoformat(timespec="seconds")
    except OSError:
        return ""


TIPOS_DE_AREA = ("comando", "api", "funcao", "job")


def rotulo_de_area(tipo: str, resto: str) -> str:
    resto = resto.strip()
    if tipo == "api":
        caminho = resto.split(None, 1)[1] if re.match(r"^[A-Z]+\s", resto) else resto
        segmentos = [s for s in caminho.split("/") if s and not s.startswith(("{", ":", "[")) and s != "*"]
        return "api:/" + "/".join(segmentos)
    if tipo == "funcao":
        return "funcao:" + (resto.rsplit(".", 1)[0] if "." in resto else resto)
    return f"{tipo}:{resto}"


def area_do_item(iid: str, itens: dict) -> tuple:
    """Devolve (area, veio_de_tela). Tela, se houver ancestral tela:; senao o ancestral de topo comando:,
    api:<recurso>, funcao:<modulo> ou job:."""
    vistos = set()
    atual = iid
    topo = None
    while atual and atual not in vistos:
        vistos.add(atual)
        it = itens.get(atual)
        tipo = str((it or {}).get("tipo") or (atual.split(":", 1)[0] if ":" in atual else ""))
        if tipo == "tela":
            return (atual.split(":", 1)[1] if ":" in atual else atual), True
        if tipo in TIPOS_DE_AREA and ":" in atual:
            topo = rotulo_de_area(tipo, atual.split(":", 1)[1])
        if it is None:
            break
        atual = it.get("pai")
    if ":" in iid:
        tipo, resto = iid.split(":", 1)
        if tipo in ("elemento", "estado", "fluxo") and resto.startswith("/"):
            return re.split(r"[#\s?]", resto, maxsplit=1)[0], True
    if topo:
        return topo, False
    return "(sem área)", False


def tela_do_item(iid: str, itens: dict) -> str:
    return area_do_item(iid, itens)[0]


def tipo_do_item(it: dict) -> str:
    if not vazio(it.get("tipo")):
        return str(it["tipo"])
    iid = str(it.get("id") or "")
    return iid.split(":", 1)[0] if ":" in iid else "(sem tipo)"


def aguardando_decisao(c: dict) -> bool:
    return c.get("status") == "bloqueado" and bool(RE_ORACULO.match(chave_busca(c.get("justificativa"))))


def gate_proprio(dados: dict, pasta: Path) -> list:
    motivos = []
    casos = dados["casos"]
    itens_ids = {str(i.get("id")) for i in dados["itens"]}
    if not dados["itens"]:
        motivos.append("ledger sem itens: enumere a superficie antes de testar")
    if not casos:
        motivos.append("ledger sem casos")
    pend = sum(1 for c in casos if c.get("status") == "pendente")
    if pend:
        motivos.append(f"{pend} caso(s) pendente(s)")
    com_caso = {c.get("item_id") for c in casos}
    sem = len([i for i in itens_ids if i not in com_caso])
    if sem:
        motivos.append(f"{sem} item(ns) sem caso")
    invalidos = 0
    sem_prova = 0
    bases = [pasta, pasta.parent]
    for c in casos:
        st = c.get("status")
        evs = [caminho_evidencia(e) for e in lista_evidencias(c.get("evidencias"))]
        evs = [e for e in evs if e]
        if st not in STATUS_CASO:
            invalidos += 1
        if st in STATUS_EXIGE_EVIDENCIA and not evs:
            invalidos += 1
        if st in STATUS_EXIGE_JUSTIFICATIVA and vazio(c.get("justificativa")):
            invalidos += 1
        if st == "falhou" and vazio(c.get("defeito_id")):
            invalidos += 1
        if st in STATUS_EXIGE_EVIDENCIA and evs and all(
                parece_arquivo(e) and not any((Path(e) if Path(e).is_absolute() else b / e).exists() for b in bases)
                for e in evs):
            sem_prova += 1
    if invalidos:
        motivos.append(f"{invalidos} erro(s) de validacao nos casos")
    if sem_prova:
        motivos.append(f"{sem_prova} caso(s) concluido(s) cuja evidencia nao existe em disco")
    abertos = sum(1 for d in dados["defeitos"] if d.get("status") == "aberto")
    if abertos:
        motivos.append(f"{abertos} defeito(s) aberto(s)")
    sem_reteste = sum(1 for d in dados["defeitos"] if d.get("status") == "corrigido"
                      and len(str(d.get("justificativa") or "").strip()) < 20)
    if sem_reteste:
        motivos.append(f"{sem_reteste} defeito(s) corrigido(s) sem reteste nem justificativa")
    sujeira = sum(1 for s in dados["sujeira"] if vazio(s.get("estado_final")))
    if sujeira:
        motivos.append(f"{sujeira} registro(s) de sujeira sem estado_final")
    return motivos


def calcular_gate(dados: dict, pasta: Path) -> dict:
    try:
        aqui = str(Path(__file__).resolve().parent)
        if aqui not in sys.path:
            sys.path.insert(0, aqui)
        import cobertura as cb
        copia = copy.deepcopy(dados)
        achados = cb.validar_dados(copia, pasta)
        motivos, _ = cb.checar_gate(copia, achados, so_cobertura=False, base=pasta)
        return {"motivos": list(motivos), "origem": "cobertura.py gate",
                "erros": list(achados.erros), "avisos": list(achados.avisos)}
    except Exception as e:
        return {"motivos": gate_proprio(dados, pasta),
                "origem": f"aproximado (cobertura.py indisponivel: {type(e).__name__})",
                "erros": [], "avisos": []}


def metricas(dados: dict) -> dict:
    casos = dados["casos"]
    total = len(casos)
    por_status = Counter(c.get("status") for c in casos)
    concluidos = total - por_status.get("pendente", 0)
    itens_ids = [str(i.get("id")) for i in dados["itens"]]
    com_caso = {c.get("item_id") for c in casos}
    defeitos = dados["defeitos"]
    return {
        "itens": len(itens_ids),
        "casos": total,
        "concluidos": concluidos,
        "cobertura_pct": round(100.0 * concluidos / total, 1) if total else 0.0,
        "passou_pct": round(100.0 * por_status.get("passou", 0) / total, 1) if total else 0.0,
        "por_status": {s: por_status.get(s, 0) for s in STATUS_CASO},
        "outros_status": {k: v for k, v in por_status.items() if k not in STATUS_CASO},
        "sem_caso": [i for i in itens_ids if i not in com_caso],
        "defeitos": len(defeitos),
        "defeitos_abertos": sum(1 for d in defeitos if d.get("status") == "aberto"),
        "defeitos_retestados": sum(1 for d in defeitos if d.get("status") == "retestado-ok"),
        "aguardando_decisao": sum(1 for c in casos if aguardando_decisao(c)),
        "sujeira": len(dados["sujeira"]),
    }


def descobrir_rodadas(principal: Path, extras: list, historico: list, so_esta: bool) -> list:
    caminhos = [principal] + extras
    if not so_esta:
        pastas = list(historico)
        if not historico:
            pastas.append(principal.parent.parent)
        for pasta in pastas:
            if not pasta.is_dir():
                falhar(f"pasta de historico nao encontrada: {pasta}")
            candidatos = list(pasta.glob(f"*/{NOME_LEDGER}"))
            if (pasta / NOME_LEDGER).exists():
                candidatos.append(pasta / NOME_LEDGER)
            caminhos.extend(candidatos)
    vistos, saida = set(), []
    for c in caminhos:
        try:
            chave = str(c.resolve()).lower() if os.name == "nt" else str(c.resolve())
        except OSError:
            chave = str(c)
        if chave not in vistos:
            vistos.add(chave)
            saida.append(c)
    return saida


def normalizar_alvo(v) -> str:
    return re.sub(r"[^a-z0-9]+", "-", chave_busca(v)).strip("-")


COR_STATUS = {
    "passou": "var(--verde)", "falhou": "var(--vermelho)", "bloqueado": "var(--ambar)",
    "nao-validado": "var(--ambar-2)", "pendente": "var(--azul)", "nao-aplicavel": "var(--cinza)",
    "retratado": "var(--cinza-2)",
}
CLASSE_STATUS = {
    "passou": "st-ok", "falhou": "st-aberto", "bloqueado": "st-pendente", "nao-validado": "st-pendente",
    "pendente": "st-azul", "nao-aplicavel": "st-neutro", "retratado": "st-neutro",
}
CLASSE_STATUS_DEFEITO = {"aberto": "st-aberto", "corrigido": "st-pendente", "retestado-ok": "st-ok",
                         "nao-corrigido": "st-pendente"}


def selo(classe: str, rotulo: str, titulo: str = "") -> str:
    t = f' title="{esc(titulo)}"' if titulo else ""
    return f'<span class="selo {classe}"{t}>{esc(rotulo)}</span>'


def selo_status(st) -> str:
    st = texto(st) or "(sem status)"
    return selo(CLASSE_STATUS.get(st, "st-neutro"), ROTULO_STATUS.get(st, st))


def selo_status_defeito(st) -> str:
    st = texto(st) or "(sem status)"
    return selo(CLASSE_STATUS_DEFEITO.get(st, "st-neutro"), ROTULO_STATUS_DEFEITO.get(st, st))


def selo_severidade(sev) -> str:
    sev = texto(sev) or "(sem)"
    return selo(f"sev-{sev}" if sev in SEVERIDADES else "st-neutro", ROTULO_SEVERIDADE.get(sev, sev))


def link_evidencia(info: dict) -> str:
    if info.get("fora"):
        return (f'<span class="ev ev-falta" title="copie a prova para evidencias/ da rodada">{esc(info["rotulo"])}'
                f'</span> <span class="falta">não lido</span>')
    rot = esc(Path(info["rotulo"]).name if info["arquivo"] else info["rotulo"])
    if not info["href"]:
        return f'<span class="ev ev-texto" title="{esc(info["rotulo"])}">{rot}</span>'
    falta = "" if info["existe"] else ' <span class="falta">não existe em disco</span>'
    classe = "ev" if info["existe"] else "ev ev-falta"
    return (f'<a class="{classe}" href="{esc(info["href"])}" title="{esc(info["rotulo"])}" '
            f'target="_blank" rel="noopener">{rot}</a>{falta}')


def miniaturas(infos: list, rotulo: str = "", classe: str = "") -> str:
    imgs = [i for i in infos if i and i["imagem"] and i["existe"]]
    if not imgs:
        return ""
    partes = []
    for i in imgs:
        partes.append(f'<figure class="mini {classe}"><a href="{esc(i["href"])}" target="_blank" rel="noopener">'
                      f'<img src="{esc(i["src"] or i["href"])}" alt="{esc(rotulo + " " + Path(i["rotulo"]).name)}" '
                      f'loading="lazy" /></a><figcaption>{esc(rotulo)} {esc(Path(i["rotulo"]).name)}'
                      f'</figcaption></figure>')
    return '<div class="minis">' + "".join(partes) + "</div>"


def barra_status(por_status: dict, total: int) -> str:
    if not total:
        return '<p class="vazio">Nenhum caso no ledger.</p>'
    partes = []
    for st in STATUS_CASO:
        n = por_status.get(st, 0)
        if not n:
            continue
        pct = 100.0 * n / total
        partes.append(f'<span class="seg" style="width:{pct:.3f}%;background:{COR_STATUS[st]}" '
                      f'title="{esc(ROTULO_STATUS[st])}: {n} ({pct:.1f}%)"></span>')
    return f'<div class="barra" role="img" aria-label="distribuição dos casos por status">{"".join(partes)}</div>'


def svg_evolucao(pontos: list) -> str:
    n = len(pontos)
    larg, alt = 760, 250
    me, md, mt, mb = 46, 18, 20, 46
    pw, ph = larg - me - md, alt - mt - mb

    def x(i):
        return me + (pw / 2 if n == 1 else pw * i / (n - 1))

    def y(p):
        return mt + ph * (1 - max(0.0, min(100.0, p)) / 100.0)

    s = [f'<svg xmlns="http://www.w3.org/2000/svg" class="grafico" viewBox="0 0 {larg} {alt}" role="img" '
         f'aria-label="evolução da cobertura e de casos que passaram, por rodada">']
    for p in (0, 25, 50, 75, 100):
        yy = y(p)
        s.append(f'<line x1="{me}" y1="{yy:.1f}" x2="{larg - md}" y2="{yy:.1f}" class="grade" />')
        s.append(f'<text x="{me - 6}" y="{yy + 4:.1f}" class="eixo" text-anchor="end">{p}%</text>')
    for chave, classe in (("cobertura_pct", "linha-cob"), ("passou_pct", "linha-pas")):
        pts = " ".join(f"{x(i):.1f},{y(pt[chave]):.1f}" for i, pt in enumerate(pontos))
        if n > 1:
            s.append(f'<polyline points="{pts}" class="{classe}" />')
        for i, pt in enumerate(pontos):
            nome = "cobertura" if chave == "cobertura_pct" else "passou"
            s.append(f'<circle cx="{x(i):.1f}" cy="{y(pt[chave]):.1f}" r="4" class="{classe}-p">'
                     f'<title>{esc(pt["rotulo"])} · {nome} {pt[chave]}%</title></circle>')
    for i, pt in enumerate(pontos):
        ancora = "middle" if n == 1 else ("start" if i == 0 else ("end" if i == n - 1 else "middle"))
        s.append(f'<text x="{x(i):.1f}" y="{alt - mb + 18}" class="eixo" text-anchor="{ancora}">R{i + 1}</text>')
        s.append(f'<text x="{x(i):.1f}" y="{alt - mb + 32}" class="eixo fraco" text-anchor="{ancora}">'
                 f'{esc(pt["data"][:10])}</text>')
    s.append(f'<rect x="{larg - md - 210}" y="2" width="10" height="10" class="leg-cob" />'
             f'<text x="{larg - md - 196}" y="11" class="eixo">cobertura</text>'
             f'<rect x="{larg - md - 120}" y="2" width="10" height="10" class="leg-pas" />'
             f'<text x="{larg - md - 106}" y="11" class="eixo">passou</text>')
    s.append("</svg>")
    return "".join(s)


def svg_defeitos(pontos: list) -> str:
    n = len(pontos)
    larg, alt = 760, 210
    me, md, mt, mb = 46, 18, 36, 34
    pw, ph = larg - me - md, alt - mt - mb
    maximo = max([1] + [p["defeitos"] for p in pontos])
    passo = pw / max(n, 1)
    bw = min(46.0, passo * 0.6)
    s = [f'<svg xmlns="http://www.w3.org/2000/svg" class="grafico" viewBox="0 0 {larg} {alt}" role="img" '
         f'aria-label="defeitos por rodada: total e abertos">']
    s.append(f'<line x1="{me}" y1="{mt + ph}" x2="{larg - md}" y2="{mt + ph}" class="grade" />')
    for i, p in enumerate(pontos):
        cx = me + passo * i + passo / 2
        ht = ph * p["defeitos"] / maximo
        ha = ph * p["defeitos_abertos"] / maximo
        s.append(f'<rect x="{cx - bw / 2:.1f}" y="{mt + ph - ht:.1f}" width="{bw:.1f}" height="{ht:.1f}" class="bar-tot">'
                 f'<title>{esc(p["rotulo"])} · {p["defeitos"]} defeito(s)</title></rect>')
        if ha:
            s.append(f'<rect x="{cx - bw / 2:.1f}" y="{mt + ph - ha:.1f}" width="{bw:.1f}" height="{ha:.1f}" '
                     f'class="bar-abe"><title>{esc(p["rotulo"])} · {p["defeitos_abertos"]} aberto(s)</title></rect>')
        s.append(f'<text x="{cx:.1f}" y="{mt + ph - ht - 5:.1f}" class="eixo" text-anchor="middle">'
                 f'{p["defeitos"]}</text>')
        s.append(f'<text x="{cx:.1f}" y="{alt - mb + 18}" class="eixo" text-anchor="middle">R{i + 1}</text>')
    s.append(f'<rect x="{larg - md - 230}" y="2" width="10" height="10" class="bar-tot" />'
             f'<text x="{larg - md - 216}" y="11" class="eixo">defeitos</text>'
             f'<rect x="{larg - md - 130}" y="2" width="10" height="10" class="bar-abe" />'
             f'<text x="{larg - md - 116}" y="11" class="eixo">abertos</text>')
    s.append("</svg>")
    return "".join(s)


def tabela(cabecalho: list, linhas: list, classe: str = "") -> str:
    if not linhas:
        return '<p class="vazio">Nenhum.</p>'
    c = f' class="{classe}"' if classe else ""
    th = "".join(f"<th>{esc(h)}</th>" for h in cabecalho)
    corpo = "".join("<tr>" + "".join(f"<td>{v}</td>" for v in linha) + "</tr>" for linha in linhas)
    return f"<table{c}><thead><tr>{th}</tr></thead><tbody>{corpo}</tbody></table>"


def dl(pares: list) -> str:
    itens = [f"<dt>{esc(k)}</dt><dd>{v}</dd>" for k, v in pares if not vazio(v)]
    return "<dl>" + "".join(itens) + "</dl>" if itens else ""


def codigo_testado(r: dict) -> str:
    g = r.get("git")
    regs = [g] if isinstance(g, dict) else [x for x in g if isinstance(x, dict)] if isinstance(g, list) else []
    partes = []
    for x in regs:
        bc = " @ ".join(y for y in (texto(x.get("branch")), texto(x.get("commit"))) if y)
        if bc:
            partes.append(f"{texto(x.get('repo'))}: {bc}" if texto(x.get("repo")) else bc)
    return "; ".join(partes)


def modificados_no_inicio(r: dict) -> str:
    g = r.get("git")
    regs = [g] if isinstance(g, dict) else [x for x in g if isinstance(x, dict)] if isinstance(g, list) else []
    return "; ".join(texto(x.get("modificados_no_inicio")) for x in regs if x.get("modificados_no_inicio"))


def regra_do_critico(r: dict) -> tuple:
    """A mesma regra do gate (cobertura.critico_secou); sem o cobertura.py, as 2 ultimas passadas sem novidade."""
    try:
        aqui = str(Path(__file__).resolve().parent)
        if aqui not in sys.path:
            sys.path.insert(0, aqui)
        import cobertura as cb
        return cb.critico_secou(r)
    except Exception:
        crit = [c for c in lista_evidencias(r.get("criticas")) if isinstance(c, dict)]
        ultimas = crit[-2:]
        seco = len(ultimas) == 2 and all(not c.get("novos_itens") and not c.get("novos_casos") for c in ultimas)
        return seco, len(crit), 2


def secao_rodada(r: dict) -> str:
    amb_conf = r.get("ambiente_confirmado") if isinstance(r.get("ambiente_confirmado"), dict) else {}
    pares = [
        ("Pedido", esc(r.get("pedido"))),
        ("Escopo", esc(r.get("escopo"))),
        ("Ambiente", esc(r.get("ambiente"))),
        ("Ambiente confirmado por", esc(texto(amb_conf.get("por")) + (f" ({amb_conf.get('em')})" if amb_conf.get("em") else ""))),
        ("Papéis usados", esc(r.get("papeis_usados"))),
        ("Tipo de projeto", esc(", ".join(str(x) for x in lista_evidencias(r.get("tipos_projeto")))
                                or r.get("tipo_projeto"))),
        ("Modo da rodada", esc(r.get("modo") or "completo")),
        ("Código testado", esc(codigo_testado(r))),
        ("Alterados no início (outra sessão)", esc(modificados_no_inicio(r))),
        ("Início / fim", esc(" → ".join(x for x in (texto(r.get("inicio")), texto(r.get("fim")) or "em andamento") if x))),
        ("PERFIL", esc(r.get("perfil"))),
        ("Observação", esc(r.get("observacao"))),
    ]
    saida = [dl(pares)]
    aut = lista_evidencias(r.get("autorizacoes"))
    saida.append("<h3>Autorizações desta rodada</h3>")
    saida.append("<ul>" + "".join(f"<li>{esc(a)}</li>" for a in aut) + "</ul>" if aut
                 else '<p class="vazio">Nenhuma registrada: vale o padrão mais restritivo.</p>')
    bases = [b for b in lista_evidencias(r.get("baselines")) if isinstance(b, dict)]
    saida.append("<h3>Baselines</h3>")
    saida.append(tabela(["Gate", "Comando", "Resultado", "Data", "Composição"],
                        [[esc(b.get("gate")), f'<code>{esc(b.get("comando"))}</code>', esc(b.get("resultado")),
                          esc(b.get("data")), esc(b.get("composicao"))] for b in bases]))
    crit = [c for c in lista_evidencias(r.get("criticas")) if isinstance(c, dict)]
    saida.append("<h3>Passadas do crítico de completude</h3>")
    saida.append(tabela(["Passada", "Itens novos", "Casos novos", "Origem"],
                        [[esc(c.get("passada")), esc(c.get("novos_itens")), esc(c.get("novos_casos")),
                          esc(c.get("origem"))] for c in crit]))
    if crit:
        seco, _, precisa = regra_do_critico(r)
        if seco:
            frase = f"{precisa} passadas seguidas sem novidade: o crítico secou."
        else:
            frase = f"O crítico ainda não secou: são precisas {precisa} passadas seguidas sem item nem caso novo."
        saida.append(f'<p class="nota">{esc(frase)}</p>')
    return "".join(saida)


CSS = """
:root{--texto:#181B21;--suave:#5C6B7F;--borda:#D5DBE2;--fundo:#F0F2F4;--zebra:#F9FAFB;--cartao:#FFFFFF;
--pagina:#F9FAFB;--vermelho:#B91C1C;--vermelho-fundo:#FEF2F2;--verde:#047857;--verde-fundo:#ECFDF5;
--ambar:#B45309;--ambar-2:#D97706;--ambar-fundo:#FFFBEB;--azul:#0369A1;--azul-fundo:#E0F2FE;
--cinza:#94A3B8;--cinza-2:#64748B;--critico:#7F1D1D}
@media (prefers-color-scheme:dark){:root{--texto:#F0F2F4;--suave:#ACB6C3;--borda:#45505F;--fundo:#2D343E;
--zebra:#232931;--cartao:#1F242B;--pagina:#181B21;--vermelho:#F87171;--vermelho-fundo:#3B1C1C;--verde:#34D399;
--verde-fundo:#14302A;--ambar:#FBBF24;--ambar-2:#F59E0B;--ambar-fundo:#33270F;--azul:#38BDF8;--azul-fundo:#10293A;
--cinza:#64748B;--cinza-2:#94A3B8;--critico:#FCA5A5}}
*{box-sizing:border-box}
body{margin:0;background:var(--pagina);color:var(--texto);font-family:"Segoe UI","Helvetica Neue",Arial,sans-serif;
font-size:14px;line-height:1.45}
main{max-width:1320px;margin:0 auto;padding:24px 16px 64px}
h1{font-size:22px;margin:0 0 4px}
h2{font-size:17px;margin:32px 0 10px;padding-bottom:6px;border-bottom:2px solid var(--texto)}
h3{font-size:14px;margin:18px 0 6px}
p{margin:0 0 8px}
a{color:var(--azul)}
code{font-family:Consolas,"SFMono-Regular",Menlo,monospace;font-size:12px;word-break:break-word}
.sub{color:var(--suave);margin:0 0 16px}
.vazio{color:var(--suave);font-style:italic}
.nota{color:var(--suave);font-size:13px}
.gate{border:1px solid var(--borda);border-left:6px solid var(--verde);background:var(--verde-fundo);
border-radius:6px;padding:12px 16px;margin:12px 0 18px}
.gate.reprova{border-left-color:var(--vermelho);background:var(--vermelho-fundo)}
.gate strong{font-size:15px}
.gate ul{margin:6px 0 0;padding-left:20px}
.kpis{display:grid;grid-template-columns:repeat(auto-fit,minmax(150px,1fr));gap:10px;margin:0 0 14px}
.kpi{background:var(--cartao);border:1px solid var(--borda);border-radius:6px;padding:10px 12px}
.kpi .n{font-size:24px;font-weight:600;font-variant-numeric:tabular-nums}
.kpi .r{color:var(--suave);font-size:12px}
.barra{display:flex;height:18px;border-radius:4px;overflow:hidden;border:1px solid var(--borda);background:var(--fundo)}
.barra .seg{display:block;height:100%}
.legenda{display:flex;flex-wrap:wrap;gap:6px;margin:8px 0 0;padding:0;list-style:none}
.legenda button{font:inherit;font-size:12px;border:1px solid var(--borda);background:var(--cartao);color:var(--texto);
border-radius:999px;padding:3px 10px;cursor:pointer;display:inline-flex;align-items:center;gap:6px}
.legenda button:hover,.legenda button:focus-visible{border-color:var(--azul);outline:none}
.legenda .cor{display:inline-block;width:10px;height:10px;border-radius:2px}
.duas{display:grid;grid-template-columns:repeat(auto-fit,minmax(420px,1fr));gap:18px}
table{width:100%;border-collapse:collapse;margin:6px 0 12px;font-size:13px;background:var(--cartao)}
th,td{border:1px solid var(--borda);padding:5px 7px;text-align:left;vertical-align:top}
th{background:var(--fundo);font-weight:600}
tbody tr:nth-child(even){background:var(--zebra)}
td.num,th.num,span.num{text-align:right;font-variant-numeric:tabular-nums;white-space:nowrap}
td.id,td.tela,td.tela code{white-space:nowrap;word-break:normal}
th.ordenavel{cursor:pointer;user-select:none}
th.ordenavel:after{content:" \\2195";color:var(--suave);font-weight:400}
.selo{display:inline-block;border-radius:4px;padding:1px 7px;font-size:12px;font-weight:600;white-space:nowrap;
border:1px solid currentColor}
.st-ok{color:var(--verde);background:var(--verde-fundo)}
.st-aberto{color:var(--vermelho);background:var(--vermelho-fundo)}
.st-pendente{color:var(--ambar);background:var(--ambar-fundo)}
.st-azul{color:var(--azul);background:var(--azul-fundo)}
.st-neutro{color:var(--suave);background:var(--fundo)}
.sev-critico{color:var(--critico);background:var(--vermelho-fundo)}
.sev-alto{color:var(--vermelho);background:var(--vermelho-fundo)}
.sev-medio{color:var(--ambar);background:var(--ambar-fundo)}
.sev-baixo{color:var(--suave);background:var(--fundo)}
.filtros{display:flex;flex-wrap:wrap;gap:8px;align-items:center;background:var(--cartao);border:1px solid var(--borda);
border-radius:6px;padding:10px;margin:8px 0;position:sticky;top:0;z-index:2}
.filtros input[type=search]{flex:1 1 260px;min-width:200px}
.filtros input,.filtros select,.filtros button{font:inherit;font-size:13px;padding:5px 8px;border:1px solid var(--borda);
border-radius:4px;background:var(--pagina);color:var(--texto);max-width:100%}
.filtros select{max-width:260px}
.filtros button{cursor:pointer}
.contagem{color:var(--suave);font-size:12px;font-variant-numeric:tabular-nums}
details summary{cursor:pointer}
details[open] summary{margin-bottom:6px}
dl{display:grid;grid-template-columns:max-content 1fr;gap:3px 12px;margin:4px 0 8px}
dt{color:var(--suave);font-size:12px}
dd{margin:0;word-break:break-word}
.ev{display:inline-block;margin:0 6px 2px 0;font-size:12px;word-break:break-all}
.ev-falta{color:var(--vermelho)}
.falta{color:var(--vermelho);font-size:11px;font-weight:600}
.minis{display:flex;flex-wrap:wrap;gap:8px;margin:6px 0}
.mini{margin:0;max-width:260px}
.mini img{max-width:260px;max-height:170px;border:1px solid var(--borda);border-radius:4px;display:block;background:#fff}
.mini figcaption{font-size:11px;color:var(--suave);word-break:break-all}
.mini.antes img{border:3px solid var(--vermelho)}
.mini.depois img{border:3px solid var(--verde)}
.mini.reteste img{border:3px solid var(--azul)}
.grafico{width:100%;max-width:760px;height:auto;display:block;background:var(--cartao);border:1px solid var(--borda);
border-radius:6px;margin:6px 0}
.grafico .grade{stroke:var(--borda);stroke-width:1}
.grafico .eixo{fill:var(--suave);font-size:11px;font-family:inherit}
.grafico .fraco{font-size:10px}
.grafico .linha-cob{fill:none;stroke:var(--azul);stroke-width:2.5}
.grafico .linha-pas{fill:none;stroke:var(--verde);stroke-width:2.5}
.grafico .linha-cob-p,.grafico .leg-cob{fill:var(--azul)}
.grafico .linha-pas-p,.grafico .leg-pas{fill:var(--verde)}
.grafico .bar-tot{fill:var(--cinza)}
.grafico .bar-abe{fill:var(--vermelho)}
.aguarda{color:var(--ambar);font-size:11px;font-weight:600;display:block;margin-top:3px}
.oculto{display:none}
footer{margin-top:40px;color:var(--suave);font-size:12px}
@media print{.filtros,.legenda{display:none}body{background:#fff}h2{break-after:avoid}tr{break-inside:avoid}}
"""

JS = r"""
(function(){
  function norm(s){return (s||'').normalize('NFD').replace(/[̀-ͯ]/g,'').toLowerCase();}
  var busca=document.getElementById('f-busca'), fst=document.getElementById('f-status'),
      ftec=document.getElementById('f-tecnica'), ftel=document.getElementById('f-tela'),
      fit=document.getElementById('f-item'), fnok=document.getElementById('f-naook'),
      cont=document.getElementById('f-contagem'), limpar=document.getElementById('f-limpar');
  var linhas=[].slice.call(document.querySelectorAll('#tabela-casos tbody tr.caso'));
  function aplicar(){
    var t=norm(busca.value).trim(), n=0, termos=t?t.split(/\s+/):[];
    linhas.forEach(function(tr){
      var ok=true, txt=tr.getAttribute('data-texto');
      for(var i=0;i<termos.length;i++){ if(txt.indexOf(termos[i])<0){ok=false;break;} }
      if(ok && fst.value && tr.getAttribute('data-status')!==fst.value) ok=false;
      if(ok && ftec.value && tr.getAttribute('data-tecnica')!==ftec.value) ok=false;
      if(ok && ftel.value && tr.getAttribute('data-tela')!==ftel.value) ok=false;
      if(ok && fit.value && tr.getAttribute('data-item')!==fit.value) ok=false;
      if(ok && fnok.checked && tr.getAttribute('data-status')==='passou') ok=false;
      tr.classList.toggle('oculto',!ok); if(ok) n++;
    });
    cont.textContent=n+' de '+linhas.length+' casos';
  }
  [busca,fst,ftec,ftel,fit,fnok].forEach(function(el){el.addEventListener('input',aplicar);el.addEventListener('change',aplicar);});
  limpar.addEventListener('click',function(){busca.value='';fst.value='';ftec.value='';ftel.value='';fit.value='';fnok.checked=false;aplicar();});
  [].slice.call(document.querySelectorAll('[data-filtro-status]')).forEach(function(b){
    b.addEventListener('click',function(){fst.value=b.getAttribute('data-filtro-status');aplicar();
      document.getElementById('casos').scrollIntoView({behavior:'smooth'});});
  });
  [].slice.call(document.querySelectorAll('[data-filtro-item]')).forEach(function(b){
    b.addEventListener('click',function(ev){ev.preventDefault();fit.value=b.getAttribute('data-filtro-item');aplicar();
      document.getElementById('casos').scrollIntoView({behavior:'smooth'});});
  });
  [].slice.call(document.querySelectorAll('table.ordenavel')).forEach(function(tab){
    var ths=[].slice.call(tab.querySelectorAll('thead th'));
    ths.forEach(function(th,idx){
      th.classList.add('ordenavel'); th.setAttribute('tabindex','0');
      var dir=1;
      function ordenar(){
        var corpo=tab.tBodies[0], rows=[].slice.call(corpo.rows);
        rows.sort(function(a,b){
          var ca=a.cells[idx], cb=b.cells[idx];
          var va=ca?(ca.getAttribute('data-ordem')||ca.textContent):'', vb=cb?(cb.getAttribute('data-ordem')||cb.textContent):'';
          var na=parseFloat(va), nb=parseFloat(vb);
          if(!isNaN(na) && !isNaN(nb) && String(na)===va.trim() && String(nb)===vb.trim()) return (na-nb)*dir;
          return va.localeCompare(vb,'pt-BR',{numeric:true})*dir;
        });
        rows.forEach(function(r){corpo.appendChild(r);}); dir=-dir;
      }
      th.addEventListener('click',ordenar);
      th.addEventListener('keydown',function(e){if(e.key==='Enter'||e.key===' '){e.preventDefault();ordenar();}});
    });
  });
  var alvo=location.hash?document.getElementById(location.hash.slice(1)):null;
  if(alvo){var d=alvo.querySelector('details'); if(d) d.open=true;}
  aplicar();
})();
"""


def opcoes(valores, rotulo_todos: str, rotulos: dict | None = None) -> str:
    saida = [f'<option value="">{esc(rotulo_todos)}</option>']
    for v in valores:
        r = (rotulos or {}).get(v, v)
        saida.append(f'<option value="{esc(v)}">{esc(resumir(r, 70))}</option>')
    return "".join(saida)


def montar_html(dados: dict, pasta: Path, pontos: list, gate: dict, ev: Evidencias,
                titulo: str, origem_ledger: str) -> str:
    r = dados["rodada"]
    m = metricas(dados)
    itens = {str(i.get("id")): i for i in dados["itens"]}
    casos = sorted(dados["casos"], key=lambda c: str(c.get("id")))
    defeitos = sorted(dados["defeitos"], key=lambda d: str(d.get("id")))
    casos_por_defeito = defaultdict(list)
    for c in casos:
        if not vazio(c.get("defeito_id")):
            casos_por_defeito[str(c.get("defeito_id"))].append(str(c.get("id")))

    h = []
    h.append('<!DOCTYPE html>\n<html lang="pt-BR" xmlns="http://www.w3.org/1999/xhtml">\n<head>\n'
             '<meta charset="utf-8" />\n<meta name="viewport" content="width=device-width, initial-scale=1" />\n'
             '<meta name="color-scheme" content="light dark" />\n')
    h.append(f"<title>{esc(titulo)}</title>\n<style>/*<![CDATA[*/{CSS}/*]]>*/</style>\n</head>\n<body>\n<main>\n")

    h.append(f"<h1>{esc(titulo)}</h1>")
    meta = [x for x in (texto(r.get("id")) or pasta.name, texto(r.get("ambiente")), codigo_testado(r),
                        f"estado: {r.get('estado')}" if r.get("estado") else "",
                        f"gerado em {agora_iso()}") if x]
    h.append(f'<p class="sub">{" · ".join(esc(x) for x in meta)}</p>')

    passa = not gate["motivos"]
    h.append(f'<div class="gate{"" if passa else " reprova"}" role="status"><strong>GATE: '
             f'{"PASSA" if passa else "NÃO PASSA"}</strong> <span class="nota">({esc(gate["origem"])})</span>')
    if gate["motivos"]:
        h.append("<ul>" + "".join(f"<li>{esc(x)}</li>" for x in gate["motivos"]) + "</ul>")
        h.append('<p class="nota">Rodada sem gate não está pronta: não diga "pronto". Execute ou justifique com a verdade.</p>')
    else:
        h.append('<p class="nota">Zero pendente, zero item sem caso, tudo justificado. Lembre a seção do que NÃO foi validado.</p>')
    h.append("</div>")

    kpis = [
        (m["itens"], "itens enumerados"), (m["casos"], "casos"),
        (f'{m["cobertura_pct"]}%', f'cobertura ({m["concluidos"]} concluídos)'),
        (f'{m["passou_pct"]}%', "passou"),
        (m["defeitos"], f'defeitos ({m["defeitos_abertos"]} abertos, {m["defeitos_retestados"]} retestados ok)'),
        (len(m["sem_caso"]), "itens sem caso"),
        (m["aguardando_decisao"], "aguardando decisão (oráculo)"),
        (m["sujeira"], "registros de sujeira"),
    ]
    h.append('<div class="kpis">' + "".join(
        f'<div class="kpi"><div class="n">{esc(v)}</div><div class="r">{esc(rt)}</div></div>' for v, rt in kpis) + "</div>")

    h.append("<h2>Casos por status</h2>")
    h.append(barra_status(m["por_status"], m["casos"]))
    leg = []
    for st in STATUS_CASO:
        n = m["por_status"][st]
        leg.append(f'<li><button type="button" data-filtro-status="{esc(st)}" title="filtrar a tabela por {esc(ROTULO_STATUS[st])}">'
                   f'<span class="cor" style="background:{COR_STATUS[st]}"></span>{esc(ROTULO_STATUS[st])}: '
                   f'<strong>{n}</strong></button></li>')
    for st, n in m["outros_status"].items():
        leg.append(f'<li><button type="button" data-filtro-status="{esc(st)}">status inválido "{esc(st)}": '
                   f'<strong>{n}</strong></button></li>')
    h.append('<ul class="legenda">' + "".join(leg) + "</ul>")

    h.append('<div class="duas"><div>')
    h.append("<h2>Defeitos por severidade e status</h2>")
    matriz = defaultdict(Counter)
    for d in defeitos:
        matriz[texto(d.get("severidade")) or "(sem)"][texto(d.get("status")) or "(sem)"] += 1
    sts = STATUS_DEFEITO + sorted({s for v in matriz.values() for s in v} - set(STATUS_DEFEITO))
    sevs = [s for s in SEVERIDADES if s in matriz] + sorted(set(matriz) - set(SEVERIDADES))
    linhas = []
    for sev in sevs:
        linhas.append([selo_severidade(sev)] + [f'<span class="num">{matriz[sev].get(s, 0)}</span>' for s in sts]
                      + [f"<strong>{sum(matriz[sev].values())}</strong>"])
    h.append(tabela(["Severidade"] + [ROTULO_STATUS_DEFEITO.get(s, s) for s in sts] + ["Total"], linhas))
    h.append("</div><div>")
    h.append("<h2>Por tipo de item</h2>")
    por_tipo = defaultdict(lambda: Counter())
    casos_do_item = defaultdict(list)
    for c in casos:
        casos_do_item[c.get("item_id")].append(c)
    for iid, it in itens.items():
        t = tipo_do_item(it)
        por_tipo[t]["itens"] += 1
        lista = casos_do_item.get(iid, [])
        if not lista:
            por_tipo[t]["sem caso"] += 1
        for c in lista:
            por_tipo[t]["casos"] += 1
            por_tipo[t][texto(c.get("status"))] += 1
    cols = ["itens", "sem caso", "casos", "passou", "falhou", "pendente", "nao-validado", "bloqueado"]
    h.append(tabela(["Tipo"] + [ROTULO_STATUS.get(c, c) for c in cols],
                    [[esc(t)] + [f'<span class="num">{v.get(c, 0)}</span>' for c in cols] for t, v in sorted(por_tipo.items())]))
    h.append("<h3>Por técnica</h3>")
    por_tec = defaultdict(Counter)
    for c in casos:
        por_tec[texto(c.get("tecnica")) or "(sem técnica)"][texto(c.get("status"))] += 1
    h.append(tabela(["Técnica", "Total", "passou", "falhou", "outros"],
                    [[esc(t), f'<span class="num">{sum(v.values())}</span>', f'<span class="num">{v.get("passou", 0)}</span>',
                      f'<span class="num">{v.get("falhou", 0)}</span>',
                      f'<span class="num">{sum(v.values()) - v.get("passou", 0) - v.get("falhou", 0)}</span>']
                     for t, v in sorted(por_tec.items())]))
    h.append("</div></div>")

    h.append("<h2>Evolução entre rodadas</h2>")
    if len(pontos) < 2:
        h.append('<p class="vazio">Só uma rodada encontrada: a evolução aparece a partir da segunda '
                 '(o painel procura as pastas vizinhas com cobertura.json, ou use --historico).</p>')
    h.append(svg_evolucao(pontos))
    h.append(svg_defeitos(pontos))
    h.append(tabela(["#", "Rodada", "Alvo", "Data", "Itens", "Casos", "Cobertura", "Passou", "Falhou",
                     "Não validado", "Defeitos", "Abertos", "Gate"],
                    [[f"R{i + 1}", esc(p["rotulo"]) + (" <strong>(esta)</strong>" if p["esta"] else ""), esc(p["alvo"]),
                      esc(p["data"][:16]), f'<span class="num">{p["itens"]}</span>', f'<span class="num">{p["casos"]}</span>',
                      f'<span class="num">{p["cobertura_pct"]}%</span>', f'<span class="num">{p["passou_pct"]}%</span>',
                      f'<span class="num">{p["falhou"]}</span>', f'<span class="num">{p["nao_validado"]}</span>',
                      f'<span class="num">{p["defeitos"]}</span>', f'<span class="num">{p["defeitos_abertos"]}</span>',
                      selo("st-ok", "passa") if p["gate"] else selo("st-aberto", "não passa")]
                     for i, p in enumerate(pontos)], "ordenavel"))

    h.append("<h2>Itens sem caso</h2>")
    if m["sem_caso"]:
        h.append('<p class="nota">Item enumerado sem caso reprova o gate. Crie ao menos um caso por item, ou um '
                 '<code>nao-aplicavel</code> justificado.</p>')
        h.append(tabela(["Item", "Título", "Origem"],
                        [[f"<code>{esc(i)}</code>", esc(itens[i].get("titulo")), f'<code>{esc(itens[i].get("origem"))}</code>']
                         for i in m["sem_caso"]]))
    else:
        h.append('<p class="vazio">Nenhum: todo item tem caso.</p>')

    h.append('<h2 id="casos">Casos</h2>')
    tecnicas = sorted({texto(c.get("tecnica")) for c in casos if not vazio(c.get("tecnica"))})
    telas = {}
    de_tela = []
    for c in casos:
        area, veio_de_tela = area_do_item(str(c.get("item_id") or ""), itens)
        telas[str(c.get("id"))] = area
        de_tela.append(veio_de_tela)
    rot_area = "tela" if de_tela and all(de_tela) else "área"
    status_presentes = STATUS_CASO + list(m["outros_status"])
    h.append('<div class="filtros" role="search">'
             '<input type="search" id="f-busca" placeholder="buscar em id, título, item, obtido, justificativa…" '
             'aria-label="buscar nos casos" />'
             f'<select id="f-status" aria-label="filtrar por status">{opcoes(status_presentes, "status: todos", ROTULO_STATUS)}</select>'
             f'<select id="f-tecnica" aria-label="filtrar por técnica">{opcoes(tecnicas, "técnica: todas")}</select>'
             f'<select id="f-tela" aria-label="filtrar por {rot_area}">{opcoes(sorted(set(telas.values())), rot_area + ": todas")}</select>'
             f'<select id="f-item" aria-label="filtrar por item">{opcoes(sorted(itens), "item: todos")}</select>'
             '<label><input type="checkbox" id="f-naook" /> só o que não passou</label>'
             '<button type="button" id="f-limpar">limpar filtros</button>'
             '<span class="contagem" id="f-contagem" aria-live="polite"></span></div>')
    linhas_casos = []
    for c in casos:
        cid = str(c.get("id"))
        st = texto(c.get("status"))
        iid = texto(c.get("item_id"))
        infos = [ev.resolver(e, pasta) for e in lista_evidencias(c.get("evidencias"))]
        infos = [i for i in infos if i]
        aguarda = aguardando_decisao(c)
        busca_txt = chave_busca(cid, c.get("titulo"), iid, telas[cid], c.get("tecnica"), st, ROTULO_STATUS.get(st),
                                c.get("resultado_obtido"), c.get("resultado_esperado"), c.get("justificativa"),
                                c.get("defeito_id"), c.get("papel"), c.get("oraculo"), c.get("passos"),
                                c.get("dimensao"), "aguardando decisao" if aguarda else "")
        detalhes = dl([
            ("Passos", esc(c.get("passos"))), ("Papel", esc(c.get("papel"))), ("Dimensão", esc(c.get("dimensao"))),
            ("Esperado", esc(c.get("resultado_esperado"))), ("Oráculo", esc(c.get("oraculo"))),
            ("Obtido", esc(c.get("resultado_obtido"))), ("Justificativa", esc(c.get("justificativa"))),
            ("Observações", esc(c.get("obs") or c.get("observacoes"))), ("Atualizado em", esc(c.get("atualizado_em"))),
        ]) + miniaturas(infos)
        titulo_c = texto(c.get("titulo")) or resumir(c.get("resultado_esperado"), 80) or "(sem título)"
        ev_html = "".join(link_evidencia(i) for i in infos) or '<span class="vazio">—</span>'
        defe = texto(c.get("defeito_id"))
        link_defeito = f'<a href="#defeito-{esc(defe)}">{esc(defe)}</a>' if defe else ""
        marca_aguarda = '<span class="aguarda">aguardando decisão</span>' if aguarda else ""
        linhas_casos.append(
            f'<tr class="caso" id="caso-{esc(cid)}" data-status="{esc(st)}" data-tecnica="{esc(c.get("tecnica"))}" '
            f'data-tela="{esc(telas[cid])}" data-item="{esc(iid)}" data-texto="{esc(busca_txt)}">'
            f'<td class="id" data-ordem="{esc(cid)}"><a href="#caso-{esc(cid)}">{esc(cid)}</a></td>'
            f'<td data-ordem="{GRAVIDADE_CASO.get(st, 9)}">{selo_status(st)}{marca_aguarda}</td>'
            f"<td>{esc(c.get('tecnica'))}</td><td class=\"tela\"><code>{esc(telas[cid])}</code></td>"
            f'<td><a href="#" data-filtro-item="{esc(iid)}" title="filtrar por este item"><code>{esc(resumir(iid, 60))}</code></a></td>'
            f"<td><details><summary>{esc(titulo_c)}</summary>{detalhes}</details></td>"
            f"<td>{link_defeito}</td>"
            f'<td data-ordem="{len(infos)}">{ev_html}</td></tr>')
    if linhas_casos:
        h.append('<table id="tabela-casos" class="ordenavel"><thead><tr><th>ID</th><th>Status</th><th>Técnica</th>'
                 f'<th>{rot_area.capitalize()}</th><th>Item</th><th>Título (clique para detalhes)</th><th>Defeito</th><th>Evidências</th>'
                 "</tr></thead><tbody>" + "".join(linhas_casos) + "</tbody></table>")
    else:
        h.append('<table id="tabela-casos"><tbody></tbody></table><p class="vazio">Nenhum caso no ledger.</p>')

    h.append("<h2>Defeitos, melhorias, decisões e retratações</h2>")
    linhas_def = []
    for d in defeitos:
        did = str(d.get("id"))
        evd = evidencias_de_defeito(d)
        blocos = []
        for chave, rot, classe in (("antes", "ANTES", "antes"), ("depois", "DEPOIS", "depois"),
                                   ("reteste", "RETESTE", "reteste"), ("outras", "OUTRAS", "")):
            infos = [ev.resolver(e, pasta) for e in evd[chave]]
            infos = [i for i in infos if i]
            if infos:
                blocos.append(f'<p><strong>{rot}:</strong> ' + "".join(link_evidencia(i) for i in infos) + "</p>"
                              + miniaturas(infos, rot, classe))
        casos_d = casos_por_defeito.get(did, [])
        det = dl([
            ("Onde", f'<code>{esc(d.get("onde"))}</code>' if d.get("onde") else ""),
            ("Causa", esc(d.get("causa"))), ("Correção", esc(d.get("correcao"))),
            ("Justificativa", esc(d.get("justificativa"))),
            ("Casos", " ".join(f'<a href="#caso-{esc(x)}">{esc(x)}</a>' for x in casos_d)),
            ("Atualizado em", esc(d.get("atualizado_em"))),
        ]) + "".join(blocos)
        linhas_def.append(
            f'<tr id="defeito-{esc(did)}"><td class="id" data-ordem="{esc(did)}">{esc(did)}</td>'
            f'<td data-ordem="{SEVERIDADES.index(d.get("severidade")) if d.get("severidade") in SEVERIDADES else 9}">'
            f'{selo_severidade(d.get("severidade"))}</td>'
            f'<td>{esc(ROTULO_TIPO_DEFEITO.get(texto(d.get("tipo")), texto(d.get("tipo")) or "defeito"))}</td>'
            f'<td>{selo_status_defeito(d.get("status"))}</td>'
            f'<td><details><summary>{esc(d.get("titulo") or "(sem título)")}</summary>{det}</details></td></tr>')
    if linhas_def:
        h.append('<table class="ordenavel"><thead><tr><th>ID</th><th>Severidade</th><th>Tipo</th><th>Status</th>'
                 "<th>Título (clique para ANTES · POR QUE · DEPOIS · STATUS)</th></tr></thead><tbody>"
                 + "".join(linhas_def) + "</tbody></table>")
    else:
        h.append('<p class="vazio">Nenhum defeito registrado.</p>')

    h.append("<h2>O que não foi validado (nunca se corta)</h2>")
    nv = [c for c in casos if c.get("status") in ("nao-validado", "bloqueado", "pendente")]
    h.append(tabela(["Caso", "Status", "Título", "Motivo e o que destrava"],
                    [[f'<a href="#caso-{esc(c.get("id"))}">{esc(c.get("id"))}</a>', selo_status(c.get("status")),
                      esc(c.get("titulo") or resumir(c.get("resultado_esperado"), 80)),
                      esc(c.get("justificativa") or "(sem justificativa: o gate reprova)")] for c in nv]))

    h.append("<h2>Sujeira deixada nos ambientes</h2>")
    h.append(tabela(["ID", "Ambiente", "O que", "Identificador", "Estado final", "Como desfazer", "Caso"],
                    [[esc(s.get("id")), esc(s.get("ambiente")), esc(s.get("o_que")), esc(s.get("identificador")),
                      esc(s.get("estado_final")) or '<span class="falta">sem estado final</span>',
                      esc(s.get("como_desfazer")),
                      f'<a href="#caso-{esc(s.get("caso_id"))}">{esc(s.get("caso_id"))}</a>' if s.get("caso_id") else ""]
                     for s in dados["sujeira"]]))

    if gate["erros"] or gate["avisos"]:
        h.append("<h2>Validação do ledger</h2>")
        h.append(tabela(["Tipo", "Código", "Onde", "Mensagem"],
                        [[selo("st-aberto", "erro"), esc(a), f"<code>{esc(b)}</code>", esc(c)] for a, b, c in gate["erros"]]
                        + [[selo("st-pendente", "aviso"), esc(a), f"<code>{esc(b)}</code>", esc(c)] for a, b, c in gate["avisos"]]))

    h.append("<h2>Rodada</h2>")
    h.append(secao_rodada(r))

    rodape = [f"gerado por painel.py (skill qa-total) em {agora_iso()}", f"fonte: {origem_ledger}"]
    if ev.ausentes:
        rodape.append(f"{ev.ausentes} evidência(s) citada(s) não existem em disco")
    if ev.fora:
        rodape.append(f"{ev.fora} evidência(s) fora de evidencias/, rede/, notas/ ou relatorio/ da rodada: não lidas "
                      f"nem linkadas")
    if ev.embutidas:
        rodape.append(f"{ev.embutidas} imagem(ns) embutida(s)")
    rodape.append("links de evidência são relativos: mova o painel junto com a pasta da rodada")
    h.append(f'<footer>{" · ".join(esc(x) for x in rodape)}</footer>\n</main>\n')
    h.append(f"<script>//<![CDATA[\n{JS}\n//]]></script>\n</body>\n</html>\n")
    return "".join(h)


def ponto_da_rodada(dados: dict, pasta: Path, esta: bool, gate: dict | None = None) -> dict:
    m = metricas(dados)
    r = dados["rodada"]
    g = gate if gate is not None else calcular_gate(dados, pasta)
    return {
        "rotulo": texto(r.get("id")) or pasta.name, "alvo": texto(r.get("alvo")), "data": data_da_rodada(dados, pasta),
        "itens": m["itens"], "casos": m["casos"], "cobertura_pct": m["cobertura_pct"], "passou_pct": m["passou_pct"],
        "falhou": m["por_status"]["falhou"], "nao_validado": m["por_status"]["nao-validado"],
        "defeitos": m["defeitos"], "defeitos_abertos": m["defeitos_abertos"], "gate": not g["motivos"], "esta": esta,
    }


def montar_parser() -> ParserPT:
    ap = ParserPT(
        prog="painel.py",
        description="Gera o painel HTML interativo da cobertura do QA a partir do cobertura.json.",
        epilog=(
            "exemplos:\n"
            "  painel.py .qa/2026-09-30-clientes\n"
            "      grava .qa/2026-09-30-clientes/relatorio/painel.html; a evolucao usa as rodadas vizinhas em .qa/\n"
            "  painel.py .qa/2026-09-30-clientes --mesmo-alvo\n"
            "      evolucao so com as rodadas do mesmo alvo\n"
            "  painel.py .qa/2026-09-30-clientes --so-esta --embutir-imagens --saida painel-para-enviar.html\n"
            "      um arquivo que viaja sozinho (imagens pequenas embutidas)\n"
            "  painel.py rodada-a/cobertura.json rodada-b/cobertura.json --so-esta\n"
            "      a primeira e a principal; as outras entram na evolucao\n\n"
            "agrupamento: a coluna e o filtro sao por tela quando todo caso tem ancestral tela:; senao por area\n"
            "(o ancestral de topo comando:, api:<recurso>, funcao:<modulo> ou job:), para CLI, API, biblioteca e job.\n\n"
            "segredo: todo texto do ledger passa pela mascara comum (_mascara.py) antes de ir para o HTML; o valor\n"
            "vira [REMOVIDO] e o aviso sai no stderr com o caminho do ledger de origem (nunca o valor). Segredo na\n"
            "rodada principal: saida 1, limpe o ledger. Segredo so numa rodada vizinha (evolucao): so aviso, com o\n"
            "caminho dela; limpe-a ou use --so-esta / --mesmo-alvo.\n\n"
            "critico: o texto da secao segue a regra do gate (cobertura.critico_secou: 2 passadas seguidas).\n\n"
            "codigos de saida: 0 painel gerado | 1 gerado, mas o ledger principal tinha segredo (mascarado) ou o\n"
            "                  gate da rodada reprovou e --exigir-gate foi pedido | 2 uso, ledger, esquema ou pasta\n"
            "                  invalida"
        ),
    )
    ap.add_argument("fontes", nargs="+", metavar="RODADA",
                    help="pasta da rodada ou caminho do cobertura.json; a primeira e a principal, as demais entram na evolucao")
    ap.add_argument("--historico", action="append", default=[], metavar="PASTA",
                    help="pasta com rodadas (PASTA/*/cobertura.json) para a evolucao; repetivel. "
                         "padrao: a pasta que contem a rodada principal (ex.: .qa/)")
    ap.add_argument("--so-esta", action="store_true",
                    help="nao procura rodadas vizinhas (so as fontes passadas entram na evolucao)")
    ap.add_argument("--mesmo-alvo", action="store_true", help="evolucao so com rodadas do mesmo alvo da principal")
    ap.add_argument("--saida", help="arquivo HTML de saida (padrao: <rodada>/relatorio/painel.html)")
    ap.add_argument("--titulo", help="titulo do painel (padrao: 'Painel de QA - <alvo>')")
    ap.add_argument("--embutir-imagens", action="store_true",
                    help="embute (base64) as imagens de evidencia ate --limite-kb, para o HTML viajar sozinho")
    ap.add_argument("--limite-kb", type=int, default=400, help="tamanho maximo de cada imagem embutida (padrao 400)")
    ap.add_argument("--exigir-gate", action="store_true", help="sai 1 se o gate da rodada principal nao passar")
    return ap


def main(argv=None) -> int:
    configurar_saida()
    args = montar_parser().parse_args(argv)
    if args.limite_kb < 1:
        falhar("--limite-kb precisa ser maior que zero")
    principal = caminho_ledger(args.fontes[0])
    dados = carregar(principal)
    principal = principal.resolve()
    extras = [caminho_ledger(f).resolve() for f in args.fontes[1:]]
    pasta = principal.parent
    saida = Path(args.saida).expanduser() if args.saida else pasta / "relatorio" / "painel.html"
    if saida.suffix.lower() not in (".html", ".htm"):
        falhar(f"--saida precisa terminar em .html: {saida}")
    saida.parent.mkdir(parents=True, exist_ok=True)

    historico = [Path(x).expanduser().resolve() for x in args.historico]
    caminhos = descobrir_rodadas(principal, extras, historico, args.so_esta)
    alvo_principal = normalizar_alvo(dados["rodada"].get("alvo"))
    gate = calcular_gate(dados, pasta)
    pontos = []
    n_ponto_principal = 0
    vizinhos_com_segredo = []
    for c in caminhos:
        esta = c == principal
        d = dados if esta else carregar(c, estrito=False)
        if d is None:
            continue
        if args.mesmo_alvo and not esta and normalizar_alvo(d["rodada"].get("alvo")) != alvo_principal:
            continue
        ponto, n_ponto = _mascara.mascarar_estrutura(ponto_da_rodada(d, c.parent, esta, gate if esta else None))
        if esta:
            n_ponto_principal += n_ponto
        elif n_ponto:
            vizinhos_com_segredo.append((c, n_ponto))
        pontos.append(ponto)
    pontos.sort(key=lambda p: (p["data"], p["rotulo"]))

    titulo = args.titulo or f"Painel de QA — {texto(dados['rodada'].get('alvo')) or pasta.name}"
    dados_vis, n_seg = _mascara.mascarar_estrutura(dados)
    gate, n_gate = _mascara.mascarar_estrutura(gate)
    titulo, n_titulo = _mascara.mascarar(titulo, estrito=True)
    n_seg += n_ponto_principal + n_gate + n_titulo
    ev = Evidencias(saida.parent.resolve(), args.embutir_imagens, args.limite_kb)
    try:
        origem = os.path.relpath(str(principal), str(saida.parent)).replace(os.sep, "/")
    except ValueError:
        origem = str(principal)
    conteudo = montar_html(dados_vis, pasta.resolve(), pontos, gate, ev, titulo, origem)
    with open(saida, "w", encoding="utf-8", newline="\n") as f:
        f.write(conteudo)

    m = metricas(dados)
    print(f"painel gerado: {saida}")
    print(f"  {m['itens']} itens, {m['casos']} casos, cobertura {m['cobertura_pct']}%, passou {m['passou_pct']}%, "
          f"defeitos {m['defeitos']} ({m['defeitos_abertos']} abertos), {len(pontos)} rodada(s) na evolucao")
    print(f"  gate: {'PASSA' if not gate['motivos'] else 'NAO PASSA - ' + '; '.join(gate['motivos'])}")
    if ev.ausentes:
        print(f"  aviso: {ev.ausentes} evidencia(s) citada(s) nao existem em disco (aparecem marcadas no painel)")
    if ev.fora:
        print(f"  aviso: {ev.fora} evidencia(s) fora de evidencias/, rede/, notas/ ou relatorio/ da rodada: nao lidas nem "
              f"linkadas (aparecem como '{MARCADOR_FORA_RODADA}'); copie a prova para evidencias/")
    for caminho_viz, n_viz in vizinhos_com_segredo:
        print(f"aviso: {n_viz} segredo(s) mascarado(s) como {_mascara.MARCA} vindos da rodada vizinha {caminho_viz} "
              f"(so entra na evolucao; o valor nao foi impresso). Limpe esse ledger ou rode com --so-esta ou "
              f"--mesmo-alvo", file=sys.stderr)
    if n_seg:
        _mascara.avisar(n_seg, f"{saida} (vindos da rodada principal {principal}; o painel saiu mascarado, mas a "
                               f"fonte, o ledger, precisa ser limpa)")
        return EXIT_FALHA
    if args.exigir_gate and gate["motivos"]:
        return EXIT_FALHA
    return EXIT_OK


if __name__ == "__main__":
    sys.exit(main())

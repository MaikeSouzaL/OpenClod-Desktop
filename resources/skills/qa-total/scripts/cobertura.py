#!/usr/bin/env python3
"""cobertura.py - ledger de cobertura do QA (skill qa-total).

O ledger (cobertura.json) guarda a superficie enumerada (itens), os testes (casos),
os defeitos e a sujeira deixada nos ambientes. A rodada so termina quando `gate` passa:
zero caso pendente, zero item sem caso, todo resultado com prova em disco ou justificativa
concreta, todo defeito corrigido com ANTES, DEPOIS e reteste que passou, as cinco dimensoes por
elemento/api, o critico seco, as secoes do catalogo cobertas e a rodada registrada. O ultimo
comando e `fechar`: gate final + a nota da fase 11 (aprender).

Somente biblioteca padrao. Python 3.9+. Windows, macOS e Linux.
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
import time
import unicodedata
from collections import Counter, defaultdict
from datetime import datetime
from pathlib import Path

_AQUI = Path(__file__).resolve().parent
if str(_AQUI) not in sys.path:
    sys.path.insert(0, str(_AQUI))
import _mascara

VERSAO_LEDGER = 1
NOME_LEDGER = "cobertura.json"
SUBPASTAS_RODADA = ("notas", "evidencias", "rede", "relatorio", "replay")
SUBPASTAS_PROVA = ("evidencias", "rede", "notas", "relatorio")
PASTA_SKILL = _AQUI.parent
CAMINHO_CATALOGO = PASTA_SKILL / "references" / "catalogo-de-testes.md"

STATUS_CASO = ["pendente", "passou", "falhou", "bloqueado", "nao-aplicavel", "retratado", "nao-validado"]
STATUS_EXIGE_JUSTIFICATIVA = {"bloqueado", "nao-aplicavel", "nao-validado", "retratado"}
STATUS_EXIGE_EVIDENCIA = {"passou", "falhou"}
GRAVIDADE_CASO = {"falhou": 6, "bloqueado": 5, "nao-validado": 4, "pendente": 3,
                  "retratado": 2, "nao-aplicavel": 1, "passou": 0}

TECNICAS_FIXAS = ["particao", "valor-limite", "tabela-decisao", "transicao-estado", "pairwise", "rbac",
                  "crud", "erro-adivinhado", "exploratorio", "regressao", "seguranca", "a11y", "i18n",
                  "responsivo", "desempenho", "estatico", "api", "banco", "avaliacao", "carga", "concorrencia",
                  "propriedade", "contrato", "visual"]
TECNICAS = TECNICAS_FIXAS

DIMENSOES = ["acerto", "erro", "limite", "bloqueio", "risco"]
SINONIMOS_DIMENSAO = {"o-que-pode-dar-errado": "risco", "riscos": "risco", "acertos": "acerto", "erros": "erro",
                      "limites": "limite", "bloqueios": "bloqueio", "valor-limite": "limite"}
TIPOS_COM_DIMENSOES = ("elemento", "api", "comando", "funcao", "job", "consumidor", "ipc", "menu", "ferramenta")

MODOS_RODADA = ["completo", "reteste", "revisao"]
PREFIXOS_P0 = ("DM-TEN", "DM-AUT", "DM-SEC", "DM-SES", "MA-6")
TIPOS_COM_P0 = {"front-web", "full-stack", "api", "mobile", "desktop", "llm"}
TIPOS_BASE_LLM = {"front-web", "full-stack", "api"}
TIPO_INFERIDO_POR_ITEM = {"prompt": "llm", "ferramenta": "llm", "fonte": "llm", "ipc": "desktop", "janela": "desktop",
                          "cena": "jogo", "job": "jobs", "fila": "jobs", "consumidor": "jobs", "comando": "cli"}
MODOS_CONTAGEM = {
    "front-web": {"rota", "tela", "elemento"}, "full-stack": {"rota", "tela", "api", "elemento"}, "api": {"api", "rota"},
    "cli": {"comando"}, "biblioteca": {"funcao"}, "mobile": {"tela"}, "jobs": {"job", "fila", "consumidor"},
    "llm": {"prompt", "ferramenta", "fonte"}, "desktop": {"ipc", "janela", "menu"}, "jogo": {"cena"},
    "site-estatico": {"rota", "tela"}, "monorepo": {"pacote"},
}
TIPOS_ELEMENTO = {"upload": "EL-UPL", "exportar": "EL-EXP", "data": "EL-DAT", "select": "EL-SEL",
                  "select-busca": "EL-SBU", "link-externo": "EL-LNK"}
TIPOS_COM_UI_RUNTIME = {"front-web", "full-stack", "mobile", "desktop", "site-estatico"}
TIPOS_COM_HTTP = {"front-web", "full-stack", "api"}
TIPOS_ITEM_REPLAY = ("tela", "elemento", "fluxo", "api", "comando", "funcao", "job", "consumidor", "ipc", "cena",
                     "prompt")
ESCOPOS_ESTREITOS = ("tela", "fluxo", "funcao", "comando", "endpoint")
MODULOS_DO_GATE = [f"MA-{i}" for i in (1, 2, 3, 4, 6)] + [f"MO-{i}" for i in range(7, 11)]

ESTADOS_SUJEIRA = ["ficou", "revertido", "apagado", "desconhecido-pedir-ao-usuario"]
ESCOPOS_ITEM = ["dentro", "fora"]

SEVERIDADES = ["critico", "alto", "medio", "baixo"]
TIPOS_DEFEITO = ["defeito", "melhoria", "decisao-de-produto", "retratado"]
STATUS_DEFEITO = ["aberto", "corrigido", "retestado-ok", "nao-corrigido"]
GRAVIDADE_DEFEITO = {"aberto": 3, "corrigido": 2, "nao-corrigido": 1, "retestado-ok": 0}

JUSTIFICATIVA_MINIMO = 20
JUSTIFICATIVAS_GENERICAS = {"sem tempo", "n/a", "na", "nao testei", ".", "-", "x", "ok", "depois", "nao deu",
                            "limite de tentativas", "nao devolveu resultado"}
JUSTIFICATIVA_SEMPRE_PROIBIDA = ("sem tempo",)
JUSTIFICATIVA_PROIBIDA_SEM_MARCADOR = ("limite de tentativas", "nao devolveu resultado")
MARCADORES_DESTRAVA = ("falta", "destrava", "oraculo:", "papel", "autoriza", "sem ambiente", "gate nao executavel")
RE_NA_GENERICO = re.compile(r"^(?:fora d[oe] escopo|nao se aplica|nao aplicavel|n/?a)(?: (?:desta|nesta|da|na) rodada)?$")

NOTAS_FINAIS = (("01", "perfil", "01-perfil-e-ambiente.md"), ("02", "estudo", "02-estudo.md"),
                ("02", "inventario", "02-inventario.md"), ("03", "plano", "03-plano.md"),
                ("08", "critico", "08-critico.md"))
NOTAS_RETESTE = (("01", "perfil", "01-perfil-e-ambiente.md"), ("07", "correcao", "07-correcao.md"))
NOTA_CORRECAO = ("07", "correcao", "07-correcao.md")
NOTAS_SNAPSHOT = ("00-git-status-inicial.txt", "00-snapshot-inicial.txt")
EXT_TEXTO_PROVA = {".txt", ".log", ".json", ".md", ".csv", ".out", ".stdout", ".stderr", ".jsonl", ".ndjson",
                   ".diff", ".patch", ".xml", ".yaml", ".yml", ".html", ".har", ".sql"}

SINONIMOS = {
    "ok": "passou", "pass": "passou", "passed": "passou", "aprovado": "passou",
    "fail": "falhou", "failed": "falhou", "reprovado": "falhou",
    "n/a": "nao-aplicavel", "na": "nao-aplicavel",
    "valor-limite/fronteira": "valor-limite", "limite": "valor-limite",
    "acessibilidade": "a11y", "permissao": "rbac", "performance": "desempenho",
}

EXIT_OK, EXIT_FALHA, EXIT_USO, EXIT_TRAVA = 0, 1, 2, 3


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


def instante(valor):
    """Data/hora ISO 8601 como datetime com fuso (sem fuso = fuso local); None se ausente ou fora do formato."""
    if valor is None:
        return None
    t = str(valor).strip()
    if not t:
        return None
    if t[-1] in "Zz":
        t = t[:-1] + "+00:00"
    try:
        d = datetime.fromisoformat(t)
    except ValueError:
        return None
    return d.astimezone() if d.tzinfo is None else d


def vis(texto) -> str:
    """Texto do ledger pronto para a tela: segredo vira [REMOVIDO] ANTES de qualquer corte (resumir)."""
    return _mascara.mascarar(str("" if texto is None else texto), estrito=True)[0]


def normalizar(valor) -> str:
    if valor is None:
        return ""
    s = unicodedata.normalize("NFKD", str(valor))
    s = "".join(ch for ch in s if not unicodedata.combining(ch))
    s = re.sub(r"[\s_]+", "-", s.strip().lower())
    return SINONIMOS.get(s, s)


def vazio(valor) -> bool:
    if valor is None:
        return True
    if isinstance(valor, str):
        return not valor.strip()
    if isinstance(valor, (list, dict, tuple, set)):
        return len(valor) == 0
    return False


def caminho_ledger(alvo: str) -> Path:
    p = Path(alvo).expanduser()
    if p.suffix.lower() == ".json":
        return p
    return p / NOME_LEDGER


def ledger_vazio(rodada: dict | None = None) -> dict:
    return {"versao": VERSAO_LEDGER, "rodada": rodada or {}, "itens": [], "casos": [],
            "defeitos": [], "sujeira": []}


def carregar(p: Path, tentar_por: float = 2.0) -> dict:
    if not p.exists():
        falhar(f"ledger nao encontrado: {p}  (crie com: cobertura.py init <pasta-rodada> --alvo ...)")
    limite = time.time() + max(0.0, tentar_por)
    while True:
        try:
            dados = json.loads(p.read_text(encoding="utf-8-sig"))
            break
        except PermissionError:
            if time.time() >= limite:
                falhar(f"nao consegui ler {p}: o arquivo esta em uso por outro processo ha mais de {tentar_por:.0f}s "
                       f"(feche o leitor e rode de novo)", EXIT_TRAVA)
        except json.JSONDecodeError as e:
            if time.time() >= limite:
                falhar(f"JSON invalido em {p}: linha {e.lineno}, coluna {e.colno}: {e.msg}")
        except FileNotFoundError:
            if time.time() >= limite:
                falhar(f"ledger nao encontrado: {p}")
        except OSError as e:
            falhar(f"nao consegui ler {p}: {e}")
        time.sleep(0.1)
    if not isinstance(dados, dict):
        falhar(f"a raiz de {p} precisa ser um objeto JSON")
    dados.setdefault("versao", VERSAO_LEDGER)
    if dados.get("rodada") is None:
        dados["rodada"] = {}
    if not isinstance(dados.get("rodada"), dict):
        falhar(f'esquema invalido em {p}: "rodada" precisa ser objeto')
    for chave in ("itens", "casos", "defeitos", "sujeira"):
        if dados.get(chave) is None:
            dados[chave] = []
        elif not isinstance(dados[chave], list):
            falhar(f'esquema invalido em {p}: "{chave}" precisa ser lista (veio {type(dados[chave]).__name__})')
    return dados


def salvar(p: Path, dados: dict) -> None:
    recusar_dentro_da_skill(p.parent)
    p.parent.mkdir(parents=True, exist_ok=True)
    texto = json.dumps(dados, ensure_ascii=False, indent=2) + "\n"
    tmp = p.with_name(p.name + ".tmp")
    with open(tmp, "w", encoding="utf-8", newline="\n") as f:
        f.write(texto)
    if p.exists():
        try:
            shutil.copy2(p, p.with_name(p.name + ".bak"))
        except OSError:
            pass
    for tentativa in range(20):
        try:
            os.replace(tmp, p)
            return
        except PermissionError:
            time.sleep(0.1 + 0.15 * ((tentativa * 7919) % 100) / 100.0)
    falhar(f"nao consegui gravar {p}: outro processo esta com o arquivo aberto (leitor sem trava, editor, antivirus). "
           f"A alteracao ficou em {tmp}; feche o leitor e rode o comando de novo", EXIT_TRAVA)


class Trava:
    def __init__(self, p: Path, espera_max: float = 30.0, velha_apos: float = 120.0):
        self.arquivo = p.with_name(p.name + ".lock")
        self.espera_max = espera_max
        self.velha_apos = velha_apos

    def __enter__(self):
        if not self.arquivo.parent.is_dir():
            falhar(f"pasta da rodada nao encontrada: {self.arquivo.parent}  "
                   f"(crie com: cobertura.py init <pasta-rodada> --alvo ...)")
        inicio = time.time()
        while True:
            try:
                fd = os.open(str(self.arquivo), os.O_CREAT | os.O_EXCL | os.O_WRONLY)
                os.write(fd, str(os.getpid()).encode("ascii"))
                os.close(fd)
                return self
            except (FileExistsError, PermissionError):
                try:
                    if time.time() - self.arquivo.stat().st_mtime > self.velha_apos:
                        self.arquivo.unlink()
                        continue
                except FileNotFoundError:
                    continue
                except PermissionError:
                    pass
                if time.time() - inicio > self.espera_max:
                    falhar(f"ledger travado por outro processo ha mais de {self.espera_max:.0f}s: "
                           f"{self.arquivo} (apague o .lock se nenhum processo estiver escrevendo)", EXIT_TRAVA)
                time.sleep(0.05 + 0.15 * (os.getpid() % 7) / 7.0)

    def __exit__(self, *exc):
        for _ in range(40):
            try:
                self.arquivo.unlink()
                return False
            except FileNotFoundError:
                return False
            except PermissionError:
                time.sleep(0.05)
        return False


def proximo_id(existentes, prefixo: str, largura: int) -> str:
    maior = 0
    padrao = re.compile(rf"^{re.escape(prefixo)}-(\d+)$")
    for i in existentes:
        m = padrao.match(str(i))
        if m:
            maior = max(maior, int(m.group(1)))
    return f"{prefixo}-{maior + 1:0{largura}d}"


def tipo_do_item(item: dict) -> str:
    if not vazio(item.get("tipo")):
        return str(item["tipo"])
    iid = str(item.get("id") or "")
    return iid.split(":", 1)[0] if ":" in iid else "(sem tipo)"


def lista_evidencias(valor) -> list:
    if valor is None:
        return []
    if isinstance(valor, (str, dict)):
        return [valor]
    if isinstance(valor, list):
        return valor
    return [valor]


def classe_pelo_nome(e) -> str:
    """Formato antigo (evidencias em lista): -ANTES/-REPRO vao para antes, -RETESTE para reteste,
    -CORRIGIDO/-DEPOIS para depois e o resto para outras (conta como antes, nunca como depois)."""
    nome = Path(str(caminho_evidencia(e) or "")).name.upper()
    if "-ANTES" in nome or "-REPRO" in nome:
        return "antes"
    if "-RETESTE" in nome:
        return "reteste"
    if "-CORRIGIDO" in nome or "-DEPOIS" in nome:
        return "depois"
    return "outras"


def evidencias_em_dict(ev) -> dict:
    if isinstance(ev, dict):
        return ev
    saida = {"antes": [], "depois": [], "reteste": []}
    for e in lista_evidencias(ev):
        classe = classe_pelo_nome(e)
        saida["antes" if classe == "outras" else classe].append(e)
    return saida


def evidencias_de_defeito(d: dict) -> dict:
    ev = d.get("evidencias")
    saida = {"antes": [], "depois": [], "reteste": [], "outras": []}
    if isinstance(ev, dict):
        for chave, valor in ev.items():
            destino = chave if chave in saida else "outras"
            saida[destino].extend(lista_evidencias(valor))
    else:
        for e in lista_evidencias(ev):
            saida[classe_pelo_nome(e)].append(e)
    return saida


def caminho_evidencia(e) -> str | None:
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
    if re.search(r"\s", s.strip()) and not re.search(r"[/\\]", s):
        return False
    return "/" in s or "\\" in s or bool(re.search(r"\.[A-Za-z0-9]{2,5}$", s))


def candidatos_evidencia(s: str, base: Path) -> list:
    alvo = Path(s).expanduser()
    if alvo.is_absolute():
        return [alvo]
    saida = [base / alvo, base.parent / alvo, base.parent.parent / alvo, Path.cwd() / alvo]
    vistos, unicos = set(), []
    for c in saida:
        k = os.path.normcase(os.path.abspath(str(c)))
        if k not in vistos:
            vistos.add(k)
            unicos.append(c)
    return unicos


def evidencia_existe(s: str, bases) -> bool:
    base = bases[0] if isinstance(bases, (list, tuple)) else bases
    return any(c.exists() for c in candidatos_evidencia(s, Path(base)))


def dentro_de(caminho: Path, pasta: Path) -> bool:
    try:
        caminho.resolve().relative_to(pasta.resolve())
        return True
    except (ValueError, OSError):
        return False


_CACHE_EVIDENCIA: dict = {}
_CACHE_SUBPASTA: dict = {}


def subpasta_da_rodada(base: Path, sub: str):
    """Caminho da subpasta da rodada, sem resolver a subpasta; None quando ela e link ou junction que resolve para
    outro lugar: o que esta nela conta como fora da rodada (a mesma regra do provas.py, do painel.py e do
    mensagens.py)."""
    chave = (os.path.normcase(os.path.abspath(str(base))), sub)
    if chave not in _CACHE_SUBPASTA:
        try:
            pasta = base.resolve() / sub
            real = pasta.resolve()
        except (OSError, RuntimeError):
            pasta, real = None, None
        if pasta is not None and os.path.normcase(str(real)) != os.path.normcase(str(pasta)):
            pasta = None
        _CACHE_SUBPASTA[chave] = pasta
    return _CACHE_SUBPASTA[chave]


def dentro_da_subpasta(caminho: Path, base: Path, sub: str) -> bool:
    pasta = subpasta_da_rodada(base, sub)
    if pasta is None:
        return False
    try:
        caminho.resolve().relative_to(pasta)
        return True
    except (ValueError, OSError, RuntimeError):
        return False


def subpasta_link_do_caminho(caminho: Path, base: Path):
    """Nome da subpasta de prova que e link para fora e que contem o caminho (sem resolver), ou None."""
    alvo = os.path.normcase(os.path.abspath(str(caminho)))
    for sub in SUBPASTAS_PROVA:
        if subpasta_da_rodada(base, sub) is not None:
            continue
        pasta = os.path.normcase(os.path.abspath(str(base / sub)))
        if alvo.startswith(pasta + os.sep) and (base / sub).exists():
            return sub
    return None


def avaliar_evidencia(s: str, base: Path) -> tuple:
    """Devolve (Path valido | None, motivo). Valido = arquivo regular com mais de 0 byte, dentro de
    evidencias/, rede/, notas/ ou relatorio/ da pasta da rodada, e que nao e o proprio cobertura.json."""
    if not isinstance(s, str) or not s.strip():
        return None, "vazia"
    chave = (s.strip(), str(base))
    if chave not in _CACHE_EVIDENCIA:
        _CACHE_EVIDENCIA[chave] = _avaliar_evidencia(s.strip(), Path(base))
    return _CACHE_EVIDENCIA[chave]


def _avaliar_evidencia(s: str, base: Path) -> tuple:
    if not parece_arquivo(s):
        return None, "texto-livre"
    existentes = [c for c in candidatos_evidencia(s, base) if c.exists()]
    if not existentes:
        return None, "inexistente"
    for c in existentes:
        if not c.is_file():
            continue
        if c.name.lower().startswith(NOME_LEDGER):
            return None, "e o proprio ledger"
        if not any(dentro_da_subpasta(c, base, sub) for sub in SUBPASTAS_PROVA):
            continue
        try:
            if c.stat().st_size <= 0:
                return None, "arquivo vazio (0 byte)"
        except OSError:
            continue
        return c, "ok"
    if any(c.is_dir() for c in existentes):
        return None, "e pasta, nao arquivo"
    for c in existentes:
        sub = subpasta_link_do_caminho(c, base)
        if sub:
            return None, f"subpasta {sub} e link para fora da rodada"
    return None, "fora de evidencias/, rede/, notas/ ou relatorio/ da rodada"


def evidencias_validas(lista, base: Path) -> list:
    saida = []
    for e in lista_evidencias(lista):
        c = caminho_evidencia(e)
        if c:
            p, _ = avaliar_evidencia(c, base)
            if p is not None:
                saida.append(p)
    return saida


def normalizar_texto(valor) -> str:
    s = unicodedata.normalize("NFKD", str(valor or ""))
    s = "".join(ch for ch in s if not unicodedata.combining(ch)).lower()
    return re.sub(r"\s+", " ", s).strip()


def justificativa_fraca(texto, status: str, item: dict | None = None) -> str | None:
    t = normalizar_texto(texto)
    if not t:
        return "vazia"
    nucleo = t.strip(" .!?;:,-")
    if t in JUSTIFICATIVAS_GENERICAS or nucleo in JUSTIFICATIVAS_GENERICAS:
        return f'generica ("{t}")'
    for proibida in JUSTIFICATIVA_SEMPRE_PROIBIDA:
        if proibida in t:
            return f'"{proibida}" nao e motivo: diga o que falta e o que destrava'
    tem_marcador = any(m in t for m in MARCADORES_DESTRAVA)
    for frase in JUSTIFICATIVA_PROIBIDA_SEM_MARCADOR:
        if frase in t and not tem_marcador:
            return f'"{frase}" sozinho nao e motivo: diga o que falta e o que destrava'
    if len(t) < JUSTIFICATIVA_MINIMO:
        return f"curta demais ({len(t)} caracteres; minimo {JUSTIFICATIVA_MINIMO})"
    if status in ("bloqueado", "nao-validado") and not tem_marcador:
        return ("sem dizer o que falta ou o que destrava: use 'falta ...', 'destrava: ...', 'oraculo: ...', o papel, "
                "a autorizacao, 'sem ambiente' ou 'gate não executável: ...'")
    if status == "nao-aplicavel" and item is not None and str(item.get("escopo") or "dentro") != "fora" \
            and tipo_do_item(item) in ("tela", "elemento", "api", "dimensao") and RE_NA_GENERICO.match(nucleo):
        return "item dentro do escopo: diga o porque concreto de nao se aplicar (o que no alvo ou no codigo impede)"
    return None


def tipos_da_rodada(r: dict) -> list:
    """Tipos de projeto declarados: rodada.tipos_projeto (lista) ou, em ledger antigo, rodada.tipo_projeto."""
    saida = []
    for v in lista_evidencias(r.get("tipos_projeto")) or [r.get("tipo_projeto")]:
        s = str(v or "").strip()
        if s and s not in saida:
            saida.append(s)
    return saida


def modo_da_rodada(r: dict) -> str:
    """Modo efetivo da rodada. Rodada que nasceu completo ou revisao (rodada.modo_inicial) e depois foi marcada
    reteste continua cobrada como nasceu: o reteste e sempre rodada nova (init --modo reteste --reteste-de)."""
    m = normalizar(r.get("modo") or "completo")
    m = m if m in MODOS_RODADA else "completo"
    inicial = normalizar(r.get("modo_inicial") or "")
    if m == "reteste" and inicial in ("completo", "revisao"):
        return inicial
    return m


def id_da_rodada(r: dict, base: Path | None = None) -> str:
    return str(r.get("id") or (base.name if base is not None else "") or "")


def defeitos_do_caso(c: dict) -> list:
    """defeito_id e, quando o caso cobre varios defeitos (add-caso --defeito repetido), defeito_ids."""
    saida = []
    for v in [c.get("defeito_id")] + lista_evidencias(c.get("defeito_ids")):
        s = str(v or "").strip()
        if s and s not in saida:
            saida.append(s)
    return saida


RE_CODIGO_TITULO = re.compile(r"^\[([A-Z][A-Z0-9]*(?:-[A-Z0-9]+)*)(?=[\]\s-]|$)")


def codigos_do_caso(c: dict) -> set:
    m = RE_CODIGO_TITULO.match(str(c.get("titulo") or "").strip())
    if not m:
        return set()
    partes = m.group(1).split("-")
    return {"-".join(partes[:k]) for k in range(1, len(partes) + 1)}


def sufixo_dimensao(iid) -> str:
    s = str(iid or "")
    return s.split(":", 1)[1].strip() if ":" in s else ""


def eh_dimensao_p0(iid) -> bool:
    suf = sufixo_dimensao(iid).upper()
    return any(suf == p or re.fullmatch(re.escape(p) + r"-\d+", suf) for p in PREFIXOS_P0)


def checar_sem_segredo(campos: dict) -> None:
    problemas = []
    for nome, valor in campos.items():
        valores = valor if isinstance(valor, (list, tuple)) else [valor]
        for v in valores:
            if isinstance(v, str) and v:
                tipos = _mascara.tipos_de_segredo(v)
                if tipos:
                    problemas.append(f"--{nome.replace('_', '-')} parece conter segredo ({', '.join(tipos)})")
    if problemas:
        falhar("; ".join(problemas) + ". Nunca grave o valor no ledger, nem um valor ficticio: descreva o tipo "
                                      "de dado, sem '=' nem o valor (ex.: 'token JWT do usuario vendedor', "
                                      "'senha de teste de 8 digitos', 'token invalido').")


def checar_caminho_evidencia(valores, opcao: str) -> None:
    for v in valores or []:
        if not isinstance(v, str) or not parece_arquivo(v.strip()):
            falhar(f'{opcao} "{v}" nao e caminho de arquivo (texto livre ou URL nao provam nada). Salve a prova em '
                   f"evidencias/, rede/ ou notas/ e passe o caminho; o que foi visto vai em --obtido.")


def avisar_evidencia_ausente(valores, base: Path) -> None:
    for v in valores or []:
        p, motivo = avaliar_evidencia(v, base)
        if p is None:
            print(f"aviso: evidencia {v}: {motivo}; o gate reprova enquanto nao houver arquivo valido", file=sys.stderr)


def normalizar_dimensao(valor) -> str:
    partes = []
    for bruto in re.split(r"[,;\s]+", str(valor or "").strip()):
        if not bruto:
            continue
        n = normalizar_texto(bruto).replace(" ", "-")
        partes.append(SINONIMOS_DIMENSAO.get(n, n))
    return ",".join(dict.fromkeys(partes))


def dimensoes_do_caso(c: dict) -> list:
    return [d for d in str(c.get("dimensao") or "").split(",") if d]


def estado_sujeira_valido(valor) -> bool:
    t = normalizar_texto(valor)
    base = t.split(":", 1)[0].strip()
    return base in ESTADOS_SUJEIRA


class ErroCatalogo(Exception):
    pass


_CACHE_CATALOGO: dict = {}


def texto_catalogo() -> str:
    if "texto" not in _CACHE_CATALOGO:
        if not CAMINHO_CATALOGO.is_file():
            raise ErroCatalogo(f"catalogo nao encontrado: {CAMINHO_CATALOGO}")
        try:
            _CACHE_CATALOGO["texto"] = CAMINHO_CATALOGO.read_text(encoding="utf-8-sig")
        except OSError as e:
            raise ErroCatalogo(f"nao consegui ler o catalogo {CAMINHO_CATALOGO}: {e}")
    return _CACHE_CATALOGO["texto"]


def tabela_da_secao(texto: str, numero: str) -> list:
    linhas = texto.split("\n")
    rx = re.compile(r"^#{2,4}\s+" + re.escape(numero) + r"\.?\s")
    ini = next((i for i, l in enumerate(linhas) if rx.match(l)), None)
    if ini is None:
        return []
    saida = []
    for l in linhas[ini + 1:]:
        if re.match(r"^#{1,4}\s", l):
            break
        s = l.strip()
        if not s.startswith("|"):
            continue
        celulas = [c.strip() for c in s.strip("|").split("|")]
        if all(re.fullmatch(r":?-{3,}:?", c) for c in celulas if c):
            continue
        saida.append(celulas)
    return saida[1:] if saida else []


def tecnicas_validas() -> list:
    if "tecnicas" not in _CACHE_CATALOGO:
        extras = []
        try:
            for celulas in tabela_da_secao(texto_catalogo(), "1.5"):
                if len(celulas) >= 2:
                    for tok in re.findall(r"`([^`]+)`", celulas[1]):
                        if re.fullmatch(r"[a-z0-9]+(?:-[a-z0-9]+)*", tok):
                            extras.append(tok)
        except ErroCatalogo:
            pass
        _CACHE_CATALOGO["tecnicas"] = list(dict.fromkeys(TECNICAS_FIXAS + extras))
    return _CACHE_CATALOGO["tecnicas"]


def slug_tipo_projeto(nome: str) -> str:
    s = normalizar_texto(nome)
    s = re.split(r"[(/,]", s, maxsplit=1)[0].strip()
    s = re.sub(r"\s+", "-", s)
    return re.sub(r"[^a-z0-9-]", "", s).strip("-")


def separar_tipos(valores) -> list:
    """--tipo-projeto repetivel e/ou com virgula: ["full-stack,llm", "cli"] -> ["full-stack", "llm", "cli"]."""
    saida = []
    for v in lista_evidencias(valores):
        for parte in str(v or "").split(","):
            if parte.strip() and parte.strip() not in saida:
                saida.append(parte.strip())
    return saida


def tipos_de_projeto() -> dict:
    if "tipos" not in _CACHE_CATALOGO:
        linhas = tabela_da_secao(texto_catalogo(), "1.4")
        tipos = {}
        for celulas in linhas:
            if len(celulas) >= 2 and celulas[0] and celulas[1]:
                slug = slug_tipo_projeto(celulas[0])
                if slug:
                    tipos[slug] = (celulas[0], celulas[1])
        if not tipos:
            raise ErroCatalogo("tabela '### 1.4 Tipo de projeto' nao encontrada ou ilegivel no catalogo "
                               f"({CAMINHO_CATALOGO})")
        _CACHE_CATALOGO["tipos"] = tipos
    return _CACHE_CATALOGO["tipos"]


def mapa_de_prefixos() -> tuple:
    """(titulos, aceitos). titulos[n] = prefixo do titulo da secao; aceitos[n] = codigos das linhas da secao.
    A secao pai (ex.: "## 4.") so herda os prefixos das subsecoes quando nao tem prefixo nem linha propria:
    a 8 (linhas ES-*) nao herda o QC da 8.1, e a 9 (sem prefixo no titulo) herda o LI das linhas das subsecoes."""
    if "prefixos" not in _CACHE_CATALOGO:
        titulo_proprio, codigos_proprios, filhos = defaultdict(set), defaultdict(set), defaultdict(set)
        atual = None
        for l in texto_catalogo().split("\n"):
            m = re.match(r"^#{2,3}\s+(\d+(?:\.\d+)?)\.?\s+(.*)$", l)
            if m:
                atual = m.group(1)
                titulo_proprio.setdefault(atual, set())
                codigos_proprios.setdefault(atual, set())
                if "." in atual:
                    filhos[atual.split(".")[0]].add(atual)
                pm = re.search(r"[—–-]\s*`([A-Z][A-Z0-9]*(?:-[A-Z0-9]+)*)`\s*$", m.group(2))
                if pm:
                    titulo_proprio[atual].add(pm.group(1))
                continue
            if re.match(r"^#{1,3}\s", l):
                atual = None
                continue
            if atual:
                for cod in re.findall(r"\*\*([A-Z][A-Z0-9]*(?:-[A-Z0-9]+)*?)-\d+\*\*", l):
                    codigos_proprios[atual].add(cod)
        titulos, aceitos = {}, {}
        for n in titulo_proprio:
            titulos[n] = set(titulo_proprio[n])
            aceitos[n] = set(codigos_proprios[n]) | set(titulo_proprio[n])
        for pai, subs in filhos.items():
            titulos.setdefault(pai, set())
            aceitos.setdefault(pai, set())
            if titulo_proprio.get(pai) or codigos_proprios.get(pai):
                continue
            for s in subs:
                titulos[pai] |= titulo_proprio[s]
                aceitos[pai] |= codigos_proprios[s] | titulo_proprio[s]
        if not any(titulos.values()):
            raise ErroCatalogo(f"nenhum titulo '### n.m ... — `PREFIXO`' no catalogo ({CAMINHO_CATALOGO})")
        _CACHE_CATALOGO["prefixos"] = (titulos, aceitos)
    return _CACHE_CATALOGO["prefixos"]


def exigencia_da_secao(n: str) -> set:
    """O que cobre a secao n: o prefixo do titulo; sem ele, os codigos das linhas (8 -> ES, 9 -> LI)."""
    titulos, aceitos = mapa_de_prefixos()
    return set(titulos.get(n) or aceitos.get(n) or set())


def _numeros(texto: str) -> list:
    return re.findall(r"(?<![\d.])(\d+(?:\.\d+)?)(?![\d.])", texto)


def entradas_do_tipo(slug: str, visitados=()) -> tuple:
    tipos = tipos_de_projeto()
    if slug not in tipos:
        raise ErroCatalogo(f'tipo de projeto "{slug}" nao existe na tabela 1.4 (validos: {", ".join(sorted(tipos))})')
    _, txt = tipos[slug]
    incond, cond = [], []
    for grupo in txt.split(";"):
        g = grupo.strip()
        if not g:
            continue
        m = re.match(r"(?i)^(?:tudo d[oa]|como)\s+([^+(]+?)\s*(?:\((?:sem|exceto)\s+([^)]*)\))?\s*(?:\+\s*(.*))?$", g)
        if m:
            ref = slug_tipo_projeto(m.group(1))
            alvo = next((s for s in tipos if s == ref), None) or next((s for s in tipos if s.startswith(ref)), None)
            if alvo and alvo != slug and alvo not in visitados:
                excl = set(_numeros(m.group(2) or ""))
                sub_i, sub_c = entradas_do_tipo(alvo, tuple(visitados) + (slug,))
                for lista_sub, destino in ((sub_i, incond), (sub_c, cond)):
                    for e in lista_sub:
                        if e["num"] in excl:
                            continue
                        destino.append(dict(e, excluir=set(e["excluir"]) | excl))
            g = (m.group(3) or "").strip()
            if not g:
                continue
        tokens = g.split(",")
        k = 0
        while k < len(tokens):
            token = tokens[k]
            k += 1
            condicional = bool(re.search(r"(?i)\bse\b", token))
            partes_exceto = re.split(r"(?i)\bexceto\b", token, maxsplit=1)
            if len(partes_exceto) == 2:
                excl = set(_numeros(partes_exceto[1]))
                while k < len(tokens) and re.fullmatch(r"\s*\d+(?:\.\d+)?(?:\s+e\s+\d+(?:\.\d+)?)?\s*", tokens[k]):
                    excl |= set(_numeros(tokens[k]))
                    k += 1
                for n in _numeros(re.sub(r"\([^)]*\)", "", partes_exceto[0])):
                    e = {"num": n, "expandir": True, "excluir": excl, "rotulo": token.strip()}
                    (cond if condicional else incond).append(e)
                continue
            todas = bool(re.search(r"(?i)\btodas\b", token))
            for n in _numeros(re.sub(r"\([^)]*\)", "", token)):
                e = {"num": n, "expandir": todas, "excluir": set(), "rotulo": token.strip()}
                (cond if condicional else incond).append(e)
    return incond, cond


def expandir_entradas(entradas: list) -> list:
    titulos, _ = mapa_de_prefixos()
    saida, vistos = [], set()
    for e in entradas:
        nums = [e["num"]]
        if e["expandir"]:
            subs = sorted((k for k in titulos if k.startswith(e["num"] + ".") and titulos[k]),
                          key=lambda k: [int(x) for x in k.split(".")])
            if subs:
                nums = subs
        for n in nums:
            if n in e["excluir"] or n in vistos:
                continue
            vistos.add(n)
            saida.append(n)
    return saida


def secoes_disparadas(dados: dict) -> dict:
    """Secao condicional que vira obrigatoria pelo que o ledger ja tem (tabela 1.4 e piso, nao teto)."""
    saida = {}
    for it in dados.get("itens") or []:
        if not isinstance(it, dict) or str(it.get("escopo") or "dentro") == "fora":
            continue
        iid = str(it.get("id") or "")
        baixo = iid.lower()
        if baixo.startswith("efeito:email") or baixo.startswith("efeito:e-mail"):
            saida.setdefault("7.10", f"item {iid}")
        if re.match(r"^efeito:(sms|push|whatsapp)", baixo):
            saida.setdefault("7.12", f"item {iid}")
        if "embed" in baixo:
            saida.setdefault("7.9", f"item {iid}")
        if re.match(r"^tela:/relatorios?(/|$)", baixo):
            saida.setdefault("7.11", f"item {iid}")
    for c in dados.get("casos") or []:
        if isinstance(c, dict) and "EL-KPI" in codigos_do_caso(c):
            saida.setdefault("7.11", f"caso {c.get('id')} [EL-KPI]")
    return saida


def faltas_de_secao(dados: dict, slugs) -> tuple:
    titulos, aceitos = mapa_de_prefixos()
    slugs = [slugs] if isinstance(slugs, str) else list(slugs)
    incond, cond = [], []
    for slug in slugs:
        i, c = entradas_do_tipo(slug)
        incond += i
        cond += c
    obrig = expandir_entradas(incond)
    disparadas = secoes_disparadas(dados)
    for n in disparadas:
        if n not in obrig:
            obrig.append(n)
    condic = [n for n in expandir_entradas(cond) if n not in obrig]
    casos = [c for c in dados.get("casos") or [] if isinstance(c, dict)]
    codigos = set()
    for c in casos:
        codigos |= codigos_do_caso(c)
    com_caso = {c.get("item_id") for c in casos}
    dims = set()
    for it in dados.get("itens") or []:
        if isinstance(it, dict) and tipo_do_item(it) == "dimensao" and it.get("id") in com_caso:
            dims.add(sufixo_dimensao(it.get("id")))

    def coberta(prefixos: set, num: str | None) -> bool:
        return bool(prefixos & codigos) or bool(prefixos & dims) or bool(num and num in dims)

    def rotulo(req: set) -> str:
        if len(req) <= 3:
            return ", ".join(sorted(req))
        familias = sorted({pf.split("-")[0] for pf in req})
        return f"{', '.join(f + '-*' for f in familias)}: {len(req)} prefixos; qualquer um deles cobre"

    faltam, avisos = [], []
    for n in obrig:
        req = exigencia_da_secao(n)
        if not req:
            continue
        if not coberta(req | (aceitos.get(n, set()) if titulos.get(n) else set()), n):
            extra = f"; disparada por {disparadas[n]}" if n in disparadas else ""
            faltam.append(f"{n} ({rotulo(req)}{extra})")
    for n in condic:
        req = exigencia_da_secao(n)
        if req and not coberta(req | (aceitos.get(n, set()) if titulos.get(n) else set()), n):
            avisos.append(f"{n} ({rotulo(req)}) - condicional: confirme que nao se aplica ou crie o caso")
    for mod in MODULOS_DO_GATE:
        if not coberta({mod}, None):
            faltam.append(mod)
    return faltam, avisos


def ma5_coberto(dados: dict) -> bool:
    """MA-5 (regressao automatica) nasce na fase 10.5: o fechar cobra um caso [MA-5-*] ou um caso no item
    dimensao:MA-5 (nao-aplicavel com o motivo)."""
    casos = [c for c in dados.get("casos") or [] if isinstance(c, dict)
             and c.get("status") not in (None, "", "pendente")]
    if any("MA-5" in codigos_do_caso(c) for c in casos):
        return True
    itens = {str(i.get("id")): i for i in dados.get("itens") or [] if isinstance(i, dict)}
    for c in casos:
        it = itens.get(str(c.get("item_id")))
        if it is not None and tipo_do_item(it) == "dimensao" and sufixo_dimensao(it.get("id")).upper() == "MA-5":
            return True
    return False


class Achados:
    def __init__(self):
        self.erros: list = []
        self.avisos: list = []

    def erro(self, codigo: str, alvo: str, texto: str) -> None:
        self.erros.append((codigo, alvo, texto))

    def aviso(self, codigo: str, alvo: str, texto: str) -> None:
        self.avisos.append((codigo, alvo, texto))

    def imprimir(self, limite_grupo: int = 4) -> None:
        for codigo, alvo, texto in self.erros:
            print(f"ERRO  [{codigo}] {vis(alvo)}: {vis(texto)}")
        grupos = defaultdict(list)
        for registro in self.avisos:
            grupos[registro[0]].append(registro)
        for codigo, lista in grupos.items():
            for _, alvo, texto in lista[:limite_grupo]:
                print(f"AVISO [{codigo}] {vis(alvo)}: {vis(texto)}")
            if len(lista) > limite_grupo:
                resto = [vis(a) for _, a, _ in lista[limite_grupo:]]
                amostra = ", ".join(resto[:15]) + (" ..." if len(resto) > 15 else "")
                print(f"AVISO [{codigo}] mais {len(resto)} do mesmo tipo: {amostra}")


def sugestao(valor, validos) -> str:
    n = normalizar(valor)
    if n in validos and n != valor:
        return f' (use "{n}")'
    return f" (validos: {', '.join(validos)})"


def chave_instante(valor) -> tuple:
    """Ordena por instante real (ISO com fuso); ausente ou fora do formato perde para qualquer valor valido."""
    d = instante(valor)
    return (1, d.timestamp()) if d is not None else (0, 0.0)


def ultimo_por_data(casos: list):
    if not casos:
        return None
    return max(enumerate(casos), key=lambda par: (chave_instante(par[1].get("atualizado_em")), par[0]))[1]


def tem_sem_antes(justificativa) -> bool:
    m = re.search(r"(?:^|[|\n;]\s*)sem-antes:\s*(.+)", str(justificativa or ""), re.I)
    return bool(m and len(m.group(1).split("|")[0].strip()) >= 15)


def fora_do_escopo_estreito(c: dict, item: dict | None, rodada: dict) -> bool:
    """Rodada de tela, fluxo, funcao, comando ou endpoint (rodada.escopo): secao fora dela, em item dimensao: com
    escopo fora e justificativa 'fora do escopo da rodada (<rodada.escopo>): <motivo>', nao conta como
    nao-aplicavel em lote. Com escopo modulo, projeto ou vazio, nada muda; os P0 seguem pedindo arquivo:linha."""
    escopo = normalizar_texto(rodada.get("escopo"))
    if not escopo or not re.match(r"^(?:" + "|".join(ESCOPOS_ESTREITOS) + r")(?![a-z0-9])", escopo):
        return False
    if item is None or str(item.get("escopo") or "dentro") != "fora":
        return False
    just = normalizar_texto(c.get("justificativa"))
    prefixo = f"fora do escopo da rodada ({escopo})"
    if not just.startswith(prefixo):
        return False
    resto = just[len(prefixo):].lstrip()
    return resto.startswith(":") and len(resto[1:].strip()) >= 10


def problema_reteste(did: str, casos: list, base: Path) -> str | None:
    regs = [c for c in casos if isinstance(c, dict) and c.get("defeito_id") == did and c.get("tecnica") == "regressao"]
    if not regs:
        return "retestado-ok sem nenhum caso de reteste (add-caso --tecnica regressao --defeito " + did + ")"
    ultimo = ultimo_por_data(regs)
    if ultimo.get("status") == "falhou":
        return f"retestado-ok com reteste que falhou ({ultimo.get('id')}, o mais recente)"
    if not any(c.get("status") == "passou" and evidencias_validas(c.get("evidencias"), base) for c in regs):
        return "retestado-ok sem reteste que passou com evidencia em disco"
    return None


def validar_dados(dados: dict, base: Path) -> Achados:
    a = Achados()
    for chave in ("itens", "casos", "defeitos", "sujeira"):
        if not isinstance(dados.get(chave), list):
            a.erro("esquema", chave, f'"{chave}" precisa ser uma lista')
    if not isinstance(dados.get("rodada"), dict):
        a.erro("esquema", "rodada", '"rodada" precisa ser um objeto')
    if a.erros:
        return a
    rodada = dados["rodada"]
    if vazio(rodada.get("alvo")):
        a.aviso("rodada", "rodada", 'sem "alvo": diga o que esta sendo testado')
    tecnicas = tecnicas_validas()
    regressoes = defaultdict(list)
    for c in dados["casos"]:
        if isinstance(c, dict) and c.get("tecnica") == "regressao" and not vazio(c.get("defeito_id")):
            regressoes[str(c.get("defeito_id"))].append(c)

    def checar_segredos(alvo, obj, ignorar=("evidencias",)):
        for k, v in obj.items():
            if k in ignorar:
                continue
            for x in (v if isinstance(v, list) else [v]):
                if isinstance(x, str) and x:
                    tipos = _mascara.tipos_de_segredo(x)
                    if tipos:
                        a.erro("segredo-no-ledger", alvo, f'campo "{k}" parece conter segredo ({", ".join(tipos)}): '
                               "troque o valor pela descricao do tipo de dado (o ledger nunca guarda segredo)")
                        break
        ev = obj.get("evidencias")
        nomes = [x for v in ev.values() for x in lista_evidencias(v)] if isinstance(ev, dict) else lista_evidencias(ev)
        for e in nomes:
            caminho = caminho_evidencia(e)
            if caminho and _mascara.tipos_de_segredo(caminho):
                a.erro("segredo-no-nome-da-evidencia", alvo, "o nome (ou a pasta) de um arquivo de evidencia parece "
                       "conter segredo: renomeie o arquivo, sem o valor, e atualize o ledger (o valor nao foi impresso)")
                break

    def checar_evidencias(alvo, lista) -> list:
        validos = []
        for e in lista:
            c = caminho_evidencia(e)
            if not c:
                continue
            p, motivo = avaliar_evidencia(c, base)
            if p is not None:
                validos.append(p)
            elif motivo == "inexistente":
                a.erro("evidencia-ausente", alvo, f"arquivo de evidencia nao encontrado: {c}")
            elif motivo == "texto-livre":
                a.aviso("evidencia-texto", alvo, f'evidencia em texto livre ou URL nao prova nada: "{resumir(c, 60)}" '
                                                 '(o que foi visto vai em "resultado_obtido")')
            else:
                a.aviso("evidencia-invalida", alvo, f"{c}: {motivo} (nao conta como prova)")
        return validos

    checar_segredos("rodada", rodada)

    itens = {}
    for idx, it in enumerate(dados["itens"]):
        if not isinstance(it, dict):
            a.erro("esquema", f"itens[{idx}]", "precisa ser um objeto")
            continue
        iid = str(it.get("id") or "").strip()
        if not iid:
            a.erro("item-sem-id", f"itens[{idx}]", 'sem "id"')
            continue
        if iid in itens:
            a.erro("item-duplicado", iid, "id repetido")
        itens[iid] = it
        if ":" not in iid:
            a.aviso("item-id-formato", iid, 'id fora do formato "<tipo>:<caminho>"')
        pai = it.get("pai")
        if not vazio(pai) and pai not in {str(x.get("id")) for x in dados["itens"] if isinstance(x, dict)}:
            a.aviso("item-pai", iid, f'"pai" aponta para item inexistente "{pai}"')
        esc = it.get("escopo")
        if not vazio(esc) and esc not in ESCOPOS_ITEM:
            a.aviso("item-escopo", iid, f'escopo desconhecido "{esc}" (use {" ou ".join(ESCOPOS_ITEM)})')
        checar_segredos(iid, it)

    defeitos = {}
    for idx, d in enumerate(dados["defeitos"]):
        if not isinstance(d, dict):
            a.erro("esquema", f"defeitos[{idx}]", "precisa ser um objeto")
            continue
        did = str(d.get("id") or "").strip()
        if not did:
            a.erro("defeito-sem-id", f"defeitos[{idx}]", 'sem "id"')
            continue
        if did in defeitos:
            a.erro("defeito-duplicado", did, "id repetido")
        defeitos[did] = d
        if vazio(d.get("titulo")):
            a.erro("defeito-sem-titulo", did, 'sem "titulo"')
        sev = d.get("severidade")
        if vazio(sev):
            a.erro("defeito-severidade", did, 'sem "severidade"' + sugestao("", SEVERIDADES))
        elif sev not in SEVERIDADES:
            a.erro("defeito-severidade", did, f'severidade desconhecida "{sev}"' + sugestao(sev, SEVERIDADES))
        tipo = d.get("tipo")
        if vazio(tipo):
            a.aviso("defeito-tipo", did, 'sem "tipo" (assumindo "defeito")')
        elif tipo not in TIPOS_DEFEITO:
            a.erro("defeito-tipo", did, f'tipo desconhecido "{tipo}"' + sugestao(tipo, TIPOS_DEFEITO))
        tipo_d = tipo or "defeito"
        st = d.get("status")
        if st not in STATUS_DEFEITO:
            a.erro("defeito-status", did, f'status desconhecido "{st}"' + sugestao(st, STATUS_DEFEITO))
        if st == "nao-corrigido":
            if vazio(d.get("justificativa")):
                a.erro("defeito-justificativa", did,
                       'status "nao-corrigido" exige "justificativa" (backend, decisao de produto, sem autorizacao...)')
            else:
                fraca = justificativa_fraca(d.get("justificativa"), "nao-corrigido")
                if fraca:
                    a.erro("justificativa-generica", did, f"justificativa {fraca}")
        if st == "corrigido" and tipo_d != "retratado" and not regressoes.get(did) \
                and justificativa_fraca(d.get("justificativa"), "bloqueado") is not None:
            a.erro("defeito-corrigido-sem-reteste", did,
                   "corrigido sem reteste exige 'falta …; destrava: …' (ex.: reinício pendente). Com reteste, crie o "
                   f"caso (add-caso --tecnica regressao --defeito {did}) e marque retestado-ok")
        if vazio(d.get("onde")):
            a.aviso("defeito-onde", did, 'sem "onde" (arquivo:linha, tela ou endpoint)')
        if not vazio(d.get("evidencias")) and not isinstance(d.get("evidencias"), dict):
            a.aviso("defeito-evidencias-lista", did, "evidencias em lista (formato antigo) classificadas pelo nome: "
                    "-ANTES/-REPRO = antes, -RETESTE = reteste, -CORRIGIDO/-DEPOIS = depois; o resto conta como antes")
        ev = evidencias_de_defeito(d)
        validos_antes = checar_evidencias(did, ev["antes"] + ev["outras"])
        validos_depois = checar_evidencias(did, ev["depois"] + ev["reteste"])
        if st in ("corrigido", "retestado-ok"):
            if vazio(d.get("correcao")):
                a.aviso("defeito-correcao", did, f'status "{st}" sem "correcao" descrita')
            if tipo_d != "retratado" and not validos_depois:
                if st == "corrigido":
                    a.erro("defeito-sem-depois", did, "corrigido sem reteste: grave o diff da correcao (git diff -- "
                                                      f"<arquivos> > rede/NN-{did}-CORRIGIDO.diff) e passe --depois "
                                                      f"rede/NN-{did}-CORRIGIDO.diff; o print verde entra no reteste "
                                                      "(retestado-ok)")
                else:
                    a.erro("defeito-sem-depois", did, f'status "{st}" sem arquivo de evidencia "depois"/"reteste" que '
                                                      "exista em disco (o print verde no mesmo ponto do ANTES)")
        if tipo_d in ("defeito", "melhoria", "decisao-de-produto") and not validos_antes \
                and not tem_sem_antes(d.get("justificativa")):
            a.erro("defeito-sem-antes", did, 'sem arquivo de evidencia "antes" que exista em disco (o print do problema). '
                                             'Sem print possivel, justifique com "sem-antes: <motivo>" e deixe a prova '
                                             "textual em rede/")
        checar_segredos(did, d)

    casos_por_item = Counter()
    defeitos_citados = set()
    ids_casos = set()
    casos_validos = []
    for idx, c in enumerate(dados["casos"]):
        if not isinstance(c, dict):
            a.erro("esquema", f"casos[{idx}]", "precisa ser um objeto")
            continue
        cid = str(c.get("id") or "").strip()
        if not cid:
            a.erro("caso-sem-id", f"casos[{idx}]", 'sem "id"')
            continue
        casos_validos.append(c)
        if cid in ids_casos:
            a.erro("caso-duplicado", cid, "id repetido")
        ids_casos.add(cid)
        item_id = c.get("item_id")
        if vazio(item_id):
            a.erro("caso-sem-item", cid, 'sem "item_id"')
        elif item_id not in itens:
            a.erro("caso-item-inexistente", cid, f'"item_id" aponta para item inexistente "{item_id}"')
        else:
            casos_por_item[item_id] += 1
        st = c.get("status")
        if st not in STATUS_CASO:
            a.erro("caso-status", cid, f'status desconhecido "{st}"' + sugestao(st, STATUS_CASO))
        tec = c.get("tecnica")
        if vazio(tec):
            a.aviso("caso-sem-tecnica", cid, 'sem "tecnica"')
        elif tec not in tecnicas:
            a.aviso("caso-tecnica", cid, f'tecnica fora do catalogo "{tec}"' + sugestao(tec, tecnicas))
        dim = c.get("dimensao")
        if not vazio(dim):
            dl = dimensoes_do_caso(c)
            invalidas = [x for x in dl if x not in DIMENSOES]
            if invalidas or not dl:
                a.erro("caso-dimensao", cid, f'dimensao fora do vocabulario: "{dim}" (validas: {", ".join(DIMENSOES)}; '
                                             'ex.: "o-que-pode-dar-errado" vira "risco")')
            elif len(dl) > 1 and st != "nao-aplicavel":
                a.erro("caso-dimensao", cid, "so caso nao-aplicavel declara mais de uma dimensao; separe em casos")
        if vazio(c.get("resultado_esperado")):
            a.erro("caso-sem-esperado", cid, 'sem "resultado_esperado" (sem oraculo nao ha teste)')
        elif vazio(c.get("oraculo")):
            a.aviso("caso-sem-oraculo", cid, 'sem "oraculo" (de onde vem o esperado: codigo, spec, regra, anterior)')
        evs = lista_evidencias(c.get("evidencias"))
        validos = checar_evidencias(cid, evs)
        if st in STATUS_EXIGE_EVIDENCIA:
            if not evs:
                a.erro("caso-sem-evidencia", cid, f'status "{st}" exige ao menos uma evidencia')
            elif not validos:
                a.erro("caso-sem-prova-valida", cid, f'status "{st}" sem nenhuma evidencia valida: precisa de um arquivo '
                                                     "com mais de 0 byte em evidencias/, rede/, notas/ ou relatorio/ "
                                                     "da rodada (texto livre, URL, pasta e o proprio ledger nao contam)")
        if st in STATUS_EXIGE_JUSTIFICATIVA:
            if vazio(c.get("justificativa")):
                a.erro("caso-sem-justificativa", cid, f'status "{st}" exige "justificativa"')
            else:
                fraca = justificativa_fraca(c.get("justificativa"), st, itens.get(item_id))
                if fraca:
                    a.erro("justificativa-generica", cid, f"justificativa {fraca}")
        did = c.get("defeito_id")
        if st == "falhou" and vazio(did):
            a.erro("caso-falhou-sem-defeito", cid, 'status "falhou" exige "defeito_id"')
        for d_citado in defeitos_do_caso(c):
            if d_citado not in defeitos:
                a.erro("caso-defeito-inexistente", cid, f'"defeito_id" aponta para defeito inexistente "{d_citado}"')
            else:
                defeitos_citados.add(d_citado)
        checar_segredos(cid, c)

    for iid in itens:
        if casos_por_item[iid] == 0:
            a.erro("item-sem-caso", iid, "item enumerado sem nenhum caso de teste")

    na_dimensao = [c for c in casos_validos if c.get("status") == "nao-aplicavel"
                   and tipo_do_item(itens.get(c.get("item_id")) or {"id": c.get("item_id")}) == "dimensao"]
    lotes = defaultdict(list)
    for c in na_dimensao:
        if fora_do_escopo_estreito(c, itens.get(c.get("item_id")), rodada):
            continue
        chave = normalizar_texto(c.get("justificativa"))
        if chave:
            lotes[chave].append(c)
    for chave_lote, lista in lotes.items():
        if len(lista) >= 3:
            ids = ", ".join(f"{c.get('id')} ({c.get('item_id')})" for c in lista[:8]) + (" ..." if len(lista) > 8 else "")
            dica = ""
            if chave_lote.startswith("fora do escopo da rodada"):
                if vazio(rodada.get("escopo")):
                    dica = (f"; numa rodada de tela, fluxo, funcao, comando ou endpoint, grave cobertura.py rodada "
                            f"<rodada> --escopo <{'|'.join(ESCOPOS_ESTREITOS)}> e use o mesmo texto entre parenteses: "
                            f"'fora do escopo da rodada (<o --escopo>): <motivo>', com o item --escopo fora")
                else:
                    dica = (f"; o lote so e aceito com o item dimensao: --escopo fora e a justificativa 'fora do escopo "
                            f"da rodada ({normalizar_texto(rodada.get('escopo'))}): <motivo de 10+ caracteres>', e so "
                            f"quando rodada.escopo comeca por {', '.join(ESCOPOS_ESTREITOS)}")
            a.erro("na-em-lote", ids, f"{len(lista)} secoes/modulos nao-aplicavel com a mesma justificativa: cada "
                                      f"secao pede o seu porque concreto (o que no alvo ou no codigo impede){dica}")
    tipos_decl = set(tipos_da_rodada(rodada))
    for c in na_dimensao:
        iid = str(c.get("item_id") or "")
        suf = sufixo_dimensao(iid).upper()
        if tipos_decl & TIPOS_COM_P0 and eh_dimensao_p0(iid):
            cita = re.search(r"\S+\.\w+:\d+", str(c.get("justificativa") or ""))
            if not cita and not evidencias_validas(c.get("evidencias"), base):
                a.erro("na-p0-sem-prova", c.get("id"), f"{iid} e P0 (autorizacao, isolamento, seguranca ou sessao) "
                       "em projeto com UI ou API: nao-aplicavel so com arquivo:linha na justificativa ou com evidencia "
                       "em disco (ex.: notas/NN-por-que-nao-se-aplica.txt)")
        if suf in ("QC", "8.1") and "sem codigo-fonte acessivel:" not in normalizar_texto(c.get("justificativa")) \
                and "sem codigo fonte acessivel:" not in normalizar_texto(c.get("justificativa")):
            a.erro("qc-na-sem-motivo", c.get("id"), f"{iid} nao-aplicavel so com 'sem código-fonte acessível: "
                                                    "<porque>' (8.1 vale sempre que ha codigo-fonte no alvo)")

    for did, d in defeitos.items():
        if did not in defeitos_citados and d.get("tipo") not in ("melhoria", "decisao-de-produto"):
            a.aviso("defeito-sem-caso", did, "nenhum caso aponta para este defeito")
        if d.get("status") == "retestado-ok" and (d.get("tipo") or "defeito") not in ("retratado", "decisao-de-produto"):
            prob = problema_reteste(did, casos_validos, base)
            if prob:
                a.erro("defeito-sem-reteste", did, prob)

    ids_sujeira = set()
    for idx, s in enumerate(dados["sujeira"]):
        if not isinstance(s, dict):
            a.erro("esquema", f"sujeira[{idx}]", "precisa ser um objeto")
            continue
        sid = str(s.get("id") or f"sujeira[{idx}]")
        if sid in ids_sujeira:
            a.erro("sujeira-duplicada", sid, "id repetido")
        ids_sujeira.add(sid)
        if vazio(s.get("o_que")):
            a.erro("sujeira-sem-o-que", sid, 'sem "o_que" (o que foi criado/alterado)')
        if vazio(s.get("ambiente")):
            a.aviso("sujeira-sem-ambiente", sid, 'sem "ambiente"')
        ef = s.get("estado_final")
        if vazio(ef):
            a.aviso("sujeira-sem-estado", sid, 'sem "estado_final" (ficou, revertido, apagado ou '
                                               'desconhecido-pedir-ao-usuario)')
        elif not estado_sujeira_valido(ef):
            a.erro("sujeira-estado", sid, f'estado_final "{resumir(ef, 50)}" fora do vocabulario: '
                                          f'{", ".join(ESTADOS_SUJEIRA)} (texto livre depois de ":", ex.: '
                                          '"ficou: cliente de teste no dev")')
        elif normalizar_texto(ef).split(":", 1)[0].strip() == "ficou" and vazio(s.get("como_desfazer")):
            a.erro("sujeira-sem-desfazer", sid, 'estado "ficou" exige "como_desfazer" (o caminho para limpar)')
        checar_segredos(sid, s)
    return a


def nota_existe(base: Path, numero: str, prefixo: str) -> bool:
    pasta = base / "notas"
    if not pasta.is_dir():
        return False
    for p in pasta.glob(f"{numero}-{prefixo}*.md"):
        try:
            if p.is_file() and p.stat().st_size > 0:
                return True
        except OSError:
            continue
    return False


def perfil_existe(valor: str, base: Path) -> bool:
    bruto = Path(str(valor)).expanduser()
    if bruto.is_absolute():
        return bruto.is_file()
    return any((b / bruto).is_file() for b in (Path.cwd(), base.parent.parent, base.parent, base))


RE_ANTES_DEPOIS = re.compile(r"(?is)antes\D{0,40}\d+.*depois\D{0,40}\d+")


def evidencia_antes_depois(c: dict, base: Path) -> bool:
    """Prova de gate estatico depois da correcao: arquivo de TEXTO com o numero antes e o numero depois
    (ex.: "antes: 308 erros | depois: 308 erros"). Imagem nao conta: nao da para conferir o numero."""
    for p in evidencias_validas(c.get("evidencias"), base):
        if p.suffix.lower() not in EXT_TEXTO_PROVA:
            continue
        try:
            t = p.read_text(encoding="utf-8", errors="replace")[:500000]
        except OSError:
            continue
        if RE_ANTES_DEPOIS.search(t):
            return True
    return False


def critico_secou(rodada: dict) -> tuple:
    crit = [c for c in lista_evidencias(rodada.get("criticas")) if isinstance(c, dict)]
    precisa = 2

    def zerada(c):
        try:
            return int(c.get("novos_itens") or 0) == 0 and int(c.get("novos_casos") or 0) == 0
        except (TypeError, ValueError):
            return False
    ok = len(crit) >= precisa and all(zerada(c) for c in crit[-precisa:])
    return ok, len(crit), precisa


def ler_nota(base: Path, numero: str, prefixo: str) -> str:
    pasta = base / "notas"
    if not pasta.is_dir():
        return ""
    partes = []
    for p in sorted(pasta.glob(f"{numero}-{prefixo}*.md")):
        try:
            partes.append(p.read_text(encoding="utf-8-sig", errors="replace"))
        except OSError:
            continue
    return "\n".join(partes)


def secao_da_nota(texto: str, nome: str) -> str:
    """Conteudo da secao '## <nome>...' ate o proximo titulo de mesmo nivel ou acima, sem comentario HTML.
    Secao com {{...}} do modelo ainda nao foi preenchida: devolve vazio."""
    linhas = texto.split("\n")
    alvo = normalizar_texto(nome)
    for i, l in enumerate(linhas):
        m = re.match(r"^(#{1,6})\s+(.*)$", l)
        if m and normalizar_texto(m.group(2)).startswith(alvo):
            nivel = len(m.group(1))
            corpo = []
            for k in range(i + 1, len(linhas)):
                mm = re.match(r"^(#{1,6})\s", linhas[k])
                if mm and len(mm.group(1)) <= nivel:
                    break
                corpo.append(linhas[k])
            texto_secao = re.sub(r"<!--.*?-->", "", "\n".join(corpo), flags=re.S).strip()
            return "" if "{{" in texto_secao else texto_secao
    return ""


def veredito_por_defeito(texto: str) -> dict:
    """Para cada D-NNN citado na nota, o trecho que vai da citacao ate a citacao de outro defeito."""
    trechos = defaultdict(list)
    marcas = [(m.start(), m.group(0)) for m in re.finditer(r"\bD-\d{3,}\b", texto)]
    for k, (pos, did) in enumerate(marcas):
        fim = len(texto)
        for pos2, did2 in marcas[k + 1:]:
            if did2 != did:
                fim = pos2
                break
        trechos[did].append(texto[pos:fim])
    saida = {}
    for did, lista in trechos.items():
        junto = normalizar_texto(" ".join(lista))
        saida[did] = "resolveu" in junto or "precisa de ajuste" in junto
    return saida


def descendentes(raiz_id: str, itens: list) -> set:
    filhos = defaultdict(set)
    for it in itens:
        if not vazio(it.get("pai")):
            filhos[id_tela_norm(it.get("pai"))].add(str(it.get("id")))
    vistos, fila = set(), [id_tela_norm(raiz_id)]
    while fila:
        atual = fila.pop()
        for f in filhos.get(atual, ()):
            if f not in vistos:
                vistos.add(f)
                fila.append(f)
    return vistos


def lista_rodada(r: dict, chave: str) -> list:
    saida = []
    for v in lista_evidencias(r.get(chave)):
        for parte in str(v or "").split(","):
            if parte.strip() and parte.strip() not in saida:
                saida.append(parte.strip())
    return saida


def faltas_de_minimo(dados: dict) -> list:
    """Minimo por tipo de item (catalogo §1.3) que o gate final confere; so itens com escopo dentro."""
    r = dados.get("rodada") or {}
    itens = [i for i in dados["itens"] if isinstance(i, dict)]
    ids_com_caso = {c.get("item_id") for c in dados["casos"] if isinstance(c, dict)}
    casos_do = defaultdict(list)
    for c in dados["casos"]:
        if isinstance(c, dict):
            casos_do[str(c.get("item_id"))].append(c)
    faltas = []
    locales, temas, viewports = lista_rodada(r, "locales"), lista_rodada(r, "temas"), lista_rodada(r, "viewports")
    for it in itens:
        if str(it.get("escopo") or "dentro") == "fora":
            continue
        iid, tipo = str(it.get("id")), tipo_do_item(it)
        proprios = casos_do.get(iid, [])
        if tipo == "tela":
            rota = sufixo_dimensao(iid)
            iid_n = id_tela_norm(iid)
            filhos = [x for x in itens if tipo_do_item(x) == "elemento" and id_tela_norm(x.get("pai") or "") == iid_n]
            sem_controles = any(c.get("status") == "nao-aplicavel"
                                and "tela sem controles:" in normalizar_texto(c.get("justificativa")) for c in proprios)
            if not filhos and not sem_controles:
                orfaos = [str(x.get("id")) for x in itens if tipo_do_item(x) == "elemento" and vazio(x.get("pai"))
                          and tela_da_rota(rota_do_elemento(x.get("id")), [iid])]
                if orfaos:
                    faltas.append(f'{iid}: nenhum elemento: com pai {iid}, mas {len(orfaos)} elemento(s) desta rota '
                                  f'estao sem pai ({", ".join(orfaos[:10])}{" ..." if len(orfaos) > 10 else ""}) -> '
                                  f'cobertura.py add-item <rodada> --id "<elemento>" --pai "{iid}" --atualizar (um por '
                                  f"elemento), ou cobertura.py reconciliar <rodada> --elementos <json> --criar de novo, "
                                  f"que agora liga o pai")
                else:
                    faltas.append(f'{iid}: nenhum elemento: com pai {iid} -> cobertura.py reconciliar <rodada> --elementos '
                                  f'<json> --criar (ou add-item --id "elemento:{barra_inicial(rota)}#<slug>" --pai "{iid}"); '
                                  f"tela sem controle nenhum: caso nao-aplicavel 'tela sem controles: <porque>'")
            familia = [iid] + sorted(descendentes(iid, itens))
            codigos = set()
            for x in familia:
                for c in casos_do.get(x, []):
                    codigos |= codigos_do_caso(c)
            for cod, oque in (("EL-EST", "vazio, carregando, erro"), ("DM-NAV", "F5, voltar, link direto")):
                if cod not in codigos:
                    faltas.append(f'{iid}: sem caso [{cod}-NN] ({oque}) -> add-caso <rodada> --item "{iid}" '
                                  f'--titulo "[{cod}-01] ..." --tecnica ... --esperado ...')
            for lista, prefixo, opcao in ((locales, "i18n", "--locales"), (temas, "tema", "--temas"),
                                          (viewports, "viewport", "--viewports")):
                for v in lista:
                    alvo = f"{prefixo}:{v}:{rota}"
                    if alvo not in ids_com_caso:
                        faltas.append(f'{iid}: {opcao} declara {v}, sem item {alvo} com caso -> add-item <rodada> '
                                      f'--id "{alvo}" --pai "{iid}" e add-caso')
        elif tipo == "papel":
            if not any("bloqueio" in dimensoes_do_caso(c) and c.get("tecnica") in ("rbac", "seguranca")
                   for c in proprios):
                faltas.append(f'{iid}: sem caso de bloqueio (--dimensao bloqueio --tecnica rbac ou seguranca: o '
                              f'proibido na UI e na API) -> add-caso <rodada> --item "{iid}" --tecnica rbac '
                              f"--dimensao bloqueio ...")
        elif tipo == "estado":
            if not any(c.get("tecnica") == "transicao-estado" and "bloqueio" in dimensoes_do_caso(c) for c in proprios):
                faltas.append(f'{iid}: sem a transicao invalida (--tecnica transicao-estado --dimensao bloqueio) -> '
                              f'add-caso <rodada> --item "{iid}" --tecnica transicao-estado --dimensao bloqueio ...')
        elif tipo == "efeito":
            if not any("bloqueio" in dimensoes_do_caso(c) for c in proprios):
                faltas.append(f'{iid}: sem o caso "nao dispara quando nao deve" (--dimensao bloqueio) -> add-caso '
                              f'<rodada> --item "{iid}" --dimensao bloqueio ...')
        elif tipo == "flag":
            finais = [c for c in proprios if c.get("status") not in (None, "", "pendente")]
            sem_alternar = any(c.get("status") == "bloqueado"
                               and "falta como alternar:" in normalizar_texto(c.get("justificativa")) for c in proprios)
            if len(finais) < 2 and not sem_alternar:
                faltas.append(f"{iid}: precisa de dois casos concluidos (flag ligada e desligada), ou um bloqueado "
                              f"'falta como alternar: <o que destrava>' -> add-caso <rodada> --item \"{iid}\" ...")
        te = normalizar(it.get("tipo_elemento")) if not vazio(it.get("tipo_elemento")) else ""
        if te:
            prefixo = TIPOS_ELEMENTO.get(te)
            codigos_item = set()
            for c in proprios:
                codigos_item |= codigos_do_caso(c)
            if prefixo and prefixo not in codigos_item:
                faltas.append(f'{iid}: tipo_elemento {te} sem caso [{prefixo}-NN] (catalogo §4) -> add-caso <rodada> '
                              f'--item "{iid}" --titulo "[{prefixo}-01] ..." (ou nao-aplicavel "[{prefixo}-*] <porque>")')
    return faltas


def chave_contagem(c: dict) -> tuple:
    return normalizar(c.get("modo")), normalizar_texto(c.get("fonte"))


def contagens_vigentes(r: dict) -> list:
    """A ultima contagem de cada (modo, fonte) normalizados; as anteriores nao contam (ledger antigo podia ter
    duplicata: vale a de maior 'em', e no empate a ultima da lista)."""
    vigente = {}
    for pos, c in enumerate(lista_evidencias(r.get("contagens"))):
        if not isinstance(c, dict):
            continue
        k = chave_contagem(c)
        ordem = (chave_instante(c.get("em")), pos)
        if k not in vigente or ordem >= vigente[k][0]:
            vigente[k] = (ordem, c)
    return [c for _, c in sorted(vigente.values(), key=lambda par: par[0][1])]


def gravar_contagens(r: dict, novas: list, so_mais_nova: bool = False) -> list:
    """Contagem nova com o mesmo (modo, fonte) normalizados SUBSTITUI a anterior em rodada.contagens; a anterior vai
    para rodada.contagens_historico (so acrescenta). Devolve as substituidas. so_mais_nova (merge de parcial): a que
    chega com 'em' mais velho que a vigente vai direto para o historico."""
    atuais = [c for c in lista_evidencias(r.get("contagens")) if isinstance(c, dict)]
    historico = [c for c in lista_evidencias(r.get("contagens_historico")) if isinstance(c, dict)]
    trocadas = []
    for n in novas:
        if not isinstance(n, dict):
            continue
        k = chave_contagem(n)
        velhas = [c for c in atuais if chave_contagem(c) == k]
        if velhas and all(json.dumps(c, sort_keys=True) == json.dumps(n, sort_keys=True) for c in velhas):
            continue
        if so_mais_nova and any(chave_instante(c.get("em")) > chave_instante(n.get("em")) for c in velhas):
            if n not in historico:
                historico.append(n)
            continue
        for c in velhas:
            if c not in historico:
                historico.append(c)
            trocadas.append(c)
        atuais = [c for c in atuais if chave_contagem(c) != k] + [n]
    r["contagens"] = atuais
    if historico:
        r["contagens_historico"] = historico
    return trocadas


def faltas_de_contagem(r: dict, tipos: list) -> list:
    contagens = contagens_vigentes(r)
    faltas = []
    for t in tipos:
        aceitos = {t} | MODOS_CONTAGEM.get(t, set())
        if t == "monorepo":
            continue
        if not any(normalizar(c.get("modo")) in aceitos for c in contagens):
            faltas.append(f'tipo {t} sem contagem do inventario -> cobertura.py rodada <rodada> --contagem '
                          f'"<{"|".join(sorted(aceitos))}>|<fonte>|<N no codigo>|<N no ledger>[|<justificativa>]"')
    for c in contagens:
        try:
            n_cod, n_led = int(c.get("n_codigo")), int(c.get("n_ledger"))
        except (TypeError, ValueError):
            faltas.append(f"contagem {c.get('modo')}/{c.get('fonte')} com numero invalido")
            continue
        if n_led < n_cod and justificativa_fraca(c.get("justificativa"), "nao-aplicavel") is not None:
            faltas.append(f"contagem {c.get('modo')} ({c.get('fonte')}): {n_led} no ledger < {n_cod} no codigo sem "
                          f"justificativa concreta -> registre os faltantes e grave de novo a contagem (mesmo modo e "
                          f"fonte) com o N atual do ledger, ou com a justificativa: cobertura.py rodada <rodada> "
                          f'--contagem "{c.get("modo")}|{c.get("fonte")}|{n_cod}|<N atual>[|<justificativa>]" (a '
                          f"nova substitui esta; a anterior fica em contagens_historico)")
    return faltas


def caminho_do_mapa(dados: dict, base: Path) -> list:
    """Onde procurar o mapa do projeto: o caminho que o PERFIL aponta ('Mapa do projeto:'), senao .qa/MAPA.md."""
    r = dados.get("rodada") or {}
    raizes = [base.parent.parent, Path.cwd(), base.parent]
    candidatos = []
    perfil = str(r.get("perfil") or "").strip()
    if perfil:
        bruto = Path(perfil).expanduser()
        achados = [bruto] if bruto.is_absolute() else [b / bruto for b in (Path.cwd(), base.parent.parent, base.parent,
                                                                           base)]
        for p in achados:
            if p.is_file():
                try:
                    m = re.search(r"(?im)mapa do projeto:\**\s*`([^`]+)`", p.read_text(encoding="utf-8-sig",
                                                                                      errors="replace"))
                except OSError:
                    m = None
                if m:
                    alvo = Path(m.group(1).strip()).expanduser()
                    candidatos += [alvo] if alvo.is_absolute() else [b / alvo for b in raizes]
                break
    candidatos += [base.parent / "MAPA.md", base.parent.parent / ".qa" / "MAPA.md", Path.cwd() / ".qa" / "MAPA.md"]
    return candidatos


def falta_de_mapa(dados: dict, base: Path) -> list:
    r = dados.get("rodada") or {}
    faltas = []
    inicio = instante(r.get("inicio"))
    achado = None
    for p in caminho_do_mapa(dados, base):
        if p.is_file() and p.stat().st_size > 0:
            achado = p
            break
    if achado is None:
        faltas.append(".qa/MAPA.md (ou o caminho do PERFIL, 'Mapa do projeto:') ausente: grave o mapa da fase 2 "
                      "(references/qualidade-e-refatoracao.md §2.6)")
    elif inicio is not None and achado.stat().st_mtime < inicio.timestamp():
        faltas.append(f"{achado} nao foi revalidado nesta rodada (modificado antes de rodada.inicio): atualize o mapa")
    itens = [i for i in dados["itens"] if isinstance(i, dict)]
    com_caso = {c.get("item_id") for c in dados["casos"] if isinstance(c, dict)}
    tem_modulo = any(tipo_do_item(i) == "modulo" and i.get("id") in com_caso for i in itens)
    sem_codigo = any(isinstance(c, dict) and c.get("status") == "nao-aplicavel"
                     and sufixo_dimensao(c.get("item_id")).upper() in ("QC", "8.1")
                     and "sem codigo-fonte acessivel:" in normalizar_texto(c.get("justificativa"))
                     for c in dados["casos"])
    if not tem_modulo and not sem_codigo:
        faltas.append("nenhum item modulo: com caso (fase 2: mapa de modulos; alvo de um arquivo so = "
                      "modulo:<o arquivo>) nem dimensao:QC nao-aplicavel 'sem código-fonte acessível: ...'")
    return faltas


def problemas_de_tipo(dados: dict, tipos: list) -> tuple:
    """(motivos, avisos): llm e monorepo exigem o tipo de base; itens que pedem um tipo nao declarado."""
    motivos, avisos = [], []
    st = set(tipos)
    if "llm" in st and not st & TIPOS_BASE_LLM:
        motivos.append("llm exige o tipo de base: declare tambem front-web, full-stack ou api "
                       "(cobertura.py rodada <rodada> --tipo-projeto llm,<base>)")
    if "monorepo" in st and len(st) == 1:
        motivos.append("monorepo exige o tipo de cada pacote: declare tambem os tipos (ex.: --tipo-projeto "
                       "monorepo,front-web,biblioteca)")
    pedidos = defaultdict(set)
    for it in dados.get("itens") or []:
        if isinstance(it, dict):
            t = TIPO_INFERIDO_POR_ITEM.get(tipo_do_item(it))
            if t and t not in st:
                pedidos[t].add(str(it.get("id")))
    for t, ids in sorted(pedidos.items()):
        amostra = ", ".join(sorted(ids)[:3]) + (" ..." if len(ids) > 3 else "")
        avisos.append(f"itens pedem o tipo {t}, que nao foi declarado ({amostra}): rodada --tipo-projeto "
                      f"{','.join(list(tipos) + [t])}")
    return motivos, avisos


def checar_reteste(dados: dict, base: Path) -> list:
    """Modo reteste: rodada nascida de init --reteste-de, com ao menos um defeito importado nao retratado. Cada
    defeito importado tem caso regressao DESTA rodada concluido com evidencia -RETESTE em disco (se esta rodada o
    corrigiu de novo, -CORRIGIDO ou -DEPOIS tambem servem) e o veredito na nota 07; o defeito novo achado no
    entorno e corrigido aqui (retestado-ok) aceita -RETESTE, -CORRIGIDO ou -DEPOIS."""
    faltas = []
    r = dados.get("rodada") or {}
    rid = id_da_rodada(r, base)
    origem = r.get("reteste_de")
    if not isinstance(origem, dict) or vazio(origem.get("pasta")):
        faltas.append("modo reteste sem rodada de origem: cobertura.py init <pasta> --modo reteste --reteste-de "
                      "<rodada-original>")
    casos = [c for c in dados["casos"] if isinstance(c, dict)]
    texto07 = ler_nota(base, "07", "correcao")
    veredito = veredito_por_defeito(texto07)
    reais = [d for d in dados["defeitos"] if isinstance(d, dict) and (d.get("tipo") or "defeito") != "retratado"]
    if not any(not vazio(d.get("importado_de")) for d in reais):
        faltas.append("modo reteste sem defeito a retestar: nenhum defeito importado da rodada de origem (init "
                      "--reteste-de) que nao seja retratado")
    for d in reais:
        did = str(d.get("id"))
        importado = not vazio(d.get("importado_de"))
        if not importado and d.get("status") != "retestado-ok":
            continue
        corrigido_aqui = not importado or d.get("corrigido_em_rodada") == rid
        sufixos = ("-RETESTE", "-CORRIGIDO", "-DEPOIS") if corrigido_aqui else ("-RETESTE",)
        regs = [c for c in casos if c.get("defeito_id") == did and c.get("tecnica") == "regressao"
                and vazio(c.get("importado_de")) and c.get("status") not in (None, "", "pendente")]
        com_reteste = [c for c in regs if any(any(s in p.name.upper() for s in sufixos)
                                              for p in evidencias_validas(c.get("evidencias"), base))]
        if not com_reteste:
            nomes = " ou ".join(sufixos)
            fora_do_pull = (f"; se este defeito nao faz parte do pull, recrie a rodada com cobertura.py init <outra-pasta> "
                            f"--modo reteste --reteste-de {origem.get('pasta') if isinstance(origem, dict) else '...'} "
                            f"--defeito <os do pull>") if importado else ""
            faltas.append(f"{did}: sem caso --tecnica regressao --defeito {did} desta rodada, concluido, com "
                          f"evidencia {nomes} em disco (add-caso ... --evidencia evidencias/NN-...{sufixos[0]}.png; "
                          f"caso importado da rodada de origem nao conta){fora_do_pull}")
        if importado and texto07 and not veredito.get(did):
            faltas.append(f"{did}: notas/07-correcao.md sem o veredito RESOLVEU ou PRECISA DE AJUSTE junto do id")
    return faltas


def checar_gate(dados: dict, achados: Achados, so_cobertura: bool = False, base: Path | None = None):
    motivos = []
    detalhes = {}
    r = dados.get("rodada") if isinstance(dados.get("rodada"), dict) else {}
    modo = modo_da_rodada(r)
    detalhes["modo"] = modo
    reteste = modo == "reteste"
    casos = [c for c in dados["casos"] if isinstance(c, dict)]
    itens = [i for i in dados["itens"] if isinstance(i, dict)]
    defeitos = [d for d in dados["defeitos"] if isinstance(d, dict)]
    if achados.erros:
        motivos.append(f"{len(achados.erros)} erro(s) de validacao")
    if not itens:
        motivos.append('ledger sem itens: enumere a superficie antes de testar -> cobertura.py add-item <rodada> --id '
                       '"<tipo>:<caminho>" --titulo "..." --origem "<arquivo:linha, menu, rota>" (em lote: parcial + '
                       'merge; do codigo: escopo_diff.py --tudo --parcial)')
    if not casos:
        motivos.append('ledger sem casos: cada item precisa de ao menos um caso -> cobertura.py add-caso <rodada> --item '
                       '"<id do item>" --tecnica <tecnica> --esperado "<resultado esperado>" --titulo "[COD-NN] ..."')
    pendentes = [c for c in casos if c.get("status") == "pendente"]
    if pendentes:
        motivos.append(f"{len(pendentes)} caso(s) pendente(s)")
        detalhes["pendentes"] = pendentes
    sem_caso = [x for x in achados.erros if x[0] == "item-sem-caso"]
    if sem_caso:
        motivos.append(f"{len(sem_caso)} item(ns) sem caso")
        detalhes["sem_caso"] = [x[1] for x in sem_caso]
    if base is not None:
        sem_prova = [c for c in casos if c.get("status") in STATUS_EXIGE_EVIDENCIA
                     and not evidencias_validas(c.get("evidencias"), base)]
        if sem_prova:
            motivos.append(f"{len(sem_prova)} caso(s) concluido(s) sem evidencia valida em disco (arquivo com mais de "
                           f"0 byte em evidencias/, rede/, notas/ ou relatorio/)")
            detalhes["sem_prova"] = sem_prova
    if so_cobertura:
        return motivos, detalhes

    regressoes = defaultdict(list)
    for c in casos:
        if c.get("tecnica") == "regressao" and not vazio(c.get("defeito_id")):
            regressoes[str(c.get("defeito_id"))].append(c)
    abertos = [d for d in defeitos if d.get("status") == "aberto"]
    if abertos:
        motivos.append(f"{len(abertos)} defeito(s) aberto(s): corrija e reteste, ou marque "
                       f'"nao-corrigido" com justificativa')
        detalhes["abertos"] = abertos
    sem_reteste = [d for d in defeitos if d.get("status") == "corrigido" and (d.get("tipo") or "defeito") != "retratado"
                   and justificativa_fraca(d.get("justificativa"), "bloqueado") is not None]
    if sem_reteste:
        motivos.append(f"{len(sem_reteste)} defeito(s) corrigido(s) sem reteste: reteste no alvo real e marque "
                       f"\"retestado-ok\", ou diga o que falta (\"falta …; destrava: …\"); 'sem tempo' nunca")
        detalhes["sem_reteste"] = sem_reteste
    if base is not None:
        mal_retestados = []
        for d in defeitos:
            if d.get("status") == "retestado-ok" and (d.get("tipo") or "defeito") not in ("retratado",
                                                                                         "decisao-de-produto"):
                prob = problema_reteste(str(d.get("id")), casos, base)
                if prob:
                    mal_retestados.append(f"{d.get('id')}: {prob}")
        if mal_retestados:
            motivos.append(f"{len(mal_retestados)} defeito(s) retestado-ok sem reteste que passou / com reteste que "
                           f"falhou")
            detalhes["mal_retestados"] = mal_retestados
    sujeira = [s for s in dados["sujeira"] if isinstance(s, dict) and vazio(s.get("estado_final"))]
    if sujeira:
        motivos.append(f"{len(sujeira)} registro(s) de sujeira sem estado_final -> cobertura.py set <rodada> S-NNN "
                       f'--estado-final "ficou|revertido|apagado|desconhecido-pedir-ao-usuario[: texto]" '
                       f'[--como-desfazer "..."] ("ficou" exige --como-desfazer)')
        detalhes["sujeira"] = sujeira

    if not reteste:
        casos_por_item = defaultdict(list)
        for c in casos:
            casos_por_item[c.get("item_id")].append(c)
        sem_dim = []
        for it in itens:
            if tipo_do_item(it) not in TIPOS_COM_DIMENSOES or str(it.get("escopo") or "dentro") == "fora":
                continue
            cobertas = set()
            for c in casos_por_item.get(it.get("id"), []):
                if c.get("status") == "nao-aplicavel" and vazio(c.get("justificativa")):
                    continue
                cobertas.update(dimensoes_do_caso(c))
            faltam = [d for d in DIMENSOES if d not in cobertas]
            if faltam:
                sem_dim.append(f"{it.get('id')} sem dimensão(ões): {', '.join(faltam)}")
        if sem_dim:
            motivos.append(f"{len(sem_dim)} acao(oes) ({', '.join(t + ':' for t in TIPOS_COM_DIMENSOES)}) sem as cinco "
                           f"dimensoes (acerto, erro, limite, bloqueio, risco): crie o caso com --dimensao, ou "
                           f"nao-aplicavel justificado para a dimensao")
            detalhes["sem_dimensao"] = sem_dim

        secou, n_crit, precisa = critico_secou(r)
        if not secou:
            motivos.append(f"critico de completude nao secou: {n_crit} passada(s) registrada(s), e as {precisa} ultimas "
                           f"precisam ter zero item e zero caso novos (cobertura.py rodada <rodada> --critica "
                           f'"passada=N;novos_itens=0;novos_casos=0;origem=<o que foi conferido>")')

    tipos = tipos_da_rodada(r)
    detalhes["tipos"] = tipos
    try:
        validos = sorted(tipos_de_projeto())
        desconhecidos = [t for t in tipos if t not in validos]
        if desconhecidos:
            motivos.append(f'tipo(s) de projeto desconhecido(s): {", ".join(desconhecidos)} '
                           f'(validos: {", ".join(validos)})')
        elif not tipos:
            if not reteste:
                motivos.append(f"tipo de projeto nao declarado (cobertura.py rodada <rodada> --tipo-projeto "
                               f"<slug>[,<slug>]; validos: {', '.join(validos)})")
        elif not reteste:
            faltam, condicionais = faltas_de_secao(dados, tipos)
            if faltam:
                motivos.append(f"{len(faltam)} secao/modulo sem caso nem nao-aplicavel: "
                               f"{', '.join(faltam[:10])}{' ...' if len(faltam) > 10 else ''} "
                               f"(veja: cobertura.py secoes <rodada>)")
                detalhes["secoes"] = faltam
            if condicionais:
                detalhes["secoes_condicionais"] = condicionais
        if tipos and not desconhecidos:
            mot_tipo, av_tipo = problemas_de_tipo(dados, tipos)
            motivos += mot_tipo
            if av_tipo:
                detalhes["avisos_tipo"] = av_tipo
    except ErroCatalogo as e:
        motivos.append(f"catalogo ilegivel, secoes e modulos nao conferidos (falha fechada): {e}")

    if not reteste:
        minimos = faltas_de_minimo(dados)
        if minimos:
            motivos.append(f"{len(minimos)} falta(s) do minimo por tipo de item (catalogo §1.3): telas sem elementos, "
                           f"estados ou navegacao; papel, estado, efeito ou flag sem o caso de bloqueio")
            detalhes["minimos"] = minimos
        contagens = faltas_de_contagem(r, tipos)
        if contagens:
            motivos.append(f"{len(contagens)} pendencia(s) de contagem do inventario por tipo (fase 3)")
            detalhes["contagens"] = contagens

    corrigidos = [d for d in defeitos if d.get("status") in ("corrigido", "retestado-ok")
                  and (d.get("tipo") or "defeito") != "retratado"]
    if reteste:
        rid = id_da_rodada(r, base)
        corrigidos = [d for d in corrigidos if rid and d.get("corrigido_em_rodada") == rid]
    if base is None:
        return motivos, detalhes
    itens_por_id = {str(i.get("id")): i for i in itens}
    if corrigidos:
        ids_corrigidos = {str(d.get("id")) for d in corrigidos}
        cobertos = set()
        for c in casos:
            it = itens_por_id.get(str(c.get("item_id")))
            ligados = set(defeitos_do_caso(c)) & ids_corrigidos
            if not it or tipo_do_item(it) != "estatico" or not ligados:
                continue
            if c.get("status") == "passou" and evidencia_antes_depois(c, base):
                cobertos |= ligados
            elif c.get("status") == "bloqueado" and normalizar_texto(c.get("justificativa")).startswith(
                    "gate nao executavel:"):
                cobertos |= ligados
        sem_estatico = sorted(ids_corrigidos - cobertos)
        if sem_estatico:
            motivos.append(f"correcao sem item estatico: ligado: {', '.join(sem_estatico)} (caso passou "
                           "--defeito D-NNN, repetivel para cobrir varios, com evidencia de TEXTO com o numero antes e "
                           "depois do typecheck/lint/testes, ex.: 'antes: 308 erros | depois: 308 erros'; ou bloqueado "
                           "'gate não executável: ...')")
            detalhes["sem_estatico"] = sem_estatico
        snapshot = [n for n in NOTAS_SNAPSHOT if (base / "notas" / n).is_file()
                    and (base / "notas" / n).stat().st_size > 0]
        if not snapshot:
            motivos.append("ha correcao de codigo sem notas/00-git-status-inicial.txt (ou notas/00-snapshot-inicial.txt "
                           "em projeto sem git): o estado inicial separa o seu diff do que ja estava aberto")

    rodada_falta = []
    if vazio(r.get("ambiente")):
        rodada_falta.append('ambiente vazio (cobertura.py rodada <rodada> --ambiente "front -> API -> banco, medido")')
    if dados["sujeira"] and not (isinstance(r.get("ambiente_confirmado"), dict)
                                 and not vazio(r["ambiente_confirmado"].get("por"))
                                 and not vazio(r["ambiente_confirmado"].get("em"))):
        rodada_falta.append('houve escrita (sujeira registrada) sem ambiente confirmado por medicao (cobertura.py '
                            'rodada <rodada> --ambiente-confirmado "<o que mediu>|agora")')
    if vazio(r.get("inicio")):
        rodada_falta.append('inicio vazio (cobertura.py rodada <rodada> --inicio "<data e hora do inicio>")')
    if vazio(r.get("fim")):
        rodada_falta.append("fim vazio (cobertura.py rodada <rodada> --fim agora)")
    if vazio(r.get("perfil")):
        rodada_falta.append("perfil vazio (cobertura.py rodada <rodada> --perfil .qa/PERFIL.md)")
    elif not perfil_existe(r.get("perfil"), base):
        rodada_falta.append(f'perfil "{r.get("perfil")}" nao encontrado (caminho relativo a raiz do projeto)')
    if reteste:
        notas_exigidas = list(NOTAS_RETESTE)
        if not lista_evidencias(r.get("git")):
            rodada_falta.append('modo reteste sem rodada.git (cobertura.py rodada <rodada> --git '
                                '"<repo>|<branch>|<commit>"): o veredito vale para o commit testado')
        rodada_falta += checar_reteste(dados, base)
    else:
        notas_exigidas = list(NOTAS_FINAIS) + ([NOTA_CORRECAO] if corrigidos else [])
    for numero, prefixo, nome in notas_exigidas:
        if not nota_existe(base, numero, prefixo):
            rodada_falta.append(f"notas/{nome} ausente ou vazia (templates/nota-de-fase.md)")
    if not reteste:
        estudo = ler_nota(base, "02", "estudo")
        if estudo and not secao_da_nota(estudo, "Entendimento"):
            rodada_falta.append("notas/02-estudo.md sem a secao 'Entendimento' preenchida (fase 2)")
        rodada_falta += falta_de_mapa(dados, base)
    if rodada_falta:
        motivos.append(f"rodada incompleta: {len(rodada_falta)} pendencia(s) de registro")
        detalhes["rodada"] = rodada_falta
    mot_lib, av_lib = problemas_de_biblioteca(dados, tipos)
    motivos += mot_lib
    if av_lib:
        detalhes.setdefault("avisos_tipo", []).extend(av_lib)
    if base is not None:
        motivos += checar_modo_pr(dados, base)
    return motivos, detalhes


def problemas_de_biblioteca(dados: dict, tipos: list) -> tuple:
    """Biblioteca: o caso [PJ-LIB-07] (pacote empacotado instalado num consumidor) passou, ou bloqueado com
    'destrava: ...' (empacotar nao funcionou, caminho B); aviso quando ha reteste com esse caso bloqueado."""
    if "biblioteca" not in tipos:
        return [], []
    casos = [c for c in dados["casos"] if isinstance(c, dict)]
    lib07 = [c for c in casos if "PJ-LIB-07" in codigos_do_caso(c)]
    passou = [c for c in lib07 if c.get("status") == "passou"]
    bloq = [c for c in lib07 if c.get("status") == "bloqueado" and "destrava:" in normalizar_texto(c.get("justificativa"))]
    motivos, avisos = [], []
    if not passou and not bloq:
        motivos.append("biblioteca sem caso [PJ-LIB-07] (pacote empacotado instalado num consumidor) que passou, nem "
                       "bloqueado com 'destrava: ...' quando empacotar nao funciona (caminho B: "
                       "references/execucao-e-evidencias.md, CLI e biblioteca)")
    if bloq and not passou:
        ret = [str(d.get("id")) for d in dados["defeitos"] if isinstance(d, dict) and d.get("status") == "retestado-ok"]
        if ret:
            avisos.append(f"reteste feito fora do pacote empacotado: {', '.join(ret)} retestado-ok com o caso "
                          f"[PJ-LIB-07] bloqueado ({', '.join(str(c.get('id')) for c in bloq)}); o reteste no pacote "
                          "vai na ressalva do nao validado")
    return motivos, avisos


def cauda_mascarada(texto, n: int = 5) -> str:
    linhas = [l.strip() for l in str(texto or "").splitlines() if l.strip()]
    return vis(" | ".join(linhas[-n:])) or "(sem saida)"


def raiz_do_projeto(r: dict, base: Path) -> Path:
    ed = r.get("escopo_diff") if isinstance(r.get("escopo_diff"), dict) else {}
    if not vazio(ed.get("raiz")):
        p = Path(str(ed.get("raiz"))).expanduser()
        return p if p.is_absolute() else (base.resolve() / p).resolve()
    b = base.resolve()
    if b.parent.name == ".qa":
        return b.parent.parent
    return Path.cwd()


RE_LINHA_GIT_STATUS = re.compile(r"^(?=.?[MADRCUT?!])([ MADRCUT?!]{2}) (\S.*)$")


def desaspar_caminho_git(c: str) -> str:
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


def caminhos_status_inicial(base: Path) -> list:
    """Caminhos das linhas 'XY caminho' (git status --short/--porcelain) de notas/00-git-status-inicial.txt; num
    rename ('R  velho -> novo'), os dois. Ignora .qa/, a linha da branch e o git log."""
    p = base / "notas" / "00-git-status-inicial.txt"
    try:
        texto = p.read_text(encoding="utf-8-sig", errors="replace")
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
            c = desaspar_caminho_git(parte).replace("\\", "/").strip()
            while c.startswith("./"):
                c = c[2:]
            if not c or c.startswith(".qa/") or "/.qa/" in c or c == ".qa":
                continue
            if c not in saida:
                saida.append(c)
    return saida


def checar_modo_pr(dados: dict, base: Path) -> list:
    """Modo PR (rodada.escopo_diff gravado pelo --parcial com base e modo diff): o gate roda o escopo_diff com
    --incluir-working e --falhar-se-descoberto, excluindo do diff o que ja estava alterado em
    notas/00-git-status-inicial.txt (outra sessao: fora da entrega; passado como --excluir-arquivo e, numa lista longa
    demais para a linha de comando, lido pelo proprio escopo_diff do --ledger) e os globs de rodada.escopo_diff.excluir.
    Arquivo de raio nao calculado so passa coberto pela secao 'Raio completado à mão' da nota 09. Qualquer outra
    saida, timeout ou erro reprova (falha fechada)."""
    r = dados.get("rodada") or {}
    ed = r.get("escopo_diff")
    if not isinstance(ed, dict) or vazio(ed.get("base")) or normalizar(ed.get("modo")) != "diff":
        return []
    base_pr = str(ed.get("base")).strip()
    raiz = raiz_do_projeto(r, base)
    cmd = [sys.executable, str(PASTA_SKILL / "scripts" / "escopo_diff.py"), "--raiz", str(raiz), "--base", base_pr,
           "--incluir-working", "--ledger", str(base.resolve()), "--falhar-se-descoberto", "--formato", "json"]
    pref = str(ed.get("prefixo_api") or "").strip()
    if pref:
        cmd += ["--prefixo-api", pref]
    manter = ed.get("manter_status_inicial") is True
    iniciais = [] if manter else caminhos_status_inicial(base)
    if manter:
        cmd += ["--manter-status-inicial"]
    if sum(len(c) + 20 for c in iniciais) <= 16000:
        for c in iniciais:
            cmd += ["--excluir-arquivo", c]
    globs = [str(g).strip() for g in lista_evidencias(ed.get("excluir")) if str(g or "").strip()]
    for g in globs:
        cmd += ["--excluir", g]
    quadro = (f"rode escopo_diff.py --base {base_pr} --incluir-working --ledger <rodada> --falhar-se-descoberto "
              f"para o quadro")
    env = dict(os.environ, PYTHONIOENCODING="utf-8")
    try:
        proc = subprocess.run(cmd, capture_output=True, text=True, encoding="utf-8", errors="replace", timeout=600,
                              env=env)
    except subprocess.TimeoutExpired:
        return ["modo PR: escopo_diff nao rodou (rc timeout, 600 s): o gate nao confere o diff sem ele"]
    except Exception as e:
        return [f"modo PR: escopo_diff nao rodou (rc -): {vis(type(e).__name__ + ': ' + str(e))}"]
    if proc.returncode == 0:
        return []
    if proc.returncode != 1:
        return [f"modo PR: escopo_diff nao rodou (rc {proc.returncode}): {cauda_mascarada(proc.stderr)}"]
    try:
        res = json.loads(proc.stdout or "")
    except ValueError:
        res = None
    excl = res.get("excluidos") if isinstance(res, dict) and isinstance(res.get("excluidos"), dict) else {}
    n_excl = len(lista_evidencias(excl.get("status_inicial"))) if excl else 0
    if manter:
        quadro += "; rodada.escopo_diff.manter_status_inicial: o git status inicial conta como diff"
    else:
        quadro += (f"; {n_excl} arquivo(s) do diff fora da conta por ja estarem alterados no git status inicial (de "
                   f"{len(iniciais)} caminho(s) em notas/00-git-status-inicial.txt)")
    if globs:
        quadro += f", mais {len(globs)} glob(s) de rodada.escopo_diff.excluir"
    cob = res.get("cobertura") if isinstance(res, dict) else None
    if not isinstance(cob, dict):
        return [f"modo PR: itens do diff descobertos ({quadro}): {cauda_mascarada(proc.stderr)}"]
    try:
        descobertos = int(cob.get("descobertos") or 0)
    except (TypeError, ValueError):
        descobertos = 1
    sem_detector = [str(x) for x in lista_evidencias(cob.get("sem_detector")) if str(x or "").strip()]
    raio = [str(x) for x in lista_evidencias(cob.get("raio_incompleto")) if str(x or "").strip()]
    motivos = []
    if excl.get("todo_o_diff"):
        motivos.append(f"modo PR: todo o diff ({n_excl} arquivo(s)) ja estava alterado no git status inicial e saiu da "
                       f"conta, entao nada foi conferido: se o pedido e testar essas alteracoes, gere o parcial de novo "
                       f"com escopo_diff.py --manter-status-inicial e funda (cobertura.py merge); senao, confira a base "
                       f"({base_pr})")
    if descobertos or sem_detector:
        motivos.append(f"modo PR: itens do diff descobertos ({quadro})")
    if raio:
        secao = secao_da_nota(ler_nota(base, "09", "relatorio"), "Raio completado")
        faltam = [x for x in raio if x not in secao and x.replace("/", "\\") not in secao]
        if faltam:
            motivos.append(f"modo PR: raio NAO calculado (linguagem sem suporte ou servidor sem rota reconhecida) para {', '.join(faltam[:10])}"
                           f"{' ...' if len(faltam) > 10 else ''}: complete o raio a mao e cite cada arquivo na secao "
                           f"'Raio completado à mão' de notas/09-relatorio.md")
    elif not motivos:
        motivos.append(f"modo PR: escopo_diff saiu 1 sem dizer o que ficou descoberto ({quadro}): "
                       f"{cauda_mascarada(proc.stderr)}")
    return motivos


def checar_superficie_tudo(dados: dict, base: Path) -> list:
    """fechar, fora do modo PR e do reteste: escopo_diff.py --tudo --ledger <rodada> --falhar-se-descoberto precisa
    sair 0 (toda superficie que o detector acha no codigo tem item no ledger com caso concluido; item fora do escopo
    com nao-aplicavel justificado conta como coberto). Servidor sem rota reconhecida so passa citado na secao 'Raio
    completado à mão' da nota 09. Timeout, erro ou rc diferente de 0 e 1 reprova (falha fechada)."""
    r = dados.get("rodada") or {}
    if modo_da_rodada(r) not in ("completo", "revisao"):
        return []
    ed = r.get("escopo_diff") if isinstance(r.get("escopo_diff"), dict) else {}
    if not vazio(ed.get("base")) and normalizar(ed.get("modo")) == "diff":
        return []
    raiz = raiz_do_projeto(r, base)
    cmd = [sys.executable, str(PASTA_SKILL / "scripts" / "escopo_diff.py"), "--raiz", str(raiz), "--tudo",
           "--ledger", str(base.resolve()), "--falhar-se-descoberto", "--formato", "json"]
    pref = str(ed.get("prefixo_api") or "").strip()
    if pref:
        cmd += ["--prefixo-api", pref]
    env = dict(os.environ, PYTHONIOENCODING="utf-8")
    try:
        proc = subprocess.run(cmd, capture_output=True, text=True, encoding="utf-8", errors="replace", timeout=600,
                              env=env)
    except subprocess.TimeoutExpired:
        return ["escopo_diff --tudo nao rodou (rc timeout, 600 s): o fechar nao confere a superficie do codigo sem ele"]
    except Exception as e:
        return [f"escopo_diff --tudo nao rodou (rc -): {vis(type(e).__name__ + ': ' + str(e))}"]
    if proc.returncode == 0:
        return []
    if proc.returncode != 1:
        return [f"escopo_diff --tudo nao rodou (rc {proc.returncode}): {cauda_mascarada(proc.stderr)}"]
    try:
        res = json.loads(proc.stdout or "")
    except ValueError:
        res = None
    cob = res.get("cobertura") if isinstance(res, dict) else None
    comando = (f"escopo_diff.py --raiz <projeto> --tudo{' --prefixo-api ' + pref if pref else ''} --ledger <rodada> "
               f"--falhar-se-descoberto")
    if not isinstance(cob, dict):
        return [f"escopo_diff --tudo saiu 1 sem quadro legivel ({comando}): {cauda_mascarada(proc.stderr)}"]
    motivos = []
    descobertos = [str(x.get("item")) for x in lista_evidencias(cob.get("linhas"))
                   if isinstance(x, dict) and x.get("descoberto")]
    if descobertos:
        motivos.append(f"superficie detectada sem caso concluido: {', '.join(vis(x) for x in descobertos[:10])}"
                       f"{' ...' if len(descobertos) > 10 else ''} ({len(descobertos)} no total; quadro: {comando}). "
                       f"Crie o item e o caso, ou item --escopo fora com caso nao-aplicavel justificado")
    for falta in lista_evidencias(cob.get("sem_detector")):
        if str(falta or "").strip():
            motivos.append(f"superficie: {vis(falta)}")
    raio = [str(x) for x in lista_evidencias(cob.get("raio_incompleto")) if str(x or "").strip()]
    if raio:
        secao = secao_da_nota(ler_nota(base, "09", "relatorio"), "Raio completado")
        faltam = [x for x in raio if x not in secao and x.replace("/", "\\") not in secao]
        if faltam:
            motivos.append(f"superficie: servidor sem rota reconhecida em {', '.join(vis(x) for x in faltam[:10])}"
                           f"{' ...' if len(faltam) > 10 else ''}: enumere as rotas a mao, registre-as no ledger "
                           f"(e a --contagem api) e cite cada arquivo na secao 'Raio completado à mão' de "
                           f"notas/09-relatorio.md")
    if not motivos:
        motivos.append(f"escopo_diff --tudo saiu 1 sem dizer o que ficou descoberto ({comando}): "
                       f"{cauda_mascarada(proc.stderr)}")
    return motivos


def calcular_metricas(dados: dict, achados: Achados, motivos_gate: list) -> dict:
    casos = [c for c in dados["casos"] if isinstance(c, dict)]
    itens = [i for i in dados["itens"] if isinstance(i, dict)]
    defeitos = [d for d in dados["defeitos"] if isinstance(d, dict)]
    por_status = Counter(c.get("status") for c in casos)
    total = len(casos)
    concluidos = total - por_status.get("pendente", 0)
    por_tecnica = defaultdict(Counter)
    for c in casos:
        por_tecnica[c.get("tecnica") or "(sem tecnica)"][c.get("status")] += 1
    item_por_id = {str(i.get("id")): i for i in itens}
    casos_do_item = defaultdict(list)
    for c in casos:
        casos_do_item[c.get("item_id")].append(c)
    por_tipo = defaultdict(lambda: {"itens": 0, "sem_caso": 0, "casos": 0, "passou": 0, "falhou": 0, "pendente": 0})
    sem_caso = []
    for iid, it in item_por_id.items():
        t = tipo_do_item(it)
        linha = por_tipo[t]
        linha["itens"] += 1
        lista = casos_do_item.get(iid, [])
        if not lista:
            linha["sem_caso"] += 1
            sem_caso.append(iid)
        for c in lista:
            linha["casos"] += 1
            if c.get("status") in ("passou", "falhou", "pendente"):
                linha[c.get("status")] += 1
    def_matriz = defaultdict(Counter)
    for d in defeitos:
        def_matriz[d.get("severidade") or "(sem)"][d.get("status") or "(sem)"] += 1
    return {
        "rodada": dados.get("rodada", {}),
        "gerado_em": agora_iso(),
        "total_itens": len(itens),
        "total_casos": total,
        "concluidos": concluidos,
        "cobertura_pct": round(100.0 * concluidos / total, 1) if total else 0.0,
        "passou_pct": round(100.0 * por_status.get("passou", 0) / total, 1) if total else 0.0,
        "por_status": {s: por_status.get(s, 0) for s in STATUS_CASO},
        "por_tecnica": {k: dict(v) for k, v in sorted(por_tecnica.items())},
        "por_tipo_item": {k: v for k, v in sorted(por_tipo.items())},
        "itens_sem_caso": sem_caso,
        "pendentes": [c.get("id") for c in casos if c.get("status") == "pendente"],
        "nao_ok": [c.get("id") for c in casos if c.get("status") not in ("passou", "pendente")],
        "defeitos_total": len(defeitos),
        "defeitos_por_severidade_status": {k: dict(v) for k, v in def_matriz.items()},
        "defeitos_abertos": [d.get("id") for d in defeitos if d.get("status") == "aberto"],
        "sujeira_total": len(dados.get("sujeira", [])),
        "erros_validacao": len(achados.erros),
        "avisos_validacao": len(achados.avisos),
        "gate_passa": not motivos_gate,
        "gate_motivos": motivos_gate,
    }


def resumir(texto, limite: int = 90) -> str:
    s = re.sub(r"\s+", " ", str(texto or "")).strip()
    return s if len(s) <= limite else s[: limite - 1] + "..."


def montar_blocos(dados: dict, m: dict, achados: Achados) -> list:
    r = dados.get("rodada", {})
    casos = [c for c in dados["casos"] if isinstance(c, dict)]
    defeitos = [d for d in dados["defeitos"] if isinstance(d, dict)]
    b = []
    b.append(("h1", f"Relatório de cobertura — {r.get('alvo') or '(sem alvo)'}"))
    meta = []
    for chave, rotulo in (("id", "rodada"), ("escopo", "escopo"), ("ambiente", "ambiente"),
                          ("inicio", "início"), ("fim", "fim")):
        if not vazio(r.get(chave)):
            meta.append(f"{rotulo}: {r.get(chave)}")
    if meta:
        b.append(("p", " | ".join(meta)))
    if r.get("autorizacoes"):
        b.append(("p", "autorizações: " + "; ".join(str(x) for x in r["autorizacoes"])))
    b.append(("h2", "Resumo"))
    b.append(("tabela", ["Itens", "Casos", "Concluídos", "Cobertura", "Passou", "Falhou",
                         "Pendentes", "Defeitos abertos"],
              [[m["total_itens"], m["total_casos"], m["concluidos"], f"{m['cobertura_pct']}%",
                m["por_status"]["passou"], m["por_status"]["falhou"], m["por_status"]["pendente"],
                len(m["defeitos_abertos"])]]))
    if m["gate_passa"]:
        b.append(("p", "Gate: PASSA"))
    else:
        b.append(("p", "Gate: NÃO PASSA"))
        b.append(("ul", m["gate_motivos"]))

    b.append(("h2", "Casos por status"))
    total = m["total_casos"] or 1
    b.append(("tabela", ["Status", "Casos", "%"],
              [[s, n, f"{round(100.0 * n / total, 1)}%"] for s, n in m["por_status"].items()]))

    b.append(("h2", "Casos por técnica"))
    cab = ["Técnica", "Total"] + STATUS_CASO
    linhas = []
    for tec, cont in m["por_tecnica"].items():
        linhas.append([tec, sum(cont.values())] + [cont.get(s, 0) for s in STATUS_CASO])
    b.append(("tabela", cab, linhas))

    b.append(("h2", "Itens por tipo"))
    b.append(("tabela", ["Tipo", "Itens", "Sem caso", "Casos", "Passou", "Falhou", "Pendentes"],
              [[t, v["itens"], v["sem_caso"], v["casos"], v["passou"], v["falhou"], v["pendente"]]
               for t, v in m["por_tipo_item"].items()]))

    b.append(("h2", f"Itens sem caso ({len(m['itens_sem_caso'])})"))
    b.append(("ul", m["itens_sem_caso"] or ["nenhum"]))

    pend = [c for c in casos if c.get("status") == "pendente"]
    b.append(("h2", f"Casos pendentes ({len(pend)})"))
    if pend:
        b.append(("tabela", ["Caso", "Item", "Técnica", "Esperado"],
                  [[c.get("id"), c.get("item_id"), c.get("tecnica"), resumir(c.get("resultado_esperado"))]
                   for c in pend]))
    else:
        b.append(("p", "nenhum"))

    nok = [c for c in casos if c.get("status") in ("falhou", "bloqueado", "retratado", "nao-aplicavel")]
    b.append(("h2", f"Casos que não passaram ({len(nok)})"))
    if nok:
        b.append(("tabela", ["Caso", "Status", "Item", "Defeito / justificativa"],
                  [[c.get("id"), c.get("status"), c.get("item_id"),
                    resumir(c.get("defeito_id") or c.get("justificativa"), 120)] for c in nok]))
    else:
        b.append(("p", "nenhum"))

    nv = [c for c in casos if c.get("status") == "nao-validado"]
    b.append(("h2", f"O que NÃO foi validado, e por quê ({len(nv)})"))
    if nv:
        b.append(("tabela", ["Caso", "Item", "Por quê"],
                  [[c.get("id"), c.get("item_id"), resumir(c.get("justificativa"), 140)] for c in nv]))
    else:
        b.append(("p", "nada"))

    b.append(("h2", f"Defeitos ({len(defeitos)})"))
    if defeitos:
        sts = STATUS_DEFEITO
        b.append(("tabela", ["Severidade"] + sts + ["Total"],
                  [[sev] + [m["defeitos_por_severidade_status"].get(sev, {}).get(s, 0) for s in sts]
                   + [sum(m["defeitos_por_severidade_status"].get(sev, {}).values())]
                   for sev in SEVERIDADES + [k for k in m["defeitos_por_severidade_status"] if k not in SEVERIDADES]
                   if sev in m["defeitos_por_severidade_status"]]))
        ordem = {s: i for i, s in enumerate(SEVERIDADES)}
        b.append(("tabela", ["Defeito", "Sev.", "Tipo", "Status", "Título", "Onde"],
                  [[d.get("id"), d.get("severidade"), d.get("tipo"), d.get("status"), resumir(d.get("titulo"), 80),
                    resumir(d.get("onde"), 60)]
                   for d in sorted(defeitos, key=lambda x: (ordem.get(x.get("severidade"), 9), str(x.get("id"))))]))
    else:
        b.append(("p", "nenhum"))

    sujeira = [s for s in dados["sujeira"] if isinstance(s, dict)]
    b.append(("h2", f"Sujeira deixada nos ambientes ({len(sujeira)})"))
    if sujeira:
        b.append(("tabela", ["Id", "Ambiente", "O que", "Estado final"],
                  [[s.get("id"), s.get("ambiente"), resumir(s.get("o_que"), 80), resumir(s.get("estado_final"), 60)]
                   for s in sujeira]))
    else:
        b.append(("p", "nenhuma"))

    b.append(("h2", "Validação do ledger"))
    b.append(("p", f"{len(achados.erros)} erro(s), {len(achados.avisos)} aviso(s)."))
    if achados.erros:
        b.append(("ul", [f"[{c}] {alvo}: {t}" for c, alvo, t in achados.erros[:200]]))
    b.append(("p", f"gerado em {m['gerado_em']}"))
    return b


def celula_md(v) -> str:
    return str("" if v is None else v).replace("|", "\\|").replace("\n", " ")


def blocos_para_md(blocos: list) -> str:
    out = []
    for blk in blocos:
        tipo = blk[0]
        if tipo == "h1":
            out.append(f"# {blk[1]}\n")
        elif tipo == "h2":
            out.append(f"\n## {blk[1]}\n")
        elif tipo == "p":
            out.append(f"{blk[1]}\n")
        elif tipo == "ul":
            out.extend(f"- {celula_md(x)}" for x in blk[1])
            out.append("")
        elif tipo == "tabela":
            cab, linhas = blk[1], blk[2]
            out.append("| " + " | ".join(celula_md(c) for c in cab) + " |")
            out.append("|" + "|".join("---" for _ in cab) + "|")
            for ln in linhas:
                out.append("| " + " | ".join(celula_md(c) for c in ln) + " |")
            out.append("")
    return re.sub(r"\n{3,}", "\n\n", "\n".join(out)).rstrip() + "\n"


CSS_HTML = """
body{font-family:"Segoe UI",-apple-system,"Helvetica Neue",Arial,"DejaVu Sans",sans-serif;color:#181B21;
max-width:1100px;margin:24px auto;padding:0 16px;line-height:1.5;font-size:14px}
h1{font-size:22px;margin:0 0 8px}h2{font-size:16px;margin:24px 0 8px;border-bottom:1px solid #E4E8EC;padding-bottom:4px}
table{border-collapse:collapse;width:100%;font-size:13px;margin:6px 0}
th,td{border:1px solid #C7CED6;padding:4px 8px;text-align:left;vertical-align:top}
th{background:#F0F2F4}tbody tr:nth-child(even) td{background:#F9FAFB}
td.n{text-align:right;font-variant-numeric:tabular-nums;white-space:nowrap}
.gate-ok{color:#08725D;font-weight:700}.gate-falha{color:#B91C1C;font-weight:700}
@page{size:A4;margin:16mm}tr{break-inside:avoid}
"""


def blocos_para_html(blocos: list, titulo: str) -> str:
    esc = lambda v: html.escape(str("" if v is None else v))
    out = ["<!doctype html>", '<html lang="pt-BR"><head><meta charset="utf-8">',
           '<meta name="viewport" content="width=device-width, initial-scale=1">',
           f"<title>{esc(titulo)}</title><style>{CSS_HTML}</style></head><body>"]
    for blk in blocos:
        tipo = blk[0]
        if tipo == "h1":
            out.append(f"<h1>{esc(blk[1])}</h1>")
        elif tipo == "h2":
            out.append(f"<h2>{esc(blk[1])}</h2>")
        elif tipo == "p":
            texto = str(blk[1])
            if texto.startswith("Gate: "):
                classe = "gate-ok" if texto == "Gate: PASSA" else "gate-falha"
                out.append(f'<p class="{classe}">{esc(texto)}</p>')
            else:
                out.append(f"<p>{esc(texto)}</p>")
        elif tipo == "ul":
            out.append("<ul>" + "".join(f"<li>{esc(x)}</li>" for x in blk[1]) + "</ul>")
        elif tipo == "tabela":
            cab, linhas = blk[1], blk[2]
            out.append("<table><thead><tr>" + "".join(f"<th>{esc(c)}</th>" for c in cab) + "</tr></thead><tbody>")
            for ln in linhas:
                cels = []
                for v in ln:
                    classe = ' class="n"' if isinstance(v, (int, float)) or re.fullmatch(r"\d+(\.\d+)?%", str(v)) else ""
                    cels.append(f"<td{classe}>{esc(v)}</td>")
                out.append("<tr>" + "".join(cels) + "</tr>")
            out.append("</tbody></table>")
    out.append("</body></html>")
    return "\n".join(out) + "\n"


def escrever_texto(destino: str | None, texto: str) -> None:
    if destino:
        p = Path(destino).expanduser()
        p.parent.mkdir(parents=True, exist_ok=True)
        with open(p, "w", encoding="utf-8", newline="\n") as f:
            f.write(texto)
        print(f"escrito: {p}")
    else:
        sys.stdout.write(texto)


def dica_reteste(dados: dict) -> str:
    if modo_da_rodada(dados.get("rodada") or {}) != "reteste":
        return ""
    return (" (no modo reteste, os defeitos da rodada original entram pelo init: cobertura.py init <rodada> --modo "
            "reteste --reteste-de <rodada-original>)")


def checar_regras_caso(c: dict, defeitos_ids: set, item: dict | None = None, dica: str = "") -> list:
    problemas = []
    st = c.get("status")
    if st not in STATUS_CASO:
        problemas.append(f'status desconhecido "{st}"' + sugestao(st, STATUS_CASO))
    if st in STATUS_EXIGE_EVIDENCIA and not lista_evidencias(c.get("evidencias")):
        problemas.append(f'status "{st}" exige --evidencia')
    if st in STATUS_EXIGE_JUSTIFICATIVA:
        if vazio(c.get("justificativa")):
            problemas.append(f'status "{st}" exige --justificativa')
        else:
            fraca = justificativa_fraca(c.get("justificativa"), st, item)
            if fraca:
                problemas.append(f"--justificativa {fraca}")
    if st == "falhou" and vazio(c.get("defeito_id")):
        problemas.append('status "falhou" exige --defeito (crie antes com add-defeito)')
    for did in defeitos_do_caso(c):
        if did not in defeitos_ids:
            problemas.append(f'defeito "{did}" nao existe no ledger{dica}')
    if not vazio(c.get("dimensao")):
        dl = dimensoes_do_caso(c)
        invalidas = [x for x in dl if x not in DIMENSOES]
        if invalidas or not dl:
            problemas.append(f'--dimensao fora do vocabulario: "{c.get("dimensao")}" (validas: {", ".join(DIMENSOES)})')
        elif len(dl) > 1 and st != "nao-aplicavel":
            problemas.append("so caso nao-aplicavel declara mais de uma dimensao")
    return problemas


def normalizar_escolha(valor, validos, nome: str):
    if valor is None:
        return None
    n = normalizar(valor)
    if n not in validos:
        falhar(f'valor invalido para {nome}: "{valor}" (validos: {", ".join(validos)})')
    return n


def resolver_git_exclude(pasta: Path) -> str | None:
    partes = [p.lower() for p in pasta.resolve().parts]
    if ".qa" not in partes:
        return None
    atual = pasta.resolve()
    while True:
        git = atual / ".git"
        if git.is_dir():
            excl = git / "info" / "exclude"
            excl.parent.mkdir(parents=True, exist_ok=True)
            atual_txt = excl.read_text(encoding="utf-8", errors="replace") if excl.exists() else ""
            linhas = [ln.strip() for ln in atual_txt.splitlines()]
            if ".qa/" in linhas or "/.qa/" in linhas or ".qa" in linhas:
                return f".qa/ ja estava em {excl}"
            with open(excl, "a", encoding="utf-8", newline="\n") as f:
                if atual_txt and not atual_txt.endswith("\n"):
                    f.write("\n")
                f.write(".qa/\n")
            return f".qa/ adicionado a {excl} (local, nao versionado)"
        if git.is_file():
            return f"repositorio com .git em arquivo (worktree/submodulo): adicione .qa/ ao exclude manualmente"
        if atual.parent == atual:
            return None
        atual = atual.parent


def valor_tempo(v):
    if v is None:
        return None
    if str(v).strip().lower() == "agora":
        return agora_iso()
    if str(v).strip() and instante(v) is None:
        falhar(f'"{v}" nao e data ISO 8601 (use agora, ou date -Iseconds; PowerShell: Get-Date -Format o)')
    return str(v).strip()


def validar_tipos_projeto(valores):
    """--tipo-projeto repetivel e com virgula; devolve a lista de slugs (None se a opcao nao veio). Slug
    desconhecido em qualquer posicao sai 2."""
    if not valores:
        return None
    try:
        validos = sorted(tipos_de_projeto())
    except ErroCatalogo as e:
        falhar(f"nao consegui conferir --tipo-projeto: {e}")
    saida = []
    for bruto in separar_tipos(valores):
        slug = slug_tipo_projeto(bruto)
        if slug not in validos:
            falhar(f'tipo de projeto "{bruto}" desconhecido (validos, da tabela 1.4 do catalogo: {", ".join(validos)})')
        if slug not in saida:
            saida.append(slug)
    return saida or None


def parse_contagem(texto: str) -> dict:
    partes = [p.strip() for p in str(texto or "").split("|")]
    if len(partes) < 4 or not all(partes[:4]):
        falhar('--contagem precisa de "<modo>|<fonte>|<N no codigo>|<N no ledger>[|<justificativa>]" (ex.: '
               '"comando|subparsers do argparse x --help|12|12")')
    modo = normalizar(partes[0])
    for nome, v in (("N no codigo", partes[2]), ("N no ledger", partes[3])):
        if not re.fullmatch(r"\d+", v):
            falhar(f"--contagem: {nome} precisa ser inteiro >= 0 (veio {v!r})")
    just = "|".join(partes[4:]).strip()
    n_cod, n_led = int(partes[2]), int(partes[3])
    if n_led < n_cod and justificativa_fraca(just, "nao-aplicavel") is not None:
        print(f"aviso: contagem {modo}: {n_led} no ledger < {n_cod} no codigo sem justificativa concreta; o gate final "
              f"reprova ate voce gravar de novo a contagem (mesmo modo e fonte) com o N atual do ledger, depois de "
              f"registrar os faltantes, ou com a justificativa (a nova substitui esta)", file=sys.stderr)
    return {"modo": modo, "fonte": partes[1], "n_codigo": n_cod, "n_ledger": n_led, "justificativa": just,
            "em": agora_iso()}


def parse_ambiente_confirmado(texto: str) -> dict:
    s = str(texto or "").strip()
    if "|" not in s:
        falhar('--ambiente-confirmado precisa de "<o que mediu>|<agora ou data ISO>" (ex.: "host da API lido na aba '
               'de rede depois de F5|agora")')
    por, em = [x.strip() for x in s.rsplit("|", 1)]
    if len(por) < 10:
        falhar("--ambiente-confirmado: diga o que foi medido (minimo 10 caracteres)")
    if em.lower() == "agora":
        em = agora_iso()
    elif instante(em) is None:
        falhar(f"--ambiente-confirmado: \"{em}\" nao e data ISO (use agora, ou date -Iseconds; PowerShell: "
               f"Get-Date -Format o)")
    return {"por": por, "em": em}


def parse_critica(texto: str) -> dict:
    s = str(texto or "").strip()
    pos = s.find("origem=")
    if pos < 0:
        falhar('--critica precisa de "passada=N;novos_itens=N;novos_casos=N;origem=<texto>" (falta origem=)')
    origem = s[pos + len("origem="):].strip()
    campos = {}
    for parte in s[:pos].split(";"):
        parte = parte.strip()
        if not parte:
            continue
        if "=" not in parte:
            falhar(f'--critica: trecho mal formado "{parte}" (use chave=valor separados por ;)')
        k, v = parte.split("=", 1)
        campos[k.strip()] = v.strip()
    saida = {}
    for chave, minimo in (("passada", 1), ("novos_itens", 0), ("novos_casos", 0)):
        v = campos.get(chave)
        if v is None or not re.fullmatch(r"\d+", v) or int(v) < minimo:
            falhar(f'--critica: "{chave}" precisa ser inteiro >= {minimo} (veio {v!r}); formato: '
                   f'"passada=N;novos_itens=N;novos_casos=N;origem=<texto>"')
        saida[chave] = int(v)
    extras = set(campos) - {"passada", "novos_itens", "novos_casos"}
    if extras:
        falhar(f"--critica: campo(s) desconhecido(s): {', '.join(sorted(extras))}")
    if len(origem) < 10:
        falhar("--critica: origem precisa dizer o que foi conferido nesta passada (minimo 10 caracteres)")
    saida["origem"] = origem
    saida["em"] = agora_iso()
    return saida


def parse_baseline(texto: str) -> dict:
    partes = [p.strip() for p in str(texto or "").split("|")]
    if len(partes) < 3 or not all(partes[:3]):
        falhar('--baseline precisa de "<gate>|<comando>|<resultado>|<composicao>" (gate, comando e resultado '
               'obrigatorios; ex.: "typecheck|npx tsc --noEmit|308 erros|9 de arquivos gerados")')
    return {"gate": partes[0], "comando": partes[1], "resultado": partes[2],
            "composicao": "|".join(partes[3:]).strip(), "data": agora_iso()[:10]}


def parse_git(texto: str) -> dict:
    partes = [p.strip() for p in str(texto or "").split("|")]
    if len(partes) != 3 or not all(partes):
        falhar('--git precisa de "<repo>|<branch>|<commit>" (ex.: "front|develop|a1b2c3d")')
    return {"repo": partes[0], "branch": partes[1], "commit": partes[2]}


def acrescentar_git(rodada: dict, novos: list) -> None:
    atual = rodada.get("git")
    if isinstance(atual, dict):
        lista = [atual] if not vazio(atual) else []
    elif isinstance(atual, list):
        lista = [x for x in atual if isinstance(x, dict)]
    else:
        lista = []
    for n in novos:
        lista = [x for x in lista if str(x.get("repo") or "") != n["repo"]] + [n]
    rodada["git"] = lista


def aplicar_listas_rodada(r: dict, args) -> None:
    tipos = validar_tipos_projeto(getattr(args, "tipo_projeto", None))
    if tipos:
        r["tipos_projeto"] = tipos
        r["tipo_projeto"] = tipos[0]
    if getattr(args, "modo", None):
        r["modo"] = args.modo
    if getattr(args, "baseline", None):
        r["baselines"] = [b for b in (r.get("baselines") or []) if isinstance(b, dict)] + \
            [parse_baseline(b) for b in args.baseline]
    if getattr(args, "git", None):
        acrescentar_git(r, [parse_git(g) for g in args.git])
    if getattr(args, "critica", None):
        r["criticas"] = [c for c in (r.get("criticas") or []) if isinstance(c, dict)] + \
            [parse_critica(c) for c in args.critica]
    if getattr(args, "contagem", None):
        for velha in gravar_contagens(r, [parse_contagem(c) for c in args.contagem]):
            print(f"contagem {velha.get('modo')} ({velha.get('fonte')}) {velha.get('n_codigo')}|{velha.get('n_ledger')} "
                  f"substituida pela nova; a anterior foi para rodada.contagens_historico", file=sys.stderr)
    if getattr(args, "ambiente_confirmado", None):
        r["ambiente_confirmado"] = parse_ambiente_confirmado(args.ambiente_confirmado)
    for chave in ("locales", "temas", "viewports"):
        valores = getattr(args, chave, None)
        if valores:
            novos = separar_tipos(valores)
            if chave == "viewports":
                for v in novos:
                    if not re.fullmatch(r"\d{2,5}", v):
                        falhar(f"--viewports: largura em px (ex.: 390,1440), veio {v!r}")
            r[chave] = novos


def guardar_ledger_antigo(p: Path) -> Path:
    """init --forcar: o ledger atual vai para um nome unico que o salvar() nunca sobrescreve."""
    carimbo = datetime.now().strftime("%Y%m%d-%H%M%S")
    destino = p.with_name(f"{p.name}.forcar-{carimbo}.bak")
    n = 2
    while destino.exists():
        destino = p.with_name(f"{p.name}.forcar-{carimbo}-{n}.bak")
        n += 1
    os.replace(p, destino)
    return destino


def importar_rodada_original(origem: str, pasta: Path, so_defeitos, todos: bool = False) -> dict:
    """init --reteste-de: traz da rodada original os defeitos nao retratados (mesmo id, importado_de), os casos
    ligados a eles (mesmo id, importado_de), os itens desses casos e os arquivos de evidencia que eles citam, no
    mesmo caminho relativo. Sem --defeito e sem --todos, deixa de fora o que nao tem o que retestar no pull: defeito
    ja retestado-ok na origem e decisao-de-produto nao-corrigido (e diz quais). Nao traz rodada.git, sujeira,
    criticas nem contagens; o commit da origem vai em rodada.reteste_de.git."""
    p_orig = caminho_ledger(origem)
    if not p_orig.is_file():
        falhar(f"--reteste-de: ledger da rodada original nao encontrado: {p_orig}")
    base_orig = p_orig.parent.resolve()
    if base_orig == pasta.resolve():
        falhar("--reteste-de aponta para a propria pasta nova: o reteste e outra rodada, em outra pasta")
    dados = carregar(p_orig)
    filtro = [x.strip() for x in separar_tipos(so_defeitos) if x.strip()]
    origem_txt = str(base_orig)
    avisos, copias = [], []

    def relocar(e):
        cam = caminho_evidencia(e)
        if not cam:
            return e
        achado, motivo = avaliar_evidencia(cam, base_orig)
        if achado is None:
            avisos.append(f"evidencia {cam}: {motivo} na rodada original; nao copiada")
            return e
        rel = Path(os.path.relpath(str(achado.resolve()), str(base_orig))).as_posix()
        copias.append((achado, pasta / rel))
        if isinstance(e, dict):
            novo = dict(e)
            for k in ("arquivo", "caminho", "path"):
                if not vazio(novo.get(k)):
                    novo[k] = rel
                    break
            return novo
        return rel

    defeitos, deixados = [], []
    for d in dados["defeitos"]:
        if not isinstance(d, dict) or vazio(d.get("id")) or (d.get("tipo") or "defeito") == "retratado":
            continue
        if filtro and str(d.get("id")) not in filtro:
            continue
        if not filtro and not todos:
            if d.get("status") == "retestado-ok":
                deixados.append(f"{d.get('id')} (ja retestado-ok na origem)")
                continue
            if (d.get("tipo") or "defeito") == "decisao-de-produto" and d.get("status") == "nao-corrigido":
                deixados.append(f"{d.get('id')} (decisao-de-produto nao-corrigido: nao ha correcao a retestar)")
                continue
        copia = json.loads(json.dumps(d))
        copia["importado_de"] = origem_txt
        copia.pop("corrigido_em_rodada", None)
        copia.pop("correcao_em_rodada", None)
        ev = copia.get("evidencias")
        if isinstance(ev, dict):
            copia["evidencias"] = {k: [relocar(x) for x in lista_evidencias(v)] for k, v in ev.items()}
        elif not vazio(ev):
            copia["evidencias"] = [relocar(x) for x in lista_evidencias(ev)]
        defeitos.append(copia)
    faltam = [x for x in filtro if x not in {str(d.get("id")) for d in defeitos}]
    if faltam:
        falhar(f"--defeito {', '.join(faltam)}: nao existe na rodada original ou e retratado")
    if not defeitos:
        if deixados:
            falhar(f"--reteste-de: nenhum defeito a retestar com o filtro padrao (deixados de fora: "
                   f"{'; '.join(deixados)}); passe --defeito <id> ou --todos")
        falhar("--reteste-de: a rodada original nao tem defeito que nao seja retratado; nao ha o que retestar")
    ids_def = {str(d.get("id")) for d in defeitos}
    casos = []
    for c in dados["casos"]:
        if not isinstance(c, dict) or vazio(c.get("id")) or not set(defeitos_do_caso(c)) & ids_def:
            continue
        copia = json.loads(json.dumps(c))
        copia["importado_de"] = origem_txt
        ligados = [x for x in defeitos_do_caso(copia) if x in ids_def]
        copia["defeito_id"] = ligados[0]
        if "defeito_ids" in copia or len(ligados) > 1:
            copia["defeito_ids"] = ligados
        copia["evidencias"] = [relocar(x) for x in lista_evidencias(copia.get("evidencias"))]
        casos.append(copia)
    ids_itens = {str(c.get("item_id")) for c in casos}
    itens = [json.loads(json.dumps(i)) for i in dados["itens"] if isinstance(i, dict) and str(i.get("id")) in ids_itens]
    marcas = base_orig / "evidencias" / "marcas.json"
    if marcas.is_file():
        copias.append((marcas, pasta / "evidencias" / "marcas.json"))
    vistos, plano = set(), []
    for src, dst in copias:
        chave = os.path.normcase(os.path.abspath(str(dst)))
        if chave in vistos:
            continue
        vistos.add(chave)
        if dst.exists():
            try:
                igual = dst.is_file() and dst.read_bytes() == src.read_bytes()
            except OSError:
                igual = False
            if not igual:
                falhar(f"--reteste-de: {dst} ja existe na pasta nova com outro conteudo; nada foi gravado (use "
                       f"uma pasta nova para o reteste)")
            continue
        plano.append((src, dst))
    importado, n_seg = _mascara.mascarar_estrutura(
        {"defeitos": defeitos, "casos": casos, "itens": itens},
        pular={"evidencias", "id", "item_id", "defeito_id", "defeito_ids", "caso_id", "pai", "importado_de"})
    if n_seg:
        avisos.append(f"{n_seg} segredo(s) da rodada original trocado(s) por {_mascara.MARCA} (o valor nao foi gravado)")
    r0 = dados.get("rodada") or {}
    git0 = r0.get("git")
    return {"reteste_de": {"pasta": origem_txt, "git": git0 if isinstance(git0, (list, dict)) else []},
            "defeitos": importado["defeitos"], "casos": importado["casos"], "itens": importado["itens"],
            "copias": plano, "avisos": avisos, "deixados": deixados}


def recusar_dentro_da_skill(pasta: Path) -> None:
    """Nenhuma rodada (ledger, notas, prints, payloads) grava dentro da pasta da skill."""
    try:
        alvo = Path(os.path.abspath(str(Path(pasta).expanduser()))).resolve()
        skill = PASTA_SKILL.resolve()
    except OSError:
        return
    if alvo == skill or skill in alvo.parents:
        falhar(f"a rodada não pode ficar dentro da skill ({alvo}): use uma pasta do projeto, ex. .qa/<data>-<alvo>")


def cmd_init(args) -> int:
    pasta = Path(args.pasta).expanduser()
    recusar_dentro_da_skill(pasta)
    p = pasta / NOME_LEDGER
    if p.exists() and not args.forcar:
        falhar(f"{p} ja existe (use --forcar para recriar vazio; o atual vai para {NOME_LEDGER}.forcar-<data>.bak)")
    checar_sem_segredo({"alvo": args.alvo, "escopo": args.escopo, "ambiente": args.ambiente,
                        "autorizacao": args.autorizacao or [], "baseline": args.baseline or [],
                        "contagem": args.contagem or [], "ambiente_confirmado": args.ambiente_confirmado,
                        "reteste_de": args.reteste_de})
    if args.reteste_de and normalizar(args.modo or "completo") != "reteste":
        falhar("--reteste-de so vale junto de --modo reteste (o reteste de uma rodada e uma rodada nova)")
    if args.defeito and not args.reteste_de:
        falhar("--defeito no init so vale junto de --reteste-de (filtra os defeitos importados)")
    if getattr(args, "todos", False) and not args.reteste_de:
        falhar("--todos no init so vale junto de --reteste-de")
    if getattr(args, "todos", False) and args.defeito:
        falhar("use --defeito (so os do pull) OU --todos (todo defeito nao retratado), nao os dois")
    rodada = {
        "id": pasta.resolve().name,
        "alvo": args.alvo,
        "escopo": args.escopo or "",
        "ambiente": args.ambiente or "",
        "inicio": valor_tempo(args.inicio) or "",
        "fim": "",
        "autorizacoes": list(args.autorizacao or []),
        "perfil": args.perfil or "",
        "modo": args.modo or "completo",
        "tipo_projeto": "",
    }
    aplicar_listas_rodada(rodada, args)
    rodada["modo_inicial"] = rodada["modo"]
    importado = importar_rodada_original(args.reteste_de, pasta, args.defeito,
                                         bool(getattr(args, "todos", False))) if args.reteste_de else None
    if importado:
        rodada["reteste_de"] = importado["reteste_de"]
    for sub in SUBPASTAS_RODADA:
        (pasta / sub).mkdir(parents=True, exist_ok=True)
    guardado = None
    with Trava(p):
        if p.exists():
            guardado = guardar_ledger_antigo(p)
        novo = ledger_vazio(rodada)
        if importado:
            for src, dst in importado["copias"]:
                dst.parent.mkdir(parents=True, exist_ok=True)
                shutil.copy2(src, dst)
            novo["itens"], novo["casos"], novo["defeitos"] = importado["itens"], importado["casos"], importado["defeitos"]
        salvar(p, novo)
    print(f"ledger criado: {p} (modo {rodada['modo']})")
    if importado:
        print(f"reteste de {importado['reteste_de']['pasta']}: {len(importado['defeitos'])} defeito(s) "
              f"({', '.join(str(d.get('id')) for d in importado['defeitos'])}), {len(importado['casos'])} caso(s), "
              f"{len(importado['itens'])} item(ns) e {len(importado['copias'])} arquivo(s) de evidencia copiados; "
              f"o entorno se mede a partir do commit em rodada.reteste_de.git")
        if importado.get("deixados"):
            print(f"deixados de fora (sem --defeito nem --todos): {'; '.join(importado['deixados'])}. Para trazer "
                  f"um deles, recrie com --defeito <id> (ou --todos)")
        for av in importado["avisos"]:
            print(f"aviso: {vis(av)}", file=sys.stderr)
    if guardado:
        print(f"ledger anterior guardado em: {guardado} (o .bak rotativo do salvar nao toca neste arquivo)")
    print("subpastas: " + ", ".join(SUBPASTAS_RODADA))
    if not rodada["tipo_projeto"] and rodada["modo"] != "reteste":
        print("lembre: declare o tipo de projeto (rodada --tipo-projeto <slug>[,<slug>]); o gate final exige",
              file=sys.stderr)
    if not args.sem_exclude:
        msg = resolver_git_exclude(pasta)
        if msg:
            print(msg)
    return EXIT_OK


def cmd_rodada(args) -> int:
    p = caminho_ledger(args.pasta)
    recusar_dentro_da_skill(p.parent)
    checar_sem_segredo({"alvo": args.alvo, "escopo": args.escopo, "ambiente": args.ambiente,
                        "autorizacao": args.autorizacao or [], "baseline": args.baseline or [],
                        "critica": args.critica or [], "contagem": args.contagem or [],
                        "ambiente_confirmado": args.ambiente_confirmado})
    validar_tipos_projeto(args.tipo_projeto)
    inicio, fim = valor_tempo(args.inicio), valor_tempo(args.fim)
    with Trava(p):
        dados = carregar(p)
        r = dados["rodada"]
        for campo in ("alvo", "escopo", "ambiente", "perfil"):
            v = getattr(args, campo)
            if v is not None:
                r[campo] = v
        if inicio is not None:
            r["inicio"] = inicio
        if fim is not None:
            r["fim"] = fim
        if args.autorizacao:
            atuais = list(r.get("autorizacoes") or [])
            for x in args.autorizacao:
                if x not in atuais:
                    atuais.append(x)
            r["autorizacoes"] = atuais
        if args.modo:
            atual = normalizar(r.get("modo") or "completo")
            tem_caso = any(isinstance(c, dict) for c in dados["casos"])
            if args.modo != atual and "reteste" in (args.modo, atual) and tem_caso:
                if args.modo == "reteste":
                    falhar("reteste é rodada nova: cobertura.py init <outra-pasta> --modo reteste --reteste-de "
                           f"{p.parent} (esta rodada ja tem casos e continua {atual})")
                falhar("a rodada de reteste ja tem casos e nao muda de modo: o QA completo ou a revisao e rodada nova "
                       "(cobertura.py init <outra-pasta> --modo completo|revisao)")
            if not tem_caso:
                r["modo_inicial"] = args.modo
        aplicar_listas_rodada(r, args)
        salvar(p, dados)
    print(json.dumps(_mascara.mascarar_estrutura(r)[0], ensure_ascii=False, indent=2))
    return EXIT_OK


def cmd_add_item(args) -> int:
    p = caminho_ledger(args.pasta)
    checar_sem_segredo({"id": args.id, "titulo": args.titulo, "origem": args.origem, "pai": args.pai,
                        "notas": args.notas})
    with Trava(p):
        dados = carregar(p)
        iid = args.id.strip()
        existente = next((i for i in dados["itens"] if isinstance(i, dict) and i.get("id") == iid), None)
        if existente and not args.atualizar:
            falhar(f'item "{iid}" ja existe (use --atualizar para mudar os campos)')
        alvo = existente if existente is not None else {"id": iid}
        if ":" not in iid:
            print(f'aviso: id "{iid}" fora do formato "<tipo>:<caminho>"', file=sys.stderr)
        campos = {"tipo": args.tipo or (None if existente else tipo_do_item({"id": iid})),
                  "titulo": args.titulo, "origem": args.origem, "pai": args.pai, "notas": args.notas,
                  "escopo": args.escopo,
                  "tipo_elemento": normalizar_escolha(args.tipo_elemento, list(TIPOS_ELEMENTO), "--tipo-elemento")}
        for k, v in campos.items():
            if v is not None:
                alvo[k] = v
        if existente is None:
            dados["itens"].append(alvo)
        salvar(p, dados)
    print(f"item {'atualizado' if existente else 'adicionado'}: {iid}")
    return EXIT_OK


def cmd_add_caso(args) -> int:
    p = caminho_ledger(args.pasta)
    checar_caminho_evidencia(args.evidencia, "--evidencia")
    checar_sem_segredo({"titulo": args.titulo, "passos": args.passos, "esperado": args.esperado,
                        "oraculo": args.oraculo, "justificativa": args.justificativa, "papel": args.papel,
                        "evidencia": args.evidencia or []})
    with Trava(p):
        dados = carregar(p)
        ids_itens = {i.get("id") for i in dados["itens"] if isinstance(i, dict)}
        if args.item not in ids_itens:
            if args.criar_item:
                dados["itens"].append({"id": args.item, "tipo": tipo_do_item({"id": args.item})})
            else:
                falhar(f'item "{args.item}" nao existe (crie com add-item ou passe --criar-item)')
        item = next((i for i in dados["itens"] if isinstance(i, dict) and i.get("id") == args.item), None)
        ids_casos = [c.get("id") for c in dados["casos"] if isinstance(c, dict)]
        cid = args.id or proximo_id(ids_casos, "C", 4)
        if cid in ids_casos:
            falhar(f'caso "{cid}" ja existe (use set para atualizar)')
        caso = {
            "id": cid,
            "item_id": args.item,
            "titulo": args.titulo or "",
            "tecnica": normalizar_escolha(args.tecnica, tecnicas_validas(), "tecnica"),
            "dimensao": normalizar_dimensao(args.dimensao) if args.dimensao else "",
            "papel": args.papel or "",
            "passos": args.passos or "",
            "resultado_esperado": args.esperado,
            "oraculo": args.oraculo or "",
            "status": normalizar_escolha(args.status or "pendente", STATUS_CASO, "status"),
            "evidencias": list(args.evidencia or []),
            "defeito_id": None,
            "justificativa": args.justificativa or "",
            "atualizado_em": agora_iso(),
        }
        ligados = separar_tipos(args.defeito)
        if ligados:
            caso["defeito_id"] = ligados[0]
            caso["defeito_ids"] = ligados
        problemas = checar_regras_caso(caso, {d.get("id") for d in dados["defeitos"] if isinstance(d, dict)}, item,
                                       dica_reteste(dados))
        if problemas and not args.forcar:
            falhar(f"caso {cid} recusado: " + "; ".join(problemas))
        dados["casos"].append(caso)
        salvar(p, dados)
    avisar_evidencia_ausente(args.evidencia, p.parent)
    print(cid)
    return EXIT_OK


def marcar_corrigido_em_rodada(d: dict, rid: str) -> None:
    """corrigido_em_rodada = a rodada que alterou codigo para este defeito (o gate do reteste so cobra estatico: e
    git status inicial dela). Defeito importado (init --reteste-de) so ganha a marca quando esta rodada gravou
    --correcao nele: retestar a correcao de outra pessoa nao e corrigir."""
    if not rid or d.get("status") not in ("corrigido", "retestado-ok") or (d.get("tipo") or "defeito") == "retratado":
        return
    if vazio(d.get("importado_de")) or d.get("correcao_em_rodada") == rid:
        d["corrigido_em_rodada"] = rid


def falta_de_depois(lista, base: Path, status: str) -> str | None:
    """corrigido/retestado-ok exigem arquivo DEPOIS ou RETESTE valido em disco (a mesma regra do validar)."""
    for e in lista_evidencias(lista):
        c = caminho_evidencia(e)
        if c and avaliar_evidencia(c, base)[0] is not None:
            return None
    return (f'status "{status}" exige arquivo DEPOIS ou RETESTE valido em disco (mais de 0 byte em evidencias/, rede/, '
            f"notas/ ou relatorio/ da rodada): passe --depois <arquivo> ou --reteste <arquivo> (corrigido sem reteste: "
            f"o diff da correcao, ex.: git diff -- <arquivos> > rede/NN-D-NNN-CORRIGIDO.diff)")


def cmd_add_defeito(args) -> int:
    p = caminho_ledger(args.pasta)
    for opcao in ("antes", "depois", "reteste"):
        checar_caminho_evidencia(getattr(args, opcao), f"--{opcao}")
    checar_sem_segredo({"titulo": args.titulo, "onde": args.onde, "causa": args.causa, "correcao": args.correcao,
                        "justificativa": args.justificativa, "antes": args.antes or [], "depois": args.depois or [],
                        "reteste": args.reteste or [], "repro": args.repro})
    tipo = normalizar_escolha(args.tipo or "defeito", TIPOS_DEFEITO, "tipo")
    if tipo == "retratado":
        if args.status and normalizar(args.status) != "nao-corrigido":
            falhar('defeito "retratado" nasce com status "nao-corrigido" (o achado caiu; nao ha o que corrigir)')
        if vazio(args.justificativa):
            falhar('defeito "retratado" exige --justificativa "retratado: <o que enganou e como caiu>"')
        status = "nao-corrigido"
    else:
        status = normalizar_escolha(args.status or "aberto", STATUS_DEFEITO, "status")
    if status == "nao-corrigido":
        if vazio(args.justificativa):
            falhar('status "nao-corrigido" exige --justificativa')
        fraca = justificativa_fraca(args.justificativa, "nao-corrigido")
        if fraca:
            falhar(f"--justificativa {fraca}")
    if status == "corrigido":
        falta = corrigido_sem_reteste(args.justificativa)
        if falta:
            falhar(f"defeito novo nasce sem caso de reteste: {falta}")
    if status in ("corrigido", "retestado-ok") and tipo not in ("retratado", "decisao-de-produto"):
        falta_depois = falta_de_depois(list(args.depois or []) + list(args.reteste or []), p.parent, status)
        if falta_depois:
            falhar(f"defeito nao registrado: {falta_depois}")
    with Trava(p):
        dados = carregar(p)
        ids = [d.get("id") for d in dados["defeitos"] if isinstance(d, dict)]
        did = args.id or proximo_id(ids, "D", 3)
        if did in ids:
            falhar(f'defeito "{did}" ja existe (use set para atualizar)')
        defeito = {
            "id": did,
            "severidade": normalizar_escolha(args.severidade, SEVERIDADES, "severidade"),
            "tipo": tipo,
            "titulo": args.titulo,
            "onde": args.onde or "",
            "causa": args.causa or "",
            "correcao": args.correcao or "",
            "status": status,
            "justificativa": args.justificativa or "",
            "evidencias": {"antes": list(args.antes or []), "depois": list(args.depois or []),
                           "reteste": list(args.reteste or [])},
            "atualizado_em": agora_iso(),
        }
        if args.repro:
            defeito["reproducao"] = args.repro
        rid = id_da_rodada(dados["rodada"], p.parent)
        if args.correcao:
            defeito["correcao_em_rodada"] = rid
        marcar_corrigido_em_rodada(defeito, rid)
        dados["defeitos"].append(defeito)
        ligados = []
        for cid in args.caso or []:
            caso = next((c for c in dados["casos"] if isinstance(c, dict) and c.get("id") == cid), None)
            if caso is None:
                falhar(f'caso "{cid}" nao existe')
            caso["defeito_id"] = did
            caso.pop("defeito_ids", None)
            caso["atualizado_em"] = agora_iso()
            ligados.append(cid)
        salvar(p, dados)
    avisar_evidencia_ausente((args.antes or []) + (args.depois or []) + (args.reteste or []), p.parent)
    if tipo in ("defeito", "melhoria", "decisao-de-produto") and not args.antes \
            and not tem_sem_antes(args.justificativa):
        print('aviso: sem --antes. O gate exige o print do problema (ou "sem-antes: <motivo>" na justificativa)',
              file=sys.stderr)
    print(did)
    if ligados:
        if tipo == "retratado":
            print(f"ligado aos casos: {', '.join(ligados)} (mude o status deles com set --status retratado "
                  f'--justificativa "<o que enganou>")', file=sys.stderr)
        else:
            print(f"ligado aos casos: {', '.join(ligados)} (mude o status deles com set --status falhou "
                  f"--evidencia ...)", file=sys.stderr)
    return EXIT_OK


def checar_sujeira(estado, como_desfazer) -> None:
    if estado is None:
        return
    if not estado_sujeira_valido(estado):
        falhar(f'--estado-final "{estado}" fora do vocabulario: {", ".join(ESTADOS_SUJEIRA)} (texto livre depois de '
               f'":", ex.: "ficou: cliente de teste no dev")')
    if normalizar_texto(estado).split(":", 1)[0].strip() == "ficou" and vazio(como_desfazer):
        falhar('--estado-final "ficou" exige --como-desfazer (o caminho para limpar, ex.: "excluir pela tela X")')


def cmd_add_sujeira(args) -> int:
    p = caminho_ledger(args.pasta)
    checar_sem_segredo({"o_que": args.o_que, "ambiente": args.ambiente, "estado_final": args.estado_final,
                        "como_desfazer": args.como_desfazer})
    checar_sujeira(args.estado_final, args.como_desfazer)
    with Trava(p):
        dados = carregar(p)
        ids = [s.get("id") for s in dados["sujeira"] if isinstance(s, dict)]
        sid = args.id or proximo_id(ids, "S", 3)
        if sid in ids:
            falhar(f'sujeira "{sid}" ja existe (use set para atualizar)')
        dados["sujeira"].append({
            "id": sid, "ambiente": args.ambiente or "", "o_que": args.o_que,
            "estado_final": args.estado_final or "", "como_desfazer": args.como_desfazer or "",
            "caso_id": args.caso or None, "atualizado_em": agora_iso(),
        })
        salvar(p, dados)
    print(sid)
    return EXIT_OK


def anexar(lista_atual, novos) -> list:
    saida = list(lista_atual or [])
    for n in novos or []:
        if n not in saida:
            saida.append(n)
    return saida


def montar_justificativa_oraculo(args) -> str | None:
    tem_extra = bool(args.opcao or args.impacto or args.para)
    if not args.oraculo_pergunta:
        if tem_extra:
            falhar("--opcao, --impacto e --para so valem junto de --oraculo-pergunta")
        return None
    if args.justificativa is not None:
        falhar("use --oraculo-pergunta OU --justificativa (a pergunta vira a justificativa no formato do oraculo)")
    pergunta = args.oraculo_pergunta.strip()
    if len(pergunta) < 10:
        falhar("--oraculo-pergunta precisa ser a pergunta fechada inteira")
    opcoes = []
    for i, op in enumerate(args.opcao or []):
        if "=>" not in op or not all(x.strip() for x in op.split("=>", 1)):
            falhar(f'--opcao "{op}" precisa de "<opcao> => <custo ou efeito>"')
        texto_op, custo = [x.strip() for x in op.split("=>", 1)]
        opcoes.append(f"{chr(65 + i)}) {texto_op} => {custo}")
    if len(opcoes) < 2:
        falhar("pergunta do oraculo precisa de pelo menos duas --opcao (A e B), cada uma com o custo")
    partes = [f"oraculo: {pergunta}"] + opcoes
    if args.impacto:
        imp = normalizar_texto(args.impacto)
        if imp not in ("alto", "medio", "baixo"):
            falhar("--impacto precisa ser alto, medio ou baixo")
        partes.append(f"impacto: {imp}")
    if args.para:
        partes.append(f"para: {args.para.strip()}")
    return " | ".join(partes)


def corrigido_sem_reteste(justificativa) -> str | None:
    """Motivo de recusa de "corrigido" sem caso de reteste, ou None se a justificativa diz o que falta."""
    if justificativa_fraca(justificativa, "bloqueado") is None:
        return None
    return ("corrigido sem reteste exige 'falta …; destrava: …' (ex.: reinício pendente). Com reteste: add-caso "
            "--tecnica regressao --defeito <id> e depois set --status retestado-ok")


def destino_evidencia_defeito(caminho: str) -> str:
    nome = Path(str(caminho)).name.upper()
    if "-ANTES" in nome or "-REPRO" in nome:
        return "antes"
    if "-RETESTE" in nome:
        return "reteste"
    return "depois"


def cmd_set(args) -> int:
    p = caminho_ledger(args.pasta)
    checar_caminho_evidencia(args.evidencia, "--evidencia")
    for opcao in ("antes", "depois", "reteste"):
        checar_caminho_evidencia(getattr(args, opcao), f"--{opcao}")
    just_oraculo = montar_justificativa_oraculo(args)
    checar_sem_segredo({k: getattr(args, k) for k in ("justificativa", "obtido", "esperado", "oraculo", "titulo",
                                                      "notas", "obs", "onde", "causa", "correcao", "estado_final",
                                                      "ambiente", "o_que", "como_desfazer", "papel",
                                                      "oraculo_pergunta", "para", "passos", "repro")}
                       | {"opcao": args.opcao or [], "evidencia": args.evidencia or [], "antes": args.antes or [],
                          "depois": args.depois or [], "reteste": args.reteste or []})
    with Trava(p):
        dados = carregar(p)
        alvo_id = args.id
        colecao, obj = None, None
        for nome in ("casos", "defeitos", "sujeira", "itens"):
            obj = next((x for x in dados[nome] if isinstance(x, dict) and x.get("id") == alvo_id), None)
            if obj is not None:
                colecao = nome
                break
        if obj is None:
            dica = dica_reteste(dados) if re.match(r"^D-\d+$", str(alvo_id or "")) else ""
            falhar(f'id "{alvo_id}" nao encontrado em casos, defeitos, sujeira nem itens{dica}')
        ignorados = []
        avisos = []

        def aplicar(campo, valor):
            if valor is not None:
                obj[campo] = valor

        def ignorar(*nomes):
            for nome in nomes:
                if getattr(args, nome, None):
                    ignorados.append(nome)

        if colecao == "casos":
            if args.status is not None:
                obj["status"] = normalizar_escolha(args.status, STATUS_CASO, "status")
            if just_oraculo is not None:
                obj["justificativa"] = just_oraculo
                if args.status is None:
                    obj["status"] = "bloqueado"
            if args.limpar_evidencias:
                obj["evidencias"] = []
            obj["evidencias"] = anexar(lista_evidencias(obj.get("evidencias")), args.evidencia)
            aplicar("justificativa", args.justificativa)
            if args.defeito is not None:
                ligados = separar_tipos(args.defeito)
                obj["defeito_id"] = ligados[0] if ligados else None
                if ligados:
                    obj["defeito_ids"] = ligados
                else:
                    obj.pop("defeito_ids", None)
            aplicar("resultado_obtido", args.obtido)
            aplicar("resultado_esperado", args.esperado)
            aplicar("oraculo", args.oraculo)
            aplicar("titulo", args.titulo)
            aplicar("papel", args.papel)
            aplicar("passos", args.passos)
            if args.dimensao is not None:
                obj["dimensao"] = normalizar_dimensao(args.dimensao)
            if args.tecnica is not None:
                obj["tecnica"] = normalizar_escolha(args.tecnica, tecnicas_validas(), "tecnica")
            ignorar("antes", "depois", "reteste", "estado_final", "severidade", "correcao", "causa", "onde", "escopo",
                    "repro")
            item = next((i for i in dados["itens"] if isinstance(i, dict) and i.get("id") == obj.get("item_id")), None)
            problemas = checar_regras_caso(obj, {d.get("id") for d in dados["defeitos"] if isinstance(d, dict)}, item,
                                           dica_reteste(dados))
            if problemas and not args.forcar:
                falhar(f"{alvo_id} nao atualizado: " + "; ".join(problemas))
        elif colecao == "defeitos":
            if args.status is not None:
                obj["status"] = normalizar_escolha(args.status, STATUS_DEFEITO, "status")
            if args.severidade is not None:
                obj["severidade"] = normalizar_escolha(args.severidade, SEVERIDADES, "severidade")
            if args.tipo is not None:
                obj["tipo"] = normalizar_escolha(args.tipo, TIPOS_DEFEITO, "tipo")
            for campo in ("titulo", "onde", "causa", "correcao", "justificativa"):
                aplicar(campo, getattr(args, campo))
            if just_oraculo is not None:
                obj["justificativa"] = just_oraculo
            ev = obj.get("evidencias")
            if not isinstance(ev, dict):
                if lista_evidencias(ev):
                    avisos.append("evidencias em lista (formato antigo) classificadas pelo nome: -ANTES/-REPRO = antes, "
                                  "-RETESTE = reteste, -CORRIGIDO/-DEPOIS = depois, o resto = antes")
                ev = evidencias_em_dict(ev)
            if args.limpar_evidencias:
                ev = {"antes": [], "depois": [], "reteste": []}
            for chave in ("antes", "depois", "reteste"):
                ev[chave] = anexar(ev.get(chave), getattr(args, chave))
            for e in args.evidencia or []:
                chave = destino_evidencia_defeito(e)
                if chave == "depois" and obj.get("status") == "aberto" and not args.forcar:
                    falhar(f'{alvo_id} esta "aberto": --evidencia {e} iria para DEPOIS (verde), mas nao ha correcao. '
                           f"Use --antes para o print do problema (ou --forcar se for mesmo o depois)")
                ev[chave] = anexar(ev.get(chave), [e])
                avisos.append(f"--evidencia em defeito foi para '{chave}' ({e}); use --antes/--depois/--reteste")
            obj["evidencias"] = ev
            aplicar("reproducao", args.repro)
            ignorar("dimensao", "papel", "escopo", "passos")
            if obj.get("status") == "nao-corrigido" and not args.forcar:
                if vazio(obj.get("justificativa")):
                    falhar('status "nao-corrigido" exige --justificativa')
                fraca = justificativa_fraca(obj.get("justificativa"), "nao-corrigido")
                if fraca:
                    falhar(f"{alvo_id} nao atualizado: justificativa {fraca}")
            if (args.status is not None or args.limpar_evidencias) \
                    and obj.get("status") in ("corrigido", "retestado-ok") \
                    and (obj.get("tipo") or "defeito") not in ("retratado", "decisao-de-produto") and not args.forcar:
                ev_d = evidencias_de_defeito(obj)
                falta_depois = falta_de_depois(ev_d["depois"] + ev_d["reteste"], p.parent, obj.get("status"))
                if falta_depois:
                    falhar(f"{alvo_id} nao atualizado: {falta_depois}")
            tem_reteste = any(isinstance(c, dict) and c.get("defeito_id") == alvo_id and c.get("tecnica") == "regressao"
                              for c in dados["casos"])
            if obj.get("status") == "corrigido" and (obj.get("tipo") or "defeito") != "retratado" \
                    and not tem_reteste and not args.forcar:
                falta = corrigido_sem_reteste(obj.get("justificativa"))
                if falta:
                    falhar(f"{alvo_id} nao atualizado: {falta}")
            rid = id_da_rodada(dados["rodada"], p.parent)
            if args.correcao is not None:
                obj["correcao_em_rodada"] = rid
            marcar_corrigido_em_rodada(obj, rid)
        elif colecao == "sujeira":
            estado = args.estado_final if args.estado_final is not None else obj.get("estado_final")
            desfazer = args.como_desfazer if args.como_desfazer is not None else obj.get("como_desfazer")
            if args.estado_final is not None or args.como_desfazer is not None:
                checar_sujeira(estado if not vazio(estado) else None, desfazer)
            aplicar("estado_final", args.estado_final)
            aplicar("ambiente", args.ambiente)
            aplicar("o_que", args.o_que)
            aplicar("como_desfazer", args.como_desfazer)
            ignorar("dimensao", "papel", "escopo", "oraculo_pergunta", "passos", "repro")
        else:
            aplicar("titulo", args.titulo)
            aplicar("notas", args.notas)
            aplicar("escopo", args.escopo)
            if args.tipo is not None:
                obj["tipo"] = args.tipo
            ignorar("dimensao", "papel", "oraculo_pergunta", "passos", "repro")
        if args.obs:
            obj["observacoes"] = anexar(obj.get("observacoes"), [f"{agora_iso()} {args.obs}"])
        obj["atualizado_em"] = agora_iso()
        salvar(p, dados)
    for a in avisos:
        print(f"aviso: {a}", file=sys.stderr)
    if ignorados:
        print(f"aviso: opcoes que nao se aplicam a {colecao} foram ignoradas: {', '.join(ignorados)}", file=sys.stderr)
    if colecao in ("casos", "defeitos"):
        novas = list(args.evidencia or []) + list(args.antes or []) + list(args.depois or []) + list(args.reteste or [])
        avisar_evidencia_ausente(novas, p.parent)
    print(f"{alvo_id} ({colecao}) atualizado: status={obj.get('status', '-')}")
    return EXIT_OK


def resolver_parcial(caminho: str) -> Path:
    p = Path(caminho).expanduser()
    if p.is_dir():
        p = p / NOME_LEDGER
    if not p.exists():
        falhar(f"parcial nao encontrado: {p}")
    return p


def igual_texto(a, b) -> bool:
    return normalizar(a) == normalizar(b)


def escolher_status(atual, novo, gravidade: dict, estrategia, t_atual, t_novo, novo_tem_prova: bool = False):
    """Devolve (escolhido, conflito, sem_regra). sem_regra=True: conflito que so --estrategia explicita resolve."""
    if atual == novo or vazio(novo):
        return atual, False, False
    if vazio(atual):
        return novo, False, False
    if gravidade is GRAVIDADE_CASO and "pendente" in (atual, novo):
        return (novo if atual == "pendente" else atual), False, False
    i_atual, i_novo = instante(t_atual), instante(t_novo)
    if estrategia is None:
        if novo_tem_prova and i_novo and (not i_atual or i_novo > i_atual):
            return novo, False, False
        return atual, True, True
    if estrategia == "recente" and (i_atual or i_novo) and i_atual != i_novo:
        if i_novo and (not i_atual or i_novo > i_atual):
            return novo, True, False
        return atual, True, False
    return (novo if gravidade.get(novo, -1) > gravidade.get(atual, -1) else atual), True, False


def tem_prova_em_disco(obj: dict, base_rodada: Path | None) -> bool:
    if base_rodada is None:
        return False
    ev = obj.get("evidencias")
    if isinstance(ev, dict):
        todas = [x for v in ev.values() for x in lista_evidencias(v)]
    else:
        todas = lista_evidencias(ev)
    return bool(evidencias_validas(todas, base_rodada))


CAMPOS_ITEM_ATUALIZAVEIS = ("titulo", "origem", "escopo", "pai")
STATUS_JUSTIFICATIVA_ATUALIZAVEL = ("nao-aplicavel", "bloqueado", "nao-validado")


def fundir_objeto(base: dict, novo: dict, chave_status: str | None, gravidade: dict, estrategia,
                  rotulo: str, avisos: list, conflitos: list | None = None, base_rodada: Path | None = None,
                  divergentes: list | None = None, atualizar: bool = False) -> None:
    """Funde 'novo' em 'base'. Campo diferente fica com o primeiro, salvo: status vencedor vindo do novo (leva
    justificativa, defeito_id e obtido); caso com o mesmo status nao-aplicavel/bloqueado/nao-validado e atualizado_em
    maior no novo (leva a justificativa); item com "atualizar": true no parcial (troca titulo, origem, escopo e pai).
    O que fica de fora vai para 'divergentes' (ou, sem a lista, para 'avisos')."""
    status_vencedor_veio_do_novo = False
    novo_mais_recente = chave_instante(novo.get("atualizado_em")) > chave_instante(base.get("atualizado_em"))
    mesmo_status_atualizavel = bool(chave_status) and gravidade is GRAVIDADE_CASO \
        and base.get(chave_status) == novo.get(chave_status) \
        and base.get(chave_status) in STATUS_JUSTIFICATIVA_ATUALIZAVEL
    if chave_status:
        escolhido, conflito, sem_regra = escolher_status(
            base.get(chave_status), novo.get(chave_status), gravidade, estrategia, base.get("atualizado_em"),
            novo.get("atualizado_em"), tem_prova_em_disco(novo, base_rodada))
        if sem_regra:
            if conflitos is not None:
                conflitos.append(f'{rotulo}: "{base.get(chave_status)}" x "{novo.get(chave_status)}" (o mais novo nao '
                                 f"traz evidencia em disco com atualizado_em maior)")
        elif conflito:
            avisos.append(f'{rotulo}: status em conflito "{base.get(chave_status)}" x "{novo.get(chave_status)}" '
                          f'-> mantido "{escolhido}" (--estrategia {estrategia})')
        status_vencedor_veio_do_novo = escolhido != base.get(chave_status)
        base[chave_status] = escolhido
    for k, v in novo.items():
        if k in ("id", chave_status, "atualizar"):
            continue
        atual = base.get(k)
        if k == "evidencias":
            if isinstance(atual, dict) or isinstance(v, dict):
                a = atual if isinstance(atual, dict) else evidencias_em_dict(atual)
                n = v if isinstance(v, dict) else evidencias_em_dict(v)
                for sub in set(a) | set(n):
                    a[sub] = anexar(lista_evidencias(a.get(sub)), lista_evidencias(n.get(sub)))
                base[k] = a
            else:
                base[k] = anexar(lista_evidencias(atual), lista_evidencias(v))
            continue
        if isinstance(v, list):
            base[k] = anexar(atual if isinstance(atual, list) else [], v)
            continue
        if vazio(atual):
            if not vazio(v):
                base[k] = v
        elif not vazio(v) and atual != v:
            if status_vencedor_veio_do_novo and k in ("justificativa", "defeito_id", "resultado_obtido", "atualizado_em"):
                base[k] = v
            elif k == "atualizado_em":
                base[k] = v if chave_instante(v) > chave_instante(atual) else atual
            elif k == "justificativa" and mesmo_status_atualizavel and novo_mais_recente:
                base[k] = v
                avisos.append(f'{rotulo}: justificativa atualizada (mesmo status "{base.get(chave_status)}", '
                              f"atualizado_em mais novo no parcial)")
            elif atualizar and k in CAMPOS_ITEM_ATUALIZAVEIS:
                base[k] = v
                avisos.append(f'{rotulo}: campo "{k}" atualizado ("atualizar": true no parcial)')
            else:
                msg = f'{rotulo}: campo "{k}" difere entre parciais -> mantido o primeiro'
                (divergentes if divergentes is not None else avisos).append(msg)


def mesmo_caso(a: dict, b: dict) -> bool:
    if a.get("item_id") != b.get("item_id"):
        return False
    for campo in ("titulo", "tecnica", "resultado_esperado"):
        va, vb = a.get(campo), b.get(campo)
        if not vazio(va) and not vazio(vb) and normalizar(va) != normalizar(vb):
            return False
    return True


def cmd_merge(args) -> int:
    destino = caminho_ledger(args.pasta)
    recusar_dentro_da_skill(destino.parent)
    avisos: list = []
    conflitos: list = []
    divergentes: list = []
    contagem = Counter()
    for caminho in args.parciais:
        resolver_parcial(caminho)
    destino.parent.mkdir(parents=True, exist_ok=True)
    base_rodada = destino.parent
    tocados_casos: list = []
    tocados_defeitos: list = []
    with Trava(destino):
        base = carregar(destino) if destino.exists() else ledger_vazio()
        for caminho in args.parciais:
            pp = resolver_parcial(caminho)
            if pp.resolve() == destino.resolve():
                continue
            parcial = carregar(pp)
            origem = pp.name if pp.name != NOME_LEDGER else str(pp.parent.name)
            datas_ruins = []
            for chave in ("itens", "casos", "defeitos", "sujeira"):
                for obj in parcial.get(chave) or []:
                    if isinstance(obj, dict) and not vazio(obj.get("atualizado_em")) \
                            and instante(obj.get("atualizado_em")) is None:
                        datas_ruins.append(f"{obj.get('id') or chave}: {resumir(vis(obj.get('atualizado_em')), 40)}")
            if datas_ruins:
                falhar(f"[{origem}] atualizado_em fora do formato ISO 8601 em {len(datas_ruins)} registro(s) "
                       f"({'; '.join(datas_ruins[:5])}{' ...' if len(datas_ruins) > 5 else ''}); NADA foi gravado. "
                       f"Use date -Iseconds (PowerShell: Get-Date -Format o)")
            parcial, n_seg = _mascara.mascarar_estrutura(
                parcial, pular={"evidencias", "id", "item_id", "defeito_id", "caso_id", "pai"})
            if n_seg:
                avisos.append(f"[{origem}] {n_seg} segredo(s) substituido(s) por {_mascara.MARCA} antes de fundir "
                              f"(o valor nao foi gravado; descreva o tipo de dado no parcial de origem)")
                contagem["segredos_removidos"] += n_seg
            r = base["rodada"]
            for k, v in (parcial.get("rodada") or {}).items():
                if k == "contagens" and isinstance(v, list):
                    gravar_contagens(r, v, so_mais_nova=True)
                elif k == "escopo_diff" and isinstance(v, dict) and isinstance(r.get(k), dict) and not vazio(r.get(k)):
                    rebaixa = normalizar(r[k].get("modo")) == "diff" and normalizar(v.get("modo")) != "diff"
                    if rebaixa:
                        avisos.append(f"[{origem}] rodada.escopo_diff mantido em modo diff (o parcial --tudo nao tira "
                                      f"a rodada do modo PR)")
                    elif chave_instante(v.get("gerado_em")) >= chave_instante(r[k].get("gerado_em")) and v != r[k]:
                        r[k] = json.loads(json.dumps(v))
                        avisos.append(f"[{origem}] rodada.escopo_diff trocado pelo do parcial (gerado_em mais novo: "
                                      f"{resumir(vis(v.get('gerado_em')), 30)})")
                elif isinstance(v, list):
                    r[k] = anexar(r.get(k) if isinstance(r.get(k), list) else [], v)
                elif vazio(r.get(k)) and not vazio(v):
                    r[k] = v

            itens = {i.get("id"): i for i in base["itens"] if isinstance(i, dict)}
            for it in parcial["itens"]:
                if not isinstance(it, dict) or vazio(it.get("id")):
                    continue
                if it["id"] in itens:
                    fundir_objeto(itens[it["id"]], it, None, {}, args.estrategia, f"[{origem}] item {it['id']}", avisos,
                                  divergentes=divergentes, atualizar=it.get("atualizar") is True)
                    contagem["itens_fundidos"] += 1
                else:
                    copia = json.loads(json.dumps(it))
                    copia.pop("atualizar", None)
                    base["itens"].append(copia)
                    itens[copia["id"]] = copia
                    contagem["itens_novos"] += 1

            mapa_def = {}
            defs = {d.get("id"): d for d in base["defeitos"] if isinstance(d, dict)}
            for d in parcial["defeitos"]:
                if not isinstance(d, dict) or vazio(d.get("id")):
                    continue
                did = d["id"]
                existente = defs.get(did)
                if existente is None:
                    copia = json.loads(json.dumps(d))
                    base["defeitos"].append(copia)
                    defs[did] = copia
                    tocados_defeitos.append(copia)
                    contagem["defeitos_novos"] += 1
                elif vazio(existente.get("titulo")) or vazio(d.get("titulo")) or igual_texto(existente.get("titulo"), d.get("titulo")):
                    fundir_objeto(existente, d, "status", GRAVIDADE_DEFEITO, args.estrategia,
                                  f"[{origem}] defeito {did}", avisos, conflitos, base_rodada, divergentes=divergentes)
                    tocados_defeitos.append(existente)
                    contagem["defeitos_fundidos"] += 1
                else:
                    novo_id = proximo_id(list(defs), "D", 3)
                    copia = json.loads(json.dumps(d))
                    copia["id"] = novo_id
                    base["defeitos"].append(copia)
                    defs[novo_id] = copia
                    tocados_defeitos.append(copia)
                    mapa_def[did] = novo_id
                    avisos.append(f"[{origem}] defeito {did} colide com outro de titulo diferente -> renumerado {novo_id}")
                    contagem["defeitos_renumerados"] += 1

            casos = {c.get("id"): c for c in base["casos"] if isinstance(c, dict)}
            for c in parcial["casos"]:
                if not isinstance(c, dict) or vazio(c.get("id")):
                    continue
                copia = json.loads(json.dumps(c))
                if copia.get("defeito_id") in mapa_def:
                    copia["defeito_id"] = mapa_def[copia["defeito_id"]]
                cid = copia["id"]
                existente = casos.get(cid)
                if existente is None:
                    base["casos"].append(copia)
                    casos[cid] = copia
                    tocados_casos.append(copia)
                    contagem["casos_novos"] += 1
                elif mesmo_caso(existente, copia):
                    fundir_objeto(existente, copia, "status", GRAVIDADE_CASO, args.estrategia,
                                  f"[{origem}] caso {cid}", avisos, conflitos, base_rodada, divergentes=divergentes)
                    tocados_casos.append(existente)
                    contagem["casos_fundidos"] += 1
                else:
                    novo_id = proximo_id(list(casos), "C", 4)
                    copia["id"] = novo_id
                    base["casos"].append(copia)
                    casos[novo_id] = copia
                    tocados_casos.append(copia)
                    motivo = ("item diferente: " + str(copia.get("item_id"))
                              if existente.get("item_id") != copia.get("item_id")
                              else "mesmo item, outro teste (titulo/tecnica/esperado diferentes)")
                    avisos.append(f"[{origem}] caso {cid} colide ({motivo}) -> renumerado {novo_id}")
                    contagem["casos_renumerados"] += 1

            suj = {s.get("id"): s for s in base["sujeira"] if isinstance(s, dict)}
            for s in parcial["sujeira"]:
                if not isinstance(s, dict):
                    continue
                copia = json.loads(json.dumps(s))
                sid = copia.get("id")
                if vazio(sid):
                    sid = copia["id"] = proximo_id(list(suj), "S", 3)
                existente = suj.get(sid)
                if existente is None:
                    base["sujeira"].append(copia)
                    suj[sid] = copia
                    contagem["sujeira_nova"] += 1
                elif igual_texto(existente.get("o_que"), copia.get("o_que")):
                    fundir_objeto(existente, copia, None, {}, args.estrategia, f"[{origem}] sujeira {sid}", avisos,
                                  divergentes=divergentes)
                else:
                    novo_id = proximo_id(list(suj), "S", 3)
                    copia["id"] = novo_id
                    base["sujeira"].append(copia)
                    suj[novo_id] = copia
                    avisos.append(f"[{origem}] sujeira {sid} colide -> renumerada {novo_id}")
            contagem["parciais"] += 1
        if conflitos:
            for av in avisos:
                print(f"AVISO {av}")
            print(f"erro: {len(conflitos)} conflito(s) de status sem regra para decidir; NADA foi gravado:", file=sys.stderr)
            for cf in conflitos:
                print(f"  {cf}", file=sys.stderr)
            print('decida e rode de novo com --estrategia pior (fica o pior resultado) ou --estrategia recente (fica o '
                  'de maior atualizado_em); o mais novo com evidencia em disco ja venceria sozinho', file=sys.stderr)
            raise SystemExit(EXIT_USO)
        itens_base = {i.get("id"): i for i in base["itens"] if isinstance(i, dict)}
        fracas = []
        for c in tocados_casos:
            st = c.get("status")
            if st in ("bloqueado", "nao-validado", "nao-aplicavel"):
                motivo = justificativa_fraca(c.get("justificativa"), st, itens_base.get(c.get("item_id")))
                if motivo:
                    fracas.append(f"caso {c.get('id')} ({st}): justificativa {motivo}")
        for d in tocados_defeitos:
            if d.get("status") == "nao-corrigido":
                motivo = justificativa_fraca(d.get("justificativa"), "nao-corrigido")
                if motivo:
                    fracas.append(f"defeito {d.get('id')} (nao-corrigido): justificativa {motivo}")
        if fracas:
            print(f"erro: {len(fracas)} registro(s) com justificativa que add-caso/set recusariam; NADA foi gravado:",
                  file=sys.stderr)
            for f in fracas:
                print(f"  {vis(f)}", file=sys.stderr)
            print("corrija o parcial de origem (o que falta e o que destrava) e rode o merge de novo", file=sys.stderr)
            raise SystemExit(EXIT_USO)
        salvar(destino, base)
    for av in avisos:
        print(f"AVISO {av}")
    resumo = ", ".join(f"{k}={v}" for k, v in sorted(contagem.items()))
    print(f"merge concluido em {destino}: {resumo or 'nada a fundir'}")
    if divergentes:
        print(f"{len(divergentes)} campo(s) diferente(s) nao aplicado(s), ficou o valor do ledger (use set ou add-item "
              f'--atualizar, ou "atualizar": true no item do parcial para titulo, origem, escopo e pai):')
        for dv in divergentes[:15]:
            print(f"  {vis(dv)}")
        if len(divergentes) > 15:
            print(f"  ... e mais {len(divergentes) - 15}")
    return EXIT_OK


def cmd_validar(args) -> int:
    p = caminho_ledger(args.pasta)
    dados = carregar(p)
    a = validar_dados(dados, p.parent)
    a.imprimir()
    print(f"validar: {len(a.erros)} erro(s), {len(a.avisos)} aviso(s) em {p}")
    return EXIT_FALHA if a.erros else EXIT_OK


EXT_IMAGEM = {".png", ".jpg", ".jpeg", ".gif", ".webp", ".svg", ".bmp"}
RE_COMENTARIO_HTML = re.compile(r"<!--.*?-->", re.S)
RE_PLACEHOLDER = re.compile(r"\{\{(.*?)\}\}", re.S)


def fora_de_comentarios(texto: str, funcao) -> str:
    """Aplica funcao so ao que esta fora de <!-- --> (as instrucoes e as VARIANTES do modelo ficam como estao)."""
    partes, pos = [], 0
    for m in RE_COMENTARIO_HTML.finditer(texto):
        partes.append(funcao(texto[pos:m.start()]))
        partes.append(m.group(0))
        pos = m.end()
    partes.append(funcao(texto[pos:]))
    return "".join(partes)


def sem_comentarios(texto: str) -> str:
    return RE_COMENTARIO_HTML.sub("", texto)


def _chave_placeholder(conteudo: str) -> str:
    m = re.match(r"\s*([A-Z][A-Z0-9_]*)", conteudo)
    return m.group(1) if m else ""


def _preencher(texto: str, valores: dict) -> str:
    def troca(m):
        chave = _chave_placeholder(m.group(1))
        v = valores.get(chave)
        if v is None or (isinstance(v, str) and not v.strip()):
            return m.group(0)
        return v if isinstance(v, Bruto) else html.escape(str(v))
    return RE_PLACEHOLDER.sub(troca, texto)


class Bruto(str):
    """Valor ja em HTML (figura ou <pre>), que o preenchimento nao escapa de novo."""


RE_SE_NENHUM = re.compile(r'[ \t]*<p class="vazio">\{\{(SE_NENHUM:.*?)\}\}</p>\n?', re.S)


def _repetir(texto: str, nome: str, linhas) -> str:
    """Repete o bloco <!-- REPETIR: nome --> uma vez por linha; linhas None deixa o bloco como esta (texto de pessoa).
    O primeiro <p class="vazio">{{SE_NENHUM: ...}}</p> depois do bloco (antes do proximo REPETIR ou do fim da secao)
    some quando ha linha; sem linha, o bloco some e o SE_NENHUM vira o texto entre aspas (se houver algo alem das
    aspas, como "e por que", fica o marcador para a pessoa escrever)."""
    if linhas is None:
        return texto
    rx = re.compile(r"[ \t]*<!-- REPETIR: " + re.escape(nome) + r" -->\n?(.*?)[ \t]*<!-- /REPETIR: " + re.escape(nome)
                    + r" -->\n?", re.S)
    pos = 0
    while True:
        m = rx.search(texto, pos)
        if not m:
            return texto
        corpo = "".join(_preencher(m.group(1), v) for v in linhas)
        depois = texto[m.end():]
        limite = len(depois)
        for marca in ("<!-- REPETIR:", "</section>", "<section", "<article"):
            achou = depois.find(marca)
            if 0 <= achou < limite:
                limite = achou
        mv = RE_SE_NENHUM.search(depois, 0, limite)
        if mv:
            if linhas:
                depois = depois[:mv.start()] + depois[mv.end():]
            else:
                mq = re.match(r'\s*SE_NENHUM:\s*"([^"]*)"\s*$', mv.group(1), re.S)
                if mq:
                    recuo = re.match(r"[ \t]*", mv.group(0)).group(0)
                    depois = depois[:mv.start()] + f'{recuo}<p class="vazio">{html.escape(mq.group(1))}</p>\n' + \
                        depois[mv.end():]
        texto = texto[:m.start()] + corpo + depois
        pos = m.start() + len(corpo)


def _prova_html(lista, base: Path, rotulo: str) -> str | None:
    """<img> (caminho relativo a relatorio/) para print; <pre> com o trecho mascarado para prova textual."""
    for e in lista_evidencias(lista):
        caminho = caminho_evidencia(e)
        p, _ = avaliar_evidencia(caminho, base) if caminho else (None, "")
        if p is None:
            continue
        try:
            rel = os.path.relpath(str(p), str(base / "relatorio")).replace(os.sep, "/")
        except ValueError:
            rel = str(p)
        if p.suffix.lower() in EXT_IMAGEM:
            return Bruto(f'<figure>\n      <img src="{html.escape(rel)}" alt="{html.escape(rotulo)}" />\n'
                         f'      <figcaption>{html.escape(p.name)}</figcaption>\n    </figure>')
        if p.suffix.lower() in EXT_TEXTO_PROVA:
            try:
                trecho = p.read_text(encoding="utf-8", errors="replace")[:2500]
            except OSError:
                continue
            trecho = _mascara.mascarar(trecho, estrito=True)[0]
            return Bruto(f"<pre><code>{html.escape(trecho)}</code></pre>\n    "
                         f'<p class="nota">Prova textual: {html.escape(p.name)}</p>')
    return None


def _trocar_figura(bloco: str, classe_parte: str, prova) -> str:
    if prova is None:
        return bloco
    rx = re.compile(r'(<div class="parte ' + re.escape(classe_parte) + r'">.*?)<figure>.*?</figure>', re.S)
    return rx.sub(lambda m: m.group(1) + prova, bloco, count=1)


RE_PROVA_HTTP = re.compile(r"<p><strong>Prova:</strong> <code>\{\{METODO_URL\}\}</code>[^\n]*?</p>")
RE_VARIANTE_COMANDO = re.compile(r"<!--\s*VARIANTE: prova de comando.*?(<p><strong>Prova:</strong> <code>\{\{COMANDO"
                                 r"\}\}</code>[^\n]*?</p>)", re.S)
LINHA_PROVA_COMANDO = ("<p><strong>Prova:</strong> <code>{{COMANDO}}</code> → código de saída {{RC}} · "
                       "{{PROVA_ANTES}}</p>")


def prova_de_comando(lista, base: Path) -> tuple:
    """(comando, codigo de saida, primeiras 20 linhas mascaradas) do primeiro arquivo de texto valido da lista:
    a transcricao do caso de CLI, biblioteca ou job ('$ <comando>' e 'codigo de saida: N')."""
    for e in lista_evidencias(lista):
        caminho = caminho_evidencia(e)
        p, _ = avaliar_evidencia(caminho, base) if caminho else (None, "")
        if p is None or p.suffix.lower() not in EXT_TEXTO_PROVA:
            continue
        try:
            texto = p.read_text(encoding="utf-8", errors="replace")
        except OSError:
            continue
        linhas = _mascara.mascarar(texto, estrito=True)[0].splitlines()
        comando = next((l[2:].strip() for l in linhas if l.startswith("$ ") and l[2:].strip()), None)
        rc = None
        for l in linhas:
            mm = re.match(r"^\s*codigo de saida\s*:?\s*(-?\d+)", normalizar_texto(l))
            if mm:
                rc = mm.group(1)
                break
        trecho = "\n".join(linhas[:20]).strip()
        return comando, rc, (Bruto(html.escape(trecho).replace("\n", "<br />\n")) if trecho else None)
    return None, None, None


def _data_curta(valor) -> str | None:
    d = instante(valor)
    return d.strftime("%Y-%m-%d %H:%M") if d is not None else None


def _rede_metodo_status(lista, base: Path) -> tuple:
    """(metodo e url, status) do primeiro rede/*.json valido da lista: objeto ou lista de registros do espiao de
    rede (metodo/method, url, status/status_code). Mascarado."""
    for e in lista_evidencias(lista):
        caminho = caminho_evidencia(e)
        p, _ = avaliar_evidencia(caminho, base) if caminho else (None, "")
        if p is None or p.suffix.lower() != ".json" or not dentro_de(p, base / "rede"):
            continue
        try:
            dado = json.loads(p.read_text(encoding="utf-8-sig", errors="replace"))
        except (OSError, ValueError):
            continue
        registros = dado if isinstance(dado, list) else [dado]
        if isinstance(dado, dict):
            for chave in ("requisicoes", "registros", "chamadas", "itens", "entries"):
                if isinstance(dado.get(chave), list):
                    registros = dado[chave]
                    break
        for reg in registros:
            if not isinstance(reg, dict):
                continue
            pedido = reg.get("request") if isinstance(reg.get("request"), dict) else {}
            url = reg.get("url") or pedido.get("url")
            if vazio(url):
                continue
            metodo = reg.get("metodo") or reg.get("method") or pedido.get("method") or "GET"
            status = reg.get("status") if reg.get("status") is not None else reg.get("status_code")
            if status is None and isinstance(reg.get("response"), dict):
                status = reg["response"].get("status")
            texto_mu = _mascara.mascarar(f"{str(metodo).upper()} {url}", estrito=True)[0]
            return texto_mu, (str(status) if status is not None else None)
    return None, None


def _linhas_fluxo(base: Path):
    """Linhas da tabela de replay a partir de replay/passos.yaml (leitura simples, sem PyYAML): id, objetivo (ou
    titulo), quantos passos ('- n:') e cria_efeito_externo. None se o arquivo nao existe."""
    p = base / "replay" / "passos.yaml"
    try:
        linhas = p.read_text(encoding="utf-8-sig", errors="replace").splitlines()
    except OSError:
        return None
    fluxos, atual = [], None

    def valor(linha):
        v = linha.split(":", 1)[1].strip()
        if len(v) >= 2 and v[0] == v[-1] and v[0] in "\"'":
            v = v[1:-1]
        return v

    for linha in linhas:
        if re.match(r"^- id\s*:", linha):
            atual = {"FLUXO_ID": valor(linha), "FLUXO_OBJETIVO": None, "FLUXO_N_PASSOS": 0, "FLUXO_EFEITO": "não",
                     "_titulo": None}
            fluxos.append(atual)
        elif atual is None:
            continue
        elif re.match(r"^\s{1,4}objetivo\s*:", linha):
            atual["FLUXO_OBJETIVO"] = valor(linha)
        elif re.match(r"^\s{1,4}titulo\s*:", linha):
            atual["_titulo"] = valor(linha)
        elif re.match(r"^\s{1,4}cria_efeito_externo\s*:", linha):
            atual["FLUXO_EFEITO"] = "sim" if valor(linha).lower() in ("true", "sim", "yes") else "não"
        elif re.match(r"^\s+- n\s*:\s*\d+", linha):
            atual["FLUXO_N_PASSOS"] += 1
    for f in fluxos:
        objetivo = f["FLUXO_OBJETIVO"] or f["_titulo"] or ""
        f["FLUXO_OBJETIVO"] = _mascara.mascarar(str(objetivo), estrito=True)[0] or None
        f["FLUXO_ID"] = _mascara.mascarar(str(f["FLUXO_ID"]), estrito=True)[0]
        f.pop("_titulo", None)
    return fluxos


GATES_ESTATICOS = (("TYPECHECK", ("typecheck", "tsc", "tipos", "mypy", "pyright")),
                   ("LINT", ("lint", "eslint", "ruff", "flake8")), ("BUILD", ("build",)),
                   ("TESTES", ("testes", "test", "tests", "suite", "unitarios", "pytest")),
                   ("EOL", ("eol", "fim-de-linha", "crlf", "diff-stat")), ("I18N", ("i18n", "chaves-i18n", "idiomas")))


def _chave_gate(sufixo: str) -> str | None:
    s = slug_simples(sufixo)
    for chave, nomes in GATES_ESTATICOS:
        if any(s == n or s.startswith(n + "-") for n in nomes):
            return chave
    return None


def preencher_modelo(dados: dict, m: dict, motivos: list, base: Path, modelo: str, saida_md: str,
                     saida_secoes: str) -> str:
    r = dados.get("rodada") or {}
    casos = [c for c in dados["casos"] if isinstance(c, dict)]
    itens = [i for i in dados["itens"] if isinstance(i, dict)]
    defeitos = [d for d in dados["defeitos"] if isinstance(d, dict)]
    sujeira = [s for s in dados["sujeira"] if isinstance(s, dict)]
    gits = [g for g in lista_evidencias(r.get("git")) if isinstance(g, dict)]
    g0 = gits[0] if gits else {}
    total = m["total_casos"]

    def pct(n):
        return f"{round(100.0 * n / total, 1)}%" if total else "0%"

    def tipo_d(d):
        return d.get("tipo") or "defeito"

    def nnn(d):
        return str(d.get("id") or "").split("-", 1)[-1]

    def classe(st):
        return {"retestado-ok": "st-ok", "aberto": "st-aberto", "corrigido": "st-pendente",
                "nao-corrigido": "st-pendente"}.get(st, "st-neutro")

    reais = [d for d in defeitos if tipo_d(d) != "retratado"]
    tem_item_papel = any(tipo_do_item(i) == "papel" for i in itens)
    v = {"RODADA_NOME": r.get("id") or base.name, "ALVO": r.get("alvo"), "INICIO": r.get("inicio"),
         "FIM": r.get("fim"), "AMBIENTE": r.get("ambiente"),
         "PAPEIS": ", ".join(str(x) for x in lista_evidencias(r.get("papeis_usados"))) or (
             "" if any(tipo_do_item(i) == "papel" for i in itens) else "sem papel"),
         "REPOSITORIO": g0.get("repo"), "BRANCH": g0.get("branch"), "COMMIT": g0.get("commit"),
         "AUTORIZACOES": "; ".join(str(x) for x in lista_evidencias(r.get("autorizacoes"))) or "nenhuma registrada",
         "N_ITENS": m["total_itens"], "N_CASOS": total, "N_DEFEITOS": len(reais),
         "N_RETESTADOS_OK": sum(1 for d in reais if d.get("status") == "retestado-ok"),
         "GATE_RESULTADO": "PASSA" if not motivos else "NAO PASSA: " + "; ".join(motivos),
         "SAIDA_COBERTURA_RELATORIO": saida_md, "SAIDA_COBERTURA_SECOES": saida_secoes,
         "PASTA_DA_RODADA": str(base),
         "N_MELHORIAS_APLICADAS": sum(1 for d in defeitos if tipo_d(d) == "melhoria"
                                      and d.get("status") in ("corrigido", "retestado-ok")),
         "N_MELHORIAS_PROPOSTAS": sum(1 for d in defeitos if tipo_d(d) == "melhoria"
                                     and d.get("status") == "nao-corrigido"),
         "N_DECISOES_PENDENTES": sum(1 for d in defeitos if tipo_d(d) == "decisao-de-produto"
                                    and d.get("status") == "nao-corrigido")}
    for st in STATUS_CASO:
        n = m["por_status"].get(st, 0)
        chave = st.upper().replace("-", "_")
        v[f"N_{chave}"], v[f"P_{chave}"] = n, pct(n)
    for sev in SEVERIDADES:
        ds = [d for d in reais if d.get("severidade") == sev]
        s = sev.upper()
        v[f"SEV_{s}_N"] = len(ds)
        v[f"SEV_{s}_OK"] = sum(1 for d in ds if d.get("status") == "retestado-ok")
        v[f"SEV_{s}_SEM_RETESTE"] = sum(1 for d in ds if d.get("status") == "corrigido")
        v[f"SEV_{s}_NC"] = sum(1 for d in ds if d.get("status") == "nao-corrigido")
    for b in lista_evidencias(r.get("baselines")):
        if isinstance(b, dict):
            chave = _chave_gate(str(b.get("gate") or ""))
            if chave:
                v[f"{chave}_BASELINE"] = f"{b.get('resultado')} ({b.get('comando')})"
    for it in itens:
        if tipo_do_item(it) != "estatico":
            continue
        chave = _chave_gate(sufixo_dimensao(it.get("id")))
        if not chave:
            continue
        cs_g = [c for c in casos if c.get("item_id") == it.get("id") and c.get("status") not in (None, "", "pendente")]
        ultimo = ultimo_por_data(cs_g)
        if ultimo is None:
            continue
        texto_g = ultimo.get("resultado_obtido") or ultimo.get("justificativa")
        v[f"{chave}_RESULTADO"] = f"{ultimo.get('status')}: {texto_g}" if texto_g else ultimo.get("status")

    casos_do = defaultdict(list)
    for c in casos:
        casos_do[str(c.get("item_id"))].append(c)
    linhas_item = []
    for it in itens:
        cs = casos_do.get(str(it.get("id")), [])
        cont = Counter(c.get("status") for c in cs)
        outros = len(cs) - cont.get("passou", 0) - cont.get("falhou", 0)
        obs = "fora do escopo" if str(it.get("escopo") or "dentro") == "fora" else \
            ", ".join(f"{k} {n}" for k, n in sorted(cont.items()) if k not in ("passou", "falhou")) or "-"
        linhas_item.append({"ITEM_ID": it.get("id"), "ITEM_CASOS": len(cs), "ITEM_PASSOU": cont.get("passou", 0),
                            "ITEM_FALHOU": cont.get("falhou", 0), "ITEM_OUTROS": outros, "ITEM_OBS": obs})
    linhas_critica = [{"PASSADA": c.get("passada"), "NOVOS_ITENS": c.get("novos_itens"),
                       "NOVOS_CASOS": c.get("novos_casos"), "ORIGEM": c.get("origem")}
                      for c in lista_evidencias(r.get("criticas")) if isinstance(c, dict)]
    linhas_secao = []
    for it in itens:
        if tipo_do_item(it) != "dimensao":
            continue
        for c in casos_do.get(str(it.get("id")), []):
            linhas_secao.append({"SECAO": sufixo_dimensao(it.get("id")), "SECAO_CASO": f"{c.get('id')} {c.get('status')}",
                                 "SECAO_MOTIVO": c.get("justificativa") or c.get("resultado_obtido") or "-"})
    corrigidos = [d for d in reais if tipo_d(d) == "defeito" and d.get("status") in ("corrigido", "retestado-ok")]
    nao_corr = [d for d in reais if tipo_d(d) in ("defeito", "decisao-de-produto") and d.get("status") == "nao-corrigido"]

    def linha_def(d, extra=None):
        base_v = {"NNN": nnn(d), "SEVERIDADE": d.get("severidade"), "SINTOMA": d.get("titulo"),
                  "ARQUIVO_LINHA": d.get("onde"), "CLASSE_STATUS": classe(d.get("status")), "STATUS": d.get("status"),
                  "MOTIVO": d.get("justificativa")}
        base_v.update(extra or {})
        return base_v

    texto = modelo
    texto = _repetir(texto, "item", linhas_item)
    texto = _repetir(texto, "critica", linhas_critica)
    texto = _repetir(texto, "secao", linhas_secao)
    texto = _repetir(texto, "linha-corrigido", [linha_def(d) for d in corrigidos])
    texto = _repetir(texto, "linha-nao-corrigido", [linha_def(d) for d in nao_corr])
    texto = _repetir(texto, "sujeira", [{"AMBIENTE": s.get("ambiente"), "O_QUE": s.get("o_que"),
                                         "IDENTIFICADOR": s.get("identificador") or s.get("id"),
                                         "ESTADO_FINAL": s.get("estado_final"),
                                         "LIMPEZA": s.get("como_desfazer")} for s in sujeira])
    nv = [c for c in casos if c.get("status") == "nao-validado"]
    texto = _repetir(texto, "nao-validado", [{"O_QUE": f"{c.get('id')} · {c.get('titulo') or c.get('item_id')}",
                                              "POR_QUE": c.get("justificativa"),
                                              "O_QUE_FALTA": c.get("justificativa")} for c in nv])
    retr = [d for d in defeitos if tipo_d(d) == "retratado"]
    texto = _repetir(texto, "retratacao", [{"ACHADO": f"{d.get('id')} · {d.get('titulo')}", "O_QUE_PARECIA": d.get("titulo"),
                                            "O_QUE_ERA": d.get("causa") or d.get("justificativa"),
                                            "COMO_DESCOBRIU": d.get("justificativa")} for d in retr])
    melh_ap = [d for d in defeitos if tipo_d(d) == "melhoria" and d.get("status") in ("corrigido", "retestado-ok")]
    melh_pr = [d for d in defeitos if tipo_d(d) == "melhoria" and d.get("status") == "nao-corrigido"]
    texto = _repetir(texto, "melhoria-aplicada", [{"N": k + 1, "ONDE": d.get("onde"), "ANTES": d.get("causa") or d.get("titulo"),
                                                   "DEPOIS": d.get("correcao")} for k, d in enumerate(melh_ap)])
    texto = _repetir(texto, "melhoria-proposta", [{"N": k + 1, "ONDE": d.get("onde"), "O_QUE": d.get("titulo"),
                                                   "POR_QUE": d.get("causa"), "DEPENDE": d.get("justificativa")}
                                                  for k, d in enumerate(melh_pr)])

    if r.get("reteste_de") or any(not vazio(d.get("importado_de")) for d in defeitos):
        texto07 = ler_nota(base, "07", "correcao")
        linhas_ret = []
        for d in reais:
            if vazio(d.get("importado_de")):
                continue
            did = str(d.get("id"))
            trecho = " ".join(t for t in re.split(r"(?=\bD-\d{3,}\b)", texto07)
                              if re.match(re.escape(did) + r"(?!\d)", t))
            trecho_n = normalizar_texto(trecho)
            veredito = "PRECISA DE AJUSTE" if "precisa de ajuste" in trecho_n else (
                "RESOLVEU" if "resolveu" in trecho_n else None)
            regs = [c for c in casos if c.get("defeito_id") == did and c.get("tecnica") == "regressao"
                    and vazio(c.get("importado_de")) and c.get("status") not in (None, "", "pendente")]
            ult = ultimo_por_data(regs)
            prova = [x.name for x in evidencias_validas(ult.get("evidencias"), base)] if ult else []
            nn = next((mm.group(1) for x in prova for mm in [re.match(r"^(\d+)-", x)] if mm), None)
            linhas_ret.append({"RETESTE_ITEM": f"{did} · {d.get('titulo')}", "RETESTE_AUTOR": d.get("autor_correcao"),
                               "RETESTE_COMMIT": g0.get("commit"), "RESOLVEU_OU_PRECISA_DE_AJUSTE": veredito,
                               "RETESTE_CLASSE": {"RESOLVEU": "st-ok", "PRECISA DE AJUSTE": "st-aberto"}.get(veredito),
                               "RETESTE_DETALHE": (f"{ult.get('id')}: {ult.get('resultado_obtido')}"
                                                   if ult and ult.get("resultado_obtido") else None),
                               "NN": nn})
        texto = _repetir(texto, "reteste", linhas_ret)
    else:
        texto = _repetir(texto, "reteste", [])
    if not any(tipo_d(d) == "decisao-de-produto" for d in defeitos):
        texto = _repetir(texto, "decisao", [])
    qc = [c for c in casos if "QC" in codigos_do_caso(c) or str(c.get("item_id") or "").upper() == "DIMENSAO:QC"]
    if qc:
        defs_por_id = {str(d.get("id")): d for d in defeitos}
        linhas_qc = []
        for c in qc:
            if c.get("status") != "falhou":
                continue
            d = defs_por_id.get(str(c.get("defeito_id"))) or {}
            cod = next((x for x in sorted(codigos_do_caso(c), key=len, reverse=True) if x.startswith("QC")), "QC")
            item_qc = next((i for i in itens if i.get("id") == c.get("item_id")), {})
            linhas_qc.append({"QC": cod, "ARQUIVO": d.get("onde") or item_qc.get("origem"),
                              "SINAL_E_NUMERO": c.get("resultado_obtido"), "RISCO": d.get("causa"),
                              "SEVERIDADE": d.get("severidade")})
        texto = _repetir(texto, "achado-qc", linhas_qc)
    areas = []
    for it in itens:
        if tipo_do_item(it) not in ("tela", "fluxo", "api", "comando", "funcao", "job", "consumidor", "ipc", "cena",
                                    "prompt") or str(it.get("escopo") or "dentro") == "fora":
            continue
        familia_a = [str(it.get("id"))] + sorted(descendentes(str(it.get("id")), itens))
        cs_a = [c for x in familia_a for c in casos_do.get(x, [])]
        if not cs_a:
            continue
        papeis = sorted({str(c.get("papel")) for c in cs_a if c.get("papel")})
        dims = [x for x in DIMENSOES if any(x in dimensoes_do_caso(c) for c in cs_a if c.get("status") != "nao-aplicavel")]
        areas.append({"AREA": it.get("id"), "AREA_PAPEIS": ", ".join(papeis) or ("-" if tem_item_papel else "sem papel"),
                      "AREA_CAMINHOS": ", ".join(dims) or "-", "AREA_N_CASOS": len(cs_a)})
    texto = _repetir(texto, "area", areas)
    texto = _repetir(texto, "fluxo", _linhas_fluxo(base))
    mod_rx = re.compile(r"(<tr><td>(MA|MO)-(\d+) [^<]*</td>)(.*?)(</tr>)")

    def troca_modulo(mm):
        prefixo, numero = mm.group(2), mm.group(3)
        cod = f"{prefixo}-{numero}"
        cs_m = [c for c in casos if cod in codigos_do_caso(c) or str(c.get("item_id") or "").upper() == f"DIMENSAO:{cod}"]
        if not cs_m:
            return mm.group(0)
        cont = Counter(c.get("status") for c in cs_m)
        concluidos = cont.get("passou", 0) + cont.get("falhou", 0)
        na = [c for c in cs_m if c.get("status") == "nao-aplicavel"]
        if concluidos:
            aplicado = "sim" if prefixo == "MA" else "ligado"
        elif na and len(na) == len(cs_m):
            aplicado = "não" if prefixo == "MA" else "desligado"
        else:
            aplicado = "sim (sem conclusão)" if prefixo == "MA" else "ligado (sem conclusão)"
        resultado = ", ".join(f"{n} {k}" for k, n in sorted(cont.items()))
        provas = [x.name for c in cs_m for x in evidencias_validas(c.get("evidencias"), base)]
        if provas:
            evid = ", ".join(list(dict.fromkeys(provas))[:4]) + (" ..." if len(set(provas)) > 4 else "")
        else:
            evid = resumir(vis(next((c.get("justificativa") for c in cs_m if c.get("justificativa")), "")), 160) or None
        vals = {"SIM_NAO": aplicado, "LIGADO_DESLIGADO": aplicado, f"{prefixo}{numero}_RESULTADO": resultado,
                f"{prefixo}{numero}_EVIDENCIA": evid}
        return mm.group(1) + _preencher(mm.group(4), vals) + mm.group(5)

    texto = mod_rx.sub(troca_modulo, texto)

    tipos_r = set(tipos_da_rodada(r))
    variante_comando = not (tipos_r & TIPOS_COM_HTTP)
    mv = RE_VARIANTE_COMANDO.search(modelo)
    linha_comando = mv.group(1) if mv else LINHA_PROVA_COMANDO

    def bloco_defeito(m_bloco, lista, com_depois):
        modelo_bloco = m_bloco.group(1)
        if variante_comando:
            modelo_bloco = fora_de_comentarios(modelo_bloco,
                                               lambda parte: RE_PROVA_HTTP.sub(lambda _m: linha_comando, parte))
        saida = []
        for d in lista:
            ligados = [c for c in casos if c.get("defeito_id") == d.get("id")]
            ev = evidencias_de_defeito(d)
            papel = ", ".join(sorted({str(c.get("papel")) for c in ligados if c.get("papel")}))
            if not papel and not tem_item_papel:
                papel = "sem papel"
            extra_cmd = {}
            if variante_comando:
                cmd_a, rc_a, prova_a = prova_de_comando(ev["antes"] + ev["outras"], base)
                prova_d = prova_de_comando(ev["depois"] + ev["reteste"], base)[2]
                extra_cmd = {"COMANDO": cmd_a, "RC": rc_a, "PROVA_ANTES": prova_a, "PROVA_DEPOIS": prova_d}
            falhos = [c for c in ligados if c.get("status") == "falhou"]
            primeiro = min(falhos, key=lambda c: chave_instante(c.get("atualizado_em"))) if falhos else None
            regs_ok = [c for c in ligados if c.get("tecnica") == "regressao" and c.get("status") == "passou"]
            antes_txt, obtido_a = None, None
            if primeiro is not None:
                esperado_a, obtido_a = primeiro.get("resultado_esperado"), primeiro.get("resultado_obtido")
                antes_txt = "; ".join(x for x in (f"esperado: {esperado_a}" if esperado_a else "",
                                                  f"obtido: {obtido_a}" if obtido_a else "") if x) or None
            depois_txt = "; ".join(f"{c.get('id')}: {c.get('resultado_obtido')}" for c in regs_ok
                                   if c.get("resultado_obtido")) or None
            controle = "; ".join(f"{c.get('id')} (regressao, passou)" + (f": {c.get('resultado_obtido')}"
                                                                         if c.get("resultado_obtido") else "")
                                 for c in regs_ok) or None
            metodo_url, status_http = _rede_metodo_status(ev["antes"] + ev["outras"] + [
                e for c in falhos for e in lista_evidencias(c.get("evidencias"))], base)
            itens_def = {str(c.get("item_id")) for c in ligados}
            nv_def = [c for c in casos if c.get("status") == "nao-validado"
                      and (d.get("id") in defeitos_do_caso(c) or str(c.get("item_id")) in itens_def)]
            nao_val = "; ".join(f"{c.get('id')}: {c.get('justificativa')}" for c in nv_def) if nv_def else "nada"
            extra_auto = {"DATA_ACHADO": _data_curta(primeiro.get("atualizado_em")) if primeiro else None,
                          "ANTES_TEXTO": antes_txt, "METODO_URL": metodo_url, "STATUS_HTTP": status_http,
                          "CONTROLE_E_REGRESSAO": controle, "NAO_VALIDADO_ITEM": nao_val}
            if not extra_cmd.get("PROVA_ANTES"):
                extra_auto["PROVA_ANTES"] = obtido_a
            if not extra_cmd.get("PROVA_DEPOIS"):
                extra_auto["PROVA_DEPOIS"] = depois_txt
            vals = linha_def(d, {"SINTOMA_EM_UMA_FRASE": d.get("titulo"), "TIPO": tipo_d(d),
                                 "ITEM_ID": ", ".join(sorted({str(c.get("item_id")) for c in ligados})),
                                 "CASOS": ", ".join(str(c.get("id")) for c in ligados),
                                 "PAPEL": papel, **extra_cmd, **extra_auto,
                                 "CAUSA": d.get("causa"), "MUDANCA": d.get("correcao"),
                                 "PROPOSTA": d.get("correcao"),
                                 "MOTIVO_E_QUEM_PRECISA_AGIR": d.get("justificativa"),
                                 "STATUS_DETALHE": d.get("justificativa") or (
                                     "reteste: " + ", ".join(str(c.get("id")) for c in ligados
                                                            if c.get("tecnica") == "regressao"))})
            b = _trocar_figura(modelo_bloco, "antes", _prova_html(ev["antes"] + ev["outras"], base,
                                                                   f"ANTES {d.get('id')}"))
            if com_depois:
                b = _trocar_figura(b, "depois", _prova_html(ev["depois"] + ev["reteste"], base,
                                                             f"DEPOIS {d.get('id')}"))
            saida.append(_preencher(b, vals))
        return "".join(saida)

    texto = re.sub(r"<!-- REPETIR: defeito-corrigido -->\n?(.*?)<!-- /REPETIR: defeito-corrigido -->\n?",
                   lambda mb: bloco_defeito(mb, corrigidos, True), texto, flags=re.S)
    texto = re.sub(r"<!-- REPETIR: defeito-nao-corrigido -->\n?(.*?)<!-- /REPETIR: defeito-nao-corrigido -->\n?",
                   lambda mb: bloco_defeito(mb, nao_corr, False), texto, flags=re.S)
    texto = fora_de_comentarios(texto, lambda parte: _preencher(parte, v))
    texto = fora_de_comentarios(
        texto, lambda parte: RE_PLACEHOLDER.sub(lambda mm: "[PREENCHA: " + html.escape(
            re.sub(r"\s+", " ", mm.group(1)).strip(), quote=False) + "]", parte))
    return texto


def texto_secoes(dados: dict) -> str:
    r = dados.get("rodada") or {}
    tipos = tipos_da_rodada(r)
    if not tipos:
        return "tipo de projeto nao declarado"
    try:
        faltam, condicionais = faltas_de_secao(dados, tipos)
    except ErroCatalogo as e:
        return f"catalogo ilegivel: {e}"
    linhas = [f"modo {modo_da_rodada(r)} · tipo(s) {', '.join(tipos)}"]
    linhas += [f"FALTA  {f}" for f in faltam] + [f"AVISO  {c}" for c in condicionais]
    linhas.append(f"MA-5   cobrado no fechar: {'coberto' if ma5_coberto(dados) else 'ainda sem caso'}")
    if not faltam:
        linhas.append("ok: toda secao obrigatoria e todo modulo do gate tem caso ou nao-aplicavel")
    return "\n".join(linhas)


def cmd_relatorio(args) -> int:
    p = caminho_ledger(args.pasta)
    dados = carregar(p)
    a = validar_dados(dados, p.parent)
    motivos, _ = checar_gate(dados, a, base=p.parent)
    dados_vis, n_seg = _mascara.mascarar_estrutura(dados)
    motivos_vis, n2 = _mascara.mascarar_estrutura(motivos)
    a_vis = Achados()
    erros_vis, n3 = _mascara.mascarar_estrutura([list(x) for x in a.erros])
    avisos_vis, n4 = _mascara.mascarar_estrutura([list(x) for x in a.avisos])
    a_vis.erros = [tuple(x) for x in erros_vis]
    a_vis.avisos = [tuple(x) for x in avisos_vis]
    n_seg += n2 + n3 + n4
    m = calcular_metricas(dados_vis, a_vis, motivos_vis)
    if args.modelo:
        if not args.saida:
            falhar("--modelo exige --saida (ex.: <rodada>/relatorio/relatorio.html)")
        try:
            modelo = Path(args.modelo).expanduser().read_text(encoding="utf-8-sig")
        except OSError as e:
            falhar(f"nao consegui ler o modelo {args.modelo}: {e}")
        blocos, n5 = _mascara.mascarar_estrutura(montar_blocos(dados_vis, m, a_vis))
        secoes_txt, n6 = _mascara.mascarar(texto_secoes(dados_vis), estrito=True)
        texto = preencher_modelo(dados_vis, m, motivos_vis, p.parent, modelo, blocos_para_md(blocos), secoes_txt)
        texto, n7 = _mascara.mascarar(texto, estrito=True)
        n_seg += n5 + n6 + n7
        escrever_texto(args.saida, texto)
        marcas = re.findall(r"\[PREENCHA: ([A-Z][A-Z0-9_]*)", sem_comentarios(texto))
        restantes = len(re.findall(r"\[PREENCHA", sem_comentarios(texto)))
        por_chave = Counter(marcas)
        print(f"modelo preenchido: {restantes} trecho(s) [PREENCHA] para escrever a mao (o fechar reprova enquanto "
              f"houver algum)" + (": " + ", ".join(f"{k} {n}" for k, n in por_chave.most_common(15))
                                  + (" ..." if len(por_chave) > 15 else "") if por_chave else ""))
        if n_seg:
            _mascara.avisar(n_seg, "relatorio de cobertura")
            return EXIT_FALHA
        return EXIT_OK
    formato = "json" if args.json else "html" if args.html else "md"
    if formato == "json":
        m, n5 = _mascara.mascarar_estrutura(m)
        n_seg += n5
        texto = json.dumps(m, ensure_ascii=False, indent=2) + "\n"
    else:
        blocos, n5 = _mascara.mascarar_estrutura(montar_blocos(dados_vis, m, a_vis))
        n_seg += n5
        if formato == "html":
            titulo, n6 = _mascara.mascarar(f"Cobertura - {dados_vis['rodada'].get('alvo') or p.parent.name}",
                                           estrito=True)
            n_seg += n6
            texto = blocos_para_html(blocos, titulo)
        else:
            texto = blocos_para_md(blocos)
    escrever_texto(args.saida, texto)
    if n_seg:
        _mascara.avisar(n_seg, "relatorio de cobertura")
        return EXIT_FALHA
    return EXIT_OK


def imprimir_gate(m: dict, motivos: list, detalhes: dict, a: Achados, limite: int) -> bool:
    if a.erros:
        a.imprimir()
    modo = detalhes.get("modo") or "completo"
    tipos = ", ".join(detalhes.get("tipos") or tipos_da_rodada(m.get("rodada") or {})) or "(nao declarado)"
    print(f"modo da rodada: {modo} · tipo(s) de projeto: {tipos}")
    for linha in detalhes.get("avisos_tipo") or []:
        print(f"aviso: {vis(linha)}")
    if not motivos:
        print(f"GATE: PASSA - {m['total_itens']} itens, {m['total_casos']} casos, cobertura {m['cobertura_pct']}%, "
              f"passou {m['por_status']['passou']}, falhou {m['por_status']['falhou']}, "
              f"nao-validado {m['por_status']['nao-validado']}, defeitos {m['defeitos_total']}")
        if m["por_status"]["nao-validado"]:
            print("lembre: liste no relatorio final o que NAO foi validado e por que (relatorio --md).")
        for linha in detalhes.get("secoes_condicionais") or []:
            print(f"aviso: secao {vis(linha)}")
        return True
    print("GATE: NAO PASSA")
    for mot in motivos:
        print(f"  - {vis(mot)}")
    if detalhes.get("pendentes"):
        print("casos pendentes:")
        for c in detalhes["pendentes"][:limite]:
            print(f"  {vis(c.get('id'))}  [{vis(c.get('tecnica'))}]  {vis(c.get('item_id'))}  "
                  f"{resumir(vis(c.get('resultado_esperado')), 70)}")
        if len(detalhes["pendentes"]) > limite:
            print(f"  ... e mais {len(detalhes['pendentes']) - limite} (veja: cobertura.py listar <pasta> --status pendente)")
    if detalhes.get("sem_prova"):
        print("casos sem evidencia valida (salve o print/payload em evidencias/ ou rede/, ou corrija o caminho):")
        for c in detalhes["sem_prova"][:limite]:
            caminhos = ", ".join(str(caminho_evidencia(e)) for e in lista_evidencias(c.get("evidencias")))
            print(f"  {vis(c.get('id'))}  {vis(c.get('status'))}  {vis(caminhos) or '(nenhuma)'}")
    if detalhes.get("sem_caso"):
        print("itens sem caso:")
        for iid in detalhes["sem_caso"][:limite]:
            print(f"  {vis(iid)}")
        if len(detalhes["sem_caso"]) > limite:
            print(f"  ... e mais {len(detalhes['sem_caso']) - limite}")
    for chave, rotulo in (("abertos", "defeitos abertos"), ("sem_reteste", "defeitos corrigidos sem reteste")):
        if detalhes.get(chave):
            print(f"{rotulo}:")
            for d in detalhes[chave][:limite]:
                print(f"  {vis(d.get('id'))}  [{vis(d.get('severidade'))}]  {resumir(vis(d.get('titulo')), 80)}")
    for chave, rotulo in (("mal_retestados", "defeitos retestado-ok sem reteste que passou / com reteste que falhou"),
                          ("sem_dimensao", "acoes sem as cinco dimensoes"),
                          ("secoes", "secoes do catalogo e modulos sem caso nem nao-aplicavel"),
                          ("minimos", "minimo por tipo de item (catalogo §1.3)"),
                          ("contagens", "contagem do inventario por tipo de projeto"),
                          ("rodada", "registro da rodada")):
        if detalhes.get(chave):
            print(f"{rotulo}:")
            for linha in detalhes[chave][:limite]:
                print(f"  {vis(linha)}")
            if len(detalhes[chave]) > limite:
                print(f"  ... e mais {len(detalhes[chave]) - limite}")
    for linha in detalhes.get("secoes_condicionais") or []:
        print(f"aviso: secao {vis(linha)}")
    if detalhes.get("sujeira"):
        print("sujeira sem estado_final (cobertura.py set <rodada> S-NNN --estado-final \"ficou|revertido|apagado|"
              "desconhecido-pedir-ao-usuario[: texto]\" [--como-desfazer \"...\"]):")
        for s in detalhes["sujeira"][:limite]:
            print(f"  {vis(s.get('id'))}  {resumir(vis(s.get('o_que')), 80)}")
    print(f"cobertura atual: {m['cobertura_pct']}% ({m['concluidos']}/{m['total_casos']} casos concluidos)")
    return False


def cmd_gate(args) -> int:
    p = caminho_ledger(args.pasta)
    dados = carregar(p)
    a = validar_dados(dados, p.parent)
    motivos, detalhes = checar_gate(dados, a, so_cobertura=args.so_cobertura, base=p.parent)
    m = calcular_metricas(dados, a, motivos)
    return EXIT_OK if imprimir_gate(m, motivos, detalhes, a, args.limite) else EXIT_FALHA


PERGUNTAS_APRENDER = (("o que testei que nao estava no catalogo", "o que testei que não estava no catálogo?"),
                      ("o que faltou e so percebi depois", "o que faltou e só percebi depois?"))


def limpar_md(linha: str) -> str:
    s = re.sub(r"^\s*(?:[-*+>]|\d+[.)])?\s*", "", linha)
    s = s.replace("**", "").replace("__", "").replace("`", "")
    return re.sub(r"\{\{[^}]*\}\}", "", s).strip(" |\t")


def checar_aprender(base: Path) -> list:
    nota = base / "notas" / "10-aprender.md"
    try:
        if not nota.is_file() or nota.stat().st_size == 0:
            return ["notas/10-aprender.md ausente ou vazia (fase 11; references/aprender.md §8)"]
        linhas = nota.read_text(encoding="utf-8-sig", errors="replace").split("\n")
    except OSError as e:
        return [f"nao consegui ler notas/10-aprender.md: {e}"]
    faltas = []
    norm = [normalizar_texto(l) for l in linhas]
    chaves = [c for c, _ in PERGUNTAS_APRENDER]
    for chave, rotulo in PERGUNTAS_APRENDER:
        i = next((k for k, l in enumerate(norm) if chave in l), None)
        if i is None:
            faltas.append(f'falta a pergunta "{rotulo}" em notas/10-aprender.md')
            continue
        pos = norm[i].find(chave) + len(chave)
        resto = norm[i][pos:]
        resto = resto[resto.find("?") + 1:] if "?" in resto else resto
        resposta = [limpar_md(resto)]
        for k in range(i + 1, len(linhas)):
            outra_pergunta = any(c in norm[k] for c in chaves if c != chave)
            linha_de_licao = re.match(r"^(aprendi:|nao gravada|nenhuma licao:)", normalizar_texto(limpar_md(linhas[k])))
            if re.match(r"^\s*#", linhas[k]) or outra_pergunta or linha_de_licao:
                break
            resposta.append(limpar_md(linhas[k]))
        texto = " ".join(x for x in resposta if x).strip(" .-:|")
        if len(re.sub(r"[\W_]+", "", texto)) < 3:
            faltas.append(f'a pergunta "{rotulo}" esta sem resposta')
    licoes = 0
    for l in linhas:
        n = normalizar_texto(limpar_md(l))
        m = re.match(r"^(aprendi:|nao gravada|nenhuma licao:)\s*(.*)$", n)
        if m and len(m.group(2).strip(" :-|")) >= 10:
            licoes += 1
    if not licoes:
        faltas.append("nenhuma linha 'APRENDI: ...', 'NAO GRAVADA ...' ou 'Nenhuma lição: <porquê>' em "
                      "notas/10-aprender.md (copie as linhas da saida do aprender.py)")
    return faltas


def faltas_de_entrega(dados: dict, base: Path) -> list:
    """Entregaveis da fase 10 que o fechar confere (o gate da fase 9 nao: eles nascem depois dele)."""
    r = dados.get("rodada") or {}
    reteste = modo_da_rodada(r) == "reteste"
    rel = base / "relatorio"
    casos = [c for c in dados["casos"] if isinstance(c, dict)]
    defeitos = [d for d in dados["defeitos"] if isinstance(d, dict)]
    itens = {str(i.get("id")): i for i in dados["itens"] if isinstance(i, dict)}
    faltas = []

    def tem_arquivo(p: Path) -> bool:
        try:
            return p.is_file() and p.stat().st_size > 0
        except OSError:
            return False

    if any((d.get("tipo") or "defeito") in ("defeito", "melhoria") for d in defeitos) \
            and not tem_arquivo(rel / "provas.pdf"):
        faltas.append("relatorio/provas.pdf ausente ou vazio (fase 10.3): provas.py gerar <rodada> --conferir")
    if not reteste:
        html_rel, pdf_rel = rel / "relatorio.html", rel / "relatorio.pdf"
        if not tem_arquivo(html_rel) and not tem_arquivo(pdf_rel):
            faltas.append("relatorio/relatorio.html (ou .pdf) ausente (fase 10.4): copie templates/relatorio.html, "
                          "preencha e rode gerar_pdf.py")
        elif tem_arquivo(html_rel):
            try:
                visivel = sem_comentarios(html_rel.read_text(encoding="utf-8", errors="replace"))
            except OSError:
                visivel = ""
            if "{{" in visivel or "[PREENCHA" in visivel:
                faltas.append("relatorio/relatorio.html ainda tem '{{' ou '[PREENCHA' fora de comentario (fase "
                              "10.4): preencha o texto que exige pessoa")
        painel, ledger = rel / "painel.html", base / NOME_LEDGER
        try:
            atrasado = not painel.is_file() or painel.stat().st_mtime < ledger.stat().st_mtime
        except OSError:
            atrasado = True
        if atrasado:
            faltas.append("relatorio/painel.html ausente ou mais velho que o cobertura.json: rode painel.py <rodada> "
                          "depois do ultimo rodada --fim (fase 10.6, EN-10)")
    oraculo = [str(c.get("id")) for c in casos if c.get("status") == "bloqueado"
               and normalizar_texto(c.get("justificativa")).startswith("oraculo:")]
    if oraculo:
        textos = []
        arquivos = (sorted(rel.glob("oraculo*.md")) + sorted(rel.glob("perguntas*.html"))) if rel.is_dir() else []
        for arq in arquivos:
            try:
                textos.append(arq.read_text(encoding="utf-8", errors="replace"))
            except OSError:
                continue
        junto = "\n".join(textos)
        sem = [cid for cid in oraculo if not re.search(r"(?<![\w-])" + re.escape(cid) + r"(?![\w-])", junto)]
        if not textos:
            faltas.append(f"{len(oraculo)} caso(s) esperando o oraculo sem relatorio/oraculo*.md: rode mensagens.py "
                          f"<rodada> --oraculo --saida <rodada>/relatorio/oraculo.md (ou --html, que grava "
                          f"relatorio/perguntas.html)")
        elif sem:
            faltas.append(f"relatorio/oraculo*.md nao cita {', '.join(sem[:10])}{' ...' if len(sem) > 10 else ''}: "
                          f"gere de novo com mensagens.py <rodada> --oraculo --saida <rodada>/relatorio/oraculo.md")
    if not reteste:
        if not ma5_coberto(dados):
            faltas.append("nenhum caso [MA-5-*] nem dimensao:MA-5 nao-aplicavel com motivo (fase 10.5: testes "
                          "automaticos de regressao gerados dos fluxos que passaram, ou o porque de nao se aplicar)")
        executou = any(c.get("status") == "passou"
                       and tipo_do_item(itens.get(str(c.get("item_id"))) or {"id": c.get("item_id")})
                       in TIPOS_ITEM_REPLAY for c in casos)
        item_replay = {"id": "dimensao:replay", "escopo": "dentro"}
        replay_na = any(c.get("status") == "nao-aplicavel" and str(c.get("item_id") or "") == "estatico:replay"
                        and justificativa_fraca(c.get("justificativa"), "nao-aplicavel", item_replay) is None
                        for c in casos)
        if executou and not replay_na:
            passos = base / "replay" / "passos.yaml"
            try:
                texto = passos.read_text(encoding="utf-8", errors="replace") if passos.is_file() else ""
            except OSError:
                texto = ""
            if not re.search(r"(?m)^-\s+(?:id|titulo)\s*:", texto):
                faltas.append("replay/passos.yaml sem nenhum fluxo (fase 10.5): copie templates/passos.yaml e grave um "
                              "fluxo por caminho executado, em qualquer tipo de projeto (executar, api, chamar, "
                              "disparar...), ou caso nao-aplicavel no item estatico:replay com o motivo")
            else:
                try:
                    modelo = (PASTA_SKILL / "templates" / "passos.yaml").read_text(encoding="utf-8", errors="replace")
                except OSError:
                    modelo = ""
                ids_modelo = set(re.findall(r"(?m)^-\s+id\s*:\s*(\S+)", modelo))
                ids_rodada = set(re.findall(r"(?m)^-\s+id\s*:\s*(\S+)", texto))
                if ids_rodada and ids_rodada <= ids_modelo:
                    faltas.append("replay/passos.yaml so tem os fluxos de exemplo do modelo (fase 10.5): grave um fluxo por "
                                  "caminho executado nesta rodada, com os valores reais e o commit testado")
    ha_relatorio = tem_arquivo(rel / "relatorio.html") or tem_arquivo(rel / "relatorio.pdf")
    ha_mensagem = rel.is_dir() and any(rel.glob("mensage*"))
    if (defeitos or ha_relatorio or ha_mensagem) and not any("EN" in codigos_do_caso(c) for c in casos):
        faltas.append("nenhum caso [EN-NN] (catalogo §13: provas, entrega e comunicacao) numa rodada com defeito, "
                      "relatorio ou mensagem: add-caso <rodada> --item \"estatico:provas\" --criar-item --titulo "
                      "\"[EN-01] ...\" --tecnica regressao ...")
    return faltas


RE_STACK_SEM_PREENCHER = re.compile(r"^ERRO:?\s*stack-sem-preencher:\s*(?:\S*?/)?references/stacks/([^/\s]+)\.md\b",
                                    re.I)


def texto_do_perfil_da_rodada(dados: dict, base: Path) -> str:
    """PERFIL da rodada (rodada.perfil, relativo a raiz do projeto ou a pasta da rodada) + notas/01-perfil-e-ambiente.md."""
    r = dados.get("rodada") or {}
    partes = [ler_nota(base, "01", "perfil")]
    perfil = str(r.get("perfil") or "").strip()
    if perfil:
        alvo = Path(perfil).expanduser()
        candidatos = [alvo] if alvo.is_absolute() else [raiz_do_projeto(r, base) / alvo, base / alvo,
                                                         base.parent / alvo, base.parent.parent / alvo, Path.cwd() / alvo]
        for c in candidatos:
            try:
                if c.is_file():
                    partes.append(c.read_text(encoding="utf-8-sig", errors="replace"))
                    break
            except OSError:
                continue
    return "\n".join(x for x in partes if x)


def stack_da_rodada(slug: str, texto_perfil: str) -> bool:
    """A stack e desta rodada se o slug, o slug com espacos ou o nome (titulo do arquivo da stack) aparece no PERFIL
    ou na nota 01, sem diferenciar maiuscula."""
    nomes = {slug, slug.replace("-", " "), slug.replace("-", "")}
    try:
        cabeca = (PASTA_SKILL / "references" / "stacks" / f"{slug}.md").read_text(encoding="utf-8-sig",
                                                                                 errors="replace")
        m = re.search(r"^#\s+(.+)$", cabeca, re.M)
        if m:
            titulo = re.sub(r"(?i)^stack\s*[:\-—–]?\s*", "", m.group(1)).strip(" #*`")
            if len(titulo) >= 2:
                nomes.add(titulo)
    except OSError:
        pass
    alvo = texto_perfil or ""
    for nome in nomes:
        if len(nome) >= 2 and re.search(r"(?<![\w-])" + re.escape(nome) + r"(?![\w-])", alvo, re.I):
            return True
    return False


def checar_integridade_skill(dados: dict | None = None, base: Path | None = None) -> tuple:
    """O fechar so fecha com a skill integra: aprender.py validar (guardas literais do SKILL.md, LF, UTF-8,
    compilacao, corpus da trava) saindo 0. Falha fechada em timeout ou erro. Devolve (falhas, avisos): o erro
    'stack-sem-preencher' de uma stack que nao aparece no PERFIL nem na nota 01 desta rodada (criada hoje por outra
    rodada ou projeto) vira aviso e nao reprova; qualquer outro erro reprova."""
    cmd = [sys.executable, str(PASTA_SKILL / "scripts" / "aprender.py"), "validar"]
    env = dict(os.environ, PYTHONIOENCODING="utf-8")
    try:
        proc = subprocess.run(cmd, capture_output=True, text=True, encoding="utf-8", errors="replace", timeout=300,
                              env=env)
    except subprocess.TimeoutExpired:
        return ["aprender.py validar não saiu 0: timeout de 300 s"], []
    except Exception as e:
        return [f"aprender.py validar não saiu 0: {vis(type(e).__name__ + ': ' + str(e))}"], []
    if proc.returncode == 0:
        return [], []
    linhas = [l.strip() for l in ((proc.stdout or "") + "\n" + (proc.stderr or "")).splitlines() if l.strip()]
    erros = [l for l in linhas if l.upper().startswith("ERRO")]
    perfil_txt = texto_do_perfil_da_rodada(dados, base) if dados is not None and base is not None else None
    avisos, restantes = [], []
    for l in erros:
        m = RE_STACK_SEM_PREENCHER.match(l)
        if m and perfil_txt is not None and not stack_da_rodada(m.group(1), perfil_txt):
            avisos.append(f"stack {m.group(1)} criada hoje por outra rodada, sem preencher: nao bloqueia esta rodada "
                          f"(o PERFIL e a nota 01 nao a citam)")
        else:
            restantes.append(l)
    if erros and not restantes:
        return [], avisos
    trecho = (restantes[:4] + linhas[-1:]) if restantes else linhas[-5:]
    return [f"aprender.py validar não saiu 0 (rc {proc.returncode}): {vis(' | '.join(trecho)) or '(sem saida)'}"], \
        avisos


def cmd_fechar(args) -> int:
    p = caminho_ledger(args.pasta)
    dados = carregar(p)
    a = validar_dados(dados, p.parent)
    motivos, detalhes = checar_gate(dados, a, so_cobertura=False, base=p.parent)
    m = calcular_metricas(dados, a, motivos)
    passou = imprimir_gate(m, motivos, detalhes, a, args.limite)
    entrega = faltas_de_entrega(dados, p.parent)
    if entrega:
        print("entregaveis da fase 10 faltando:")
        for f in entrega:
            print(f"  - {vis(f)}")
    superficie = checar_superficie_tudo(dados, p.parent)
    if superficie:
        print("superficie do codigo (escopo_diff --tudo --ledger --falhar-se-descoberto):")
        for f in superficie:
            print(f"  - {f}")
    faltas = checar_aprender(p.parent)
    if faltas:
        print("fase 11 (aprender) incompleta:")
        for f in faltas:
            print(f"  - {f}")
    integridade, avisos_integridade = checar_integridade_skill(dados, p.parent)
    for av in avisos_integridade:
        print(f"aviso (integridade da skill, nao bloqueia): {vis(av)}")
    if integridade:
        print("integridade da skill:")
        for f in integridade:
            print(f"  - {f}")
    if passou and not faltas and not entrega and not integridade and not superficie:
        print("RODADA FECHADA: gate final passou, a superficie do codigo confere (fora do modo PR e do reteste), os "
              "entregaveis da fase 10 existem, a fase 11 esta registrada e a skill passa no aprender.py validar.")
        return EXIT_OK
    print("RODADA NAO FECHADA: resolva o que esta acima e rode 'cobertura.py fechar' de novo.")
    return EXIT_FALHA


def cmd_secoes(args) -> int:
    p = caminho_ledger(args.pasta)
    dados = carregar(p)
    r = dados["rodada"]
    modo = modo_da_rodada(r)
    try:
        validos = sorted(tipos_de_projeto())
        brutos = separar_tipos(args.tipo_projeto) if args.tipo_projeto else tipos_da_rodada(r)
        if not brutos:
            falhar(f"tipo de projeto nao declarado: passe --tipo-projeto ou grave com 'rodada --tipo-projeto' "
                   f"(validos: {', '.join(validos)})")
        slugs = []
        for tipo in brutos:
            slug = slug_tipo_projeto(tipo)
            if slug not in validos:
                falhar(f'tipo de projeto "{tipo}" desconhecido (validos: {", ".join(validos)})')
            if slug not in slugs:
                slugs.append(slug)
        incond = []
        for slug in slugs:
            incond += entradas_do_tipo(slug)[0]
        obrig = expandir_entradas(incond)
        faltam, condicionais = faltas_de_secao(dados, slugs)
        mot_tipo, av_tipo = problemas_de_tipo(dados, slugs)
    except ErroCatalogo as e:
        print(f"ERRO: {e} (falha fechada: nada conferido)", file=sys.stderr)
        return EXIT_USO
    exigidas = [n for n in obrig if exigencia_da_secao(n)]
    print(f"modo da rodada: {modo} · tipo(s) de projeto: {', '.join(slugs)} · {len(exigidas)} secao(oes) com prefixo "
          f"+ {len(MODULOS_DO_GATE)} modulos no gate (MA-1..MA-4, MA-6, MO-7..MO-10); MA-5 e cobrado no fechar")
    if modo == "reteste":
        print("aviso: no modo reteste o gate nao cobra as secoes (so o reteste de cada defeito); a lista abaixo e "
              "informativa")
    for linha in mot_tipo:
        print(f"FALTA  {linha}")
    for linha in av_tipo:
        print(f"AVISO  {linha}")
    for f in faltam:
        print(f"FALTA  {f}  -> caso com titulo '[<PREFIXO>-NN] ...' ou item dimensao:<PREFIXO> com caso nao-aplicavel "
              f"justificado")
    for c in condicionais:
        print(f"AVISO  {c}")
    estado_ma5 = "coberto" if ma5_coberto(dados) else "ainda sem caso [MA-5-*] nem dimensao:MA-5"
    print(f"MA-5   cobrado no fechar (fase 10.5): {estado_ma5}")
    if not faltam and not mot_tipo:
        print("ok: toda secao obrigatoria e todo modulo do gate tem caso ou nao-aplicavel")
    return EXIT_FALHA if (faltam or mot_tipo) else EXIT_OK


def slug_simples(texto) -> str:
    return re.sub(r"[^a-z0-9]+", "-", normalizar_texto(texto)).strip("-")


RE_ROTULO_EXPORTAR = re.compile(r"(?i)\b(exportar|export|baixar|download|csv|excel|xlsx|pdf)\b")


def tipo_elemento_do_snippet(el: dict) -> str | None:
    """Classifica o elemento visto em runtime pelo tag, role, type e href (o href nao e gravado)."""
    tag = str(el.get("tag") or "").lower()
    role = str(el.get("role") or "").lower()
    tipo = str(el.get("tipo") or el.get("type") or "").lower()
    href = str(el.get("href") or "").strip().lower()
    nome = str(el.get("nome") or "")
    if tag == "input" and tipo == "file":
        return "upload"
    if tag == "input" and tipo in ("date", "datetime-local", "time", "month", "week"):
        return "data"
    if tag == "select" or role == "listbox":
        return "select"
    if role == "combobox":
        return "select-busca"
    if tag == "a" and re.match(r"^(https?:|mailto:|tel:)", href):
        return "link-externo"
    if (tag in ("button", "a") or role in ("button", "link", "menuitem")) and RE_ROTULO_EXPORTAR.search(nome):
        return "exportar"
    return None


TIPOS_INPUT_BOTAO = ("button", "submit", "reset", "image")
ROLES_CAMPO = ("textbox", "searchbox", "spinbutton", "combobox", "listbox")
RE_ID_DE_LINHA = re.compile(r"^(.+?)[-_](\d+|[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}|[0-9a-f]{12,})$")
RE_SEG_DINAMICO = re.compile(r"^(?:\[[^\[\].]+\]|\[\[[^\[\].]+\]\]|:[\w-]+\??|\{[^{}*]+\}|\$[\w-]+|<[^<>]+>)$")
RE_SEG_RESTO = re.compile(r"^(?:\[\.\.\.[^\]]+\]|\[\[\.\.\.[^\]]+\]\]|\*{1,2}|\*[\w-]+|:[\w-]+\*|\{[^{}]*\*[^{}]*\})$")


def eh_campo_do_snippet(el: dict) -> bool:
    """input (fora os de botao), textarea, select e caixa editavel: o rotulo nunca pode ser o valor do campo."""
    tag = str(el.get("tag") or "").lower()
    tipo = str(el.get("tipo") or el.get("type") or "").lower()
    role = str(el.get("role") or "").lower()
    if tag in ("textarea", "select"):
        return True
    if tag == "input":
        return tipo not in TIPOS_INPUT_BOTAO
    return role in ROLES_CAMPO


def rotulo_do_snippet(el: dict) -> str:
    """Rotulo do elemento visto em runtime. Em campo, o 'nome' igual ao 'valor'/'value' que o JSON trouxer (snippet
    antigo caia em el.value) e descartado, e o 'valor' nunca e lido para nada alem disso: titulo e slug nunca guardam
    dado digitado ou carregado do registro."""
    nome = re.sub(r"\s+", " ", str(el.get("nome") or "")).strip()
    if nome and eh_campo_do_snippet(el):
        for chave in ("valor", "value"):
            v = el.get(chave)
            if v is not None and str(v).strip() and nome == re.sub(r"\s+", " ", str(v)).strip():
                return ""
    return nome


def barra_inicial(rota) -> str:
    r = str(rota or "").strip()
    return r if r.startswith("/") else "/" + r


def id_tela_norm(iid) -> str:
    """tela:index.html e tela:/index.html sao a mesma tela (so a barra inicial e normalizada)."""
    s = str(iid or "").strip()
    return "tela:" + barra_inicial(s[len("tela:"):].strip()) if s.startswith("tela:") else s


def rota_do_url(url) -> str:
    """Caminho do url do snippet (location.pathname + search), sem esquema, host, query nem ancora."""
    u = str(url or "").strip()
    m = re.match(r"^[a-z][a-z0-9+.-]*://[^/?#]*", u, re.I)
    if m:
        u = u[m.end():]
    u = re.split(r"[?#]", u, maxsplit=1)[0]
    return barra_inicial(u) if u else "/"


def url_sem_valores(url) -> str:
    """Caminho e so os NOMES dos parametros da query (?tab&id): valor de query pode ser token ou dado pessoal."""
    u = str(url or "").strip()
    rota = rota_do_url(u)
    q = u.split("?", 1)[1].split("#", 1)[0] if "?" in u else ""
    nomes = [p.split("=", 1)[0] for p in q.split("&") if p.split("=", 1)[0]]
    return rota + ("?" + "&".join(dict.fromkeys(nomes)) if nomes else "")


def casa_tela(padrao: str, rota: str):
    """None se a rota concreta nao casa o caminho da tela; senao a pontuacao (menor = mais especifica): segmento
    dinamico ([id], :id, {id}, $id) vale 1; resto ([...slug], *) vale 100. (grupo) e @slot do Next sao ignorados."""
    ps = [s for s in padrao.split("?", 1)[0].strip("/").split("/")
          if s and not (s.startswith("(") and s.endswith(")")) and not s.startswith("@")]
    rs = [s for s in rota.strip("/").split("/") if s]
    din = 0
    for i, seg in enumerate(ps):
        if RE_SEG_RESTO.match(seg):
            minimo = 0 if seg.startswith("[[") else 1
            return din + 100 if len(rs) - i >= minimo else None
        if i >= len(rs):
            return None
        if RE_SEG_DINAMICO.match(seg):
            din += 1
            continue
        if seg.lower() != rs[i].lower():
            return None
    return din if len(ps) == len(rs) else None


def tela_da_rota(url, telas: list):
    """Id da tela do ledger para o url do bloco: o id exato com a query, se existir; senao a tela cujo caminho casa
    (exato, ou com segmento dinamico), a mais especifica, preferindo a sem query."""
    u = str(url or "").strip()
    rota = rota_do_url(u)
    if "?" in u:
        exato = "tela:" + rota + "?" + u.split("?", 1)[1].split("#", 1)[0]
        for t in telas:
            if id_tela_norm(t) == exato:
                return t
    melhor = None
    for t in telas:
        caminho = id_tela_norm(t)[len("tela:"):]
        pontos = casa_tela(caminho, rota)
        if pontos is None:
            continue
        chave = (pontos, "?" in caminho, len(caminho))
        if melhor is None or chave < melhor[0]:
            melhor = (chave, t)
    return melhor[1] if melhor else None


def rota_do_elemento(iid) -> str:
    s = str(iid or "")
    s = s[len("elemento:"):] if s.startswith("elemento:") else s
    return s.split("#", 1)[0]


def prefixo_de_linha(chave: str):
    m = RE_ID_DE_LINHA.match(str(chave or "").strip().lower())
    return m.group(1) if m else None


def cmd_reconciliar(args) -> int:
    p = caminho_ledger(args.pasta)
    if not args.elementos:
        tipos = tipos_da_rodada(carregar(p).get("rodada") or {})
        if not tipos:
            falhar("reconciliar sem --elementos: declare antes o tipo de projeto (rodada --tipo-projeto <slug>); com "
                   "UI, passe --elementos <json do snippet de elementos em runtime>")
        com_ui = sorted(set(tipos) & TIPOS_COM_UI_RUNTIME)
        if com_ui:
            falhar(f"--elementos e obrigatorio em rodada com UI ({', '.join(com_ui)}): o JSON {{url, total, itens}} "
                   "do snippet de elementos em runtime (references/perfil-e-inventario.md §4.3)")
        print(f"reconciliar: não se aplica, sem elementos em runtime (tipo(s) {', '.join(tipos)}); anote na nota "
              "02-inventario \"reconciliar: não se aplica, sem elementos em runtime\"")
        return EXIT_OK
    try:
        bruto = json.loads(Path(args.elementos).expanduser().read_text(encoding="utf-8-sig"))
    except OSError as e:
        falhar(f"nao consegui ler {args.elementos}: {e}")
    except json.JSONDecodeError as e:
        falhar(f"JSON invalido em {args.elementos}: linha {e.lineno}, coluna {e.colno}: {e.msg}")
    blocos = bruto if isinstance(bruto, list) else [bruto]
    for b in blocos:
        if not isinstance(b, dict) or not isinstance(b.get("itens"), list):
            falhar("formato esperado: o objeto {url, total, itens} do snippet de elementos em runtime "
                   "(references/perfil-e-inventario.md), ou uma lista desses objetos")

    def executar(dados) -> tuple:
        itens = [i for i in dados["itens"] if isinstance(i, dict)]
        telas = [str(i.get("id")) for i in itens if tipo_do_item(i) == "tela" and str(i.get("id") or "")]
        elementos = [i for i in itens if tipo_do_item(i) == "elemento"]
        ids_elementos = {str(i.get("id")) for i in elementos}
        ids_elem_norm = {"elemento:" + barra_inicial(rota_do_elemento(x)) + ("#" + x.split("#", 1)[1] if "#" in x else "")
                         for x in ids_elementos}
        blob, slugs, testids = [], set(), set()
        for it in elementos:
            iid = str(it.get("id") or "")
            texto_it = " ".join(str(it.get(k) or "") for k in ("id", "titulo", "origem", "notas"))
            blob.append(normalizar_texto(texto_it))
            if "#" in iid:
                slugs.add(slug_simples(iid.split("#", 1)[1]))
            if it.get("titulo"):
                slugs.add(slug_simples(it.get("titulo")))
            testids.update(t.lower() for t in re.findall(r"data-testid\s*[=:]\s*['\"]?([\w.-]+)", texto_it))
        tudo = " ".join(blob)
        faltando, contagens, sem_tela = [], [], []
        for bi, b in enumerate(blocos):
            url = str(b.get("url") or "")
            concreta = rota_do_url(url)
            tela = tela_da_rota(url, telas)
            rota = id_tela_norm(tela)[len("tela:"):] if tela else concreta
            if not tela and concreta not in [x[0] for x in sem_tela]:
                sem_tela.append((concreta, url))
            ok = 0
            for k, el in enumerate(b["itens"]):
                if not isinstance(el, dict):
                    continue
                testid = str(el.get("testid") or "").strip()
                rotulo = rotulo_do_snippet(el)
                achou = False
                if testid:
                    achou = testid.lower() in testids or slug_simples(testid) in slugs \
                        or re.search(r"(?<![\w-])" + re.escape(testid.lower()) + r"(?![\w-])", tudo) is not None
                if not achou and rotulo:
                    achou = slug_simples(rotulo) in slugs
                sugestao_slug = slug_simples(testid or rotulo) or f"{el.get('tag') or 'el'}-sem-rotulo-{k + 1}"
                if not achou:
                    achou = any(f"elemento:{r}#{sugestao_slug}" in ids_elem_norm for r in {concreta, barra_inicial(rota)})
                pref = prefixo_de_linha(testid or sugestao_slug)
                if not achou and pref:
                    sl = slug_simples(pref)
                    achou = f"{sl}-id" in slugs or f"elemento:{barra_inicial(rota)}#{sl}-[id]" in ids_elem_norm
                if achou:
                    ok += 1
                    continue
                faltando.append({"bloco": bi, "url": url, "concreta": concreta, "rota": rota, "tela": tela, "el": el,
                                 "slug": sugestao_slug, "rotulo": rotulo, "testid": testid, "prefixo": pref})
            total = b.get("total")
            contagens.append((url_sem_valores(url) or "(sem url)", total if isinstance(total, int) else len(b["itens"]),
                              len(b["itens"]), ok))
        return faltando, contagens, sem_tela

    def planejar(faltando, ids_existentes) -> tuple:
        """Um item por controle: o mesmo controle visto em outro estado ou papel (outro bloco) nao vira item de novo;
        a acao repetida por linha (3+ testids ou slugs '<prefixo>-<n|uuid|hex>' num bloco) vira um item so,
        elemento:<rota>#<prefixo>-[id]. Sufixo -N so para outro controle com o mesmo slug no mesmo bloco, ou para id
        que ja existe no ledger com outro testid."""
        contagem_linha = defaultdict(int)
        for f in faltando:
            if f["prefixo"]:
                contagem_linha[(f["rota"], f["prefixo"], f["bloco"])] += 1
        linhas = {}
        for (rota, pref, _bi), n in contagem_linha.items():
            if n >= 3:
                linhas[(rota, pref)] = max(n, linhas.get((rota, pref), 0))
        ids = set(ids_existentes)
        criados, plano, repetidos = {}, [], 0
        for f in faltando:
            el = f["el"]
            sig = (str(el.get("tag") or "").lower(), str(el.get("role") or "").lower(), f["testid"].lower())
            chave_linha = (f["rota"], f["prefixo"]) if f["prefixo"] else None
            if chave_linha in linhas:
                base_id = f"elemento:{f['rota']}#{slug_simples(f['prefixo'])}-[id]"
                if base_id in criados or base_id in ids:
                    repetidos += 1
                    continue
                criados[base_id] = {"bloco": f["bloco"], "sigs": {sig}}
                ids.add(base_id)
                plano.append(dict(f, id=base_id, linha=linhas[chave_linha]))
                continue
            base_id = f"elemento:{f['rota']}#{f['slug']}"
            info = criados.get(base_id)
            if info is not None and not (info["bloco"] == f["bloco"] and sig not in info["sigs"]):
                info["sigs"].add(sig)
                repetidos += 1
                continue
            iid, n = base_id, 2
            while iid in ids:
                iid = f"{base_id}-{n}"
                n += 1
            ids.add(iid)
            criados.setdefault(base_id, {"bloco": f["bloco"], "sigs": set()})["sigs"].add(sig)
            plano.append(dict(f, id=iid, linha=0))
        return plano, repetidos

    def item_do_plano(f) -> dict:
        el = f["el"]
        te = tipo_elemento_do_snippet(dict(el, nome=f["rotulo"]))
        if f["linha"]:
            base_titulo = f["rotulo"] or f["prefixo"]
            titulo = f"{base_titulo} (acao da linha)"
            notas = f"acao da linha ({f['linha']} linhas vistas); criado pelo reconciliar: falta caso"
        else:
            titulo = f["rotulo"] or f["testid"] or f["slug"]
            if eh_campo_do_snippet(el) and f["testid"] and f["rotulo"] and f["rotulo"] != f["testid"]:
                titulo = f"{f['rotulo']} [{f['testid']}]"
            flags = [x for x in ("desabilitado", "obrigatorio", "coberto", "foraDaTela") if el.get(x)]
            notas = "criado pelo reconciliar: falta caso" + (f"; {', '.join(flags)}" if flags else "")
        item = {"id": f["id"], "tipo": "elemento", "titulo": _mascara.mascarar(titulo)[0],
                "origem": _mascara.mascarar(f"runtime: {url_sem_valores(f['url'])} (cobertura.py reconciliar)")[0],
                "notas": notas}
        if te:
            item["tipo_elemento"] = te
        return item

    criados_ids, telas_criadas, ligados = [], [], 0
    if args.criar:
        with Trava(p):
            dados = carregar(p)
            faltando, contagens, sem_tela = executar(dados)
            ids = {str(i.get("id")) for i in dados["itens"] if isinstance(i, dict)}
            for concreta, url in sem_tela:
                tid = f"tela:{concreta}"
                if tid in ids or id_tela_norm(tid) in {id_tela_norm(x) for x in ids if x.startswith("tela:")}:
                    continue
                dados["itens"].append({"id": tid, "tipo": "tela", "titulo": _mascara.mascarar(concreta)[0],
                                       "origem": _mascara.mascarar(f"runtime: {url_sem_valores(url)} "
                                                                   f"(cobertura.py reconciliar)")[0],
                                       "notas": "criada pelo reconciliar: falta caso (EL-EST, DM-NAV)"})
                ids.add(tid)
                telas_criadas.append(tid)
            plano, repetidos = planejar(faltando, ids)
            for f in plano:
                dados["itens"].append(item_do_plano(f))
                criados_ids.append(f["id"])
            telas = [str(i.get("id")) for i in dados["itens"] if isinstance(i, dict) and tipo_do_item(i) == "tela"]
            for it in dados["itens"]:
                if not isinstance(it, dict) or tipo_do_item(it) != "elemento" or not vazio(it.get("pai")):
                    continue
                tela = tela_da_rota(rota_do_elemento(it.get("id")), telas)
                if tela:
                    it["pai"] = tela
                    ligados += 1
            salvar(p, dados)
    else:
        dados = carregar(p)
        faltando, contagens, sem_tela = executar(dados)
        plano, repetidos = planejar(faltando, {str(i.get("id")) for i in dados["itens"] if isinstance(i, dict)})
    for url, total, vistos, ok in contagens:
        extra = f" (o snippet disse total={total})" if total != vistos else ""
        print(f"{vis(url)}: {vistos} elemento(s) visto(s){extra}, {ok} registrado(s), {vistos - ok} fora do ledger")
    for concreta, _url in sem_tela:
        if not args.criar:
            print(f"AVISO  tela:{vis(concreta)} nao existe no ledger (o --criar cria e liga os elementos; se a tela ja "
                  f"esta com outro id, use add-item --id \"<elemento>\" --pai \"<tela>\" --atualizar)")
    for f in plano:
        te = tipo_elemento_do_snippet(dict(f["el"], nome=f["rotulo"]))
        extra_linha = f"  acao da linha ({f['linha']} linhas)" if f["linha"] else ""
        print(f"FALTA  {vis(f['id'])}  testid={vis(f['testid']) or '-'}  nome=\"{resumir(vis(f['rotulo']), 50)}\"  "
              f"tag={f['el'].get('tag') or '-'}" + (f"  tipo_elemento={te}" if te else "") + extra_linha)
    if repetidos:
        print(f"{repetidos} ocorrencia(s) do mesmo controle em outro estado, papel ou linha: nao viram item novo")
    if telas_criadas:
        print(f"{len(telas_criadas)} tela(s) criada(s) sem caso: {', '.join(vis(t) for t in telas_criadas[:10])}")
    if criados_ids:
        print(f"{len(criados_ids)} item(ns) criado(s) sem caso: o gate reprova ate cada um ter caso (add-caso)")
    if ligados:
        print(f"{ligados} elemento(s) sem pai ligado(s) a tela da rota (pai = tela:<rota>)")
    if not faltando:
        print("ok: as contagens batem (todo elemento visto esta no ledger)")
    return EXIT_FALHA if faltando else EXIT_OK


def cmd_listar(args) -> int:
    p = caminho_ledger(args.pasta)
    dados = carregar(p)
    if args.itens_sem_caso:
        com_caso = {c.get("item_id") for c in dados["casos"] if isinstance(c, dict)}
        faltam = [i for i in dados["itens"] if isinstance(i, dict) and i.get("id") not in com_caso]
        for i in faltam:
            print(f"{vis(i.get('id'))}\t{resumir(vis(i.get('titulo')), 80)}")
        print(f"{len(faltam)} item(ns) sem caso", file=sys.stderr)
        return EXIT_OK
    status = {normalizar(s) for s in (args.status or [])}
    tecnicas = {normalizar(t) for t in (args.tecnica or [])}
    linhas = []
    for c in dados["casos"]:
        if not isinstance(c, dict):
            continue
        if status and c.get("status") not in status:
            continue
        if tecnicas and c.get("tecnica") not in tecnicas:
            continue
        if args.item and not str(c.get("item_id") or "").startswith(args.item):
            continue
        linhas.append(c)
    for c in linhas:
        extra = c.get("defeito_id") or c.get("justificativa") or c.get("titulo") or c.get("resultado_esperado")
        print(f"{vis(c.get('id'))}\t{vis(c.get('status'))}\t{vis(c.get('tecnica'))}\t{vis(c.get('item_id'))}\t"
              f"{resumir(vis(extra), 80)}")
    print(f"{len(linhas)} caso(s)", file=sys.stderr)
    return EXIT_OK


EPILOGO = """\
convencoes:
  ledger      <pasta-rodada>/cobertura.json (ou passe direto o caminho de um .json)
  itens       superficie enumerada; id "<tipo>:<caminho>", ex. "tela:/clientes",
              "elemento:/clientes#botao-salvar", "api:POST /api/v1/cliente", "regra:cliente.cnpj-obrigatorio",
              "estatico:typecheck", "dimensao:DM-TEN" (secao ou modulo inteiro nao aplicavel); elemento pode
              levar --tipo-elemento upload|exportar|data|select|select-busca|link-externo (o reconciliar --criar
              preenche pelo snippet) e o gate exige o caso da subsecao do catalogo (EL-UPL, EL-EXP, EL-DAT...)
  casos       C-0001...; status: pendente|passou|falhou|bloqueado|nao-aplicavel|retratado|nao-validado
              passou/falhou exigem evidencia VALIDA: arquivo com mais de 0 byte em evidencias/, rede/,
              notas/ ou relatorio/ da rodada (texto livre, URL, pasta e o proprio ledger nao contam; o que foi
              visto vai em --obtido); falhou exige defeito_id;
              bloqueado/nao-aplicavel/nao-validado/retratado exigem justificativa concreta: minimo 20 caracteres,
              nada generico ("sem tempo", "n/a", "ok", "depois"...); bloqueado e nao-validado dizem o que falta
              ou o que destrava ("falta ...", "destrava: ...", "oraculo: ...", o papel, a autorizacao,
              "sem ambiente", "gate não executável: ..."); dimensao: acerto|erro|limite|bloqueio|risco
              item dimensao: com nao-aplicavel: 3 ou mais com a mesma justificativa = erro (na-em-lote);
              DM-TEN, DM-AUT, DM-SEC, DM-SES e MA-6 em projeto com UI ou API so com arquivo:linha na
              justificativa ou evidencia em disco (na-p0-sem-prova); dimensao:QC so com
              "sem código-fonte acessível: ..."
  defeitos    D-001...; severidade critico|alto|medio|baixo; status aberto|corrigido|retestado-ok|nao-corrigido
              defeito/melhoria/decisao-de-produto exigem arquivo ANTES em disco (ou "sem-antes: <motivo>" na
              justificativa); corrigido/retestado-ok exigem arquivo DEPOIS ou RETESTE valido em disco
              (add-defeito/set recusam sem ele, saida 2, nada gravado); retestado-ok exige caso
              --tecnica regressao --defeito D que passou, com evidencia, e o mais recente nao pode ter falhado;
              corrigido sem caso de reteste so com "falta ...; destrava: ..." (add-defeito/set recusam, saida 2);
              --repro grava como reproduzir por outro caminho; evidencias em lista (formato antigo) sao
              classificadas pelo nome (-ANTES/-REPRO, -CORRIGIDO/-DEPOIS, -RETESTE);
              retratado nasce nao-corrigido com --justificativa "retratado: <o que enganou>"
  sujeira     S-001...; tudo que o teste criou/alterou; estado_final: ficou|revertido|apagado|
              desconhecido-pedir-ao-usuario (texto livre depois de ":"); "ficou" exige como_desfazer
  segredo     nenhum campo aceita token, senha ou chave: add-*/set recusam (saida 2), merge troca por [REMOVIDO];
              listar, gate, validar e relatorio mascaram ANTES de cortar o texto; nome de arquivo de evidencia
              com segredo e erro (segredo-no-nome-da-evidencia)
  datas       atualizado_em, --inicio, --fim e --ambiente-confirmado em ISO 8601 (date -Iseconds; PowerShell:
              Get-Date -Format o) ou "agora"; o merge recusa data fora do formato (saida 2)

modos da rodada (init/rodada --modo; padrao completo):
  completo    QA completo, fases 0-11: o gate final abaixo inteiro
  revisao     auditoria executada sem alterar codigo (PR ou branch): o mesmo gate do completo
  reteste     "dei pull, testa": rodada NOVA, sempre com
              cobertura.py init <rodada> --modo reteste --reteste-de <rodada-original> [--defeito D-NNN | --todos]
              (traz os defeitos nao retratados, os casos e itens deles e as evidencias; sem --defeito nem --todos,
              deixa de fora o ja retestado-ok e a decisao-de-produto nao-corrigido; rodada.reteste_de.git e o
              commit de onde se mede o entorno). Fases 0, 1, 5, 7 (veredito; defeito claro novo achado no
              entorno e corrigido com ANTES/DEPOIS), 9, 10.1-10.3, o caso [EN-01] da 10.5 e, se houver caso
              "oraculo:", o --oraculo da 10.6, e 11. O gate nao cobra notas 02-estudo, 02-inventario, 03-plano
              e 08-critico, nem critico, secoes, cinco dimensoes, minimos por tipo, contagens e mapa; cobra
              rodada.reteste_de, ao menos um defeito importado, notas 01-perfil-e-ambiente e 07-correcao (com
              RESOLVEU ou PRECISA DE AJUSTE junto de cada D-NNN importado), rodada.git e, para cada defeito
              importado, um caso --tecnica regressao --defeito D-NNN desta rodada concluido com evidencia -RETESTE
              em disco (-CORRIGIDO ou -DEPOIS tambem servem no defeito que esta rodada corrigiu); item estatico:
              e git status inicial so para defeito com corrigido_em_rodada desta rodada (gravado pelo
              add-defeito/set; no importado, so quando esta rodada gravou --correcao nele). Trocar para ou de
              reteste com casos no ledger sai 2

gate final (gate sem --so-cobertura, e fechar) exige tambem, no modo completo e revisao:
  - acoes (elemento:, api:, comando:, funcao:, job:, consumidor:, ipc:, menu:, ferramenta:) dentro do escopo
    com as cinco dimensoes (nao-aplicavel justificado conta)
  - critico de completude seco: as 2 ultimas passadas com zero item e caso novos
  - tipo(s) de projeto validos (--tipo-projeto repetivel ou com virgula: full-stack,llm; llm exige o tipo de
    base, monorepo exige o tipo dos pacotes) e toda secao obrigatoria do catalogo (tabela 1.4, a uniao dos
    tipos; 7.9, 7.10, 7.11 e 7.12 viram obrigatorias quando o ledger tem item que as dispara) e todo modulo
    MA-1..MA-4, MA-6 e MO-7..MO-10 com caso ou item dimensao: com caso (veja: secoes; MA-5 nasce na fase
    10.5 e quem cobra e o fechar). Rodada de tela, fluxo, funcao, comando ou endpoint (--escopo): secao fora
    dela vai em item dimensao: --escopo fora com "fora do escopo da rodada (<escopo>): <motivo>", que nao conta
    como lote (os P0 seguem pedindo arquivo:linha)
  - minimo por tipo de item (catalogo §1.3): tela com elemento: filho (ou 'tela sem controles: ...'), casos
    [EL-EST] e [DM-NAV], e i18n:/tema:/viewport: para cada --locales/--temas/--viewports; papel, estado e
    efeito com o caso de bloqueio; flag ligada e desligada
  - uma contagem do inventario por tipo declarado (rodada --contagem), sem N no ledger < N no codigo sem
    justificativa
  - com correcao de codigo: para CADA defeito corrigido, caso de item estatico: ligado a ele (--defeito D-NNN,
    repetivel: um caso cobre varios) com status passou e evidencia de TEXTO com o numero antes e depois
    ("antes: 308 ... depois: 308"), ou bloqueado "gate não executável: ...", e notas/00-git-status-inicial.txt
    (ou 00-snapshot-inicial.txt sem git); corrigido sem reteste leva como DEPOIS o diff da correcao
    (rede/NN-D-NNN-CORRIGIDO.diff)
  - biblioteca: caso [PJ-LIB-07] (pacote empacotado instalado num consumidor) passou, ou bloqueado com
    "destrava: ..." quando empacotar nao funciona
  - modo PR (rodada.escopo_diff com base e modo diff, gravado pelo --parcial): o gate roda escopo_diff.py
    --base <base> --incluir-working --ledger <rodada> --falhar-se-descoberto e reprova se sair diferente de 0
    (raio nao calculado so passa citado na secao "Raio completado à mão" da nota 09)
  - rodada com ambiente, inicio, fim e perfil existente; ambiente_confirmado quando houve escrita (sujeira);
    notas 01-perfil-e-ambiente, 02-estudo (com "Entendimento"), 02-inventario, 03-plano, 08-critico (e
    07-correcao quando houve correcao); .qa/MAPA.md (ou o do PERFIL) atualizado na rodada e um item modulo:
    com caso
fechar exige ainda os entregaveis da fase 10: relatorio/provas.pdf (com defeito ou melhoria),
  relatorio/relatorio.html sem "{{" (ou .pdf), relatorio/painel.html mais novo que o cobertura.json,
  relatorio/oraculo*.md citando cada caso "oraculo: ...", um caso [MA-5-*] ou dimensao:MA-5 nao-aplicavel,
  replay/passos.yaml com um fluxo quando algum caso passou em tela:, elemento:, fluxo:, api:, comando:,
  funcao:, job:, consumidor:, ipc:, cena: ou prompt: (sem fluxo reproduzivel: nao-aplicavel no item
  estatico:replay com o motivo) e um caso [EN-NN]; no modo reteste, so provas.pdf, oraculo e EN.
  Por ultimo roda aprender.py validar (integridade da skill) e so fecha com ele saindo 0

codigos de saida: 0 ok | 1 validacao/gate reprovou (ou relatorio com segredo mascarado) | 2 uso, arquivo ou
                  esquema invalido, data fora do ISO, conflito de merge sem --estrategia, ou parcial com
                  justificativa fraca | 3 ledger travado ou em uso

fluxo tipico:
  cobertura.py init .qa/2026-09-30-clientes --alvo "Cadastro de clientes" --inicio agora --tipo-projeto full-stack
  cobertura.py add-item .qa/2026-09-30-clientes --id "tela:/clientes" --titulo "Listagem"
  cobertura.py add-caso .qa/2026-09-30-clientes --item "tela:/clientes" --tecnica crud --dimensao acerto \\
      --titulo "[EL-LST-01] Lista carrega com dado real" --esperado "lista carrega" --oraculo "spec"
  cobertura.py set .qa/2026-09-30-clientes C-0001 --status passou --evidencia evidencias/01-lista.png
  cobertura.py set .qa/2026-09-30-clientes C-0002 --oraculo-pergunta "Cliente inativo aparece no combo?" \\
      --opcao "some do combo => quem reativa vai ao cadastro" --opcao "aparece desabilitado => um clique a mais" \\
      --impacto alto --para "dono do produto"          (vira bloqueado com a pergunta no formato do oraculo)
  cobertura.py rodada .qa/2026-09-30-clientes --contagem "rota|router x menu|14|14"
  cobertura.py rodada .qa/2026-09-30-clientes --critica "passada=3;novos_itens=0;novos_casos=0;origem=checklist"
  cobertura.py gate .qa/2026-09-30-clientes --so-cobertura   (no meio da rodada)
  cobertura.py rodada .qa/2026-09-30-clientes --fim agora
  cobertura.py gate .qa/2026-09-30-clientes          (gate final: sai 1 enquanto houver pendencia)
  cobertura.py fechar .qa/2026-09-30-clientes        (ULTIMO comando: gate final + entregaveis + 10-aprender)
  reteste: cobertura.py init .qa/2026-10-01-reteste --alvo "Reteste D-003" --modo reteste --inicio agora \\
      --reteste-de .qa/2026-09-30-clientes --defeito D-003
  reconciliar sem UI (cli, biblioteca, jobs, api): cobertura.py reconciliar <rodada> diz "nao se aplica" e sai 0
  carga em lote: escreva um parcial .json com itens/casos e use merge.
"""


def montar_parser() -> argparse.ArgumentParser:
    ap = ParserPT(prog="cobertura.py",
                  description="Ledger de cobertura do QA: enumere tudo, teste tudo, nao deixe nada para tras.",
                  epilog=EPILOGO)
    sub = ap.add_subparsers(dest="comando", metavar="COMANDO", title="comandos", parser_class=ParserPT)
    sub.required = True
    tecnicas = tecnicas_validas()

    def opcoes_listas_rodada(p, com_critica: bool):
        p.add_argument("--tipo-projeto", dest="tipo_projeto", action="append", metavar="SLUG[,SLUG]",
                       help="tipo(s) da tabela 1.4 do catalogo, repetivel ou separado por virgula (front-web, "
                            "full-stack, api, cli, biblioteca, mobile, jobs, llm, desktop, jogo, site-estatico, "
                            "monorepo); grava rodada.tipos_projeto e rodada.tipo_projeto = o primeiro; llm exige o "
                            "tipo de base (ex.: full-stack,llm) e monorepo o tipo dos pacotes")
        p.add_argument("--modo", choices=MODOS_RODADA,
                       help="completo (padrao), reteste ('dei pull': o gate cobra o reteste de cada defeito, nao as "
                            "secoes; nasce com init --modo reteste --reteste-de <rodada-original>) ou revisao (PR, "
                            "auditoria: gate do completo); grava rodada.modo. No rodada, trocar para ou de reteste so "
                            "em rodada sem casos (o reteste e sempre rodada nova); entre completo e revisao, livre")
        p.add_argument("--contagem", action="append", metavar='"MODO|FONTE|N_CODIGO|N_LEDGER[|JUSTIFICATIVA]"',
                       help="contagem do inventario (repetivel; rodada.contagens). MODO = slug do tipo de projeto ou "
                            "tipo de item contado (rota, tela, api, comando, funcao, job, ipc, prompt, cena...); o gate "
                            "final exige uma por tipo declarado e justificativa quando N_LEDGER < N_CODIGO. Regravar o "
                            "mesmo modo e fonte substitui; a anterior fica em contagens_historico (o gate so le a "
                            "ultima de cada modo e fonte)")
        p.add_argument("--ambiente-confirmado", dest="ambiente_confirmado", metavar='"O QUE MEDIU|agora|ISO"',
                       help="grava rodada.ambiente_confirmado {por, em}; o gate final exige quando houve escrita")
        p.add_argument("--locales", action="append", metavar="pt-BR,en-US",
                       help="locales suportados; o gate final exige i18n:<locale>:<rota> com caso em cada tela")
        p.add_argument("--temas", action="append", metavar="claro,escuro",
                       help="temas; o gate final exige tema:<tema>:<rota> com caso em cada tela")
        p.add_argument("--viewports", action="append", metavar="390,1440",
                       help="larguras em px; o gate final exige viewport:<largura>:<rota> com caso em cada tela")
        p.add_argument("--baseline", action="append", metavar='"GATE|COMANDO|RESULTADO|COMPOSICAO"',
                       help="acrescenta a rodada.baselines (repetivel), medido ANTES de mexer no codigo")
        p.add_argument("--git", action="append", metavar='"REPO|BRANCH|COMMIT"',
                       help="acrescenta a rodada.git o codigo testado de cada repositorio (repetivel)")
        if com_critica:
            p.add_argument("--critica", action="append",
                           metavar='"passada=N;novos_itens=N;novos_casos=N;origem=<texto>"',
                           help="registra uma passada do critico de completude (repetivel)")

    p = sub.add_parser("init", help="cria a pasta da rodada e um cobertura.json vazio")
    p.add_argument("pasta", help="pasta da rodada, ex. .qa/2026-09-30-clientes")
    p.add_argument("--alvo", required=True, help="o que esta sendo testado")
    p.add_argument("--escopo", help='limites do teste (tela | fluxo | modulo | projeto, ou o texto do que entra e sai)')
    p.add_argument("--ambiente", help="ex. localhost -> API dev; nunca producao para escrita")
    p.add_argument("--inicio", help='data/hora de inicio em ISO 8601 (date -Iseconds) ou "agora" (relogio do '
                                    'sistema); omitido = vazio')
    p.add_argument("--autorizacao", action="append", help="autorizacao dada pelo usuario (repetivel)")
    p.add_argument("--perfil", help="caminho do PERFIL.md usado")
    opcoes_listas_rodada(p, com_critica=False)
    p.add_argument("--forcar", action="store_true",
                   help="recria mesmo se ja existir (o atual vai para cobertura.json.forcar-<AAAAMMDD-HHMMSS>.bak, "
                        "que nenhum comando sobrescreve)")
    p.add_argument("--sem-exclude", action="store_true", help="nao adiciona .qa/ ao .git/info/exclude")
    p.add_argument("--reteste-de", dest="reteste_de", metavar="PASTA_DA_RODADA_ORIGINAL",
                   help="so com --modo reteste: traz da rodada original os defeitos nao retratados (mesmo id, "
                        "importado_de), os casos ligados a eles, os itens desses casos e os arquivos de evidencia que "
                        "eles citam (mesmo caminho relativo); grava rodada.reteste_de {pasta, git}; nao traz git, "
                        "sujeira, criticas nem contagens. Sem --defeito e sem --todos, deixa de fora (e lista) o "
                        "defeito ja retestado-ok na origem e a decisao-de-produto nao-corrigido: o gate do reteste "
                        "cobra caso de regressao e veredito de cada importado")
    p.add_argument("--defeito", action="append", metavar="D-NNN",
                   help="so com --reteste-de: importa so estes defeitos, os do pull (repetivel ou com virgula); "
                        "importa mesmo retestado-ok ou decisao-de-produto, se for o pedido")
    p.add_argument("--todos", action="store_true",
                   help="so com --reteste-de e sem --defeito: importa todo defeito nao retratado, inclusive os ja "
                        "retestado-ok e as decisoes de produto nao-corrigido (comportamento antigo)")
    p.set_defaults(func=cmd_init)

    p = sub.add_parser("rodada", help="atualiza os dados da rodada (alvo, fim, tipo, critica, baselines...)")
    p.add_argument("pasta")
    for nome in ("alvo", "escopo", "ambiente", "perfil"):
        p.add_argument(f"--{nome}")
    p.add_argument("--inicio", help='ISO 8601 (date -Iseconds; PowerShell: Get-Date -Format o) ou "agora"')
    p.add_argument("--fim", help='ISO 8601 (date -Iseconds; PowerShell: Get-Date -Format o) ou "agora"')
    p.add_argument("--autorizacao", action="append", help="acrescenta autorizacao (repetivel)")
    opcoes_listas_rodada(p, com_critica=True)
    p.set_defaults(func=cmd_rodada)

    p = sub.add_parser("add-item", help="adiciona (ou atualiza) um item da superficie")
    p.add_argument("pasta")
    p.add_argument("--id", required=True, help='"<tipo>:<caminho>", ex. "tela:/clientes"')
    p.add_argument("--titulo")
    p.add_argument("--tipo", help="padrao: o prefixo do id")
    p.add_argument("--origem", help="onde foi encontrado (arquivo:linha, menu, spec, rota)")
    p.add_argument("--pai", help="id do item pai, ex. a tela de um elemento")
    p.add_argument("--notas")
    p.add_argument("--escopo", choices=ESCOPOS_ITEM, help="dentro (padrao) ou fora; fora tambem precisa de caso "
                                                          "nao-aplicavel justificado")
    p.add_argument("--tipo-elemento", dest="tipo_elemento",
                   help="|".join(TIPOS_ELEMENTO) + ": o gate final exige o caso da subsecao do catalogo (" +
                        ", ".join(f"{k} -> {v}" for k, v in TIPOS_ELEMENTO.items()) + ")")
    p.add_argument("--atualizar", action="store_true", help="permite alterar item existente")
    p.set_defaults(func=cmd_add_item)

    p = sub.add_parser("add-caso", help="adiciona um caso de teste a um item (imprime o id gerado)")
    p.add_argument("pasta")
    p.add_argument("--item", required=True, help="id do item testado")
    p.add_argument("--tecnica", required=True, help="|".join(tecnicas) + " (tabela 1.5 do catalogo)")
    p.add_argument("--esperado", required=True, help="resultado esperado (o oraculo)")
    p.add_argument("--oraculo", help="de onde vem o esperado: codigo, spec, regra do usuario, comportamento anterior")
    p.add_argument("--dimensao", help="|".join(DIMENSOES) + " (lista separada por virgula so em nao-aplicavel)")
    p.add_argument("--papel", help="papel/usuario que executou (ex. vendedor, somente-leitura)")
    p.add_argument("--titulo", help="comece pelo codigo do catalogo: [EL-TXT-04] ...")
    p.add_argument("--passos")
    p.add_argument("--id", help="padrao: proximo C-NNNN")
    p.add_argument("--status", help="padrao: pendente")
    p.add_argument("--evidencia", action="append",
                   help="caminho de arquivo relativo a pasta da rodada (repetivel); texto livre e URL sao recusados")
    p.add_argument("--justificativa")
    p.add_argument("--defeito", action="append", metavar="D-NNN",
                   help="id do defeito (repetivel: o caso estatico: de typecheck/lint/testes pode cobrir varias "
                        "correcoes; grava defeito_id = o primeiro e defeito_ids = todos)")
    p.add_argument("--criar-item", action="store_true", help="cria o item se ele nao existir")
    p.add_argument("--forcar", action="store_true", help="grava mesmo violando as regras de status (proibido no QA)")
    p.set_defaults(func=cmd_add_caso)

    p = sub.add_parser("add-defeito", help="registra um defeito (imprime o id gerado)")
    p.add_argument("pasta")
    p.add_argument("--titulo", required=True)
    p.add_argument("--severidade", required=True, help="|".join(SEVERIDADES))
    p.add_argument("--tipo", help="|".join(TIPOS_DEFEITO) + " (padrao: defeito; retratado nasce nao-corrigido)")
    p.add_argument("--onde", help="arquivo:linha, tela ou endpoint")
    p.add_argument("--causa")
    p.add_argument("--correcao")
    p.add_argument("--status", help="|".join(STATUS_DEFEITO) + " (padrao: aberto)")
    p.add_argument("--justificativa", help="obrigatoria para nao-corrigido e retratado; 'sem-antes: <motivo>' dispensa "
                                           "o print ANTES")
    p.add_argument("--antes", action="append", help="arquivo de evidencia do problema (repetivel)")
    p.add_argument("--depois", action="append", help="arquivo de evidencia da correcao (repetivel)")
    p.add_argument("--reteste", action="append", help="arquivo de evidencia do reteste (repetivel)")
    p.add_argument("--caso", action="append", help="liga o defeito a este caso (repetivel)")
    p.add_argument("--repro", help="como reproduzir por outro caminho (vai para defeito.reproducao e para a issue)")
    p.add_argument("--id", help="padrao: proximo D-NNN")
    p.set_defaults(func=cmd_add_defeito)

    p = sub.add_parser("add-sujeira", help="registra algo que o teste criou/alterou em um ambiente")
    p.add_argument("pasta")
    p.add_argument("--o-que", required=True, dest="o_que", help="o que foi criado/alterado (com ids)")
    p.add_argument("--ambiente")
    p.add_argument("--estado-final", dest="estado_final",
                   help="|".join(ESTADOS_SUJEIRA) + ' (texto livre depois de ":", ex. "ficou: cliente de teste")')
    p.add_argument("--como-desfazer", dest="como_desfazer", help="obrigatorio quando o estado e ficou")
    p.add_argument("--caso", help="caso que gerou a sujeira")
    p.add_argument("--id", help="padrao: proximo S-NNN")
    p.set_defaults(func=cmd_add_sujeira)

    p = sub.add_parser("set", help="atualiza um caso, defeito, sujeira ou item pelo id")
    p.add_argument("pasta")
    p.add_argument("id", help="C-NNNN, D-NNN, S-NNN ou id de item")
    p.add_argument("--status")
    p.add_argument("--evidencia", action="append",
                   help="acrescenta evidencia (repetivel). Em defeito, -ANTES/-REPRO no nome vai para antes, -RETESTE "
                        "para reteste e o resto para depois (recusado em defeito aberto sem --forcar); prefira "
                        "--antes/--depois/--reteste")
    p.add_argument("--limpar-evidencias", action="store_true", help="zera as evidencias antes de acrescentar")
    p.add_argument("--justificativa")
    p.add_argument("--oraculo-pergunta", dest="oraculo_pergunta",
                   help="monta a justificativa 'oraculo: <pergunta> | A) ... | B) ...' (caso: vira bloqueado se --status "
                        "nao vier; defeito decisao-de-produto: so a justificativa)")
    p.add_argument("--opcao", action="append", metavar='"<OPCAO> => <CUSTO>"',
                   help="opcao fechada da pergunta do oraculo, com o custo (repetivel; minimo duas)")
    p.add_argument("--impacto", help="alto|medio|baixo (pergunta do oraculo)")
    p.add_argument("--para", help="quem decide (pergunta do oraculo)")
    p.add_argument("--defeito", action="append", metavar="D-NNN",
                   help='liga o caso a um defeito (repetivel: troca a lista inteira; "" desliga)')
    p.add_argument("--obtido", help="resultado obtido")
    p.add_argument("--esperado")
    p.add_argument("--oraculo")
    p.add_argument("--tecnica")
    p.add_argument("--dimensao", help="|".join(DIMENSOES))
    p.add_argument("--papel")
    p.add_argument("--titulo")
    p.add_argument("--passos", help="so para casos: a entrada exata (vai para a issue e para o replay)")
    p.add_argument("--repro", help="so para defeitos: como reproduzir por outro caminho (defeito.reproducao)")
    p.add_argument("--notas")
    p.add_argument("--escopo", choices=ESCOPOS_ITEM, help="so para itens")
    p.add_argument("--obs", help="acrescenta uma observacao datada")
    p.add_argument("--severidade")
    p.add_argument("--tipo")
    p.add_argument("--onde")
    p.add_argument("--causa")
    p.add_argument("--correcao")
    p.add_argument("--antes", action="append")
    p.add_argument("--depois", action="append")
    p.add_argument("--reteste", action="append")
    p.add_argument("--estado-final", dest="estado_final")
    p.add_argument("--ambiente")
    p.add_argument("--o-que", dest="o_que")
    p.add_argument("--como-desfazer", dest="como_desfazer")
    p.add_argument("--forcar", action="store_true", help="grava mesmo violando as regras de status (proibido no QA)")
    p.set_defaults(func=cmd_set)

    p = sub.add_parser("merge", help="funde ledgers parciais (de varios agentes) no ledger da rodada; campo diferente "
                                     "fica com o do ledger (resumo no fim), salvo: caso com o mesmo status "
                                     "nao-aplicavel/bloqueado/nao-validado e atualizado_em maior leva a justificativa "
                                     "nova; item com \"atualizar\": true troca titulo, origem, escopo e pai; "
                                     "rodada.contagens segue a regra do --contagem (mesmo modo e fonte substitui)")
    p.add_argument("pasta", help="pasta da rodada (destino)")
    p.add_argument("parciais", nargs="+", help="arquivos .json ou pastas com cobertura.json")
    p.add_argument("--estrategia", choices=["pior", "recente"], default=None,
                   help='conflito de status. Sem esta opcao: "pendente" nunca sobrescreve status executado; o status '
                        "mais novo vence quando traz evidencia em disco e atualizado_em maior; qualquer outro "
                        'conflito para o merge (saida 2, nada gravado). "pior": falhou > bloqueado > nao-validado > '
                        'retratado > nao-aplicavel > passou. "recente": maior atualizado_em. Caso de mesmo id e mesmo '
                        "item com titulo, tecnica ou esperado diferentes e outro teste: vira caso novo (renumerado)")
    p.set_defaults(func=cmd_merge)

    p = sub.add_parser("validar", help="checa esquema e regras (sai 1 se houver erro)")
    p.add_argument("pasta")
    p.set_defaults(func=cmd_validar)

    p = sub.add_parser("relatorio", help="numeros por status, tecnica, tipo; pendencias; defeitos; sujeira")
    p.add_argument("pasta")
    g = p.add_mutually_exclusive_group()
    g.add_argument("--md", action="store_true", help="Markdown (padrao)")
    g.add_argument("--html", action="store_true", help="HTML autocontido")
    g.add_argument("--json", action="store_true", help="metricas em JSON")
    p.add_argument("--saida", help="arquivo de saida (padrao: tela); segredo vira [REMOVIDO] e a saida e 1")
    p.add_argument("--modelo", metavar="TEMPLATE_HTML",
                   help="preenche templates/relatorio.html a partir do ledger (resumo, numeros, cobertura, critico, "
                        "secoes, linhas e blocos de defeito com figura ou prova textual, sujeira, nao validado), "
                        "mascara segredos e deixa [PREENCHA] so no texto que exige pessoa; exige --saida")
    p.set_defaults(func=cmd_relatorio)

    p = sub.add_parser("gate", help="so passa com zero pendente, zero item sem caso e tudo provado (sai 1 se nao)")
    p.add_argument("pasta")
    p.add_argument("--so-cobertura", action="store_true",
                   help="so cobertura e prova (meio da rodada): ignora defeitos, sujeira, dimensoes, critico, secoes, "
                        "baseline e registro da rodada")
    p.add_argument("--limite", type=int, default=30, help="quantos pendentes listar (padrao 30)")
    p.set_defaults(func=cmd_gate)

    p = sub.add_parser("fechar", help="ULTIMO comando da rodada: gate final + fase 11 (notas/10-aprender.md)")
    p.add_argument("pasta")
    p.add_argument("--limite", type=int, default=30, help="quantos pendentes listar (padrao 30)")
    p.set_defaults(func=cmd_fechar)

    p = sub.add_parser("secoes", help="secoes obrigatorias do catalogo (tabela 1.4, uniao dos tipos) e modulos MA/MO "
                                      "sem caso; mostra o modo e os tipos (sai 1)")
    p.add_argument("pasta")
    p.add_argument("--tipo-projeto", dest="tipo_projeto", action="append", metavar="SLUG[,SLUG]",
                   help="padrao: rodada.tipos_projeto (ou rodada.tipo_projeto); repetivel ou com virgula")
    p.set_defaults(func=cmd_secoes)

    p = sub.add_parser("reconciliar", help="elementos vistos em runtime x itens elemento: do ledger (sai 1 se faltar)")
    p.add_argument("pasta")
    p.add_argument("--elementos",
                   help="JSON {url,total,itens} do snippet de elementos em runtime (ou uma lista desses); obrigatorio "
                        "com UI (front-web, full-stack, mobile, desktop, site-estatico). Sem UI e sem esta opcao: "
                        "'reconciliar: nao se aplica' e saida 0 (anote na nota 02-inventario)")
    p.add_argument("--criar", action="store_true", help="acrescenta os elementos faltantes como itens sem caso")
    p.set_defaults(func=cmd_reconciliar)

    p = sub.add_parser("listar", help="lista casos filtrando por status, tecnica ou prefixo de item")
    p.add_argument("pasta")
    p.add_argument("--status", action="append", help="repetivel")
    p.add_argument("--tecnica", action="append", help="repetivel")
    p.add_argument("--item", help="prefixo do item_id, ex. tela:/clientes")
    p.add_argument("--itens-sem-caso", action="store_true", help="lista os itens que ainda nao tem caso")
    p.set_defaults(func=cmd_listar)
    return ap


def main(argv=None) -> int:
    configurar_saida()
    args = montar_parser().parse_args(argv)
    try:
        return args.func(args)
    except SystemExit:
        raise
    except KeyboardInterrupt:
        print("erro: interrompido", file=sys.stderr)
        return EXIT_USO
    except Exception as e:
        print(f"erro: {type(e).__name__}: {e}", file=sys.stderr)
        return EXIT_USO


if __name__ == "__main__":
    sys.exit(main())

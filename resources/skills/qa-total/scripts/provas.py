#!/usr/bin/env python3
"""provas.py - PDF de provas ANTES/DEPOIS de toda correcao (skill qa-total).

Monta o documento que o time recebe: capa com o nome da branch, cada item em 4 partes
(ANTES - POR QUE - DEPOIS - STATUS), par de prints empilhado (ANTES em vermelho em cima, DEPOIS em
verde embaixo, faixa com o rotulo, moldura e caixas numeradas no ponto exato), provas textuais
(payload, banco, log), rodape com o nome em toda pagina e "N / M", PR.md e instrucoes de aplicar.

Entrada: um provas.json (spec) ou direto o cobertura.json da rodada (defeitos com evidencias
antes/depois/reteste). Saida: HTML de impressao A4 + PDF pelo Chrome/Edge/Chromium headless.

Subcomandos: gerar | indice | conferir | validar | exemplo. Rode cada um com --help.

Python 3.9+, biblioteca padrao. Opcionais: Pillow (compoe e circula os prints; sem ele as caixas
viram sobreposicao em HTML), PyMuPDF (renderiza paginas para conferir e carimba o rodape quando o
navegador nao imprime as margens da pagina). Windows, macOS e Linux.
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

AQUI = Path(__file__).resolve().parent
if str(AQUI) not in sys.path:
    sys.path.insert(0, str(AQUI))
import _mascara


def configurar_saida() -> None:
    for fluxo in (sys.stdout, sys.stderr):
        try:
            if fluxo.isatty() or os.environ.get("PYTHONIOENCODING"):
                fluxo.reconfigure(errors="replace")
            else:
                fluxo.reconfigure(encoding="utf-8", errors="replace")
        except (AttributeError, ValueError):
            pass

try:
    from PIL import Image, ImageDraw, ImageFont
    TEM_PIL = True
except ImportError:
    Image = ImageDraw = ImageFont = None
    TEM_PIL = False

EXIT_OK, EXIT_CONFERENCIA, EXIT_USO, EXIT_SEM_NAVEGADOR, EXIT_FALHA_PDF, EXIT_DEPENDENCIA = 0, 1, 2, 3, 4, 5

CORES = {
    "vermelho": (225, 29, 72),
    "verde": (5, 150, 105),
    "amarelo": (217, 119, 6),
    "azul": (37, 99, 235),
    "cinza": (92, 107, 127),
}
SINONIMOS_COR = {"red": "vermelho", "green": "verde", "yellow": "amarelo", "blue": "azul",
                 "gray": "cinza", "grey": "cinza", "antes": "vermelho", "depois": "verde"}

STATUS = {
    "corrigido": ("CORRIGIDO", "ok"),
    "retestado-ok": ("CORRIGIDO E RETESTADO", "ok"),
    "resolveu": ("RESOLVEU", "ok"),
    "precisa-de-ajuste": ("PRECISA DE AJUSTE", "ruim"),
    "aberto": ("ABERTO", "ruim"),
    "nao-corrigido": ("NÃO CORRIGIDO", "aviso"),
    "bloqueio": ("NÃO CORRIGIDO — bloqueia o merge", "ruim"),
    "decisao-de-produto": ("DECISÃO DE PRODUTO", "info"),
    "retratado": ("RETRATADO", "neutro"),
}
SINONIMOS_STATUS = {
    "corrigida": "corrigido", "retestado": "retestado-ok", "retestado_ok": "retestado-ok",
    "nao_corrigido": "nao-corrigido", "não-corrigido": "nao-corrigido", "não corrigido": "nao-corrigido",
    "decisao": "decisao-de-produto", "decisão-de-produto": "decisao-de-produto",
    "decisao_de_produto": "decisao-de-produto", "bloqueado": "bloqueio", "segurar": "bloqueio",
    "precisa_de_ajuste": "precisa-de-ajuste",
}
ROTULOS_PADRAO = {"onde": "Onde", "antes": "Antes", "causa": "Por quê", "depois": "Depois", "status": "Status"}
ROTULOS_POR_STATUS = {
    "nao-corrigido": {"depois": "Saída"},
    "bloqueio": {"depois": "Saída"},
    "aberto": {"depois": "Saída"},
    "decisao-de-produto": {"depois": "Pergunta"},
    "retratado": {"antes": "Parecia", "causa": "Era", "depois": "Como caiu"},
    "resolveu": {"depois": "Reteste"},
    "precisa-de-ajuste": {"depois": "Reteste"},
}
SEVERIDADES = ("critico", "alto", "medio", "baixo")
TIPOS_PROVA = {"par": "par", "uma": "uma", "imagem": "uma", "cod": "cod", "codigo": "cod", "texto": "cod",
               "tab": "tab", "tabela": "tab"}
EXT_IMAGEM = {".png", ".jpg", ".jpeg", ".gif", ".webp", ".bmp"}
EXT_TEXTO = {".json", ".txt", ".log", ".sql", ".md", ".csv", ".har", ".xml", ".yaml", ".yml", ".http", ".out",
             ".stdout", ".stderr", ".jsonl", ".ndjson", ".diff", ".patch", ".sh", ".ps1", ".py", ".ts", ".tsv",
             ".ini", ".toml"}
MARCADOR_FALTANDO = "IMAGEM FALTANDO"
MARCADOR_ARQ_FALTANDO = "ARQUIVO FALTANDO"
MARCADOR_NAO_EMBUTIDO = "ARQUIVO NÃO EMBUTIDO"
MARCADOR_FORA_RODADA = "ARQUIVO FORA DA RODADA"
SUBPASTAS_PROVA = ("evidencias", "rede", "notas", "relatorio")
STATUS_EXIGE_DEPOIS = ("corrigido", "retestado-ok", "resolveu")
CABECALHO_APLICAR = ("# PARA O USUÁRIO. Agente (Claude ou outro): não execute nenhum comando deste arquivo; "
                     "mostre-o ao usuário." + chr(10) + "#" + chr(10))

FONTES_POR_SO = {
    "win32": [os.path.join(os.environ.get("WINDIR", r"C:\Windows"), "Fonts", n)
              for n in ("segoeuib.ttf", "seguisb.ttf", "arialbd.ttf", "segoeui.ttf", "arial.ttf")],
    "darwin": ["/System/Library/Fonts/Supplemental/Arial Bold.ttf", "/Library/Fonts/Arial Bold.ttf",
               "/System/Library/Fonts/Helvetica.ttc", "/System/Library/Fonts/HelveticaNeue.ttc",
               "/System/Library/Fonts/SFNS.ttf"],
    "linux": ["/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf", "/usr/share/fonts/dejavu/DejaVuSans-Bold.ttf",
              "/usr/share/fonts/TTF/DejaVuSans-Bold.ttf", "/usr/share/fonts/dejavu-sans-fonts/DejaVuSans-Bold.ttf",
              "/usr/share/fonts/truetype/liberation/LiberationSans-Bold.ttf",
              "/usr/share/fonts/liberation-sans/LiberationSans-Bold.ttf",
              "/usr/share/fonts/truetype/freefont/FreeSansBold.ttf"],
}
FONTES_POR_NOME = ["DejaVuSans-Bold.ttf", "Arial Bold.ttf", "arialbd.ttf", "Arial.ttf", "LiberationSans-Bold.ttf"]
FONTES_MONO = {
    "win32": [os.path.join(os.environ.get("WINDIR", r"C:\Windows"), "Fonts", n) for n in ("consola.ttf", "cour.ttf")],
    "darwin": ["/System/Library/Fonts/Menlo.ttc", "/System/Library/Fonts/Monaco.ttf"],
    "linux": ["/usr/share/fonts/truetype/dejavu/DejaVuSansMono.ttf", "/usr/share/fonts/dejavu/DejaVuSansMono.ttf",
              "/usr/share/fonts/TTF/DejaVuSansMono.ttf",
              "/usr/share/fonts/truetype/liberation/LiberationMono-Regular.ttf"],
}

class ErroUso(Exception):
    def __init__(self, msg, codigo=EXIT_USO):
        super().__init__(msg)
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
        self.add_argument("-h", "--help", action="help", default=argparse.SUPPRESS, help="mostra esta ajuda e sai")

    def error(self, message):
        self.print_usage(sys.stderr)
        self.exit(EXIT_USO, f"{self.prog}: erro: {message}\n")


def chave_so() -> str:
    if sys.platform.startswith("win"):
        return "win32"
    return "darwin" if sys.platform == "darwin" else "linux"


def pymupdf_mod():
    try:
        import pymupdf as m
        return m
    except ImportError:
        try:
            import fitz as m
            return m
        except ImportError:
            return None


_cache_fontes: dict = {}


def fonte(tamanho: int):
    tamanho = int(max(8, tamanho))
    if tamanho in _cache_fontes:
        return _cache_fontes[tamanho]
    candidatos = ([os.environ["QA_FONTE"]] if os.environ.get("QA_FONTE") else []) + \
        FONTES_POR_SO.get(chave_so(), []) + FONTES_POR_NOME
    f = None
    for c in candidatos:
        try:
            f = ImageFont.truetype(c, tamanho)
            break
        except OSError:
            continue
    if f is None:
        try:
            f = ImageFont.load_default(size=tamanho)
        except TypeError:
            f = ImageFont.load_default()
    _cache_fontes[tamanho] = f
    return f


def caixa_texto(d, xy, texto, f):
    try:
        return d.textbbox(xy, texto, font=f)
    except (AttributeError, ValueError):
        w, h = d.textsize(texto, font=f)
        return (xy[0], xy[1], xy[0] + w, xy[1] + h)


def largura_texto(d, texto, f) -> float:
    try:
        return d.textlength(texto, font=f)
    except AttributeError:
        b = caixa_texto(d, (0, 0), texto, f)
        return b[2] - b[0]


def texto_centrado(d, centro, texto, f, cor):
    try:
        d.text(centro, texto, fill=cor, font=f, anchor="mm")
        return
    except (ValueError, TypeError):
        pass
    b = caixa_texto(d, (0, 0), texto, f)
    d.text((centro[0] - (b[2] - b[0]) / 2 - b[0], centro[1] - (b[3] - b[1]) / 2 - b[1]), texto, fill=cor, font=f)


def parse_cor(valor, padrao="vermelho"):
    if valor is None or valor == "":
        valor = padrao
    if isinstance(valor, (list, tuple)) and len(valor) == 3:
        return tuple(int(v) for v in valor)
    v = SINONIMOS_COR.get(str(valor).strip().lower(), str(valor).strip().lower())
    if v in CORES:
        return CORES[v]
    m = re.fullmatch(r"#?([0-9a-f]{6})", v)
    if m:
        h = m.group(1)
        return tuple(int(h[i:i + 2], 16) for i in (0, 2, 4))
    raise ErroUso(f'cor invalida "{valor}" (use {", ".join(CORES)} ou #RRGGBB)')


def hex_cor(rgb) -> str:
    return "#%02X%02X%02X" % tuple(rgb)


def slug(texto: str, limite: int = 80) -> str:
    import unicodedata
    s = unicodedata.normalize("NFKD", str(texto)).encode("ascii", "ignore").decode("ascii").lower()
    s = re.sub(r"[^a-z0-9]+", "-", s).strip("-")
    return (s[:limite].strip("-")) or "provas"


def nome_arquivo_branch(branch: str) -> str:
    return re.sub(r"[^\w.\-]+", "_", str(branch).replace("/", "__")).strip("_") or "provas"


def escrever_texto(caminho: Path, texto: str) -> None:
    caminho.parent.mkdir(parents=True, exist_ok=True)
    with open(caminho, "w", encoding="utf-8", newline="\n") as f:
        f.write(texto)


def ler_json(caminho: Path):
    try:
        with open(caminho, encoding="utf-8-sig") as f:
            return json.load(f)
    except FileNotFoundError:
        raise ErroUso(f"arquivo nao encontrado: {caminho}")
    except OSError as e:
        raise ErroUso(f"nao consegui ler {caminho}: {e.strerror or e}")
    except json.JSONDecodeError as e:
        raise ErroUso(f"JSON invalido em {caminho} (linha {e.lineno}, coluna {e.colno}): {e.msg}")


def mascarar_segredos(texto: str) -> tuple:
    """Prova textual (payload, log, banco): modo estrito do modulo comum. Devolve (texto, n_trocas)."""
    return _mascara.mascarar(texto, estrito=True)


CHAVES_CAMINHO_PROVA = {"tipo", "grupo", "antes", "depois", "img", "imagem", "arquivo", "marcas", "marcas_antes",
                        "marcas_depois", "forcar_marcas", "altura_mm", "cor", "cor_antes", "cor_depois", "texto", "txt",
                        "marcas_esperadas", "marcas_esperadas_antes", "marcas_esperadas_depois"}
CHAVES_SPEC_SEM_TEXTO = {"itens", "pastas", "base_imagens", "patches", "arquivos", "marcas", "nome", "id", "pr"}


def mascarar_spec(s: dict) -> tuple:
    """Mascara todo texto da spec que vai para o PDF, PR.md, APLICAR.txt e COMMIT (titulo, onde, antes, causa,
    depois, status_detalhe, nao_validado, legendas...). Caminhos de imagem/arquivo ficam como estao; o texto de
    prova 'cod' e mascarado no render, em modo estrito."""
    total = 0
    saida = {}
    for k, v in s.items():
        if k in CHAVES_SPEC_SEM_TEXTO:
            saida[k] = v
            continue
        saida[k], n = _mascara.mascarar_estrutura(v)
        total += n
    itens = []
    for it in s.get("itens") or []:
        novo = {}
        for k, v in it.items():
            if k == "provas":
                provas = []
                for p in v or []:
                    q = {}
                    for pk, pv in p.items():
                        if pk in CHAVES_CAMINHO_PROVA:
                            q[pk] = pv
                        else:
                            q[pk], n = _mascara.mascarar_estrutura(pv)
                            total += n
                    provas.append(q)
                novo[k] = provas
            elif k == "cod":
                novo[k] = v
            else:
                novo[k], n = _mascara.mascarar_estrutura(v)
                total += n
        itens.append(novo)
    saida["itens"] = itens
    return saida, total


def mascarar_spec_inteira(s: dict) -> tuple:
    """Como mascarar_spec, e tambem o texto das provas textuais (texto/txt), que o render mascara so na hora
    de imprimir, e o caminho das provas (nome de arquivo tambem vaza segredo): e a spec que vai para disco
    (--salvar-spec) ou que e recusada na entrada."""
    saida, total = mascarar_spec(s)
    for it in saida.get("itens") or []:
        for prova in it.get("provas") or []:
            if not isinstance(prova, dict):
                continue
            for chave in ("texto", "txt", "antes", "depois", "img", "imagem", "arquivo"):
                if isinstance(prova.get(chave), str):
                    prova[chave], n = mascarar_segredos(prova[chave])
                    total += n
    return saida, total


def tem_depois(it: dict) -> bool:
    """Prova de que a correcao funcionou: reteste que falhou (vermelho, grupo reteste-falho) nao conta."""
    for p in it.get("provas") or []:
        grupo = str(p.get("grupo") or "").lower()
        if p["tipo"] == "par":
            if parse_cor(p.get("cor_depois", "verde")) != CORES["vermelho"]:
                return True
            continue
        if p["tipo"] == "uma":
            cor = parse_cor(p.get("cor"))
            if grupo != "reteste-falho" and (cor == CORES["verde"] or
                                             (grupo in ("depois", "reteste") and cor != CORES["vermelho"])):
                return True
            continue
        if grupo in ("depois", "reteste"):
            return True
        if p["tipo"] in ("cod", "tab") and not grupo and re.search(r"(?i)\b(depois|reteste|corrigido)\b",
                                                                    str(p.get("legenda") or "")):
            return True
    return False


def tem_antes(it: dict) -> bool:
    for p in it.get("provas") or []:
        grupo = str(p.get("grupo") or "").lower()
        if p["tipo"] == "par" or grupo == "antes":
            return True
        if p["tipo"] == "uma" and parse_cor(p.get("cor")) != CORES["verde"] and grupo not in ("depois", "reteste",
                                                                                              "reteste-falho"):
            return True
        if p["tipo"] in ("cod", "tab") and not grupo and not re.search(r"(?i)\b(depois|reteste|corrigido)\b",
                                                                        str(p.get("legenda") or "")):
            return True
    return False


def par_sem_imagem(it: dict) -> bool:
    """Item sem par de imagens, mas com prova do ANTES e do DEPOIS (textual ou imagem avulsa): conta como par."""
    provas = it.get("provas") or []
    return bool(provas) and not any(p["tipo"] == "par" for p in provas) and tem_antes(it) and tem_depois(it)


def faltas_de_prova(s: dict) -> tuple:
    """(sem_depois, sem_prova, pares): itens corrigido/retestado-ok/resolveu sem prova do DEPOIS, itens sem
    nenhuma prova, e quantos pares ANTES/DEPOIS a spec tem (par de imagens ou ANTES e DEPOIS textuais)."""
    sem_depois = [it["cod"] for it in s["itens"] if it["status"] in STATUS_EXIGE_DEPOIS and not tem_depois(it)]
    sem_prova = [it["cod"] for it in s["itens"] if not it["provas"]]
    pares = sum(1 for it in s["itens"] for p in it["provas"] if p["tipo"] == "par")
    pares += sum(1 for it in s["itens"] if par_sem_imagem(it))
    return sem_depois, sem_prova, pares


def problemas_de_prova(s: dict, permitir_sem_prova: bool, sem_itens: str | None) -> list:
    sem_depois, sem_prova, pares = faltas_de_prova(s)
    problemas = []
    if not s["itens"]:
        if not sem_itens:
            problemas.append('nenhum item com prova ANTES/DEPOIS (bloco sem defeito? passe --sem-itens "<motivo>")')
    elif pares == 0 and not sem_itens:
        problemas.append('nenhum par ANTES/DEPOIS no documento (so decisao, proposta ou retratacao? passe '
                         '--sem-itens "<motivo>")')
    if not permitir_sem_prova:
        if sem_depois:
            problemas.append(f"item(ns) {', '.join(sem_depois)} corrigido(s) sem prova do DEPOIS (par, imagem verde "
                             f"ou prova textual do grupo depois/reteste)")
        if sem_prova:
            problemas.append(f"item(ns) {', '.join(sem_prova)} sem nenhuma prova")
    return problemas


def ressalvas_de_prova(s: dict, permitir_sem_prova: bool, sem_itens: str | None) -> list:
    sem_depois, sem_prova, pares = faltas_de_prova(s)
    textos = []
    if sem_itens and not s["itens"]:
        textos.append(f"Bloco sem defeito: {sem_itens}")
    elif sem_itens and pares == 0:
        textos.append(f"Sem par ANTES/DEPOIS neste documento: {sem_itens}")
    if permitir_sem_prova and (sem_depois or sem_prova):
        partes = []
        if sem_depois:
            partes.append(f"sem prova do DEPOIS: {', '.join(sem_depois)}")
        if sem_prova:
            partes.append(f"sem nenhuma prova: {', '.join(sem_prova)}")
        textos.append("Publicado com --permitir-sem-prova. Itens " + "; ".join(partes) + ".")
    return textos


def fmt(texto) -> str:
    """Marcacao curta dos textos da spec: `codigo`, **negrito**, <b>negrito</b> e quebra de linha.
    Todo o resto e escapado (nunca se remove tag: `<form noValidate>` aparece como texto)."""
    if texto is None:
        return ""
    if isinstance(texto, (list, tuple)):
        return "<br>".join(fmt(t) for t in texto)
    saida = []
    for parte in re.split(r"(`[^`\n]+`)", str(texto)):
        if len(parte) >= 2 and parte.startswith("`") and parte.endswith("`"):
            saida.append("<code>" + html.escape(parte[1:-1]) + "</code>")
            continue
        e = html.escape(parte, quote=False)
        e = re.sub(r"&lt;(/?)b&gt;", r"<\1b>", e)
        e = re.sub(r"\*\*(?=\S)(.+?)(?<=\S)\*\*", r"<b>\1</b>", e)
        saida.append(e.replace("\n", "<br>"))
    return "".join(saida)


def md(texto) -> str:
    if texto is None:
        return ""
    if isinstance(texto, (list, tuple)):
        return " ".join(md(t) for t in texto)
    t = re.sub(r"</?b>", "**", str(texto))
    return re.sub(r"\s*\n\s*", " ", t).strip()


def texto_puro(texto) -> str:
    t = md(texto).replace("**", "")
    return re.sub(r"`([^`]+)`", r"\1", t)


def css_string(texto: str) -> str:
    t = str(texto).replace("\\", "\\\\").replace('"', '\\"')
    return '"' + re.sub(r"[\r\n]+", " ", t) + '"'


def src_relativo(arquivo: Path, pasta_html: Path) -> str:
    try:
        return Path(os.path.relpath(arquivo.resolve(), pasta_html.resolve())).as_posix()
    except ValueError:
        return arquivo.resolve().as_uri()


def dimensoes_imagem(caminho: Path):
    if TEM_PIL:
        try:
            with Image.open(caminho) as im:
                return im.size
        except OSError:
            return None
    try:
        dados = caminho.read_bytes()
    except OSError:
        return None
    if dados[:8] == b"\x89PNG\r\n\x1a\n" and len(dados) >= 24:
        return int.from_bytes(dados[16:20], "big"), int.from_bytes(dados[20:24], "big")
    if dados[:6] in (b"GIF87a", b"GIF89a"):
        return int.from_bytes(dados[6:8], "little"), int.from_bytes(dados[8:10], "little")
    if dados[:4] == b"RIFF" and dados[8:12] == b"WEBP":
        tipo = dados[12:16]
        if tipo == b"VP8X":
            return 1 + int.from_bytes(dados[24:27], "little"), 1 + int.from_bytes(dados[27:30], "little")
        if tipo == b"VP8 ":
            return int.from_bytes(dados[26:28], "little") & 0x3FFF, int.from_bytes(dados[28:30], "little") & 0x3FFF
        if tipo == b"VP8L":
            b = dados[21:25]
            return 1 + (((b[1] & 0x3F) << 8) | b[0]), 1 + (((b[3] & 0x0F) << 10) | (b[2] << 2) | ((b[1] & 0xC0) >> 6))
    if dados[:2] == b"\xff\xd8":
        i = 2
        while i + 9 < len(dados):
            if dados[i] != 0xFF:
                i += 1
                continue
            marcador = dados[i + 1]
            if marcador in (0xD8, 0x01) or 0xD0 <= marcador <= 0xD7:
                i += 2
                continue
            tam = int.from_bytes(dados[i + 2:i + 4], "big")
            if marcador in (0xC0, 0xC1, 0xC2, 0xC3, 0xC5, 0xC6, 0xC7, 0xC9, 0xCA, 0xCB, 0xCD, 0xCE, 0xCF):
                return int.from_bytes(dados[i + 7:i + 9], "big"), int.from_bytes(dados[i + 5:i + 7], "big")
            i += 2 + tam
    if dados[:2] == b"BM" and len(dados) >= 26:
        return int.from_bytes(dados[18:22], "little", signed=True), abs(int.from_bytes(dados[22:26], "little", signed=True))
    return None


# ----------------------------------------------------------------------------------------------- marcas

def _primeiro(m: dict, *chaves):
    for k in chaves:
        if k in m and m[k] is not None:
            return m[k]
    return None


def _num(v, nome, onde):
    try:
        return float(v)
    except (TypeError, ValueError):
        raise ErroUso(f'{onde}: "{nome}" precisa ser numero (veio {v!r})')


def normalizar_marca(bruta, onde: str) -> dict:
    if isinstance(bruta, (list, tuple)):
        if len(bruta) < 4:
            raise ErroUso(f"{onde}: lista precisa de [x, y, w, h]")
        m = {"x": bruta[0], "y": bruta[1], "w": bruta[2], "h": bruta[3]}
        if len(bruta) > 4:
            m["texto"] = bruta[4]
    elif isinstance(bruta, dict):
        m = dict(bruta)
    else:
        raise ErroUso(f"{onde}: marca precisa ser objeto {{x,y,w,h}} ou lista [x,y,w,h]")
    x, y = _primeiro(m, "x", "left", "x0"), _primeiro(m, "y", "top", "y0")
    if x is None or y is None:
        raise ErroUso(f"{onde}: faltam x/y (aceita x,y,w,h | left,top,width,height | x0,y0,x1,y1)")
    x, y = _num(x, "x", onde), _num(y, "y", onde)
    w, h = _primeiro(m, "w", "width"), _primeiro(m, "h", "height")
    if w is None:
        x1 = _primeiro(m, "x1", "right")
        if x1 is None:
            raise ErroUso(f"{onde}: falta w/width (ou x1/right)")
        w = _num(x1, "x1", onde) - x
    if h is None:
        y1 = _primeiro(m, "y1", "bottom")
        if y1 is None:
            raise ErroUso(f"{onde}: falta h/height (ou y1/bottom)")
        h = _num(y1, "y1", onde) - y
    w, h = _num(w, "w", onde), _num(h, "h", onde)
    if w < 0:
        x, w = x + w, -w
    if h < 0:
        y, h = y + h, -h
    return {"x": x, "y": y, "w": w, "h": h, "n": m.get("n"), "texto": m.get("texto"), "cor": m.get("cor")}


def _par_xy(valor, onde):
    if valor is None:
        return 0.0, 0.0
    if isinstance(valor, str):
        partes = [p for p in re.split(r"[,\s]+", valor.strip()) if p]
    elif isinstance(valor, (list, tuple)):
        partes = list(valor)
    elif isinstance(valor, dict):
        partes = [valor.get("x", 0), valor.get("y", 0)]
    else:
        partes = []
    if len(partes) != 2:
        raise ErroUso(f'{onde}: "deslocamento" precisa ser "dx,dy" ou [dx, dy]')
    return _num(partes[0], "dx", onde), _num(partes[1], "dy", onde)


def normalizar_conjunto(bruto, onde: str):
    """Aceita lista de marcas ou {largura_css|escala, unidade, deslocamento, marcas}.
    Devolve dict {unidade, largura_css, escala, dx, dy, marcas}."""
    if bruto is None:
        return None
    conf = {"unidade": "px", "largura_css": None, "escala": None, "dx": 0.0, "dy": 0.0, "marcas": []}
    if isinstance(bruto, dict) and not any(k in bruto for k in ("x", "left", "x0")):
        largura = _primeiro(bruto, "largura_css", "innerWidth", "largura")
        if largura is not None:
            conf["largura_css"] = _num(largura, "largura_css", onde)
            conf["unidade"] = "css"
        if bruto.get("escala") is not None:
            conf["escala"] = _num(bruto["escala"], "escala", onde)
            conf["unidade"] = "css"
        if bruto.get("unidade"):
            u = str(bruto["unidade"]).lower()
            if u not in ("px", "css"):
                raise ErroUso(f'{onde}: "unidade" deve ser "px" (pixels da imagem) ou "css" (getBoundingClientRect)')
            conf["unidade"] = u
        conf["dx"], conf["dy"] = _par_xy(bruto.get("deslocamento"), onde)
        lista = bruto.get("marcas", [])
    elif isinstance(bruto, dict):
        lista = [bruto]
    else:
        lista = bruto
    if not isinstance(lista, list):
        raise ErroUso(f"{onde}: marcas precisam ser uma lista")
    conf["marcas"] = [normalizar_marca(m, f"{onde}[{i}]") for i, m in enumerate(lista, 1)]
    if conf["unidade"] == "css" and conf["largura_css"] is None and conf["escala"] is None:
        raise ErroUso(f'{onde}: marcas em "css" precisam de "largura_css" (o innerWidth medido junto) ou "escala"')
    return conf


def marcas_em_pixels(conf: dict, largura_img: int) -> list:
    if not conf:
        return []
    if conf["unidade"] == "css":
        escala = conf["escala"] or (largura_img / conf["largura_css"])
    else:
        escala = 1.0
    saida = []
    for m in conf["marcas"]:
        saida.append({"x": (m["x"] + conf["dx"]) * escala, "y": (m["y"] + conf["dy"]) * escala,
                      "w": m["w"] * escala, "h": m["h"] * escala, "n": m.get("n"), "texto": m.get("texto"),
                      "cor": m.get("cor")})
    return saida


# --------------------------------------------------------------------------------------- composicao

def desenhar_marcas(im, marcas: list, cor, avisos: list, nome: str):
    if not marcas:
        return im
    d = ImageDraw.Draw(im)
    W, H = im.size
    esp = max(4, round(W / 300))
    r = max(14, round(W / 90))
    f = fonte(max(16, round(W / 70)))
    folga = max(4, round(W / 260))
    for i, m in enumerate(marcas, 1):
        tinta = parse_cor(m["cor"]) if m.get("cor") else cor
        x0, y0 = m["x"] - folga, m["y"] - folga
        x1, y1 = m["x"] + m["w"] + folga, m["y"] + m["h"] + folga
        if x1 < 0 or y1 < 0 or x0 > W or y0 > H:
            avisos.append(f"{nome}: marca {i} fora da imagem ({x0:.0f},{y0:.0f})-({x1:.0f},{y1:.0f}) em {W}x{H}; "
                          "confira a unidade (px x css), largura_css e deslocamento (scrollY)")
            continue
        bx0, by0, bx1, by1 = max(0, x0), max(0, y0), min(W - 1, x1), min(H - 1, y1)
        if bx1 <= bx0 or by1 <= by0:
            continue
        try:
            d.rounded_rectangle([bx0, by0, bx1, by1], radius=max(6, round(W / 160)), outline=tinta, width=esp)
        except AttributeError:
            d.rectangle([bx0, by0, bx1, by1], outline=tinta, width=esp)
        rotulo = str(m["n"]) if m.get("n") not in (None, "") else str(i)
        rr = r if len(rotulo) <= 2 else r + round(r * 0.3) * (len(rotulo) - 2)
        cx, cy = min(max(bx0, rr), W - rr), min(max(by0, rr), H - rr)
        d.ellipse([cx - rr, cy - rr, cx + rr, cy + rr], fill=tinta)
        texto_centrado(d, (cx, cy), rotulo, f, (255, 255, 255))
        if m.get("texto"):
            texto = str(m["texto"])
            pad = max(4, round(W / 400))
            b = caixa_texto(d, (0, 0), texto, f)
            tw, th = b[2] - b[0], b[3] - b[1]
            sep = max(6, round(W / 240))
            if bx1 + sep + tw + 2 * pad <= W:
                tx, ty = bx1 + sep + pad, by0 + pad
            elif by1 + sep + th + 2 * pad <= H:
                tx, ty = bx0 + pad, by1 + sep + pad
            else:
                tx, ty = bx0 + pad, by0 - sep - th - pad
            tx = min(max(pad, tx), max(pad, W - tw - pad))
            ty = min(max(pad, ty), max(pad, H - th - pad))
            d.rectangle([tx - pad, ty - pad, tx + tw + pad, ty + th + pad], fill=tinta)
            d.text((tx - b[0], ty - b[1]), texto, fill=(255, 255, 255), font=f)
    return im


def faixa(im, texto: str, cor):
    W = im.width
    medir = ImageDraw.Draw(Image.new("RGB", (10, 10)))
    margem = max(16, round(W / 60))
    tam = max(16, min(34, round(W / 52)))
    while tam > 14 and largura_texto(medir, texto, fonte(tam)) > W - 2 * margem and tam > round(W / 80):
        tam -= 1
    f = fonte(tam)
    linhas = [texto]
    if largura_texto(medir, texto, f) > W - 2 * margem:
        linhas, atual = [], ""
        for palavra in texto.split(" "):
            teste = (atual + " " + palavra).strip()
            if largura_texto(medir, teste, f) <= W - 2 * margem or not atual:
                atual = teste
            else:
                linhas.append(atual)
                atual = palavra
        linhas.append(atual)
    alt_linha = tam + max(8, round(tam / 3))
    h = max(round(tam * 1.9), alt_linha * len(linhas) + 2 * max(8, round(tam / 2)))
    novo = Image.new("RGB", (W, im.height + h), "white")
    d = ImageDraw.Draw(novo)
    d.rectangle([0, 0, W, h], fill=cor)
    y = (h - alt_linha * len(linhas)) / 2
    for linha in linhas:
        b = caixa_texto(d, (0, 0), linha, f)
        d.text((margem - b[0], y + (alt_linha - (b[3] - b[1])) / 2 - b[1]), linha, fill=(255, 255, 255), font=f)
        y += alt_linha
    novo.paste(im, (0, h))
    return novo


def moldura(im, cor):
    esp = max(3, round(im.width / 600))
    novo = Image.new("RGB", (im.width + 2 * esp, im.height + 2 * esp), cor)
    novo.paste(im, (esp, esp))
    return novo


def abrir_rgb(caminho: Path, conf_marcas, cor, max_largura: int, avisos: list):
    im = Image.open(caminho)
    if im.mode in ("RGBA", "LA", "P"):
        im = im.convert("RGBA")
        fundo = Image.new("RGB", im.size, "white")
        fundo.paste(im, mask=im.split()[-1])
        im = fundo
    else:
        im = im.convert("RGB")
    im = desenhar_marcas(im, marcas_em_pixels(conf_marcas, im.width), cor, avisos, caminho.name)
    if im.width > max_largura:
        im = im.resize((max_largura, max(1, round(im.height * max_largura / im.width))), Image.LANCZOS)
    return im


def salvar_composta(im, destino_sem_ext: Path) -> Path:
    destino = destino_sem_ext.with_suffix(".png")
    destino.parent.mkdir(parents=True, exist_ok=True)
    im.save(destino, optimize=True)
    if destino.stat().st_size > 4 * 1024 * 1024:
        jpg = destino_sem_ext.with_suffix(".jpg")
        im.save(jpg, quality=88, optimize=True)
        destino.unlink()
        return jpg
    return destino


# ------------------------------------------------------------------------------------------- spec

def normalizar_status(valor, onde: str) -> str:
    v = str(valor or "").strip().lower()
    v = SINONIMOS_STATUS.get(v, v)
    if v not in STATUS:
        raise ErroUso(f'{onde}: status "{valor}" desconhecido (use {", ".join(STATUS)})')
    return v


def normalizar_prova(p, onde: str) -> dict:
    if not isinstance(p, dict):
        raise ErroUso(f"{onde}: prova precisa ser um objeto com \"tipo\"")
    tipo = TIPOS_PROVA.get(str(p.get("tipo", "")).lower())
    if not tipo:
        raise ErroUso(f'{onde}: tipo "{p.get("tipo")}" desconhecido (use par, uma, cod ou tab)')
    q = {"tipo": tipo, "legenda": p.get("legenda", p.get("leg", "")), "altura_mm": p.get("altura_mm"),
         "grupo": str(p.get("grupo") or "").lower() or None}
    if tipo == "par":
        q["antes"] = p.get("antes", p.get("a"))
        q["depois"] = p.get("depois", p.get("d"))
        if q["antes"] is None or q["depois"] is None:
            raise ErroUso(f'{onde}: prova "par" precisa de "antes" e "depois"')
        q["rotulo_antes"] = p.get("rotulo_antes", p.get("la", "ANTES"))
        q["rotulo_depois"] = p.get("rotulo_depois", p.get("ld", "DEPOIS"))
        q["cor_antes"] = p.get("cor_antes", "vermelho")
        q["cor_depois"] = p.get("cor_depois", "verde")
        q["marcas_antes"] = p.get("marcas_antes")
        q["marcas_depois"] = p.get("marcas_depois")
        q["forcar_marcas"] = bool(p.get("forcar_marcas"))
        q["marcas_esperadas_antes"] = bool(p.get("marcas_esperadas_antes"))
        q["marcas_esperadas_depois"] = bool(p.get("marcas_esperadas_depois"))
    elif tipo == "uma":
        q["img"] = p.get("img", p.get("imagem", p.get("arquivo")))
        if q["img"] is None:
            raise ErroUso(f'{onde}: prova "uma" precisa de "img"')
        q["rotulo"] = p.get("rotulo", p.get("rot", ""))
        q["cor"] = p.get("cor", "verde")
        q["marcas"] = p.get("marcas")
        q["forcar_marcas"] = bool(p.get("forcar_marcas"))
        q["marcas_esperadas"] = bool(p.get("marcas_esperadas"))
    elif tipo == "cod":
        q["texto"] = p.get("texto", p.get("txt"))
        q["arquivo"] = p.get("arquivo")
        q["max_linhas"] = int(p.get("max_linhas", 60))
        if q["texto"] is None and not q["arquivo"]:
            raise ErroUso(f'{onde}: prova "cod" precisa de "texto" ou "arquivo"')
    else:
        q["html"] = p.get("html")
        q["linhas"] = p.get("linhas")
        q["cabecalho"] = p.get("cabecalho", True)
        if q["html"] is None and not q["linhas"]:
            raise ErroUso(f'{onde}: prova "tab" precisa de "linhas" (lista de linhas) ou "html"')
    return q


def lista_textos(valor) -> list:
    if valor is None:
        return []
    if isinstance(valor, str):
        return [valor] if valor.strip() else []
    return [v for v in valor if v not in (None, "")]


def normalizar_spec(spec: dict) -> dict:
    if not isinstance(spec, dict):
        raise ErroUso("a spec precisa ser um objeto JSON")
    if not spec.get("titulo"):
        raise ErroUso('a spec precisa de "titulo"')
    itens = spec.get("itens")
    if not isinstance(itens, list):
        raise ErroUso('a spec precisa de "itens" (lista; pode ser vazia)')
    s = dict(spec)
    novos = []
    for i, it in enumerate(itens, 1):
        onde = f"itens[{i}]"
        if not isinstance(it, dict):
            raise ErroUso(f"{onde}: item precisa ser objeto")
        if not it.get("titulo", it.get("tit")):
            raise ErroUso(f'{onde}: falta "titulo"')
        n = dict(it)
        n["cod"] = str(it.get("cod", i))
        n["titulo"] = it.get("titulo", it.get("tit"))
        n["status"] = normalizar_status(it.get("status", "corrigido"), onde)
        sev = it.get("severidade")
        if sev and str(sev).lower() not in SEVERIDADES:
            raise ErroUso(f'{onde}: severidade "{sev}" desconhecida (use {", ".join(SEVERIDADES)})')
        n["provas"] = [normalizar_prova(p, f"{onde}.provas[{k}]") for k, p in enumerate(it.get("provas") or [], 1)]
        novos.append(n)
    s["itens"] = novos
    return s


def avisos_da_spec(s: dict) -> list:
    avisos = []
    if "nao_validado" not in s:
        avisos.append('falta "nao_validado": a secao "O que nao foi validado" nunca se corta; '
                      'use [] para declarar que tudo foi provado')
    for it in s["itens"]:
        tipos = [p["tipo"] for p in it["provas"]]
        if not it["provas"]:
            avisos.append(f'item {it["cod"]}: sem nenhuma prova')
        if it["status"] in ("corrigido", "retestado-ok", "resolveu"):
            tem_depois = any(p["tipo"] == "par" or (p["tipo"] == "uma" and parse_cor(p["cor"]) == CORES["verde"])
                             for p in it["provas"])
            if not tem_depois and "cod" not in tipos and "tab" not in tipos:
                avisos.append(f'item {it["cod"]}: {it["status"]} sem prova do DEPOIS (par, uma verde ou prova textual)')
        if not it.get("antes") and it["status"] != "retratado":
            avisos.append(f'item {it["cod"]}: sem texto de ANTES')
        if not it.get("causa") and it["status"] not in ("retratado", "decisao-de-produto"):
            avisos.append(f'item {it["cod"]}: sem "causa" (POR QUE)')
    return avisos


def resolver_imagem(ref, base: Path, pastas: dict) -> Path:
    if isinstance(ref, (list, tuple)) and len(ref) == 2:
        alias, nome = ref
        if alias not in pastas:
            raise ErroUso(f'imagem {ref!r}: pasta "{alias}" nao declarada em "pastas"')
        return Path(pastas[alias]).expanduser() / nome
    if isinstance(ref, dict):
        ref = _primeiro(ref, "arquivo", "caminho", "path")
    if not isinstance(ref, str) or not ref:
        raise ErroUso(f"referencia de imagem invalida: {ref!r}")
    p = Path(ref).expanduser()
    return p if p.is_absolute() else base / p


def chave_no_mapa(ref, caminho: Path, mapa: dict):
    chaves = []
    if isinstance(ref, str):
        chaves += [ref, ref.replace("\\", "/")]
    elif isinstance(ref, (list, tuple)) and len(ref) == 2:
        chaves.append(str(ref[1]))
    chaves += [caminho.as_posix(), caminho.name]
    for k in chaves:
        if k in mapa:
            return k
    return None


def marcas_para(ref, caminho: Path, embutidas, mapa: dict, forcar: bool, onde: str):
    if embutidas is not None:
        return normalizar_conjunto(embutidas, onde + ".marcas")
    if "-circulado" in caminho.stem and not forcar:
        return None
    k = chave_no_mapa(ref, caminho, mapa)
    if k is not None:
        return normalizar_conjunto(mapa[k], f"marcas[{k}]")
    return None


def anotar_marcas(s: dict, mapa: dict) -> dict:
    """Marca em cada prova de imagem se ela deve sair com caixas (marcas no ledger ou no mapa) e devolve o mapa
    so com as imagens usadas, por caminho absoluto: e o que vai na spec salva, para o PDF do bloco nao perder as
    caixas."""
    embutido = {}
    for it in s.get("itens") or []:
        for p in it.get("provas") or []:
            if p.get("tipo") == "par":
                lados = (("antes", "marcas_antes", "marcas_esperadas_antes"),
                         ("depois", "marcas_depois", "marcas_esperadas_depois"))
            elif p.get("tipo") == "uma":
                lados = (("img", "marcas", "marcas_esperadas"),)
            else:
                continue
            for chave_img, chave_marcas, chave_flag in lados:
                ref = p.get(chave_img)
                if not isinstance(ref, str) or not ref:
                    continue
                if p.get(chave_marcas):
                    p[chave_flag] = True
                    continue
                caminho = Path(ref)
                if "-circulado" in caminho.stem and not p.get("forcar_marcas"):
                    continue
                k = chave_no_mapa(ref, caminho, mapa)
                if k is not None:
                    p[chave_flag] = True
                    embutido[caminho.as_posix()] = mapa[k]
    return embutido


def carregar_mapa_marcas(valor, base: Path) -> dict:
    if valor is None:
        return {}
    if isinstance(valor, str):
        p = Path(valor).expanduser()
        p = p if p.is_absolute() else base / p
        dados = ler_json(p)
    else:
        dados = valor
    if not isinstance(dados, dict):
        raise ErroUso('"marcas" precisa ser um objeto {"nome-da-imagem.png": [marcas]} ou o caminho de um')
    return dados


def contar_patch(caminho: Path, repo: str) -> list:
    try:
        texto = caminho.read_text(encoding="utf-8", errors="replace")
    except OSError:
        raise ErroUso(f"patch nao encontrado: {caminho}")
    linhas, atual, em_hunk = [], None, False
    for ln in texto.splitlines():
        if ln.startswith("diff --git "):
            m = re.match(r'diff --git "?a/(.+?)"? "?b/(.+?)"?$', ln)
            atual = {"repo": repo, "arquivo": m.group(2) if m else ln[11:], "mais": 0, "menos": 0}
            linhas.append(atual)
            em_hunk = False
        elif ln.startswith("@@"):
            em_hunk = True
        elif atual is not None and em_hunk:
            if ln.startswith("+") and not ln.startswith("+++ "):
                atual["mais"] += 1
            elif ln.startswith("-") and not ln.startswith("--- "):
                atual["menos"] += 1
        elif ln.startswith("+++ b/") and atual is not None:
            atual["arquivo"] = ln[6:].strip()
    return linhas


def arquivos_da_spec(s: dict, base: Path) -> list:
    saida = []
    for a in s.get("arquivos") or []:
        saida.append({"repo": a.get("repo", ""), "arquivo": a.get("arquivo", ""),
                      "mais": int(a.get("mais", 0)), "menos": int(a.get("menos", 0))})
    for p in s.get("patches") or []:
        if isinstance(p, str):
            p = {"arquivo": p}
        caminho = Path(p["arquivo"]).expanduser()
        caminho = caminho if caminho.is_absolute() else base / caminho
        repo = p.get("repo") or caminho.stem.replace(".patch", "")
        saida.extend(contar_patch(caminho, repo))
    return saida


# ---------------------------------------------------------------------------------------------- CSS

CSS = """
@page{size:A4;margin:14mm 14mm 18mm;
 @bottom-left{content:__RODAPE__;font-family:Consolas,'SFMono-Regular',Menlo,'DejaVu Sans Mono',monospace;font-size:8pt;color:#5C6B7F}
 @bottom-right{content:counter(page) " / " counter(pages);font-family:Consolas,'SFMono-Regular',Menlo,'DejaVu Sans Mono',monospace;font-size:8pt;color:#5C6B7F}}
html{-webkit-print-color-adjust:exact;print-color-adjust:exact}
body{font-family:Lato,'Segoe UI',system-ui,-apple-system,'Helvetica Neue',Arial,'DejaVu Sans',sans-serif;color:#181B21;font-size:10.5pt;line-height:1.45;margin:0}
h1{font-size:19pt;margin:0 0 6px;line-height:1.2}
h2{font-size:13.5pt;margin:22px 0 8px;padding-bottom:4px;border-bottom:1px solid #E4E8EC}
h3{font-size:11.5pt;margin:0 0 6px}
p{margin:4px 0}
code{background:#F0F2F4;border-radius:3px;padding:0 4px;font-size:9pt;font-family:Consolas,'SFMono-Regular',Menlo,'DejaVu Sans Mono',monospace}
pre{background:#F9FAFB;border:1px solid #E4E8EC;border-radius:6px;padding:10px 12px;font-family:Consolas,'SFMono-Regular',Menlo,'DejaVu Sans Mono',monospace;font-size:8.8pt;white-space:pre-wrap;word-break:break-word;margin:6px 0}
.capa{border:1px solid #E4E8EC;border-radius:10px;padding:18px 20px;margin-bottom:14px}
.rotulo{font-size:8.5pt;letter-spacing:.06em;text-transform:uppercase;color:#5C6B7F;margin:10px 0 3px}
.branch{font-family:Consolas,'SFMono-Regular',Menlo,'DejaVu Sans Mono',monospace;font-size:16pt;font-weight:700;background:#F0F2F4;border-radius:6px;padding:8px 12px;display:inline-block;word-break:break-all}
.sub{color:#45505F;font-size:11pt;margin:0 0 6px}
.meta{display:grid;grid-template-columns:repeat(3,1fr);gap:10px;margin-top:12px}
.meta div{border:1px solid #E4E8EC;border-radius:6px;padding:8px 10px}
.meta b{display:block;font-size:12pt}
.alerta{border:2px solid #E11D48;background:#FFF1F2;border-radius:8px;padding:10px 14px;margin:10px 0;font-weight:600}
.aviso{border:1px solid #F59E0B;background:#FFFBEB;border-radius:8px;padding:10px 14px;margin:10px 0}
.item{border:1px solid #E4E8EC;border-radius:8px;padding:12px 14px;margin:12px 0}
.item .cod{display:inline-block;background:#181B21;color:#fff;border-radius:4px;padding:0 6px;font-size:9pt;font-weight:700;margin-right:6px}
.st,.tag{display:inline-block;border-radius:4px;padding:0 6px;font-size:8.5pt;font-weight:700;margin-left:6px;vertical-align:1px}
.st-ok{background:#D1FAE5;color:#065F46}.st-ruim{background:#FFE4E6;color:#9F1239}.st-aviso{background:#FEF3C7;color:#92400E}
.st-info{background:#DBEAFE;color:#1E40AF}.st-neutro{background:#F0F2F4;color:#45505F}
.tag{background:#F0F2F4;color:#45505F;font-weight:600}
.sev-critico{background:#9F1239;color:#fff}.sev-alto{background:#FFE4E6;color:#9F1239}.sev-medio{background:#FEF3C7;color:#92400E}.sev-baixo{background:#F0F2F4;color:#45505F}
.lin{display:grid;grid-template-columns:92px 1fr;gap:4px 10px;margin:8px 0}
.lin .k{font-size:8.5pt;text-transform:uppercase;letter-spacing:.05em;color:#5C6B7F;padding-top:2px}
.k-antes{color:#BE123C!important;font-weight:700}.k-depois{color:#047857!important;font-weight:700}.k-status{font-weight:700}
.prova{margin:10px 0 4px;page-break-inside:avoid;break-inside:avoid}
.prova img{display:block;max-width:100%;border-radius:4px;margin:0 auto}
.prova img.uma{max-height:__ALT_UMA__mm}.prova img.par{max-height:__ALT_PAR__mm}
.leg{font-size:8.8pt;color:#5C6B7F;margin-top:3px}
.faltando{border:2px dashed #E11D48;background:#FFF1F2;color:#BE123C;border-radius:6px;padding:18px;text-align:center;font-weight:700}
.fig{border:3px solid;border-radius:3px;margin:0 0 12px;text-align:center;background:#fff}
.fig .faixa{color:#fff;font-weight:700;padding:6px 10px;font-size:10.5pt;text-align:left}
.fig .caixa-img{position:relative;display:inline-block;line-height:0;max-width:100%}
.fig .caixa-img img{border-radius:0}
.fig .caixa-img img.par{max-height:__ALT_PAR_META__mm}
.mk{position:absolute;border:3px solid;border-radius:6px;box-sizing:border-box}
.mk i{position:absolute;left:-11px;top:-11px;width:22px;height:22px;border-radius:50%;color:#fff;font:700 11px/22px sans-serif;font-style:normal;text-align:center}
.mk span{position:absolute;left:100%;top:-3px;margin-left:6px;white-space:nowrap;color:#fff;font:700 10px/16px sans-serif;padding:1px 5px}
table{border-collapse:collapse;width:100%;font-size:9.5pt;margin:6px 0}
th,td{border:1px solid #E4E8EC;padding:5px 8px;text-align:left;vertical-align:top}
th{background:#F9FAFB;font-weight:700}
td.n,th.n{text-align:right;font-variant-numeric:tabular-nums;white-space:nowrap}
tr.ruim td{background:#FFF1F2}tr.bom td{background:#ECFDF5}
ul,ol{margin:4px 0 4px 18px;padding:0}li{margin:3px 0}
h2,h3{break-after:avoid;page-break-after:avoid}
.pb{page-break-before:always;break-before:page}
.ok{color:#047857}.ruim{color:#BE123C}
"""


def montar_css(rodape: str, alt_uma: float, alt_par: float) -> str:
    return (CSS.replace("__RODAPE__", css_string(rodape)).replace("__ALT_UMA__", f"{alt_uma:g}")
            .replace("__ALT_PAR__", f"{alt_par:g}").replace("__ALT_PAR_META__", f"{max(40.0, alt_par / 2 - 12):g}"))


def documento_html(titulo: str, rodape: str, corpo: str, alt_uma: float, alt_par: float, extra_meta: dict) -> str:
    metas = "".join(f'<meta name="{html.escape(k)}" content="{html.escape(str(v), quote=True)}">\n'
                    for k, v in extra_meta.items())
    return ("<!doctype html>\n<html lang=\"pt-BR\">\n<head>\n<meta charset=\"utf-8\">\n"
            f"<meta name=\"qa-provas-rodape\" content=\"{html.escape(rodape, quote=True)}\">\n{metas}"
            f"<title>{html.escape(titulo)}</title>\n<style>{montar_css(rodape, alt_uma, alt_par)}</style>\n"
            f"</head>\n<body>\n{corpo}\n</body>\n</html>\n")


# --------------------------------------------------------------------------------------- render

class Contexto:
    def __init__(self, base: Path, pasta_html: Path, pasta_provas: Path, prefixo: str, mapa_marcas: dict,
                 pastas: dict, max_largura: int, usar_pil: bool, permitir_faltando: bool):
        self.base = base
        self.pasta_html = pasta_html
        self.pasta_provas = pasta_provas
        self.prefixo = prefixo
        self.mapa_marcas = mapa_marcas
        self.pastas = pastas
        self.max_largura = max_largura
        self.usar_pil = usar_pil
        self.permitir_faltando = permitir_faltando
        self.n = 0
        self.avisos: list = []
        self.faltando: list = []
        self.imagens = 0
        self.geradas: list = []
        self.segredos = 0
        self.pares = 0
        self.marcas_perdidas: list = []


def bloco_faltando(caminho: Path, rotulo: str = "") -> str:
    return (f"<div class='faltando'>{MARCADOR_FALTANDO}: {html.escape(str(caminho))}"
            + (f"<br><span style='font-weight:400'>{html.escape(rotulo)}</span>" if rotulo else "") + "</div>")


def figura_html(ctx: Contexto, caminho: Path, rotulo: str, cor, conf, classe: str) -> str:
    """Modo sem Pillow: faixa e moldura em CSS, caixas sobrepostas em porcentagem."""
    dims = dimensoes_imagem(caminho)
    corhex = hex_cor(cor)
    caixas = ""
    if conf and conf["marcas"]:
        if not dims:
            ctx.avisos.append(f"{caminho.name}: nao consegui ler o tamanho da imagem; marcas omitidas")
        else:
            W, H = dims
            for i, m in enumerate(marcas_em_pixels(conf, W), 1):
                tinta = hex_cor(parse_cor(m["cor"])) if m.get("cor") else corhex
                left, top = 100 * m["x"] / W, 100 * m["y"] / H
                larg, alt = 100 * m["w"] / W, 100 * m["h"] / H
                if left > 100 or top > 100 or left + larg < 0 or top + alt < 0:
                    ctx.avisos.append(f"{caminho.name}: marca {i} fora da imagem; confira unidade e largura_css")
                    continue
                n = html.escape(str(m["n"]) if m.get("n") not in (None, "") else str(i))
                txt = (f"<span style='background:{tinta}'>{html.escape(str(m['texto']))}</span>"
                       if m.get("texto") else "")
                caixas += (f"<div class='mk' style='left:{left:.3f}%;top:{top:.3f}%;width:{larg:.3f}%;"
                           f"height:{alt:.3f}%;border-color:{tinta}'><i style='background:{tinta}'>{n}</i>{txt}</div>")
    src = html.escape(src_relativo(caminho, ctx.pasta_html), quote=True)
    faixa_html = f"<div class='faixa' style='background:{corhex}'>{fmt(rotulo)}</div>" if rotulo else ""
    return (f"<div class='fig' style='border-color:{corhex}'>{faixa_html}<div class='caixa-img'>"
            f"<img class='{classe}' src='{src}' alt='{html.escape(texto_puro(rotulo), quote=True)}'>{caixas}</div></div>")


def render_imagens(ctx: Contexto, prova: dict, cod: str, onde: str) -> str:
    estilo = f" style='max-height:{float(prova['altura_mm']):g}mm'" if prova.get("altura_mm") else ""
    if prova["tipo"] == "par":
        refs = [(prova["antes"], prova["rotulo_antes"], parse_cor(prova["cor_antes"]), prova["marcas_antes"],
                 prova.get("marcas_esperadas_antes")),
                (prova["depois"], prova["rotulo_depois"], parse_cor(prova["cor_depois"]), prova["marcas_depois"],
                 prova.get("marcas_esperadas_depois"))]
    else:
        refs = [(prova["img"], prova["rotulo"], parse_cor(prova["cor"]), prova["marcas"], prova.get("marcas_esperadas"))]
    resolvidas = []
    for ref, rotulo, cor, emb, esperadas in refs:
        caminho = resolver_imagem(ref, ctx.base, ctx.pastas)
        if not caminho.is_file():
            ctx.faltando.append(str(caminho))
            resolvidas.append((None, caminho, rotulo, cor, None))
            continue
        conf = marcas_para(ref, caminho, emb, ctx.mapa_marcas, prova.get("forcar_marcas", False), onde)
        if esperadas and not (conf and conf.get("marcas")):
            ctx.marcas_perdidas.append(f"{cod}: {caminho.name}")
        resolvidas.append((True, caminho, rotulo, cor, conf))
    if any(r[0] is None for r in resolvidas):
        if not ctx.permitir_faltando:
            return ""
        return "".join(bloco_faltando(r[1], r[2]) if r[0] is None else "" for r in resolvidas)
    ctx.n += 1
    ctx.imagens += 1
    if prova["tipo"] == "par":
        ctx.pares += 1
    if ctx.usar_pil:
        partes = []
        for _, caminho, rotulo, cor, conf in resolvidas:
            im = abrir_rgb(caminho, conf, cor, ctx.max_largura, ctx.avisos)
            if rotulo:
                im = faixa(im, texto_puro(rotulo), cor)
            partes.append(moldura(im, cor))
        if len(partes) == 1:
            comp = partes[0]
        else:
            vao = max(16, round(max(p.width for p in partes) / 100))
            comp = Image.new("RGB", (max(p.width for p in partes), sum(p.height for p in partes) + vao), "white")
            comp.paste(partes[0], (0, 0))
            comp.paste(partes[1], (0, partes[0].height + vao))
        destino = salvar_composta(comp, ctx.pasta_provas / f"{ctx.prefixo}-{ctx.n:02d}-{slug(cod, 24)}")
        ctx.geradas.append(destino)
        src = html.escape(src_relativo(destino, ctx.pasta_html), quote=True)
        alt = html.escape(" / ".join(texto_puro(r[2]) for r in resolvidas), quote=True)
        return f"<img class='{prova['tipo']}' src='{src}' alt='{alt}'{estilo}>"
    return "".join(figura_html(ctx, caminho, rotulo, cor, conf, prova["tipo"])
                   for _, caminho, rotulo, cor, conf in resolvidas)


def _marcas(linhas: list) -> int:
    return sum(l.count(_mascara.MARCA) for l in linhas)


def ler_arquivo_texto(caminho: Path, max_linhas: int, avisos: list | None = None) -> tuple:
    """Prova textual de arquivo. .json, .har, .jsonl e .ndjson sao carregados e passam INTEIROS por
    mascarar_estrutura (par nome/valor de cookie, cabecalho e queryString, JSON dentro de string, chave sensivel)
    antes de qualquer dump; depois o trecho mostrado (max_linhas) passa pela mascara de texto estrita. Conta como
    segredo do documento o que ficou nas linhas mostradas; o que a estrutura achou so nas omitidas vira aviso."""
    try:
        texto = caminho.read_text(encoding="utf-8-sig", errors="replace")
    except OSError:
        raise ErroUso(f"arquivo de prova textual nao encontrado: {caminho}")
    est = _mascara.estrutura_de_arquivo(texto, caminho.suffix)
    if est is not None:
        brutas, linhas = est[0].splitlines(), est[1].splitlines()
    else:
        brutas = linhas = texto.splitlines()
    mostradas, omitidas = linhas[:max_linhas], linhas[max_linhas:]
    n_estrutura = max(0, _marcas(mostradas) - _marcas(brutas[:max_linhas]))
    bloco, n_texto = mascarar_segredos("\n".join(mostradas))
    if not omitidas:
        return bloco, n_estrutura + n_texto
    nome, n_nome = mascarar_segredos(caminho.name)
    n_omitidas = max(0, _marcas(omitidas) - _marcas(brutas[max_linhas:]))
    if n_omitidas and avisos is not None:
        avisos.append(f"{nome}: {n_omitidas} segredo(s) nas linhas omitidas do arquivo (fora do PDF); mascare o "
                      f"arquivo da rodada, ele continua com o valor")
    return (bloco + "\n" + f"... ({len(omitidas)} linha(s) omitida(s); arquivo completo: {nome})",
            n_estrutura + n_texto + n_nome)


def celula(valor, cabecalho: bool) -> str:
    texto = valor if not isinstance(valor, dict) else valor.get("texto", "")
    classe = ""
    if isinstance(valor, dict) and valor.get("classe"):
        classe = valor["classe"]
    elif re.fullmatch(r"\s*[-+−]?[\d.,]+\s*(%|ms|s|KB|MB)?\s*", str(texto)):
        classe = "n"
    tag = "th" if cabecalho else "td"
    return f"<{tag}{f' class={chr(39)}{classe}{chr(39)}' if classe else ''}>{fmt(texto)}</{tag}>"


def render_tabela(prova: dict) -> str:
    if prova.get("html"):
        return str(prova["html"])
    linhas = prova["linhas"]
    saida = ["<table>"]
    for i, ln in enumerate(linhas):
        classe = ""
        if isinstance(ln, dict):
            classe = ln.get("classe", "")
            ln = ln.get("celulas", [])
        cab = i == 0 and prova.get("cabecalho", True)
        saida.append(f"<tr{f' class={chr(39)}{classe}{chr(39)}' if classe else ''}>"
                     + "".join(celula(c, cab) for c in ln) + "</tr>")
    saida.append("</table>")
    return "".join(saida)


def render_prova(ctx: Contexto, prova: dict, cod: str, onde: str) -> str:
    leg = f"<div class='leg'>{fmt(prova['legenda'])}</div>" if prova.get("legenda") else ""
    if prova["tipo"] in ("par", "uma"):
        corpo = render_imagens(ctx, prova, cod, onde)
        if not corpo:
            return ""
    elif prova["tipo"] == "cod":
        if prova.get("arquivo"):
            caminho = Path(prova["arquivo"]).expanduser()
            caminho = caminho if caminho.is_absolute() else ctx.base / caminho
            if not caminho.is_file():
                ctx.faltando.append(str(caminho))
                if not ctx.permitir_faltando:
                    return ""
                return (f"<div class='prova'><div class='faltando'>{MARCADOR_ARQ_FALTANDO}: "
                        f"{html.escape(str(caminho))}</div>{leg}</div>")
            texto, n_seg = ler_arquivo_texto(caminho, prova["max_linhas"], ctx.avisos)
            ctx.segredos += n_seg
            if not prova.get("legenda"):
                leg = f"<div class='leg'>{html.escape(prova['arquivo'])}</div>"
        else:
            texto, n_seg = mascarar_segredos(str(prova["texto"]))
            ctx.segredos += n_seg
        corpo = f"<pre>{html.escape(texto)}</pre>"
    else:
        corpo = render_tabela(prova)
    return f"<div class='prova'>{corpo}{leg}</div>"


def secao_lista(titulo: str, itens, vazio: str = "", classe: str = "") -> str:
    itens = lista_textos(itens)
    cab = f"<h2{f' class={chr(39)}{classe}{chr(39)}' if classe else ''}>{html.escape(titulo)}</h2>"
    if not itens:
        return cab + f"<p>{fmt(vazio)}</p>" if vazio else ""
    return cab + "<ul>" + "".join(f"<li>{fmt(x)}</li>" for x in itens) + "</ul>"


def render_item(ctx: Contexto, it: dict, pagina_nova: bool) -> str:
    rot = dict(ROTULOS_PADRAO)
    rot.update(ROTULOS_POR_STATUS.get(it["status"], {}))
    rot.update(it.get("rotulos") or {})
    rotulo_st, classe_st = STATUS[it["status"]]
    rotulo_st = it.get("status_rotulo") or rotulo_st
    classes = "item" + (" pb" if pagina_nova or it.get("pagina_nova") else "")
    tags = ""
    if it.get("tipo") and it["tipo"] not in ("defeito", it["status"]):
        tags += f"<span class='tag'>{html.escape(str(it['tipo']).replace('-', ' ').upper())}</span>"
    if it.get("severidade"):
        sev = str(it["severidade"]).lower()
        tags += f"<span class='tag sev-{sev}'>{html.escape(sev.upper())}</span>"
    h = [f"<div class='{classes}'><h3><span class='cod'>{html.escape(it['cod'])}</span>{fmt(it['titulo'])}"
         f"<span class='st st-{classe_st}'>{html.escape(rotulo_st)}</span>{tags}</h3><div class='lin'>"]
    if it.get("onde"):
        h.append(f"<div class='k'>{html.escape(rot['onde'])}</div><div>{fmt(it['onde'])}</div>")
    if it.get("antes"):
        h.append(f"<div class='k k-antes'>{html.escape(rot['antes'])}</div><div>{fmt(it['antes'])}</div>")
    if it.get("causa") and str(it["causa"]).strip() not in ("-", "—"):
        h.append(f"<div class='k'>{html.escape(rot['causa'])}</div><div>{fmt(it['causa'])}</div>")
    if it.get("depois"):
        h.append(f"<div class='k k-depois'>{html.escape(rot['depois'])}</div><div>{fmt(it['depois'])}</div>")
    detalhe = it.get("status_detalhe")
    h.append(f"<div class='k k-status'>{html.escape(rot['status'])}</div><div><b class='{'ok' if classe_st == 'ok' else 'ruim' if classe_st == 'ruim' else ''}'>"
             f"{html.escape(rotulo_st)}</b>{(' — ' + fmt(detalhe)) if detalhe else ''}</div>")
    h.append("</div>")
    for k, p in enumerate(it["provas"], 1):
        h.append(render_prova(ctx, p, it["cod"], f"item {it['cod']}.provas[{k}]"))
    if par_sem_imagem(it):
        ctx.pares += 1
    h.append("</div>")
    return "".join(h)


def comandos_texto(valor) -> str:
    if valor is None:
        return ""
    return "\n".join(valor) if isinstance(valor, (list, tuple)) else str(valor)


def gerar_corpo(s: dict, ctx: Contexto, arquivos: list, pagina_nova_itens: bool) -> str:
    corpo = ["<div class='capa'>"]
    if s.get("branch"):
        corpo.append(f"<div class='rotulo'>{html.escape(s.get('rotulo') or 'Branch')}</div>"
                     f"<div class='branch'>{html.escape(s['branch'])}</div>")
    elif s.get("rotulo"):
        corpo.append(f"<div class='rotulo'>{html.escape(s['rotulo'])}</div>")
    corpo.append(f"<h1 style='margin-top:12px'>{fmt(s['titulo'])}</h1>")
    if s.get("subtitulo"):
        corpo.append(f"<p class='sub'>{fmt(s['subtitulo'])}</p>")
    if s.get("resumo"):
        corpo.append(f"<p>{fmt(s['resumo'])}</p>")
    meta = []
    if s.get("repos"):
        meta.append(("Repositórios", " + ".join(lista_textos(s["repos"]))))
    if arquivos:
        meta.append(("Arquivos", str(len(arquivos))))
        meta.append(("Linhas", f"+{sum(a['mais'] for a in arquivos)} −{sum(a['menos'] for a in arquivos)}"))
    for m in s.get("metadados") or []:
        if isinstance(m, dict):
            meta.append((m.get("rotulo", ""), m.get("valor", "")))
        elif isinstance(m, (list, tuple)) and len(m) == 2:
            meta.append((m[0], m[1]))
    if isinstance(s.get("metadados"), dict):
        meta.extend(s["metadados"].items())
    if meta:
        corpo.append("<div class='meta'>" + "".join(f"<div>{html.escape(str(k))}<b>{fmt(v)}</b></div>" for k, v in meta)
                     + "</div>")
    detalhes = []
    if s.get("base"):
        detalhes.append(("Criar a partir de", s["base"]))
    if "depende" in s:
        dep = lista_textos(s["depende"])
        detalhes.append(("Depende de", ", ".join(dep) if dep else "nenhuma"))
    if s.get("ordem"):
        detalhes.append(("Ordem", s["ordem"]))
    for d in s.get("detalhes") or []:
        if isinstance(d, dict):
            detalhes.append((d.get("rotulo", ""), d.get("texto", "")))
    for k, v in detalhes:
        corpo.append(f"<div class='rotulo'>{html.escape(str(k))}</div><p>{fmt(v)}</p>")
    corpo.append("</div>")
    for a in lista_textos(s.get("alerta")):
        corpo.append(f"<div class='alerta'>{fmt(a)}</div>")
    for a in lista_textos(s.get("aviso")):
        corpo.append(f"<div class='aviso'>{fmt(a)}</div>")
    if arquivos:
        corpo.append("<h2>Arquivos</h2><table><tr><th>Repositório</th><th>Arquivo</th><th class='n'>+</th><th class='n'>−</th></tr>")
        for a in arquivos:
            corpo.append(f"<tr><td>{html.escape(a['repo'])}</td><td><code>{html.escape(a['arquivo'])}</code></td>"
                         f"<td class='n'>{a['mais']}</td><td class='n'>{a['menos']}</td></tr>")
        corpo.append("</table>")
    corpo.append(f"<h2>{html.escape(s.get('titulo_itens') or 'O que muda, com as provas')}</h2>")
    if not s["itens"]:
        corpo.append(f"<p>{fmt(s.get('_sem_itens_texto') or 'Nenhum item.')}</p>")
    for i, it in enumerate(s["itens"]):
        corpo.append(render_item(ctx, it, pagina_nova_itens and i > 0))
    if "nao_validado" in s:
        corpo.append(secao_lista("O que ainda não foi validado", s["nao_validado"],
                                 "Nenhum: todos os itens deste documento têm prova acima."))
    else:
        corpo.append("<h2>O que ainda não foi validado</h2><p><b>Não informado.</b> Esta seção nunca se corta: "
                     "declare o que ficou sem prova e por quê.</p>")
    corpo.append(secao_lista("Atenção do revisor (decisão do time)", s.get("atencao")))
    corpo.append(secao_lista("Fora deste documento (não corrigido aqui)", s.get("fora")))
    for sec in s.get("secoes_extra") or []:
        if not isinstance(sec, dict):
            continue
        if sec.get("itens") is not None:
            corpo.append(secao_lista(sec.get("titulo", ""), sec["itens"], sec.get("vazio", "Nenhum.")))
        else:
            corpo.append(f"<h2>{html.escape(sec.get('titulo', ''))}</h2>")
            if sec.get("texto"):
                corpo.append(f"<p>{fmt(sec['texto'])}</p>")
            if sec.get("pre"):
                corpo.append(f"<pre>{html.escape(comandos_texto(sec['pre']))}</pre>")
    cmds = comandos_texto(s.get("comandos"))
    if cmds:
        corpo.append(f"<h2 class='pb'>{html.escape(s.get('titulo_comandos') or 'Como aplicar')}</h2>")
        aviso = s.get("aviso_aplicar", "Os arquivos são <b>patches</b>: aplicam só as linhas deste documento, mesmo quando o "
                                       "arquivo também tem mudanças de outro assunto. Use `git apply` com o patch; "
                                       "<b>não copie arquivos inteiros</b>.")
        if aviso:
            corpo.append(f"<div class='aviso'>{fmt(aviso)}</div>")
        corpo.append(f"<pre>{html.escape(cmds)}</pre>")
    commit = s.get("commit")
    if isinstance(commit, dict):
        for repo, msg in commit.items():
            corpo.append(f"<h2>Mensagem de commit — {html.escape(str(repo))}</h2><pre>{html.escape(str(msg))}</pre>")
    elif commit:
        corpo.append(f"<h2>Mensagem de commit</h2><pre>{html.escape(str(commit))}</pre>")
    if commit:
        corpo.append("<p><b>Nada foi commitado:</b> quem cria a branch, commita e sobe é quem recebe este documento.</p>")
    corpo.append(secao_lista("Verificação feita", s.get("verificacao")))
    return "".join(corpo)


def gerar_pr(s: dict, caminho: Path, nome_pdf: str) -> None:
    destino = (s.get("pr") or {}).get("destino", "develop") if isinstance(s.get("pr"), dict) else "develop"
    linhas = [f"# {texto_puro(s['titulo'])}", ""]
    if s.get("branch"):
        linhas += [f"Branch: `{s['branch']}` → `{destino}`", ""]
    if s.get("resumo"):
        linhas += [md(s["resumo"]), ""]
    linhas += ["## O que muda", ""]
    for it in s["itens"]:
        rot, _ = STATUS[it["status"]]
        linhas.append(f"- **{it['cod']} {md(it['titulo'])}** ({rot.lower()}) — {md(it.get('depois') or it.get('antes') or '')}")
    linhas += ["", "## Ainda não validado", ""]
    nv = lista_textos(s.get("nao_validado"))
    linhas += [f"- {md(x)}" for x in nv] if nv else ["- Nada: todos os itens têm prova no PDF."]
    for chave, titulo in (("atencao", "Atenção do revisor"), ("fora", "Fora deste PR")):
        if lista_textos(s.get(chave)):
            linhas += ["", f"## {titulo}", ""] + [f"- {md(x)}" for x in lista_textos(s[chave])]
    dep = lista_textos(s.get("depende"))
    if dep:
        linhas += ["", "## Depende de", ""] + [f"- {md(x)}" for x in dep]
    linhas += ["", f"Provas (prints antes/depois): `{nome_pdf}`"]
    escrever_texto(caminho, "\n".join(linhas) + "\n")


# ------------------------------------------------------------------------------------- navegador / pdf

def _modulo_gerar_pdf():
    if str(AQUI) not in sys.path:
        sys.path.insert(0, str(AQUI))
    try:
        import gerar_pdf as gp
        if all(hasattr(gp, n) for n in ("localizar_navegador", "imprimir_pdf")):
            return gp
    except Exception:
        return None
    return None


def _candidatos_navegador() -> list:
    lista = [os.environ["QA_CHROME"]] if os.environ.get("QA_CHROME") else []
    for nome in ("google-chrome", "google-chrome-stable", "chrome", "chromium", "chromium-browser", "msedge",
                 "microsoft-edge", "microsoft-edge-stable", "brave", "brave-browser"):
        achado = shutil.which(nome)
        if achado:
            lista.append(achado)
    if sys.platform.startswith("win"):
        for raiz in (os.environ.get(v) for v in ("PROGRAMFILES", "PROGRAMFILES(X86)", "LOCALAPPDATA", "PROGRAMW6432")):
            if raiz:
                lista += [os.path.join(raiz, r) for r in (r"Google\Chrome\Application\chrome.exe",
                                                           r"Microsoft\Edge\Application\msedge.exe",
                                                           r"BraveSoftware\Brave-Browser\Application\brave.exe",
                                                           r"Chromium\Application\chrome.exe")]
    elif sys.platform == "darwin":
        lista += ["/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
                  "/Applications/Chromium.app/Contents/MacOS/Chromium",
                  "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge",
                  "/Applications/Brave Browser.app/Contents/MacOS/Brave Browser"]
    else:
        lista += ["/usr/bin/google-chrome", "/usr/bin/chromium", "/usr/bin/chromium-browser", "/snap/bin/chromium",
                  "/usr/bin/microsoft-edge", "/usr/bin/brave-browser"]
    return lista + _chromium_do_playwright()


def _chromium_do_playwright() -> list:
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
        m = re.search(r"chromium-(\d+)", caminho.replace(chr(92), "/"))
        return int(m.group(1)) if m else 0
    return sorted(achados, key=versao, reverse=True)


TIMEOUT_PRIMEIRA = 30
ARQUIVO_MODO = "qa-total-headless-modo.json"


def _modo_lembrado(exe: str) -> str:
    try:
        dados = json.loads((Path(tempfile.gettempdir()) / ARQUIVO_MODO).read_text(encoding="utf-8"))
        modo = dados.get(os.path.normcase(os.path.abspath(exe))) if isinstance(dados, dict) else ""
    except (OSError, ValueError):
        return ""
    return modo if modo in ("--headless=new", "--headless") else ""


def _lembrar_modo(exe: str, modo: str) -> None:
    arq = Path(tempfile.gettempdir()) / ARQUIVO_MODO
    try:
        dados = json.loads(arq.read_text(encoding="utf-8"))
        dados = dados if isinstance(dados, dict) else {}
    except (OSError, ValueError):
        dados = {}
    dados[os.path.normcase(os.path.abspath(exe))] = modo
    try:
        tmp = arq.with_name(arq.name + f".{os.getpid()}.tmp")
        tmp.write_text(json.dumps(dados, ensure_ascii=False, indent=1) + "\n", encoding="utf-8")
        os.replace(tmp, arq)
    except OSError:
        pass


def _pdf_pronto(caminho: Path) -> int:
    try:
        tamanho = caminho.stat().st_size
        if tamanho <= 0:
            return 0
        with open(caminho, "rb") as f:
            f.seek(max(0, tamanho - 2048))
            return tamanho if b"%%EOF" in f.read() else 0
    except OSError:
        return 0


def _encerrar(proc) -> None:
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


def _rodar_ate_o_pdf(cmd: list, temp: Path, limite: float) -> bool:
    try:
        proc = subprocess.Popen(cmd, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    except OSError:
        return False
    inicio, anterior = time.monotonic(), 0
    try:
        while True:
            tamanho = _pdf_pronto(temp)
            if tamanho and tamanho == anterior:
                return True
            anterior = tamanho
            if proc.poll() is not None:
                time.sleep(0.3)
                return bool(_pdf_pronto(temp))
            if time.monotonic() - inicio > limite:
                return False
            time.sleep(1)
    finally:
        _encerrar(proc)


def imprimir(html_path: Path, pdf: Path, navegador: str | None, espera_ms: int, timeout: int,
             timeout_primeira: int = TIMEOUT_PRIMEIRA):
    """Devolve (codigo, info). Usa scripts/gerar_pdf.py quando existe; senao, a copia minima abaixo (mesma
    estrategia: PDF conferido a cada 1 s, primeira tentativa curta, modo que funcionou lembrado)."""
    gp = _modulo_gerar_pdf()
    if gp is not None:
        try:
            exe = gp.localizar_navegador(navegador)
            try:
                ok, info = gp.imprimir_pdf(exe, html_path, pdf, espera_ms, timeout, timeout_primeira)
            except TypeError:
                ok, info = gp.imprimir_pdf(exe, html_path, pdf, espera_ms, timeout)
        except SystemExit as e:
            codigo = e.code if isinstance(e.code, int) else EXIT_FALHA_PDF
            return (EXIT_SEM_NAVEGADOR if codigo == 3 else EXIT_FALHA_PDF), "veja a mensagem acima"
        return (EXIT_OK, f"{Path(exe).name} {info}") if ok else (EXIT_FALHA_PDF, info)
    exe = None
    if navegador:
        exe = shutil.which(navegador) or navegador
        if not Path(exe).is_file():
            return EXIT_SEM_NAVEGADOR, f"navegador informado nao existe: {navegador}"
    else:
        exe = next((c for c in _candidatos_navegador() if Path(c).is_file()), None)
    if not exe:
        return EXIT_SEM_NAVEGADOR, "nenhum Chrome/Edge/Chromium/Brave encontrado (use --navegador ou QA_CHROME)"
    perfil = tempfile.mkdtemp(prefix="qa-provas-perfil-")
    temp = Path(tempfile.mkdtemp(prefix="qa-provas-pdf-")) / "saida.pdf"
    lembrado = _modo_lembrado(exe)
    modos = [lembrado] + [m for m in ("--headless=new", "--headless") if m != lembrado] if lembrado else \
        ["--headless=new", "--headless"]
    try:
        for i, modo in enumerate(modos):
            limite = timeout if i > 0 else min(timeout, max(5, timeout_primeira))
            try:
                temp.unlink()
            except OSError:
                pass
            cmd = [exe, modo, "--disable-gpu", "--no-first-run", "--no-default-browser-check", "--disable-extensions",
                   f"--user-data-dir={perfil}", "--no-pdf-header-footer", "--print-to-pdf-no-header",
                   f"--print-to-pdf={temp}", f"--virtual-time-budget={espera_ms}", html_path.resolve().as_uri()]
            if _rodar_ate_o_pdf(cmd, temp, limite):
                _lembrar_modo(exe, modo)
                pdf.parent.mkdir(parents=True, exist_ok=True)
                for _ in range(5):
                    try:
                        shutil.move(str(temp), str(pdf))
                        return EXIT_OK, f"{Path(exe).name} {modo}"
                    except PermissionError:
                        time.sleep(0.6)
                return EXIT_FALHA_PDF, f"nao consegui gravar {pdf}: o arquivo esta aberto em outro programa?"
        return EXIT_FALHA_PDF, "o navegador nao gerou o PDF"
    finally:
        shutil.rmtree(perfil, ignore_errors=True)
        shutil.rmtree(temp.parent, ignore_errors=True)


def _sem_espaco(t: str) -> str:
    """Compara so letras e numeros: o PDF extrai o ponto medio como U+2219 e o espaco como NBSP."""
    return re.sub(r"[\W_]+", "", t or "").lower()


def garantir_rodape(pdf: Path, rodape: str) -> str:
    """Se o navegador nao imprimiu as margens de @page (Chrome < 131), carimba rodape e N / M com PyMuPDF."""
    fz = pymupdf_mod()
    if fz is None:
        return "rodape nao conferido (PyMuPDF ausente): abra o PDF e confira o rodape em toda pagina"
    doc = fz.open(str(pdf))
    try:
        if len(doc) == 0:
            return "PDF sem paginas"
        alvo = _sem_espaco(rodape)[:24]
        presentes = sum(1 for p in doc if alvo and alvo in _sem_espaco(p.get_text()))
        if presentes == len(doc):
            return f"rodape presente em {presentes}/{len(doc)} pagina(s)"
        fonte_mono = next((c for c in FONTES_MONO.get(chave_so(), []) if os.path.isfile(c)), None)
        total = len(doc)
        for i, pag in enumerate(doc, 1):
            r = pag.rect
            kw = {"fontsize": 8, "color": (0.36, 0.42, 0.5)}
            if fonte_mono:
                kw.update(fontname="qamono", fontfile=fonte_mono)
            else:
                kw.update(fontname="cour")
            pag.insert_text((40, r.height - 24), rodape, **kw)
            num = f"{i} / {total}"
            try:
                larg = fz.get_text_length(num, fontname="cour", fontsize=8)
            except Exception:
                larg = len(num) * 4.8
            pag.insert_text((r.width - 40 - larg, r.height - 24), num, **kw)
        temp = pdf.with_name(pdf.stem + ".carimbando.pdf")
        doc.save(str(temp), garbage=3, deflate=True)
    finally:
        doc.close()
    os.replace(temp, pdf)
    return f"rodape carimbado com PyMuPDF (o navegador nao imprimiu as margens da pagina em {total - presentes} pagina(s))"


# ------------------------------------------------------------------------------------------ conferir

def pasta_padrao_conferir(pdf: Path) -> Path:
    """PDF dentro de uma rodada (<rodada>/relatorio/..., com cobertura.json na rodada): <rodada>/relatorio/conferir/
    <nome do pdf>/, que fica com a rodada. Fora de rodada: pasta temporaria do sistema com um hash curto do caminho
    absoluto, para dois PDFs de mesmo nome (rodada completa e reteste, blocos diferentes) nao se sobrescreverem."""
    import hashlib
    alvo = pdf.expanduser().resolve()
    for anc in alvo.parents:
        if anc.name.lower() == "relatorio" and (anc.parent / "cobertura.json").is_file():
            return anc / "conferir" / slug(alvo.stem, 60)
    marca = hashlib.sha1(os.path.normcase(str(alvo)).encode("utf-8", "replace")).hexdigest()[:8]
    return Path(tempfile.gettempdir()) / "qa-provas-conferir" / f"{slug(alvo.stem, 50)}-{marca}"


def conferir(pdf: Path, html_path: Path | None, rodape: str | None, dpi: int, saida_dir: Path | None,
             paginas: str | None, exigir_render: bool, grade_colunas: int = 4, sem_itens: str | None = None):
    problemas, avisos, linhas, pngs = [], [], [], []
    html_txt = ""
    if html_path is None:
        candidato = pdf.with_suffix(".html")
        html_path = candidato if candidato.is_file() else None
    if html_path is not None:
        html_txt = html_path.read_text(encoding="utf-8", errors="replace")
        if rodape is None:
            m = re.search(r'<meta name="qa-provas-rodape" content="([^"]*)"', html_txt)
            if m:
                rodape = html.unescape(m.group(1))
        for padrao, nome in ((r"\{\{[^}]*\}\}", "placeholder {{...}}"), (MARCADOR_FALTANDO, "imagem faltando"),
                             (MARCADOR_ARQ_FALTANDO, "arquivo de prova textual faltando"),
                             (MARCADOR_NAO_EMBUTIDO, "evidencia referenciada que ficou fora do documento"),
                             (MARCADOR_FORA_RODADA, "evidencia fora de evidencias/, rede/, notas/ ou relatorio/ "
                                                    "da rodada (nao lida)")):
            achados = re.findall(padrao, html_txt)
            if achados:
                problemas.append(f"HTML: {len(achados)} {nome}: {', '.join(sorted(set(achados))[:5])}")
        metas = {k: html.unescape(v) for k, v in re.findall(r'<meta name="(qa-provas-[a-z-]+)" content="([^"]*)"',
                                                            html_txt)}
        perdidas = (metas.get("qa-provas-marcas-perdidas") or "").strip()
        if perdidas:
            problemas.append(f"imagem(ns) com marcas no ledger ou no mapa e nenhuma caixa no documento: {perdidas} "
                             f"(a spec salva perdeu o mapa? copie a chave \"marcas\" junto com os \"itens\")")
        if "qa-provas-itens" in metas and "qa-provas-blocos" not in metas:
            ressalva = (sem_itens or metas.get("qa-provas-sem-itens") or "").strip()
            try:
                n_itens = int(metas.get("qa-provas-itens") or 0)
            except ValueError:
                n_itens = 0
            if "qa-provas-pares" in metas:
                try:
                    n_pares = int(metas.get("qa-provas-pares") or 0)
                except ValueError:
                    n_pares = 0
            else:
                n_pares = len(re.findall(r"<img class='par'", html_txt))
            linhas.append(f"provas: {n_itens} item(ns), {n_pares} par(es) ANTES/DEPOIS")
            if n_itens == 0 and not ressalva:
                problemas.append('nenhum item com prova ANTES/DEPOIS (bloco sem defeito? gere com --sem-itens "<motivo>")')
            elif n_pares == 0 and not ressalva:
                problemas.append('nenhum par ANTES/DEPOIS no documento (so decisao, proposta ou retratacao? '
                                 '--sem-itens "<motivo>" registra o porque no PDF)')
        imgs = re.findall(r"<img[^>]+src=['\"]([^'\"]+)['\"]", html_txt)
        faltam = []
        for src in imgs:
            if src.startswith(("data:", "http://", "https://")):
                continue
            from urllib.parse import unquote, urlparse
            from urllib.request import url2pathname
            if src.startswith("file:"):
                alvo = Path(url2pathname(urlparse(src).path))
            else:
                alvo = html_path.parent / unquote(src)
            if not alvo.is_file():
                faltam.append(src)
        if faltam:
            problemas.append(f"HTML: {len(faltam)} imagem(ns) sem arquivo: {', '.join(faltam[:5])}")
        linhas.append(f"HTML {html_path.name}: {len(imgs)} imagem(ns) referenciada(s), {len(imgs) - len(faltam)} no disco")
    if not pdf.is_file():
        problemas.append(f"PDF nao encontrado: {pdf}")
        return problemas, avisos, linhas, pngs
    fz = pymupdf_mod()
    if fz is None:
        msg = "PyMuPDF ausente: paginas nao renderizadas (pip install pymupdf). Abra o PDF e olhe pagina a pagina."
        (problemas if exigir_render else avisos).append(msg)
        gp = _modulo_gerar_pdf()
        if gp is not None and hasattr(gp, "contar_paginas"):
            n, _ = gp.contar_paginas(pdf)
            linhas.append(f"PDF {pdf.name}: {n or '?'} pagina(s)")
        return problemas, avisos, linhas, pngs
    doc = fz.open(str(pdf))
    total = len(doc)
    alvo_rod = _sem_espaco(rodape)[:24] if rodape else ""
    sem_rodape, sem_numero, total_imgs = [], [], 0
    for i, pag in enumerate(doc, 1):
        texto = pag.get_text()
        if "{{" in texto:
            problemas.append(f"pagina {i}: placeholder {{{{...}}}} no texto")
        for marcador in (MARCADOR_FALTANDO, MARCADOR_ARQ_FALTANDO, MARCADOR_NAO_EMBUTIDO, MARCADOR_FORA_RODADA):
            if marcador in texto:
                problemas.append(f"pagina {i}: {marcador}")
        if alvo_rod and alvo_rod not in _sem_espaco(texto):
            sem_rodape.append(i)
        if not re.search(rf"\b{i}\s*/\s*{total}\b", texto):
            sem_numero.append(i)
        total_imgs += len(pag.get_images(full=True))
    if sem_rodape:
        problemas.append(f"rodape ausente em {len(sem_rodape)} pagina(s): {sem_rodape[:12]}")
    if sem_numero:
        problemas.append(f'"N / {total}" ausente em {len(sem_numero)} pagina(s): {sem_numero[:12]}')
    n_html = len(re.findall(r"<img\b", html_txt)) if html_txt else None
    if n_html is not None and n_html > 0 and total_imgs == 0:
        problemas.append(f"o HTML tem {n_html} imagem(ns) e o PDF nenhuma: imagens nao carregaram na impressao")
    elif n_html is not None and total_imgs < n_html:
        avisos.append(f"PDF com {total_imgs} imagem(ns) para {n_html} no HTML (imagem repetida conta uma vez; confira)")
    linhas.append(f"PDF {pdf.name}: {total} pagina(s), {total_imgs} imagem(ns)"
                  + (f", rodape '{rodape}'" if rodape else ""))
    escolhidas = list(range(1, total + 1))
    if paginas and paginas != "todas":
        escolhidas = []
        for parte in paginas.split(","):
            parte = parte.strip()
            if "-" in parte:
                a, b = parte.split("-", 1)
                escolhidas += list(range(int(a), int(b) + 1))
            elif parte:
                escolhidas.append(int(parte))
        escolhidas = [p for p in escolhidas if 1 <= p <= total]
    if saida_dir is None:
        saida_dir = pasta_padrao_conferir(pdf)
    saida_dir.mkdir(parents=True, exist_ok=True)
    for velho in saida_dir.glob("pagina-*.png"):
        velho.unlink()
    for velho in saida_dir.glob("grade*.png"):
        velho.unlink()
    for p in escolhidas:
        destino = saida_dir / f"pagina-{p:02d}.png"
        doc[p - 1].get_pixmap(dpi=dpi).save(str(destino))
        pngs.append(destino)
    doc.close()
    if TEM_PIL and pngs:
        por_grade = grade_colunas * 4
        for g in range(0, len(pngs), por_grade):
            ims = [Image.open(x).convert("RGB") for x in pngs[g:g + por_grade]]
            w, h = max(i.width for i in ims), max(i.height for i in ims)
            col = min(grade_colunas, len(ims))
            filas = (len(ims) + col - 1) // col
            grade = Image.new("RGB", (col * (w + 8) + 8, filas * (h + 8) + 8), (200, 205, 212))
            for k, im in enumerate(ims):
                grade.paste(im, (8 + (k % col) * (w + 8), 8 + (k // col) * (h + 8)))
            nome = saida_dir / (f"grade-{g // por_grade + 1:02d}.png" if len(pngs) > por_grade else "grade.png")
            grade.save(nome, optimize=True)
            pngs.append(nome)
    return problemas, avisos, linhas, pngs


def imprimir_conferencia(problemas, avisos, linhas, pngs) -> int:
    for ln in linhas:
        print(ln)
    for a in avisos:
        print(f"aviso: {a}")
    for p in problemas:
        print(f"PROBLEMA: {p}")
    grades = [p for p in pngs if p.name.startswith("grade")]
    if pngs:
        print(f"paginas renderizadas em: {pngs[0].parent}")
        if grades:
            print("olhe primeiro: " + ", ".join(str(g) for g in grades))
            print(f"grade: {grades[0]}")
    print("conferencia: " + ("REPROVOU" if problemas else "ok") +
          " (olhe as paginas: par legivel, caixa no ponto certo, rodape e N / M em toda pagina)")
    if problemas and all(p.startswith("PyMuPDF ausente") for p in problemas):
        return EXIT_DEPENDENCIA
    return EXIT_CONFERENCIA if problemas else EXIT_OK


# ------------------------------------------------------------------------------------------ ledger

def eh_ledger(dados) -> bool:
    return isinstance(dados, dict) and "defeitos" in dados and ("casos" in dados or "rodada" in dados)


def localizar_ledger(entrada: Path) -> Path:
    if entrada.is_dir():
        p = entrada / "cobertura.json"
        if not p.is_file():
            raise ErroUso(f"nao achei cobertura.json em {entrada}")
        return p
    return entrada


def _evid_lista(v) -> list:
    if v is None:
        return []
    return v if isinstance(v, list) else [v]


def _evid_caminho(e):
    if isinstance(e, str):
        return e
    if isinstance(e, dict):
        return _primeiro(e, "arquivo", "caminho", "path")
    return None


def _resolver_evidencia(rel: str, rodada: Path) -> Path:
    p = Path(rel).expanduser()
    if p.is_absolute():
        return p
    for cand in (rodada / p, rodada / "evidencias" / p.name, rodada / "rede" / p.name):
        if cand.is_file():
            return cand
    return rodada / p


SUBPASTAS_LINK_AVISADAS: set = set()


def _mesmo_caminho(a: Path, b: Path) -> bool:
    return os.path.normcase(str(a)) == os.path.normcase(str(b))


def dentro_da_rodada(p: Path, rodada: Path) -> bool:
    """Evidencia so e lida se resolve dentro de evidencias/, rede/, notas/ ou relatorio/ da rodada. Link simbolico
    que aponta para fora conta como fora; subpasta que e link ou junction (resolve para outro lugar) tambem, com
    aviso unico."""
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


def evidencia_permitida(rel: str, rodada: Path) -> bool:
    if ".." in Path(str(rel).replace("\\", "/")).parts:
        return False
    return dentro_da_rodada(_resolver_evidencia(rel, rodada), rodada)


def _mesmo_arquivo(a: Path, b: Path) -> bool:
    def norm(x: Path) -> str:
        s = os.path.normcase(os.path.abspath(str(x)))
        return re.sub(r"-circulado(?=\.[^.\\/]+$)", "", s)
    return norm(a) == norm(b)


def _citado_em(p: Path, casos_x: list, rodada: Path) -> bool:
    for c in casos_x:
        for e in _evid_lista(c.get("evidencias")):
            rel = _evid_caminho(e)
            if rel and _mesmo_arquivo(_resolver_evidencia(rel, rodada), p):
                return True
    return False


def eh_texto_utf8(p: Path) -> bool:
    try:
        with open(p, "rb") as f:
            amostra = f.read(65536)
    except OSError:
        return False
    if b"\x00" in amostra:
        return False
    try:
        amostra.decode("utf-8")
        return True
    except UnicodeDecodeError as e:
        return e.start >= len(amostra) - 3


def _preferir_circulado(p: Path) -> Path:
    if "-circulado" in p.stem:
        return p
    circ = p.with_name(f"{p.stem}-circulado{p.suffix}")
    return circ if circ.is_file() else p


def _desc_do_nome(p: Path) -> str:
    s = re.sub(r"^\d+[-_]", "", p.stem)
    s = re.sub(r"(?i)-(antes|corrigido|reteste|depois|circulado)\b", "", s)
    return s.replace("-", " ").replace("_", " ").strip()


def _defeitos_do_caso(c: dict) -> list:
    """defeito_id e, quando o caso cobre varios defeitos (add-caso --defeito repetido), defeito_ids."""
    saida = []
    for v in [c.get("defeito_id")] + _evid_lista(c.get("defeito_ids")):
        t = str(v or "").strip()
        if t and t not in saida:
            saida.append(t)
    return saida


def _eh_caso_de_gate(c: dict, itens_por_id: dict) -> bool:
    if str(c.get("tecnica") or "") == "estatico":
        return True
    iid = str(c.get("item_id") or "")
    if iid.startswith("estatico:"):
        return True
    it = itens_por_id.get(iid) or {}
    return str(it.get("tipo") or "") == "estatico"


def _titulo_curto(c: dict, limite: int = 70) -> str:
    t = re.sub(r"\s+", " ", str(c.get("titulo") or "")).strip()
    return t if len(t) <= limite else t[:limite - 1] + "…"


def _sem_acento(texto: str) -> str:
    import unicodedata
    t = unicodedata.normalize("NFKD", str(texto or ""))
    return "".join(ch for ch in t if not unicodedata.combining(ch)).lower()


def _ler_nota_correcao(rodada_dir: Path) -> str:
    pasta = rodada_dir / "notas"
    if not pasta.is_dir():
        return ""
    partes = []
    for arq in sorted(pasta.glob("07-correcao*.md")):
        try:
            partes.append(arq.read_text(encoding="utf-8-sig", errors="replace"))
        except OSError:
            continue
    return "\n".join(partes)


def _veredito_da_nota(texto: str, did: str):
    """(linha, 'resolveu' | 'precisa-de-ajuste') da nota 07 com o id do defeito e o veredito; senao (None, None).
    Procura primeiro a linha que tem os dois; depois o trecho que vai da citacao do id ate a de outro defeito."""
    if not texto or not did:
        return None, None
    rx_id = re.compile(r"(?<![\w-])" + re.escape(did) + r"(?![\w-])")

    def qual(linha):
        n = _sem_acento(linha)
        if "precisa de ajuste" in n:
            return "precisa-de-ajuste"
        if "resolveu" in n:
            return "resolveu"
        return None

    def limpa(linha):
        t = re.sub(r"^[\s#>*|`-]+", "", linha)
        t = re.sub(r"\s+", " ", t.replace("**", "").replace("`", "")).strip(" |")
        t, _ = mascarar_segredos(t)
        return t if len(t) <= 220 else t[:219] + "…"

    linhas = texto.splitlines()
    for linha in linhas:
        if rx_id.search(linha) and qual(linha):
            return limpa(linha), qual(linha)
    dentro = False
    for linha in linhas:
        ids = re.findall(r"\bD-\d{3,}\b", linha)
        if did in ids:
            dentro = True
        elif ids:
            dentro = False
        if dentro and qual(linha):
            return limpa(linha), qual(linha)
    return None, None


def _registros_git(rod: dict) -> list:
    regs = rod.get("git")
    return [regs] if isinstance(regs, dict) else [g for g in (regs or []) if isinstance(g, dict)]


def _assunto_do_commit(rodada_dir: Path, commit: str) -> str:
    """Assunto do commit (git log -1 --format=%s, so leitura); vazio quando o git nao esta acessivel."""
    if not commit or commit.startswith("-") or not re.fullmatch(r"[0-9A-Za-z._/@~^-]{4,80}", commit):
        return ""
    env = {k: v for k, v in os.environ.items() if not k.startswith("GIT_")}
    env["GIT_OPTIONAL_LOCKS"] = "0"
    env["GIT_TERMINAL_PROMPT"] = "0"
    try:
        r = subprocess.run(["git", "-C", str(rodada_dir), "log", "-1", "--no-color", "--format=%s", commit, "--"],
                           capture_output=True, timeout=10, env=env)
    except (OSError, subprocess.SubprocessError):
        return ""
    if r.returncode != 0:
        return ""
    assunto = r.stdout.decode("utf-8", "replace").strip().splitlines()
    return mascarar_segredos(assunto[0])[0] if assunto else ""


def _correcao_de_terceiro(rod: dict, rodada_dir: Path) -> str:
    partes = []
    for g in _registros_git(rod):
        commit = str(g.get("commit") or "").strip()
        if not commit:
            continue
        rotulo = (f"{g.get('repo')} " if g.get("repo") else "") + f"`{commit[:12]}`"
        if g.get("branch"):
            rotulo += f" ({g.get('branch')})"
        assunto = _assunto_do_commit(rodada_dir, commit)
        partes.append(rotulo + (f" — {assunto}" if assunto else ""))
    if not partes:
        return ("correção de terceiro: commit não registrado em rodada.git "
                "(cobertura.py rodada --git repo|branch|commit)")
    return "correção de terceiro: " + "; ".join(partes)


def spec_do_ledger(dados: dict, rodada_dir: Path, filtros: dict) -> dict:
    rod = dados.get("rodada") or {}
    casos = [c for c in dados.get("casos") or [] if isinstance(c, dict)]
    itens_por_id = {str(i.get("id")): i for i in dados.get("itens") or [] if isinstance(i, dict)}
    rid_rodada = str(rod.get("id") or rodada_dir.name)
    nota_correcao = None
    avisos_ledger = []
    defeitos = [d for d in dados.get("defeitos") or [] if isinstance(d, dict)]
    if filtros.get("defeitos"):
        quer = set(filtros["defeitos"])
        defeitos = [d for d in defeitos if d.get("id") in quer]
        faltam = quer - {d.get("id") for d in defeitos}
        if faltam:
            raise ErroUso(f"defeito(s) inexistente(s) no ledger: {', '.join(sorted(faltam))}")
    if filtros.get("tipos"):
        defeitos = [d for d in defeitos if (d.get("tipo") or "defeito") in filtros["tipos"]]
    if filtros.get("status"):
        defeitos = [d for d in defeitos if d.get("status") in filtros["status"]]
    ordem = {"retestado-ok": 0, "corrigido": 1, "nao-corrigido": 2, "aberto": 3}
    grupo = {"decisao-de-produto": 1, "retratado": 2}
    defeitos.sort(key=lambda d: (grupo.get(d.get("tipo") or "defeito", 0), ordem.get(d.get("status"), 4),
                                 str(d.get("id"))))
    itens = []
    nao_embutidos = []
    fora_da_rodada = []
    for d in defeitos:
        did = d.get("id", "?")
        tipo = d.get("tipo") or "defeito"
        st = d.get("status") or "aberto"
        if tipo == "retratado":
            status = "retratado"
        elif tipo == "decisao-de-produto" and st in ("nao-corrigido", "aberto"):
            status = "decisao-de-produto"
        else:
            status = SINONIMOS_STATUS.get(st, st) if SINONIMOS_STATUS.get(st, st) in STATUS else "aberto"
        ligados = [c for c in casos if did in _defeitos_do_caso(c)]
        falhos = [c for c in ligados if c.get("status") in ("falhou", "retratado")]
        gates = [c for c in ligados if _eh_caso_de_gate(c, itens_por_id) and c.get("tecnica") != "regressao"]
        retestes = [c for c in ligados
                    if c not in gates and (c.get("status") == "passou" or c.get("tecnica") == "regressao")]
        terceiro = (bool(str(d.get("importado_de") or "").strip()) and st == "retestado-ok" and tipo != "retratado"
                    and str(d.get("corrigido_em_rodada") or "") != rid_rodada)
        antes = d.get("antes_texto") or d.get("sintoma")
        if not antes:
            partes = []
            originais = [c for c in falhos if c.get("tecnica") != "regressao"] or falhos
            for c in originais or ligados[:1]:
                txt = f"{c.get('id')} {c.get('titulo') or ''}".strip()
                if c.get("resultado_esperado"):
                    txt += f" — esperado: {c['resultado_esperado']}"
                if c.get("resultado_obtido"):
                    txt += f"; obtido: {c['resultado_obtido']}"
                partes.append(txt)
            antes = "\n".join(partes) or d.get("titulo", "")
        detalhe = []
        just = str(d.get("justificativa") or "").strip()
        if just and not (terceiro and re.match(r"\s*(proposta\s*:|falta)", _sem_acento(just))):
            detalhe.append(just)
        if terceiro:
            if nota_correcao is None:
                nota_correcao = _ler_nota_correcao(rodada_dir)
            linha_v, veredito = _veredito_da_nota(nota_correcao, str(did))
            if linha_v:
                detalhe.insert(0, f"veredito (notas/07-correcao.md): {linha_v}")
                if veredito == "precisa-de-ajuste":
                    avisos_ledger.append(f"{did}: o ledger diz retestado-ok e notas/07-correcao.md diz PRECISA DE "
                                         f"AJUSTE; confira antes de mandar")
            else:
                detalhe.insert(0, "veredito: nao encontrado em notas/07-correcao.md (linha com o id e RESOLVEU ou "
                                  "PRECISA DE AJUSTE)")
                avisos_ledger.append(f"{did}: defeito importado sem o veredito RESOLVEU ou PRECISA DE AJUSTE em "
                                     f"notas/07-correcao.md")
        for c in retestes:
            obtido = f": {c['resultado_obtido']}" if c.get("resultado_obtido") else ""
            if c.get("tecnica") == "regressao":
                if c.get("status") == "passou":
                    detalhe.append(f"reteste {c.get('id')} passou{obtido}")
                elif c.get("status") == "falhou":
                    detalhe.append(f"reteste {c.get('id')} falhou, precisa de ajuste{obtido}")
                else:
                    detalhe.append(f"reteste {c.get('id')}: {c.get('status')}")
            elif c.get("status") == "passou":
                detalhe.append(f"caso {c.get('id')} passou{obtido}")
        for c in gates:
            if c.get("status") in (None, "", "pendente"):
                continue
            partes_gate = ("gate:", str(c.get("id")), _titulo_curto(c), str(c.get("status")))
            detalhe.append(" ".join(x for x in partes_gate if x))
        regressao_falhou = [c for c in ligados if c.get("tecnica") == "regressao" and c.get("status") == "falhou"]
        regressao_passou = [c for c in ligados if c.get("tecnica") == "regressao" and c.get("status") == "passou"]
        reteste_falho_geral = tipo != "retratado" and st in ("aberto", "nao-corrigido")
        depois_confirmado = tipo == "retratado" or st in ("corrigido", "retestado-ok")

        def veredito_reteste(p_orig: Path) -> str:
            if tipo == "retratado":
                return "ok"
            if reteste_falho_geral or _citado_em(p_orig, regressao_falhou, rodada_dir):
                return "falhou"
            if st == "retestado-ok" or _citado_em(p_orig, regressao_passou, rodada_dir):
                return "ok"
            return "sem-veredito"
        ev = d.get("evidencias")
        if isinstance(ev, dict):
            grupos = {k: _evid_lista(ev.get(k)) for k in ("antes", "depois", "reteste")}
            grupos["outras"] = [x for k, v in ev.items() if k not in ("antes", "depois", "reteste") for x in _evid_lista(v)]
        else:
            grupos = {"antes": [], "depois": [], "reteste": [], "outras": _evid_lista(ev)}
        if tipo != "retratado":
            ja = {str(_evid_caminho(e) or "").replace("\\", "/") for v in grupos.values() for e in v}
            for c in regressao_falhou:
                for e in _evid_lista(c.get("evidencias")):
                    rel = str(_evid_caminho(e) or "").replace("\\", "/")
                    if rel and "-reteste" in rel.lower() and rel not in ja:
                        grupos["reteste"].append(e)
                        ja.add(rel)
        rot_a, rot_d, rot_r =("PARECIA", "ERA", "ERA") if status == "retratado" else ("ANTES", "DEPOIS", "RETESTE")

        def separar(lista, rotulo_grupo):
            imgs, textos = [], []
            for e in lista:
                rel = _evid_caminho(e)
                if not rel:
                    continue
                if not evidencia_permitida(str(rel), rodada_dir):
                    nome_visivel, _ = mascarar_segredos(Path(str(rel).replace("\\", "/")).name or str(rel))
                    fora_da_rodada.append(nome_visivel)
                    provas_fora.append({"tipo": "cod", "grupo": rotulo_grupo,
                                        "texto": f"{MARCADOR_FORA_RODADA}: {nome_visivel}. Nao lido nem embutido: "
                                                 f"copie a prova para evidencias/ da rodada e cite o caminho relativo.",
                                        "legenda": f"{rotulo_grupo.upper()} — evidencia fora da rodada"})
                    continue
                p = _resolver_evidencia(rel, rodada_dir)
                info = e if isinstance(e, dict) else {}
                if p.suffix.lower() in EXT_IMAGEM:
                    mostrada = p if info.get("marcas") else _preferir_circulado(p)
                    if not dentro_da_rodada(mostrada, rodada_dir):
                        mostrada = p
                    imgs.append((mostrada, info, p))
                elif p.suffix.lower() in EXT_TEXTO or not p.suffix or not p.is_file() or eh_texto_utf8(p):
                    textos.append((p, info))
                else:
                    nao_embutidos.append(str(p))
                    try:
                        tamanho = f"{p.stat().st_size} bytes"
                    except OSError:
                        tamanho = "tamanho desconhecido"
                    provas_fora.append({"tipo": "cod", "grupo": rotulo_grupo,
                                        "texto": f"{MARCADOR_NAO_EMBUTIDO}: {p} ({p.suffix or 'sem extensao'}, "
                                                 f"{tamanho}). Abra o arquivo a parte.",
                                        "legenda": f"{rotulo_grupo.upper()} — evidencia fora do documento"})
            return imgs, textos

        provas_fora = []
        ia, ta = separar(grupos["antes"] + grupos["outras"], "antes")
        idp, td = separar(grupos["depois"], "depois")
        ir, tr = separar(grupos["reteste"], "reteste")
        depois_imgs = []
        for p, i, orig in idp:
            desc = i.get("rotulo") or _desc_do_nome(p)
            if tipo != "retratado" and _citado_em(orig, regressao_falhou, rodada_dir):
                depois_imgs.append((p, i, f"{rot_r} — PRECISA DE AJUSTE — {desc}", "vermelho", "reteste-falho"))
            elif depois_confirmado:
                depois_imgs.append((p, i, i.get("rotulo") or f"{rot_d} — {desc}", "verde", "depois"))
            else:
                qual = "NÃO CONFIRMADO" if tipo == "defeito" else "PROPOSTA"
                depois_imgs.append((p, i, f"{rot_d} — {qual} — {desc}", "amarelo", "depois"))
        for p, i, orig in ir:
            desc = i.get("rotulo") or _desc_do_nome(p)
            veredito = veredito_reteste(orig)
            if veredito == "falhou":
                depois_imgs.append((p, i, f"{rot_r} — PRECISA DE AJUSTE — {desc}", "vermelho", "reteste-falho"))
            elif veredito == "ok":
                depois_imgs.append((p, i, i.get("rotulo") or f"{rot_r} — {desc}", "verde", "reteste"))
            else:
                depois_imgs.append((p, i, f"{rot_r} — SEM VEREDITO — {desc}", "amarelo", "reteste"))
        provas = []
        for k in range(max(len(ia), len(depois_imgs))):
            a = ia[k] if k < len(ia) else None
            b = depois_imgs[k] if k < len(depois_imgs) else None
            if a and b:
                provas.append({"tipo": "par", "antes": str(a[0]), "depois": str(b[0]),
                               "rotulo_antes": a[1].get("rotulo") or f"{rot_a} — {_desc_do_nome(a[0])}",
                               "rotulo_depois": b[2], "cor_antes": "vermelho", "cor_depois": b[3],
                               "marcas_antes": a[1].get("marcas"), "marcas_depois": b[1].get("marcas"),
                               "legenda": a[1].get("legenda") or b[1].get("legenda") or ""})
            elif a:
                provas.append({"tipo": "uma", "img": str(a[0]), "cor": "vermelho", "marcas": a[1].get("marcas"),
                               "grupo": "antes" if status != "retratado" else None,
                               "rotulo": a[1].get("rotulo") or f"{rot_a} — {_desc_do_nome(a[0])}",
                               "legenda": a[1].get("legenda", "")})
            else:
                provas.append({"tipo": "uma", "img": str(b[0]), "cor": b[3], "marcas": b[1].get("marcas"),
                               "grupo": b[4] if status != "retratado" else None,
                               "rotulo": b[2], "legenda": b[1].get("legenda", "")})
        for rotulo, grupo_txt, lista in ((rot_a, "antes", ta), (rot_d, "depois", td), (rot_r, "reteste", tr)):
            for p, info in lista:
                try:
                    rel = Path(os.path.relpath(p, rodada_dir)).as_posix()
                except ValueError:
                    rel = str(p)
                rot_txt, grupo_prova = rotulo, grupo_txt
                if (grupo_txt == "reteste" and veredito_reteste(p) == "falhou") or (
                        grupo_txt == "depois" and tipo != "retratado" and _citado_em(p, regressao_falhou, rodada_dir)):
                    rot_txt, grupo_prova = f"{rot_r} — PRECISA DE AJUSTE", "reteste-falho"
                elif grupo_txt == "depois" and not depois_confirmado:
                    rot_txt = f"{rotulo} — NÃO CONFIRMADO" if tipo == "defeito" else f"{rotulo} — PROPOSTA"
                provas.append({"tipo": "cod", "arquivo": str(p), "max_linhas": int(info.get("max_linhas", 40)),
                               "grupo": grupo_prova if status != "retratado" else None,
                               "legenda": info.get("legenda") or f"{rot_txt} — {rel}"})
        provas.extend(provas_fora)
        if status == "retratado" and not provas:
            explicacao = d.get("justificativa") or d.get("causa") or "motivo não registrado no ledger"
            provas.append({"tipo": "cod", "grupo": None,
                           "texto": f"PARECIA: {d.get('titulo') or did} · ERA: {explicacao}",
                           "legenda": "Retratação sem arquivo: o achado caiu ao ser reproduzido por outro caminho"})
        itens.append({"cod": did, "titulo": d.get("titulo", did), "status": status, "tipo": tipo,
                      "severidade": d.get("severidade") if d.get("severidade") in SEVERIDADES else None,
                      "onde": d.get("onde", ""), "antes": antes, "causa": d.get("causa", ""),
                      "depois": _correcao_de_terceiro(rod, rodada_dir) if terceiro else d.get("correcao", ""),
                      "status_detalhe": "; ".join(detalhe), "provas": provas})
    nao_val = []
    for c in casos:
        if c.get("status") in ("nao-validado", "bloqueado"):
            nao_val.append(f"{c.get('id')} {c.get('titulo') or ''} ({c.get('status')}): {c.get('justificativa') or 'sem justificativa'}")
    pend = [c for c in casos if c.get("status") == "pendente"]
    if pend:
        nao_val.append(f"{len(pend)} caso(s) ainda pendente(s): {', '.join(str(c.get('id')) for c in pend[:15])}"
                       + (" ..." if len(pend) > 15 else ""))
    contagem = {}
    for c in casos:
        contagem[c.get("status")] = contagem.get(c.get("status"), 0) + 1
    regs_git = _registros_git(rod)
    codigo = "; ".join((f"{g.get('repo')}: " if g.get("repo") else "")
                       + " @ ".join(str(x) for x in (g.get("branch"), g.get("commit")) if x)
                       for g in regs_git if g.get("branch") or g.get("commit"))
    meta = [{"rotulo": "Defeitos neste documento", "valor": str(len(itens))},
            {"rotulo": "Casos na rodada", "valor": str(len(casos))},
            {"rotulo": "Casos por status", "valor": " · ".join(f"{k} {v}" for k, v in sorted(contagem.items(), key=lambda kv: str(kv[0]))) or "—"}]
    detalhes = []
    if rod.get("ambiente"):
        detalhes.append({"rotulo": "Ambiente", "texto": rod["ambiente"]})
    if codigo:
        detalhes.append({"rotulo": "Código testado", "texto": f"`{codigo}`"})
    if rod.get("autorizacoes"):
        detalhes.append({"rotulo": "Autorizações da rodada", "texto": "; ".join(lista_textos(rod["autorizacoes"]))})
    sujeira = [f"{s.get('id')} · {s.get('ambiente', '')} · {s.get('o_que', '')} → {s.get('estado_final', '?')}"
               for s in dados.get("sujeira") or [] if isinstance(s, dict)]
    verif = []
    for b in rod.get("baselines") or []:
        if isinstance(b, dict):
            verif.append(f"{b.get('gate', '')}: {b.get('resultado', '')}" + (f" (`{b['comando']}`)" if b.get("comando") else "")
                         + (f" — {b['composicao']}" if b.get("composicao") else ""))
    rid = rod.get("id") or rodada_dir.name
    partes_filtro = [str(x) for x in list(filtros.get("defeitos") or []) + list(filtros.get("tipos") or [])
                     + list(filtros.get("status") or [])]
    if filtros.get("branch"):
        partes_filtro.append(nome_arquivo_branch(filtros["branch"]))
    nome = nome_arquivo_branch("-".join(["provas"] + partes_filtro))[:120] if partes_filtro else "provas"
    return {
        "titulo": filtros.get("titulo") or f"Provas antes e depois — {rod.get('alvo') or rid}",
        "rotulo": f"Rodada {rid}" + (" · branch" if filtros.get("branch") else ""),
        "branch": filtros.get("branch") or "",
        "rodape": filtros.get("rodape") or f"{rid} · provas",
        "resumo": filtros.get("resumo") or rod.get("pedido") or "",
        "metadados": meta, "detalhes": detalhes, "itens": itens, "nao_validado": nao_val,
        "secoes_extra": [{"titulo": "Sujeira deixada", "itens": sujeira, "vazio": "Nenhuma registrada."}],
        "verificacao": verif, "item_em_pagina_nova": True, "base_imagens": str(rodada_dir),
        "aviso": avisos_ledger,
        "_nao_embutidos": nao_embutidos, "_fora_da_rodada": fora_da_rodada, "_filtrado": bool(partes_filtro),
        "nome": nome,
    }


# ------------------------------------------------------------------------------------------ comandos

def ao_lado(pasta: Path, nome_arquivo: str) -> Path:
    """Arquivo escrito ao lado do PDF (PR.md, APLICAR.txt, COMMIT-*.txt): nunca sai da pasta do PDF."""
    destino = (pasta / nome_arquivo).resolve()
    if destino.parent != pasta.resolve():
        raise ErroUso(f"nome de arquivo invalido (sairia da pasta {pasta}): {nome_arquivo!r}")
    return destino


def _sob(alvo: Path, raiz: Path) -> bool:
    try:
        alvo.relative_to(raiz)
        return True
    except ValueError:
        return False


def _dentro_de_alguma_rodada(alvo: Path) -> bool:
    for anc in list(alvo.parents)[:8]:
        if (anc / "cobertura.json").is_file() and dentro_da_rodada(alvo, anc):
            return True
    return False


def refs_de_arquivo(prova: dict) -> list:
    if prova.get("tipo") == "par":
        return [prova.get("antes"), prova.get("depois")]
    if prova.get("tipo") == "uma":
        return [prova.get("img")]
    if prova.get("tipo") == "cod" and prova.get("arquivo"):
        return [prova.get("arquivo")]
    return []


def provas_fora_da_base(s: dict, base: Path, pastas: dict) -> list:
    """Modo spec: cada imagem (par/uma) e cada arquivo de prova textual (cod) precisa resolver dentro de base_imagens
    (ou --base), de uma pasta declarada em "pastas" ou de evidencias/, rede/, notas/ ou relatorio/ de uma rodada
    (pasta com cobertura.json). Caminho absoluto, '..' ou link que sai disso e recusado (--permitir-fora libera)."""
    raizes = []
    for r in [base] + [Path(v) for v in pastas.values()]:
        try:
            raizes.append(r.expanduser().resolve())
        except (OSError, RuntimeError):
            continue
    fora = []
    for it in s.get("itens") or []:
        for prova in it.get("provas") or []:
            for ref in refs_de_arquivo(prova):
                if ref is None:
                    continue
                try:
                    alvo = resolver_imagem(ref, base, pastas).resolve()
                except (OSError, RuntimeError):
                    alvo = None
                if alvo is not None and (any(_sob(alvo, rz) for rz in raizes) or _dentro_de_alguma_rodada(alvo)):
                    continue
                bruto = "/".join(map(str, ref)) if isinstance(ref, (list, tuple)) else str(ref)
                visivel, _ = mascarar_segredos(bruto)
                fora.append(f"item {it.get('cod')}: {visivel}")
    return fora


def mensagem_fora_da_base(fora: list, base: Path) -> str:
    return (f"{len(fora)} prova(s) da spec fora de base_imagens ({base}), das pastas declaradas e da rodada: "
            + "; ".join(fora[:10]) + (" ..." if len(fora) > 10 else "")
            + ". Copie a prova para perto da spec, aponte base_imagens para a rodada ou, se o arquivo e mesmo prova "
              "desta entrega, gere com --permitir-fora")


def preparar_saida(args, s: dict, base: Path, padrao_dir: Path):
    bruto = args.nome or s.get("nome")
    if bruto:
        nome = nome_arquivo_branch(bruto)
    elif s.get("branch"):
        nome = nome_arquivo_branch(s["branch"])
    else:
        nome = slug(s["titulo"], 60)
    if args.saida:
        alvo = Path(args.saida).expanduser()
        if alvo.suffix.lower() == ".pdf":
            pdf, pasta_pedida = alvo, alvo.parent
        else:
            pdf, pasta_pedida = alvo / f"{nome}.pdf", alvo
    else:
        pdf, pasta_pedida = padrao_dir / f"{nome}.pdf", padrao_dir
    pdf = pdf.resolve()
    if pdf.parent != pasta_pedida.resolve():
        raise ErroUso(f"nome de saida invalido (o PDF sairia de {pasta_pedida}): {bruto!r}")
    return pdf, nome


def limpar_compostas(pasta: Path, prefixo: str) -> None:
    if not pasta.is_dir():
        return
    for arq in pasta.iterdir():
        if arq.is_file() and re.fullmatch(re.escape(prefixo) + r"-\d{2,3}-[a-z0-9-]*\.(png|jpg)", arq.name):
            arq.unlink()


def gerar_documento(s_bruta: dict, base: Path, args, padrao_dir: Path, pasta_spec: Path | None = None,
                    recusar_segredo: bool = False, exigir_base: bool = False) -> int:
    pasta_spec = pasta_spec or padrao_dir
    s = normalizar_spec(s_bruta)
    if recusar_segredo:
        _, n_entrada = mascarar_spec_inteira(s)
        if n_entrada:
            print(f"PROBLEMA: a spec de entrada tem {n_entrada} segredo(s) (o valor nao foi impresso). Nada foi "
                  f"gerado: tire o dado da spec, descreva so o tipo, e gere de novo.", file=sys.stderr)
            return EXIT_CONFERENCIA
    s, n_seg_spec = mascarar_spec(s)
    for a in avisos_da_spec(s):
        print(f"aviso: {a}")
    permitir = bool(getattr(args, "permitir_sem_prova", False))
    sem_itens = (getattr(args, "sem_itens", None) or "").strip() or None
    problemas = problemas_de_prova(s, permitir, sem_itens)
    ressalvas = ressalvas_de_prova(s, permitir, sem_itens)
    if ressalvas:
        s["aviso"] = lista_textos(s.get("aviso")) + ressalvas
    if sem_itens and not s["itens"]:
        s["_sem_itens_texto"] = f"Bloco sem defeito: {sem_itens}"
    nao_embutidos = list(s.get("_nao_embutidos") or [])
    for f in nao_embutidos:
        print(f"aviso: evidencia referenciada fora do documento (formato que nao embute): {f}")
    fora_da_rodada = list(s.get("_fora_da_rodada") or [])
    for f in fora_da_rodada:
        print(f"aviso: evidencia fora de evidencias/, rede/, notas/ ou relatorio/ da rodada, nao lida nem embutida: {f} "
              f"(copie a prova para evidencias/ e corrija o caminho no ledger)")
    pdf, nome = preparar_saida(args, s, base, padrao_dir)
    if s.get("_filtrado"):
        completo = (padrao_dir / "provas.pdf").resolve()
        if pdf == completo:
            raise ErroUso(f"documento filtrado (--defeito/--tipo/--status/--branch) nao sobrescreve o PDF completo da "
                          f"rodada ({completo}): use outro --nome ou deixe o padrao provas-<filtro>")
    html_path = pdf.with_suffix(".html")
    pasta_provas = pdf.parent / (args.pasta_provas or "provas")
    prefixo = slug(str(s.get("id") or nome), 40)
    usar_pil = TEM_PIL and not args.sem_pillow
    if not usar_pil:
        print("aviso: sem Pillow (ou --sem-pillow): faixas e caixas viram HTML sobreposto; instale com pip install Pillow "
              "para o par composto igual ao padrao")
    pastas = {k: str((pasta_spec / v) if not Path(v).expanduser().is_absolute() else Path(v).expanduser())
              for k, v in (s.get("pastas") or {}).items()}
    if exigir_base:
        fora = provas_fora_da_base(s, base, pastas)
        if fora:
            raise ErroUso(mensagem_fora_da_base(fora, base))
    if args.marcas:
        mapa = dict(carregar_mapa_marcas(args.marcas, Path.cwd()))
        extras = [carregar_mapa_marcas(s.get("marcas"), pasta_spec)] if s.get("marcas") else []
    else:
        mapa = dict(carregar_mapa_marcas(s.get("marcas"), pasta_spec))
        extras = []
    for extra in extras + list(getattr(args, "_mapas_extra", [])):
        for k, v in extra.items():
            mapa.setdefault(k, v)
    ctx = Contexto(base, html_path.parent, pasta_provas, prefixo, mapa, pastas, args.max_largura, usar_pil,
                   args.permitir_faltando)
    if usar_pil:
        limpar_compostas(pasta_provas, prefixo)
    arquivos = arquivos_da_spec(s, pasta_spec)
    corpo = gerar_corpo(s, ctx, arquivos, bool(args.item_pagina_nova or s.get("item_em_pagina_nova")))
    if ctx.faltando and not args.permitir_faltando:
        print(f"erro: {len(ctx.faltando)} arquivo(s) de prova nao encontrado(s) (base: {base}):", file=sys.stderr)
        for f in ctx.faltando:
            print(f"  - {f}", file=sys.stderr)
        print("corrija os caminhos (base_imagens/--base) ou use --permitir-faltando para ver o layout com o aviso no lugar",
              file=sys.stderr)
        return EXIT_CONFERENCIA
    rodape = s.get("rodape") or s.get("branch") or texto_puro(s["titulo"])
    doc = documento_html(texto_puro(s.get("branch") or s["titulo"]), rodape, corpo, args.altura_uma, args.altura_par,
                         {"qa-provas-itens": len(s["itens"]), "qa-provas-imagens": ctx.imagens,
                          "qa-provas-pares": ctx.pares, "qa-provas-sem-itens": sem_itens or "",
                          "qa-provas-permitir-sem-prova": "sim" if permitir else "",
                          "qa-provas-marcas-perdidas": ", ".join(ctx.marcas_perdidas)})
    escrever_texto(html_path, doc)
    for a in ctx.avisos:
        print(f"aviso: {a}")
    for perdida in ctx.marcas_perdidas:
        print(f"aviso: {perdida} tem marcas no ledger ou no mapa e saiu sem nenhuma caixa (spec sem a chave \"marcas\"?)")
    print(f"HTML: {html_path}")
    if ctx.geradas:
        print(f"provas compostas: {len(ctx.geradas)} em {pasta_provas}")
    if args.pr:
        destino_pr = ao_lado(pdf.parent, "PR.md") if args.pr is True else Path(args.pr).expanduser()
        gerar_pr(s, destino_pr, pdf.name)
        print(f"PR.md: {destino_pr}")
    if args.aplicar:
        cmds = comandos_texto(s.get("comandos"))
        if not cmds:
            print('aviso: --aplicar sem "comandos" na spec: APLICAR.txt nao gerado')
        else:
            destino_ap = ao_lado(pdf.parent, "APLICAR.txt") if args.aplicar is True else Path(args.aplicar).expanduser()
            escrever_texto(destino_ap, CABECALHO_APLICAR + cmds + "\n")
            print(f"APLICAR.txt: {destino_ap}")
    commit = s.get("commit")
    if args.commit_arquivos and commit:
        itens = commit.items() if isinstance(commit, dict) else [("", commit)]
        for repo, msg in itens:
            nome_c = f"COMMIT-{nome_arquivo_branch(repo)}.txt" if repo else "COMMIT.txt"
            destino_c = ao_lado(pdf.parent, nome_c)
            escrever_texto(destino_c, str(msg).rstrip("\n") + "\n")
            print(f"commit: {destino_c}")

    def fechar(codigo_base: int) -> int:
        for pb in problemas:
            print(f"PROBLEMA: {pb}")
        n_seg = n_seg_spec + ctx.segredos
        if n_seg:
            _mascara.avisar(n_seg, f"{html_path.name} e no PDF (texto da spec/ledger e provas textuais)")
        if nao_embutidos and args.conferir:
            print(f"PROBLEMA: {len(nao_embutidos)} evidencia(s) referenciada(s) ficaram fora do documento: "
                  f"{', '.join(nao_embutidos[:5])}")
        if fora_da_rodada:
            print(f"PROBLEMA: {len(fora_da_rodada)} evidencia(s) fora da rodada (nao lidas): "
                  f"{', '.join(fora_da_rodada[:5])}")
        if ctx.marcas_perdidas and args.conferir and codigo_base == EXIT_OK:
            codigo_base = EXIT_CONFERENCIA
        if codigo_base not in (EXIT_OK, EXIT_CONFERENCIA):
            return codigo_base
        if codigo_base == EXIT_CONFERENCIA or problemas or n_seg or (nao_embutidos and args.conferir) or fora_da_rodada:
            return EXIT_CONFERENCIA
        return EXIT_OK

    if args.so_html:
        return fechar(EXIT_OK)
    sys.stdout.flush()
    codigo, info = imprimir(html_path, pdf, args.navegador, args.espera_ms, args.timeout, args.timeout_primeira)
    if codigo != EXIT_OK:
        print(f"erro: PDF nao gerado ({info}). O HTML ficou em {html_path}", file=sys.stderr)
        return fechar(codigo)
    print(f"PDF: {pdf} ({info})")
    print(garantir_rodape(pdf, rodape))
    if args.conferir:
        resultado = conferir(pdf, html_path, rodape, args.dpi, Path(args.saida_conferir) if args.saida_conferir else None,
                             "todas", args.exigir_render, sem_itens=sem_itens)
        return fechar(imprimir_conferencia(*resultado))
    return fechar(EXIT_OK)


def cmd_gerar(args) -> int:
    entrada = resolver_entrada(Path(args.entrada).expanduser().resolve())
    dados = ler_json(entrada)
    modo = args.tipo_entrada
    if modo == "auto":
        modo = "ledger" if eh_ledger(dados) else "spec"
    args._mapas_extra = []
    if getattr(args, "so_spec", False) and not args.salvar_spec:
        raise ErroUso("--so-spec exige --salvar-spec <arquivo>")
    if modo == "ledger":
        rodada_dir = entrada.parent
        filtros = {"defeitos": args.defeito, "tipos": args.tipo, "status": args.status, "branch": args.branch,
                   "titulo": args.titulo, "rodape": args.rodape, "resumo": args.resumo}
        spec = spec_do_ledger(dados, rodada_dir, filtros)
        for cand in (rodada_dir / "marcas.json", rodada_dir / "evidencias" / "marcas.json"):
            if cand.is_file():
                args._mapas_extra.append(carregar_mapa_marcas(str(cand), rodada_dir))
        mapa_rodada = dict(carregar_mapa_marcas(args.marcas, Path.cwd())) if args.marcas else {}
        for extra in args._mapas_extra:
            for k, v in extra.items():
                mapa_rodada.setdefault(k, v)
        embutido = anotar_marcas(spec, mapa_rodada)
        if embutido:
            spec["marcas"] = embutido
        n_salvo = 0
        if args.salvar_spec:
            destino = Path(args.salvar_spec).expanduser()
            spec_limpa, n_salvo = mascarar_spec_inteira(spec)
            if isinstance(spec_limpa.get("marcas"), dict):
                spec_limpa["marcas"] = {mascarar_segredos(k)[0]: v for k, v in spec_limpa["marcas"].items()}
            escrever_texto(destino, json.dumps(spec_limpa, ensure_ascii=False, indent=2) + "\n")
            print(f"spec derivada do ledger: {destino} (edite rotulos, marcas e legendas e gere com: provas.py gerar {destino})")
            if embutido:
                print(f"  marcas de {len(embutido)} imagem(ns) embutidas na chave \"marcas\" da spec: copie \"itens\" e "
                      f"\"marcas\" juntos para o provas.json do bloco")
            if n_salvo:
                _mascara.avisar(n_salvo, str(destino))
            if args.so_spec:
                print("--so-spec: nenhum HTML nem PDF gerado")
                return EXIT_CONFERENCIA if n_salvo else EXIT_OK
        base = Path(args.base).expanduser().resolve() if args.base else rodada_dir
        codigo = gerar_documento(spec, base, args, rodada_dir / "relatorio", rodada_dir)
        return EXIT_CONFERENCIA if (n_salvo and codigo == EXIT_OK) else codigo
    if getattr(args, "so_spec", False):
        raise ErroUso("--so-spec so vale com o cobertura.json (modo ledger)")
    for chave, valor in (("branch", args.branch), ("titulo", args.titulo), ("rodape", args.rodape), ("resumo", args.resumo)):
        if valor:
            dados[chave] = valor
    if args.base:
        base = Path(args.base).expanduser().resolve()
    elif dados.get("base_imagens"):
        b = Path(dados["base_imagens"]).expanduser()
        base = b if b.is_absolute() else (entrada.parent / b).resolve()
    else:
        base = entrada.parent
    return gerar_documento(dados, base, args, entrada.parent, entrada.parent, recusar_segredo=True,
                           exigir_base=not getattr(args, "permitir_fora", False))


def resumo_bloco(spec_path: Path) -> dict:
    s_bruta = ler_json(spec_path)
    s = normalizar_spec(s_bruta)
    base = spec_path.parent
    arquivos = arquivos_da_spec(s, base)
    contagem = {}
    for it in s["itens"]:
        contagem[it["status"]] = contagem.get(it["status"], 0) + 1
    situacao = s.get("situacao")
    if not situacao:
        if lista_textos(s.get("alerta")) or "bloqueio" in contagem or "aberto" in contagem or "precisa-de-ajuste" in contagem:
            situacao = "segurar"
        elif all(k in ("corrigido", "retestado-ok", "resolveu") for k in contagem):
            situacao = "pronto"
        else:
            situacao = "com pendências"
    nome = s.get("nome") or (nome_arquivo_branch(s["branch"]) if s.get("branch") else slug(s["titulo"], 60))
    repos = lista_textos(s.get("repos")) or sorted({a["repo"] for a in arquivos if a["repo"]})
    return {"id": str(s.get("id") or ""), "branch": s.get("branch", ""), "titulo": s["titulo"], "repos": repos,
            "arquivos": len(arquivos), "mais": sum(a["mais"] for a in arquivos), "menos": sum(a["menos"] for a in arquivos),
            "depende": lista_textos(s.get("depende")), "situacao": situacao, "contagem": contagem,
            "pdf": s.get("pdf") or f"{nome}.pdf", "dir": spec_path.parent}


def cmd_indice(args) -> int:
    entradas = [Path(e).expanduser().resolve() for e in args.entradas]
    conf = {}
    blocos_paths = []
    if len(entradas) == 1 and entradas[0].is_file():
        dados = ler_json(entradas[0])
        if isinstance(dados, dict) and "blocos" in dados:
            conf = dados
            for b in dados["blocos"]:
                p = Path(b).expanduser() if isinstance(b, str) else None
                if p is None:
                    raise ErroUso('"blocos" do indice deve listar caminhos de specs (provas.json de cada bloco)')
                blocos_paths.append(p if p.is_absolute() else (entradas[0].parent / p).resolve())
    if not blocos_paths:
        for e in entradas:
            if e.is_dir():
                achados = sorted(e.glob("*/provas.json")) or ([e / "provas.json"] if (e / "provas.json").is_file() else [])
                if not achados:
                    raise ErroUso(f"nenhum provas.json em {e} nem nas subpastas")
                blocos_paths.extend(achados)
            else:
                blocos_paths.append(e)
    blocos = [resumo_bloco(p) for p in blocos_paths]
    blocos, n_seg = _mascara.mascarar_estrutura(blocos)
    conf, n_conf = _mascara.mascarar_estrutura(conf, pular={"blocos", "ordem"})
    n_seg += n_conf
    titulo = args.titulo or conf.get("titulo") or "Índice das entregas"
    rodape = args.rodape or conf.get("rodape") or f"{slug(titulo, 40)} · índice"
    if args.saida:
        pdf = Path(args.saida).expanduser().resolve()
        if pdf.suffix.lower() != ".pdf":
            pdf = pdf / "00-INDICE.pdf"
    elif conf:
        pdf = entradas[0].parent / "00-INDICE.pdf"
    else:
        pdf = Path(os.path.commonpath([str(b["dir"]) for b in blocos])) / "00-INDICE.pdf"
        if len(blocos) == 1:
            pdf = blocos[0]["dir"].parent / "00-INDICE.pdf"
    corpo = [f"<h1>{fmt(titulo)}</h1>"]
    intro = args.intro or conf.get("intro")
    if intro:
        corpo.append(f"<p>{fmt(intro)}</p>")
    for a in lista_textos(conf.get("alerta")):
        corpo.append(f"<div class='alerta'>{fmt(a)}</div>")
    corpo.append("<table><tr><th>#</th><th>Branch</th><th>Repos</th><th class='n'>Arq.</th><th class='n'>+</th>"
                 "<th class='n'>−</th><th>Depende</th><th>Situação</th></tr>")
    for k, b in enumerate(blocos, 1):
        ordem_st = list(STATUS)
        cont = " · ".join(f"{n} {STATUS[st][0].lower()}"
                          for st, n in sorted(b["contagem"].items(), key=lambda kv: ordem_st.index(kv[0])))
        cor = "#047857" if b["situacao"] == "pronto" else "#BE123C" if b["situacao"] == "segurar" else "#92400E"
        rel_pdf = src_relativo(b["dir"] / b["pdf"], pdf.parent)
        corpo.append(f"<tr><td>{html.escape(b['id'] or str(k))}</td><td><code>{html.escape(b['branch'] or '—')}</code>"
                     f"<div class='leg'>{fmt(b['titulo'])}</div><div class='leg'>{html.escape(rel_pdf)}</div></td>"
                     f"<td>{html.escape(' + '.join(b['repos']) or '—')}</td><td class='n'>{b['arquivos']}</td>"
                     f"<td class='n'>{b['mais']}</td><td class='n'>{b['menos']}</td>"
                     f"<td>{html.escape(', '.join(b['depende']) or '—')}</td>"
                     f"<td><b style='color:{cor}'>{html.escape(b['situacao'])}</b><div class='leg'>{html.escape(cont)}</div></td></tr>")
    corpo.append("</table>")
    ordem = conf.get("ordem")
    if ordem:
        corpo.append("<h2>Ordem sugerida de merge</h2><ol>")
        por_id = {b["id"]: b for b in blocos}
        for oid in ordem:
            b = por_id.get(str(oid))
            if b:
                corpo.append(f"<li><code>{html.escape(b['branch'] or b['titulo'])}</code>"
                             + (f" — depois do bloco {', '.join(b['depende'])}" if b["depende"] else "") + "</li>")
            else:
                corpo.append(f"<li>{fmt(oid)}</li>")
        corpo.append("</ol>")
    for sec in conf.get("secoes") or []:
        if not isinstance(sec, dict):
            continue
        corpo.append(f"<h2>{html.escape(sec.get('titulo', ''))}</h2>")
        if sec.get("texto"):
            corpo.append(f"<p>{fmt(sec['texto'])}</p>")
        if sec.get("itens"):
            corpo.append("<ul>" + "".join(f"<li>{fmt(x)}</li>" for x in lista_textos(sec["itens"])) + "</ul>")
        if sec.get("pre"):
            corpo.append(f"<pre>{html.escape(comandos_texto(sec['pre']))}</pre>")
    doc = documento_html(texto_puro(titulo), rodape, "".join(corpo), args.altura_uma, args.altura_par,
                         {"qa-provas-blocos": len(blocos)})
    html_path = pdf.with_suffix(".html")
    escrever_texto(html_path, doc)
    print(f"HTML: {html_path}")

    def fechar(codigo_base: int) -> int:
        if n_seg:
            _mascara.avisar(n_seg, f"{html_path.name} (titulos e textos dos blocos)")
            if codigo_base == EXIT_OK:
                return EXIT_CONFERENCIA
        return codigo_base

    if args.so_html:
        return fechar(EXIT_OK)
    sys.stdout.flush()
    codigo, info = imprimir(html_path, pdf, args.navegador, args.espera_ms, args.timeout, args.timeout_primeira)
    if codigo != EXIT_OK:
        print(f"erro: PDF nao gerado ({info}). O HTML ficou em {html_path}", file=sys.stderr)
        return fechar(codigo)
    print(f"PDF: {pdf} ({info})")
    print(garantir_rodape(pdf, rodape))
    if args.conferir:
        return fechar(imprimir_conferencia(*conferir(pdf, html_path, rodape, args.dpi,
                                                     Path(args.saida_conferir) if args.saida_conferir else None,
                                                     "todas", args.exigir_render)))
    return fechar(EXIT_OK)


def cmd_conferir(args) -> int:
    alvo = Path(args.arquivo).expanduser().resolve()
    if alvo.suffix.lower() in (".html", ".htm"):
        html_path, pdf = alvo, alvo.with_suffix(".pdf")
    else:
        pdf, html_path = alvo, (Path(args.html).expanduser().resolve() if args.html else None)
    resultado = conferir(pdf, html_path, args.rodape, args.dpi,
                         Path(args.saida_conferir).expanduser() if args.saida_conferir else None,
                         args.paginas, args.exigir_render, sem_itens=(args.sem_itens or "").strip() or None)
    return imprimir_conferencia(*resultado)


def resolver_entrada(entrada: Path) -> Path:
    if entrada.is_dir():
        for nome in ("cobertura.json", "provas.json"):
            if (entrada / nome).is_file():
                return entrada / nome
        raise ErroUso(f"a pasta {entrada} nao tem cobertura.json nem provas.json")
    return entrada


def cmd_validar(args) -> int:
    entrada = resolver_entrada(Path(args.entrada).expanduser().resolve())
    dados = ler_json(entrada)
    if eh_ledger(dados):
        spec = spec_do_ledger(dados, entrada.parent, {})
        base = entrada.parent
    else:
        spec = dados
        b = dados.get("base_imagens")
        if not b:
            base = entrada.parent
        elif Path(b).expanduser().is_absolute():
            base = Path(b).expanduser()
        else:
            base = (entrada.parent / b).resolve()
    s = normalizar_spec(spec)
    _, n_seg = mascarar_spec_inteira(s)
    s, _ = mascarar_spec(s)
    avisos = avisos_da_spec(s)
    problemas = problemas_de_prova(s, args.permitir_sem_prova, (args.sem_itens or "").strip() or None)
    for f in s.get("_nao_embutidos") or []:
        avisos.append(f"evidencia referenciada que nao embute no documento: {f}")
    if not eh_ledger(dados) and not args.permitir_fora:
        pastas_v = {k: str((entrada.parent / v) if not Path(v).expanduser().is_absolute() else Path(v).expanduser())
                    for k, v in (s.get("pastas") or {}).items()}
        fora = provas_fora_da_base(s, base, pastas_v)
        if fora:
            problemas.append(mensagem_fora_da_base(fora, base))
    for f in s.get("_fora_da_rodada") or []:
        problemas.append(f"evidencia fora de evidencias/, rede/, notas/ ou relatorio/ da rodada (nao lida): {f}")
    faltando = []
    if args.checar_arquivos:
        pastas = {k: str((entrada.parent / v) if not Path(v).is_absolute() else Path(v))
                  for k, v in (s.get("pastas") or {}).items()}
        for it in s["itens"]:
            for p in it["provas"]:
                refs = [p["antes"], p["depois"]] if p["tipo"] == "par" else [p["img"]] if p["tipo"] == "uma" else []
                if p["tipo"] == "cod" and p.get("arquivo"):
                    refs = [p["arquivo"]]
                for r in refs:
                    c = resolver_imagem(r, base, pastas)
                    if not c.is_file():
                        faltando.append(f"item {it['cod']}: {c}")
        mapa = carregar_mapa_marcas(s.get("marcas"), entrada.parent) if s.get("marcas") else {}
        try:
            arquivos_da_spec(s, entrada.parent)
        except ErroUso as erro:
            faltando.append(str(erro))
        for k, v in mapa.items():
            normalizar_conjunto(v, f"marcas[{k}]")
    for a in avisos:
        print(f"aviso: {a}")
    for f in faltando:
        print(f"PROBLEMA: arquivo nao encontrado: {f}")
    for pb in problemas:
        print(f"PROBLEMA: {pb}")
    if n_seg:
        print(f"PROBLEMA: {n_seg} segredo(s) no texto da spec/ledger (o PDF sairia com [REMOVIDO]): limpe a fonte")
    estado = "ok" if not (faltando or problemas or n_seg) else "com problema"
    print(f"spec {estado}: {len(s['itens'])} item(ns), {sum(len(i['provas']) for i in s['itens'])} prova(s)"
          + (f", {len(faltando)} arquivo(s) faltando" if faltando else ""))
    if faltando or problemas or n_seg or (args.estrito and avisos):
        return EXIT_CONFERENCIA
    return EXIT_OK


def cmd_exemplo(args) -> int:
    origem = AQUI.parent / "templates" / "provas.exemplo.json"
    if not origem.is_file():
        raise ErroUso(f"modelo nao encontrado: {origem}")
    if not args.destino:
        print(origem.read_text(encoding="utf-8"))
        return EXIT_OK
    destino = Path(args.destino).expanduser()
    if destino.is_dir():
        destino = destino / "provas.json"
    if destino.exists() and not args.sobrescrever:
        raise ErroUso(f"{destino} ja existe (use --sobrescrever)")
    escrever_texto(destino, origem.read_text(encoding="utf-8"))
    print(f"modelo copiado para {destino}")
    return EXIT_OK


EPILOGO = """\
fluxo tipico:
  provas.py exemplo .qa/2026-09-30-clientes/relatorio/provas.json     (copia o modelo)
  provas.py validar provas.json --checar-arquivos                      (estrutura + arquivos)
  provas.py gerar provas.json --pr --aplicar --conferir                (HTML + PDF + PR.md + APLICAR.txt)
  provas.py gerar .qa/2026-09-30-clientes                              (direto do cobertura.json)
  provas.py gerar .qa/2026-09-30-clientes --defeito D-001              (relatorio/provas-D-001.pdf; o completo fica)
  provas.py gerar .qa/2026-09-30-clientes --defeito D-001 --salvar-spec itens-D-001.json --so-spec
                                                                       (so a spec, com "itens" e "marcas", para o bloco)
  provas.py indice entregas/*/provas.json --titulo "Entregas 30/09"    (00-INDICE.pdf)
  provas.py conferir saida.pdf                                         (renderiza e confere)

formato visual (fixo): capa com rotulo, branch em destaque e grade de metadados; item com codigo,
status colorido e as linhas ONDE / ANTES (vermelho) / POR QUE / DEPOIS (verde) / STATUS; prova em
par empilhado (ANTES em cima, DEPOIS embaixo) com faixa colorida, moldura e caixas numeradas;
rodape com o nome em toda pagina e "N / M". Detalhes: references/provas-antes-depois.md.
No ledger, o -RETESTE sai em vermelho ("RETESTE — PRECISA DE AJUSTE") quando o defeito esta aberto ou
nao-corrigido, ou quando o caso de regressao que cita o arquivo falhou (o -RETESTE desse caso entra no par mesmo
fora das evidencias do defeito, e o DEPOIS que ele cita tambem sai vermelho); verde so para reteste de defeito
retestado-ok (ou citado por regressao que passou) e para DEPOIS de defeito corrigido. Evidencia fora de
evidencias/, rede/, notas/ ou relatorio/ da rodada (caminho com '..', que resolve fora, ou subpasta que e link
para outro lugar) nao e lida: vira o bloco "ARQUIVO FORA DA RODADA" e sai 1. Retratado sem arquivo vira o bloco
textual PARECIA/ERA. No STATUS, "reteste" so cita caso --tecnica regressao; caso estatico (lint, typecheck,
testes) sai como "gate: C-NNNN <titulo> passou". Defeito importado (reteste de correcao de terceiro) e
retestado-ok: DEPOIS = "correcao de terceiro: <commit de rodada.git> — <assunto>" e STATUS = o veredito da linha
de notas/07-correcao.md com o id (RESOLVEU ou PRECISA DE AJUSTE), seguido do caso de regressao que passou.

prova fora da base (modo spec): imagem (par/uma) e arquivo de prova textual (cod) precisam resolver dentro de
base_imagens (ou --base), de uma pasta de "pastas" ou de evidencias/, rede/, notas/ ou relatorio/ de uma rodada
(pasta com cobertura.json); caminho absoluto, '..' ou link que sai disso faz o gerar sair 2 e o validar sair 1,
listando o que esta fora (--permitir-fora libera).

prova obrigatoria (gerar, validar e conferir): sai 1 quando a spec nao tem item (bloco sem defeito: use
--sem-itens "<motivo>"), quando nao ha nenhum par ANTES/DEPOIS (--sem-itens "<motivo>"), quando um item
corrigido/retestado-ok/resolveu nao tem prova do DEPOIS (par, imagem verde ou prova textual com "grupo":
"depois"/"reteste") ou quando um item nao tem prova nenhuma (--permitir-sem-prova publica com a ressalva no
PDF). Evidencia em formato que nao embute (video, binario) vira o bloco "ARQUIVO NAO EMBUTIDO" e reprova a
conferencia. Todo texto passa pela mascara de segredos: achou, vira [REMOVIDO], avisa e sai 1.

segredo na entrada: no modo spec (provas.json), spec com segredo (texto, legenda, prova textual inline) e
recusada: sai 1 sem gravar HTML nem PDF; validar tambem sai 1. No modo ledger, o --salvar-spec grava a spec
ja mascarada ([REMOVIDO]), avisa e sai 1; o HTML e o PDF saem mascarados.

tempo: o PDF e conferido a cada 1 s e o navegador e encerrado assim que o arquivo fica estavel; a primeira
tentativa tem --timeout-primeira segundos (padrao 30), a segunda (outro modo, mesmo perfil temporario)
--timeout. O primeiro lancamento num perfil novo pode travar sem gerar nada; o segundo sai em ~1 s. O modo que
funcionou fica lembrado na pasta temporaria do sistema (qa-total-headless-modo.json) e vai primeiro.

codigos de saida: 0 ok | 1 conferencia reprovou, imagem faltando, prova faltando ou segredo mascarado |
2 uso ou spec invalida | 3 navegador nao encontrado (o HTML fica gerado) | 4 falha na impressao |
5 dependencia exigida ausente
"""


def adicionar_opcoes_prova(p):
    g = p.add_argument_group("prova obrigatoria")
    g.add_argument("--permitir-sem-prova", action="store_true",
                   help="publica mesmo com item corrigido/retestado sem DEPOIS ou item sem prova; a ressalva vai no PDF")
    g.add_argument("--sem-itens", metavar="MOTIVO",
                   help='documento sem item (ou sem nenhum par ANTES/DEPOIS): grava "bloco sem defeito: MOTIVO" no PDF '
                        "em vez de reprovar")


def adicionar_opcoes_pdf(p):
    g = p.add_argument_group("pdf")
    g.add_argument("--navegador", help="executavel do Chrome/Edge/Chromium/Brave (padrao: QA_CHROME, PATH, caminhos comuns)")
    g.add_argument("--so-html", action="store_true", help="para no HTML (nao abre navegador)")
    g.add_argument("--espera-ms", type=int, default=8000, help="tempo virtual para imagens carregarem (padrao 8000)")
    g.add_argument("--timeout", type=int, default=180, help="limite em segundos da segunda tentativa (padrao 180)")
    g.add_argument("--timeout-primeira", type=int, default=TIMEOUT_PRIMEIRA,
                   help=f"limite da primeira tentativa: o modo lembrado, ou --headless=new (padrao {TIMEOUT_PRIMEIRA})")
    g.add_argument("--altura-uma", type=float, default=105.0, help="altura maxima em mm de uma imagem sozinha (padrao 105)")
    g.add_argument("--altura-par", type=float, default=235.0, help="altura maxima em mm do par empilhado (padrao 235)")
    g.add_argument("--conferir", action="store_true", help="depois do PDF, roda a conferencia (renderiza e checa)")
    g.add_argument("--dpi", type=int, default=60, help="resolucao das paginas renderizadas na conferencia (padrao 60)")
    g.add_argument("--saida-conferir",
                   help="pasta das paginas renderizadas (padrao: <rodada>/relatorio/conferir/<pdf>/ com o PDF numa "
                        "rodada; senao, pasta temporaria com hash do caminho)")
    g.add_argument("--exigir-render", action="store_true", help="sem PyMuPDF a conferencia reprova (saida 5) em vez de avisar")


def main(argv=None) -> int:
    configurar_saida()
    ap = ParserPT(prog="provas.py", description="PDF de provas ANTES/DEPOIS de correcoes, no padrao da skill qa-total.",
                  epilog=EPILOGO)
    sub = ap.add_subparsers(dest="comando", metavar="COMANDO", parser_class=ParserPT)
    sub.required = True

    g = sub.add_parser("gerar", help="gera HTML + PDF (e PR.md/APLICAR.txt) de uma spec ou do cobertura.json",
                       description="Gera o documento de provas. ENTRADA e um provas.json (spec), um cobertura.json "
                                   "ou a pasta da rodada.", epilog=EPILOGO)
    g.add_argument("entrada", help="provas.json, cobertura.json ou pasta da rodada")
    g.add_argument("-o", "--saida", help="PDF de saida ou pasta (padrao: ao lado da spec; ledger: <rodada>/relatorio/)")
    g.add_argument("--nome", help="nome base dos arquivos (padrao: a branch com / trocado por __, ou o titulo; no ledger "
                                  "com --defeito/--tipo/--status/--branch, provas-<filtro>, para nunca sobrescrever o "
                                  "relatorio/provas.pdf completo)")
    g.add_argument("--base", help="pasta base das imagens relativas (padrao: base_imagens da spec, ou a pasta da spec)")
    g.add_argument("--permitir-fora", action="store_true",
                   help="modo spec: aceita imagem ou arquivo de prova fora de base_imagens, das \"pastas\" e da rodada "
                        "(caminho absoluto ou com '..' que sai dela); sem isto, sai 2 listando o que esta fora")
    g.add_argument("--marcas", help="marcas.json {\"imagem.png\": [marcas] | {largura_css, marcas}} (ou na spec)")
    g.add_argument("--tipo-entrada", choices=["auto", "spec", "ledger"], default="auto", help="padrao: detecta")
    g.add_argument("--pasta-provas", help="subpasta das imagens compostas, ao lado do PDF (padrao: provas)")
    g.add_argument("--max-largura", type=int, default=2400, help="largura maxima das imagens em px (padrao 2400)")
    g.add_argument("--item-pagina-nova", action="store_true", help="cada item comeca em pagina nova (padrao no modo ledger)")
    g.add_argument("--permitir-faltando", action="store_true",
                   help=f'arquivo de prova ausente vira um bloco "{MARCADOR_FALTANDO}"/"{MARCADOR_ARQ_FALTANDO}" '
                        'em vez de erro (a conferencia reprova)')
    g.add_argument("--sem-pillow", action="store_true", help="forca o modo sem Pillow (faixa e caixas em HTML)")
    g.add_argument("--pr", nargs="?", const=True, help="escreve PR.md (ao lado do PDF ou no caminho dado)")
    g.add_argument("--aplicar", nargs="?", const=True, help="escreve APLICAR.txt com os \"comandos\" da spec")
    g.add_argument("--commit-arquivos", action="store_true", help="escreve COMMIT-<repo>.txt com o \"commit\" da spec")
    g.add_argument("--branch", help="sobrescreve a branch da capa e do rodape")
    g.add_argument("--titulo", help="sobrescreve o titulo")
    g.add_argument("--rodape", help="sobrescreve o texto do rodape")
    g.add_argument("--resumo", help="sobrescreve o resumo da capa")
    lg = g.add_argument_group("modo ledger (cobertura.json)")
    lg.add_argument("--defeito", action="append", help="so este defeito (repetivel), ex. --defeito D-003")
    lg.add_argument("--tipo", action="append", help="so este tipo: defeito, melhoria, decisao-de-produto, retratado")
    lg.add_argument("--status", action="append", help="so este status do defeito: aberto, corrigido, retestado-ok, nao-corrigido")
    lg.add_argument("--salvar-spec", help="grava a spec derivada do ledger para editar (rotulos, marcas, legendas); "
                                         "as marcas da rodada vao embutidas na chave \"marcas\"")
    lg.add_argument("--so-spec", action="store_true",
                    help="com --salvar-spec: grava so a spec e sai, sem HTML nem PDF (para os itens de um bloco)")
    adicionar_opcoes_prova(g)
    adicionar_opcoes_pdf(g)
    g.set_defaults(func=cmd_gerar)

    i = sub.add_parser("indice", help="indice de varios documentos (tabela de blocos com situacao)",
                       description="Gera o 00-INDICE.pdf. ENTRADAS: specs (provas.json) de cada bloco, pastas com "
                                   "*/provas.json, ou um unico indice.json {titulo, intro, blocos:[...], ordem, alerta, secoes}.")
    i.add_argument("entradas", nargs="+", help="provas.json de cada bloco, pasta(s), ou um indice.json")
    i.add_argument("-o", "--saida", help="PDF de saida ou pasta (padrao: 00-INDICE.pdf na pasta comum)")
    i.add_argument("--titulo", help="titulo do indice")
    i.add_argument("--intro", help="paragrafo de abertura")
    i.add_argument("--rodape", help="texto do rodape (padrao: <titulo> · indice)")
    adicionar_opcoes_pdf(i)
    i.set_defaults(func=cmd_indice)

    c = sub.add_parser("conferir", help="renderiza paginas em PNG e checa imagens, placeholders e rodape",
                       description="Confere um PDF gerado: nenhuma imagem faltando, nenhum placeholder, rodape e "
                                   "N / M em toda pagina. Renderiza as paginas (PyMuPDF) e monta uma grade para olhar.")
    c.add_argument("arquivo", help="PDF (o .html de mesmo nome e lido se existir) ou o HTML")
    c.add_argument("--html", help="HTML de origem, se tiver outro nome")
    c.add_argument("--rodape", help="texto esperado no rodape (padrao: lido do HTML)")
    c.add_argument("--paginas", default="todas", help='paginas a renderizar: "todas" (padrao), "1,3" ou "2-5"')
    c.add_argument("--dpi", type=int, default=60, help="resolucao (padrao 60; use 110 para ler texto)")
    c.add_argument("--saida-conferir", help="pasta das PNG (padrao: <rodada>/relatorio/conferir/<pdf>/ com o PDF numa "
                                            "rodada; senao, pasta temporaria com hash do caminho)")
    c.add_argument("--exigir-render", action="store_true", help="sem PyMuPDF, reprova (saida 5) em vez de so avisar")
    c.add_argument("--sem-itens", metavar="MOTIVO",
                   help="aceita documento sem item ou sem par ANTES/DEPOIS (o gerar ja registra o motivo no HTML)")
    c.set_defaults(func=cmd_conferir)

    v = sub.add_parser("validar", help="valida a estrutura da spec (ou do ledger) sem gerar nada")
    v.add_argument("entrada", help="provas.json, cobertura.json ou pasta da rodada")
    v.add_argument("--checar-arquivos", action="store_true", help="confere se cada imagem/arquivo citado existe")
    v.add_argument("--estrito", action="store_true", help="aviso tambem reprova (saida 1)")
    v.add_argument("--permitir-fora", action="store_true",
                   help="modo spec: nao reprova imagem ou arquivo de prova fora de base_imagens, das \"pastas\" e "
                        "da rodada")
    adicionar_opcoes_prova(v)
    v.set_defaults(func=cmd_validar)

    e = sub.add_parser("exemplo", help="mostra ou copia o modelo templates/provas.exemplo.json")
    e.add_argument("destino", nargs="?", help="arquivo ou pasta de destino (sem ele, imprime o modelo)")
    e.add_argument("--sobrescrever", action="store_true", help="sobrescreve o destino se existir")
    e.set_defaults(func=cmd_exemplo)

    args = ap.parse_args(argv)
    try:
        return args.func(args)
    except ErroUso as erro:
        print(f"erro: {erro}", file=sys.stderr)
        return erro.codigo
    except KeyboardInterrupt:
        return EXIT_USO


if __name__ == "__main__":
    sys.exit(main())

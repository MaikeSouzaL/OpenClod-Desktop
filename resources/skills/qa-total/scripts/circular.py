#!/usr/bin/env python3
"""circular.py - anota prints com caixas numeradas (skill qa-total).

Vermelho marca o problema; verde marca o mesmo ponto depois de corrigido.
As marcas vem em pixels CSS (o que getBoundingClientRect() devolve) e sao
convertidas para pixels da imagem pela largura CSS da janela (innerWidth).

Requer Pillow (pip install Pillow). Python 3.9+. Windows, macOS e Linux.
"""
from __future__ import annotations

import argparse
import json
import os
import re
import sys
from pathlib import Path

try:
    from PIL import Image, ImageDraw, ImageFont
except ImportError:
    Image = ImageDraw = ImageFont = None

EXIT_OK, EXIT_USO, EXIT_SEM_PILLOW = 0, 2, 3

CORES = {
    "vermelho": (225, 29, 72),
    "verde": (5, 150, 105),
    "amarelo": (217, 119, 6),
    "azul": (37, 99, 235),
}

FONTES_POR_SO = {
    "win32": [
        os.path.join(os.environ.get("WINDIR", r"C:\Windows"), "Fonts", nome)
        for nome in ("segoeuib.ttf", "seguisb.ttf", "arialbd.ttf", "segoeui.ttf", "arial.ttf")
    ],
    "darwin": [
        "/System/Library/Fonts/Supplemental/Arial Bold.ttf",
        "/Library/Fonts/Arial Bold.ttf",
        "/System/Library/Fonts/Helvetica.ttc",
        "/System/Library/Fonts/HelveticaNeue.ttc",
        "/System/Library/Fonts/SFNS.ttf",
    ],
    "linux": [
        "/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf",
        "/usr/share/fonts/dejavu/DejaVuSans-Bold.ttf",
        "/usr/share/fonts/TTF/DejaVuSans-Bold.ttf",
        "/usr/share/fonts/dejavu-sans-fonts/DejaVuSans-Bold.ttf",
        "/usr/share/fonts/truetype/liberation/LiberationSans-Bold.ttf",
        "/usr/share/fonts/liberation-sans/LiberationSans-Bold.ttf",
        "/usr/share/fonts/truetype/freefont/FreeSansBold.ttf",
    ],
}
FONTES_POR_NOME = ["DejaVuSans-Bold.ttf", "Arial Bold.ttf", "arialbd.ttf", "Arial.ttf", "LiberationSans-Bold.ttf"]


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


def chave_so() -> str:
    if sys.platform.startswith("win"):
        return "win32"
    if sys.platform == "darwin":
        return "darwin"
    return "linux"


_cache_fontes: dict = {}


def carregar_fonte(tamanho: int):
    if tamanho in _cache_fontes:
        return _cache_fontes[tamanho]
    candidatos = []
    if os.environ.get("QA_FONTE"):
        candidatos.append(os.environ["QA_FONTE"])
    candidatos += FONTES_POR_SO.get(chave_so(), []) + FONTES_POR_NOME
    fonte = None
    for c in candidatos:
        try:
            fonte = ImageFont.truetype(c, tamanho)
            break
        except OSError:
            continue
    if fonte is None:
        try:
            fonte = ImageFont.load_default(size=tamanho)
        except TypeError:
            fonte = ImageFont.load_default()
    _cache_fontes[tamanho] = fonte
    return fonte


def caixa_texto(d, xy, texto, fonte):
    try:
        return d.textbbox(xy, texto, font=fonte)
    except (AttributeError, ValueError):
        w, h = d.textsize(texto, font=fonte)
        return (xy[0], xy[1], xy[0] + w, xy[1] + h)


def texto_centrado(d, centro, texto, fonte, cor):
    try:
        d.text(centro, texto, fill=cor, font=fonte, anchor="mm")
        return
    except (ValueError, TypeError):
        pass
    b = caixa_texto(d, (0, 0), texto, fonte)
    w, h = b[2] - b[0], b[3] - b[1]
    d.text((centro[0] - w / 2 - b[0], centro[1] - h / 2 - b[1]), texto, fill=cor, font=fonte)


def parse_cor(valor: str):
    if valor is None:
        return CORES["vermelho"]
    v = str(valor).strip().lower()
    if v in CORES:
        return CORES[v]
    m = re.fullmatch(r"#?([0-9a-f]{6})", v)
    if m:
        h = m.group(1)
        return tuple(int(h[i:i + 2], 16) for i in (0, 2, 4))
    falhar(f'cor invalida "{valor}" (use {", ".join(CORES)} ou #RRGGBB)')


def numero(valor, nome: str, idx: int) -> float:
    try:
        return float(valor)
    except (TypeError, ValueError):
        falhar(f'marca {idx}: "{nome}" precisa ser numero (veio {valor!r})')


def primeiro(m: dict, *chaves):
    for k in chaves:
        if k in m and m[k] is not None:
            return m[k]
    return None


def normalizar_marca(bruta, idx: int) -> dict:
    if isinstance(bruta, (list, tuple)):
        if len(bruta) < 4:
            falhar(f"marca {idx}: lista precisa de [x, y, w, h]")
        m = {"x": bruta[0], "y": bruta[1], "w": bruta[2], "h": bruta[3]}
        if len(bruta) > 4:
            m["texto"] = bruta[4]
    elif isinstance(bruta, dict):
        m = dict(bruta)
    else:
        falhar(f"marca {idx}: precisa ser objeto {{x,y,w,h}} ou lista [x,y,w,h]")
    x = primeiro(m, "x", "left", "x0")
    y = primeiro(m, "y", "top", "y0")
    if x is None or y is None:
        falhar(f"marca {idx}: faltam x/y (aceita x,y,w,h | left,top,width,height | x0,y0,x1,y1)")
    x = numero(x, "x", idx)
    y = numero(y, "y", idx)
    w = primeiro(m, "w", "width")
    h = primeiro(m, "h", "height")
    if w is None:
        x1 = primeiro(m, "x1", "right")
        if x1 is None:
            falhar(f"marca {idx}: falta w/width (ou x1/right)")
        w = numero(x1, "x1", idx) - x
    if h is None:
        y1 = primeiro(m, "y1", "bottom")
        if y1 is None:
            falhar(f"marca {idx}: falta h/height (ou y1/bottom)")
        h = numero(y1, "y1", idx) - y
    w = numero(w, "w", idx)
    h = numero(h, "h", idx)
    if w < 0:
        x, w = x + w, -w
    if h < 0:
        y, h = y + h, -h
    return {"x": x, "y": y, "w": w, "h": h, "n": m.get("n"), "texto": m.get("texto"), "cor": m.get("cor")}


def eh_mapa(dados) -> bool:
    return (isinstance(dados, dict) and bool(dados) and "marcas" not in dados
            and not any(k in dados for k in ("x", "left", "x0"))
            and all(isinstance(v, (dict, list)) for v in dados.values()))


def chaves_da_imagem(entrada: Path, bruta: str):
    nome = entrada.name
    sem_circulado = nome.replace("-circulado", "") if "-circulado" in entrada.stem else None
    cands = [bruta, bruta.replace("\\", "/"), nome]
    if sem_circulado:
        cands.append(sem_circulado)
    return list(dict.fromkeys(cands))


def escolher_do_mapa(mapa: dict, entrada: Path, bruta: str, chave):
    if chave is not None:
        if chave not in mapa:
            falhar(f'--chave "{chave}" nao existe no mapa de marcas (chaves: {", ".join(list(mapa)[:10])})')
        return chave
    cands = chaves_da_imagem(entrada, bruta)
    for k in cands:
        if k in mapa:
            return k
    nomes = {Path(c).name for c in cands}
    por_nome = [k for k in mapa if Path(str(k).replace("\\", "/")).name in nomes]
    if len(por_nome) == 1:
        return por_nome[0]
    if len(por_nome) > 1:
        falhar(f"mais de uma chave do mapa serve para {entrada.name}: {', '.join(por_nome)}; escolha com --chave")
    falhar(f'nenhuma chave do mapa de marcas serve para "{entrada.name}" (procurei {", ".join(cands)}; chaves: '
           f'{", ".join(list(mapa)[:10])}{" ..." if len(mapa) > 10 else ""}). Use a chave igual ao nome do print '
           f"ou --chave <nome>")


def ler_marcas(fonte_marcas: str, entrada: Path = None, bruta: str = "", chave=None):
    texto = fonte_marcas
    if fonte_marcas == "-":
        texto = sys.stdin.read()
    else:
        s = fonte_marcas.strip()
        if not s.startswith(("[", "{")):
            p = Path(fonte_marcas).expanduser()
            if not p.exists():
                falhar(f"arquivo de marcas nao encontrado: {p}")
            texto = p.read_text(encoding="utf-8-sig")
    try:
        dados = json.loads(texto)
    except json.JSONDecodeError as e:
        falhar(f"marcas: JSON invalido (linha {e.lineno}, coluna {e.colno}): {e.msg}")
    conf = {"largura_css": None, "escala": None, "deslocamento": None, "unidade": None, "chave": None}
    if eh_mapa(dados):
        k = escolher_do_mapa(dados, entrada if entrada is not None else Path(""), bruta, chave)
        conf["chave"] = k
        dados = dados[k]
    elif chave is not None:
        falhar("--chave so vale com um mapa {\"<nome-da-imagem>.png\": {largura_css, marcas}}")
    if isinstance(dados, dict):
        largura = primeiro(dados, "largura_css", "innerWidth", "largura")
        conf["largura_css"] = float(numero(largura, "largura_css", 0)) if largura is not None else None
        if dados.get("escala") is not None:
            conf["escala"] = numero(dados["escala"], "escala", 0)
        if dados.get("deslocamento") is not None:
            d = dados["deslocamento"]
            conf["deslocamento"] = parse_par(",".join(map(str, d)) if isinstance(d, (list, tuple)) else str(d),
                                             "deslocamento")
        if dados.get("unidade"):
            conf["unidade"] = str(dados["unidade"]).lower()
        if "marcas" in dados:
            dados = dados["marcas"]
        elif any(k in dados for k in ("x", "left", "x0")):
            dados = [dados]
        else:
            falhar('marcas: objeto sem lista "marcas" (para varias imagens use o mapa '
                   '{"<nome-da-imagem>.png": {"largura_css": ..., "marcas": [...]}})')
    if not isinstance(dados, list):
        falhar("marcas: esperado uma lista")
    return [normalizar_marca(m, i) for i, m in enumerate(dados, 1)], conf


def parse_par(valor: str, nome: str):
    try:
        a, b = (float(x) for x in valor.split(","))
        return a, b
    except ValueError:
        falhar(f'{nome} precisa ser "a,b" (veio {valor!r})')


def anotar(entrada: Path, saida: Path, marcas: list, escala: float, cor_padrao, deslocamento=(0.0, 0.0),
           folga_css: float = 6.0, espessura=None, recorte=None, avisos=None) -> Path:
    avisos = avisos if avisos is not None else []
    im = Image.open(entrada)
    im = im.convert("RGBA" if im.mode in ("RGBA", "LA", "P") else "RGB")
    W, H = im.size
    d = ImageDraw.Draw(im)
    esp = espessura or max(3, round(4 * escala))
    tam_fonte = max(16, round(20 * escala))
    f = carregar_fonte(tam_fonte)
    raio = max(14, round(15 * escala))
    folga = folga_css * escala
    dx, dy = deslocamento
    caixas = []
    for i, m in enumerate(marcas, 1):
        tinta = parse_cor(m["cor"]) if m.get("cor") else cor_padrao
        x0 = (m["x"] + dx) * escala - folga
        y0 = (m["y"] + dy) * escala - folga
        x1 = (m["x"] + dx + m["w"]) * escala + folga
        y1 = (m["y"] + dy + m["h"]) * escala + folga
        if x1 < 0 or y1 < 0 or x0 > W or y0 > H:
            avisos.append(f"marca {i} fora da imagem ({x0:.0f},{y0:.0f})-({x1:.0f},{y1:.0f}) em {W}x{H}: "
                          f"confira --largura-css (innerWidth da janela) e --deslocamento (scroll)")
        elif x0 < 0 or y0 < 0 or x1 > W or y1 > H:
            avisos.append(f"marca {i} passa da borda da imagem: foi recortada na borda")
        bx0, by0 = max(0, x0), max(0, y0)
        bx1, by1 = min(W - 1, x1), min(H - 1, y1)
        if bx1 <= bx0 or by1 <= by0:
            continue
        caixas.append((x0, y0, x1, y1))
        try:
            d.rounded_rectangle([bx0, by0, bx1, by1], radius=round(8 * escala), outline=tinta, width=esp)
        except AttributeError:
            d.rectangle([bx0, by0, bx1, by1], outline=tinta, width=esp)
        rotulo = str(m["n"]) if m.get("n") not in (None, "") else str(i)
        r = raio if len(rotulo) <= 2 else raio + 4 * (len(rotulo) - 2)
        cx = min(max(bx0, r), W - r)
        cy = min(max(by0, r), H - r)
        d.ellipse([cx - r, cy - r, cx + r, cy + r], fill=tinta)
        texto_centrado(d, (cx, cy), rotulo, f, (255, 255, 255))
        if m.get("texto"):
            texto = str(m["texto"])
            pad = max(4, round(6 * escala))
            b = caixa_texto(d, (0, 0), texto, f)
            tw, th = b[2] - b[0], b[3] - b[1]
            sep = 8 * escala
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
    if recorte is not None:
        if recorte == "auto" or (isinstance(recorte, tuple) and recorte[0] == "auto"):
            margem = (recorte[1] if isinstance(recorte, tuple) else 48.0) * escala
            if caixas:
                rx0 = min(c[0] for c in caixas) - margem
                ry0 = min(c[1] for c in caixas) - margem
                rx1 = max(c[2] for c in caixas) + margem
                ry1 = max(c[3] for c in caixas) + margem
            else:
                rx0, ry0, rx1, ry1 = 0, 0, W, H
                avisos.append("recorte auto sem marcas: imagem mantida inteira")
        else:
            rx0, ry0, rx1, ry1 = ((v + (dx if k % 2 == 0 else dy)) * escala for k, v in enumerate(recorte))
        rx0, ry0 = max(0, int(rx0)), max(0, int(ry0))
        rx1, ry1 = min(W, int(round(rx1))), min(H, int(round(ry1)))
        if rx1 - rx0 < 2 or ry1 - ry0 < 2:
            falhar("recorte vazio depois de limitar a imagem: confira as coordenadas (pixels CSS)")
        im = im.crop((rx0, ry0, rx1, ry1))
    saida.parent.mkdir(parents=True, exist_ok=True)
    if saida.suffix.lower() in (".jpg", ".jpeg") and im.mode != "RGB":
        im = im.convert("RGB")
    im.save(saida)
    return saida


def parse_recorte(valor: str | None):
    if valor is None:
        return None
    v = valor.strip().lower()
    if v.startswith("auto"):
        if ":" in v:
            try:
                return ("auto", float(v.split(":", 1)[1]))
            except ValueError:
                falhar(f'--recorte auto:N precisa de numero (veio {valor!r})')
        return "auto"
    partes = [p for p in re.split(r"[,\s]+", v) if p]
    if len(partes) != 4:
        falhar('--recorte precisa de "x0,y0,x1,y1" (pixels CSS) ou "auto[:margem]"')
    try:
        x0, y0, x1, y1 = (float(p) for p in partes)
    except ValueError:
        falhar(f"--recorte com valor nao numerico: {valor!r}")
    return (min(x0, x1), min(y0, y1), max(x0, x1), max(y0, y1))


def saida_padrao(entrada: Path) -> Path:
    return entrada.with_name(f"{entrada.stem}-circulado{entrada.suffix or '.png'}")


EPILOGO = """\
formato das marcas (pixels CSS, como getBoundingClientRect devolve):
  [{"x":120,"y":340,"w":220,"h":40,"n":1,"texto":"sem asterisco"}, {"x":..., "cor":"verde"}]
  tambem aceita {left,top,width,height}, {x0,y0,x1,y1}, [x,y,w,h], o objeto de uma imagem
  {"largura_css": 1568, "marcas":[...]} (a largura vem junto com a medicao) e o MAPA por
  imagem, o mesmo arquivo que o provas.py le em <rodada>/evidencias/marcas.json:
  {"07-cnpj-ANTES.png": {"largura_css": 1568, "marcas":[...]}, "07-cnpj-CORRIGIDO.png": {...}}
  No mapa, a entrada sai do nome do print (com e sem -circulado) ou de --chave <nome>.
  Cada entrada aceita tambem "escala", "deslocamento" [dx, dy] e "unidade" ("css" | "px").

medir no navegador (cole na ferramenta de JS) e grave o resultado no mapa, sob a chave igual
ao nome do print, em <rodada>/evidencias/marcas.json (nunca na raiz do projeto):
  JSON.stringify({largura_css: innerWidth, marcas: [...document.querySelectorAll('SELETOR')]
    .map((e,i)=>{const r=e.getBoundingClientRect();return {x:r.x,y:r.y,w:r.width,h:r.height,n:i+1}})})

escala: pixels da imagem / --largura-css. Print de tela inteira com zoom ou DPR != 1 so bate se
--largura-css for o innerWidth da janela medida. Print de pagina inteira: some o scroll com
--deslocamento 0,<scrollY>. Marca fora da imagem gera aviso (sinal de largura errada).

exemplos:
  circular.py "$R/evidencias/03-salvar-ANTES.png" --marcas "$R/evidencias/marcas.json"
  circular.py "$R/evidencias/03-salvar-CORRIGIDO.png" --marcas "$R/evidencias/marcas.json" --cor verde
  circular.py "$R/evidencias/03-salvar-RETESTE.png" --marcas "$R/evidencias/marcas.json" \\
    --chave 03-salvar-CORRIGIDO.png --cor verde        (reaproveita a medida do DEPOIS)
  circular.py evidencias/03-salvar-ANTES.png --marcas uma-imagem.json --largura-css 1568
  circular.py tela.png saida.png '[{"x":10,"y":20,"w":100,"h":30}]' 1568 verde   (forma posicional antiga)
  circular.py tela.png --marcas marcas.json --recorte auto:60

codigos de saida: 0 ok | 2 uso, arquivo ou marcas invalidos (inclusive chave ausente no mapa) |
3 Pillow ausente
"""


def interpretar_posicionais(resto: list, args) -> None:
    for valor in resto:
        v = str(valor).strip()
        baixo = v.lower()
        if v.startswith(("[", "{")) or baixo.endswith(".json") or v == "-":
            if args.marcas is None:
                args.marcas = v
                continue
        if re.fullmatch(r"\d+(\.\d+)?", v) and args.largura_css is None:
            args.largura_css = float(v)
            continue
        if (baixo in CORES or re.fullmatch(r"#[0-9a-f]{6}", baixo)) and args.cor is None:
            args.cor = baixo
            continue
        if args.saida is None:
            args.saida = v
            continue
        falhar(f"argumento posicional nao reconhecido: {v!r}")


def main(argv=None) -> int:
    configurar_saida()
    ap = ParserPT(prog="circular.py",
                  description="Anota um print com caixas numeradas: vermelho = problema, verde = corrigido.",
                  epilog=EPILOGO)
    ap.add_argument("entrada", help="imagem de entrada (png/jpg)")
    ap.add_argument("resto", nargs="*", metavar="[SAIDA] [MARCAS] [LARGURA_CSS] [COR]",
                    help="forma posicional antiga; prefira as opcoes abaixo")
    ap.add_argument("-m", "--marcas", help="JSON inline, caminho de arquivo .json, ou - para ler da entrada padrao; "
                                           "aceita o mapa <rodada>/evidencias/marcas.json (uma entrada por imagem)")
    ap.add_argument("--chave", help="com o mapa: a chave a usar (padrao: o nome do print, com e sem -circulado)")
    ap.add_argument("-o", "--saida", help="imagem de saida (padrao: <entrada>-circulado.<ext>)")
    ap.add_argument("-l", "--largura-css", type=float, dest="largura_css",
                    help="innerWidth da janela onde as marcas foram medidas (define a escala)")
    ap.add_argument("--escala", type=float, help="escala explicita pixels-imagem/pixel-CSS (ignora --largura-css)")
    ap.add_argument("-c", "--cor", help="vermelho (padrao) | verde | amarelo | azul | #RRGGBB")
    ap.add_argument("--deslocamento", help='"dx,dy" em pixels CSS somados a toda marca (ex. 0,<scrollY>)')
    ap.add_argument("--folga", type=float, default=6.0, help="folga em pixels CSS entre o elemento e a caixa (padrao 6)")
    ap.add_argument("--espessura", type=int, help="espessura da linha em pixels da imagem")
    ap.add_argument("--recorte", help='"x0,y0,x1,y1" em pixels CSS, ou "auto[:margem]" em volta das marcas')
    args = ap.parse_args(argv)
    interpretar_posicionais(args.resto, args)

    if Image is None:
        falhar("Pillow nao instalado. Instale com: python -m pip install Pillow", EXIT_SEM_PILLOW)
    entrada = Path(args.entrada).expanduser()
    if not entrada.exists():
        falhar(f"imagem nao encontrada: {entrada}")
    if args.marcas is None:
        falhar("informe as marcas (--marcas JSON | arquivo.json | -)")
    marcas, conf = ler_marcas(args.marcas, entrada, args.entrada, args.chave)
    largura_do_arquivo = conf["largura_css"]
    if conf["chave"]:
        print(f'marcas: usando a chave "{conf["chave"]}" do mapa', file=sys.stderr)
    if not marcas:
        falhar("lista de marcas vazia")
    saida = Path(args.saida).expanduser() if args.saida else saida_padrao(entrada)
    if saida.resolve() == entrada.resolve():
        falhar("a saida nao pode sobrescrever a entrada: guarde o print cru e o -circulado")
    try:
        with Image.open(entrada) as tmp:
            largura_img = tmp.size[0]
    except OSError as e:
        falhar(f"nao consegui abrir a imagem {entrada}: {e}")
    unidade_px = conf["unidade"] == "px"
    largura_css = args.largura_css or (None if unidade_px else largura_do_arquivo)
    escala_do_arquivo = 1.0 if unidade_px else conf["escala"]
    if args.escala:
        escala = args.escala
    elif args.largura_css:
        escala = largura_img / args.largura_css
    elif escala_do_arquivo:
        escala = escala_do_arquivo
    elif largura_css:
        escala = largura_img / largura_css
    else:
        escala = 1.0
    if args.deslocamento:
        deslocamento = parse_par(args.deslocamento, "--deslocamento")
    else:
        deslocamento = conf["deslocamento"] or (0.0, 0.0)
    avisos: list = []
    if not args.escala and not largura_css and not escala_do_arquivo:
        avisos.append(f"sem --largura-css: usando escala 1 (pixel da imagem = pixel CSS). Se o print tem "
                      f"{largura_img}px e a janela media outro innerWidth, as caixas saem deslocadas")
    resultado = anotar(entrada, saida, marcas, escala, parse_cor(args.cor or "vermelho"), deslocamento,
                       args.folga, args.espessura, parse_recorte(args.recorte), avisos)
    for a in avisos:
        print(f"aviso: {a}", file=sys.stderr)
    print(str(resultado))
    return EXIT_OK


if __name__ == "__main__":
    sys.exit(main())

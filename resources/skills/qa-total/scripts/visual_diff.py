#!/usr/bin/env python3
"""visual_diff.py - compara prints entre rodadas (skill qa-total, modulo opcional 7).

Compara duas imagens, ou duas pastas casando os arquivos pelo nome: conta os pixels
diferentes (acima de uma tolerancia por canal), ignora retangulos mascarados (data, hora, id,
avatar), grava uma imagem de diferenca com o que mudou em vermelho, agrupa as diferencas em
regioes (no formato de marcas do circular.py) e escreve o relatorio em Markdown e JSON.

Diferenca nao e defeito: e um caso para OLHAR. Quem decide se e regressao, mudanca intencional
ou ruido e voce, olhando o par. Este script nunca atualiza a baseline.

Requer Pillow (python -m pip install Pillow). Python 3.9+. Windows, macOS e Linux.
"""
from __future__ import annotations

import argparse
import fnmatch
import json
import math
import os
import re
import sys
from datetime import datetime
from pathlib import Path

try:
    from PIL import Image, ImageChops, ImageDraw, ImageFont, ImageOps
except ImportError:
    Image = ImageChops = ImageDraw = ImageFont = ImageOps = None

EXIT_OK, EXIT_REPROVOU, EXIT_USO, EXIT_SEM_PILLOW = 0, 1, 2, 3

EXTENSOES = {".png", ".jpg", ".jpeg", ".webp", ".bmp"}
SUFIXOS_ANOTADOS = ("-circulado", "-diff", "-comparacao")
VERMELHO = (225, 29, 72)
AZUL = (37, 99, 235)
AMARELO = (217, 119, 6)

FONTES = [
    os.path.join(os.environ.get("WINDIR", r"C:\Windows"), "Fonts", n)
    for n in ("segoeuib.ttf", "arialbd.ttf", "segoeui.ttf", "arial.ttf")
] + [
    "/System/Library/Fonts/Supplemental/Arial Bold.ttf",
    "/System/Library/Fonts/Helvetica.ttc",
    "/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf",
    "/usr/share/fonts/dejavu/DejaVuSans-Bold.ttf",
    "/usr/share/fonts/TTF/DejaVuSans-Bold.ttf",
    "/usr/share/fonts/truetype/liberation/LiberationSans-Bold.ttf",
    "DejaVuSans-Bold.ttf",
    "arialbd.ttf",
]

STATUS_ORDEM = ["acima-do-limiar", "tamanho-diferente", "erro", "so-na-base", "abaixo-do-limiar",
                "so-na-atual", "igual"]
STATUS_LEGENDA = {
    "igual": "nenhum pixel acima da tolerância",
    "abaixo-do-limiar": "mudou pouco: abaixo do limiar, mas olhe se a região é de dado (um dígito trocado é pequeno)",
    "acima-do-limiar": "mudou acima do limiar: abra o par e classifique (regressão, intencional ou ruído)",
    "tamanho-diferente": "mudou o tamanho do print: layout, rolagem ou viewport diferentes",
    "so-na-base": "a baseline tem este print e a rodada não: cobertura perdida ou tela renomeada",
    "so-na-atual": "print novo sem baseline: revise e, se estiver certo, promova para a baseline",
    "erro": "não foi possível abrir ou comparar",
}


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


_fontes: dict = {}


def fonte(tamanho: int):
    if tamanho in _fontes:
        return _fontes[tamanho]
    f = None
    for c in FONTES:
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
    _fontes[tamanho] = f
    return f


def medir_texto(d, texto, f):
    try:
        b = d.textbbox((0, 0), texto, font=f)
        return b[2] - b[0], b[3] - b[1]
    except (AttributeError, ValueError):
        return d.textsize(texto, font=f)


def rotulo(d, xy, texto, cor, tamanho=16):
    f = fonte(tamanho)
    w, h = medir_texto(d, texto, f)
    x, y = xy
    pad = max(3, tamanho // 4)
    d.rectangle([x, y, x + w + 2 * pad, y + h + 2 * pad + 2], fill=cor)
    d.text((x + pad, y + pad - 1), texto, fill=(255, 255, 255), font=f)


def ler_json(valor: str):
    v = valor.strip()
    if v.startswith("[") or v.startswith("{"):
        try:
            return json.loads(v)
        except json.JSONDecodeError as e:
            falhar(f"mascaras: JSON invalido ({e})")
    p = Path(valor).expanduser()
    if not p.exists():
        falhar(f"arquivo de mascaras nao encontrado: {p}")
    try:
        return json.loads(p.read_text(encoding="utf-8-sig"))
    except json.JSONDecodeError as e:
        falhar(f"mascaras: JSON invalido em {p} ({e})")


def ret(bruto, origem: str) -> dict:
    if isinstance(bruto, (list, tuple)) and len(bruto) >= 4:
        x, y, w, h = bruto[:4]
        motivo = bruto[4] if len(bruto) > 4 else ""
    elif isinstance(bruto, dict):
        x = bruto.get("x", bruto.get("left"))
        y = bruto.get("y", bruto.get("top"))
        w = bruto.get("w", bruto.get("width"))
        h = bruto.get("h", bruto.get("height"))
        motivo = bruto.get("motivo", bruto.get("texto", ""))
    else:
        falhar(f"mascara invalida em {origem}: use {{x,y,w,h,motivo}} ou [x,y,w,h]")
    try:
        x, y, w, h = float(x), float(y), float(w), float(h)
    except (TypeError, ValueError):
        falhar(f"mascara invalida em {origem}: x, y, w e h precisam ser numeros")
    if w < 0:
        x, w = x + w, -w
    if h < 0:
        y, h = y + h, -h
    return {"x": x, "y": y, "w": w, "h": h, "motivo": str(motivo or "")}


def carregar_mascaras(arquivo, inline: list) -> dict:
    cfg = {"largura_css": None, "todas": [], "por_arquivo": []}
    if arquivo:
        dados = ler_json(arquivo)
        if isinstance(dados, list):
            cfg["todas"] = [ret(r, "lista") for r in dados]
        elif isinstance(dados, dict):
            lc = dados.get("largura_css")
            if lc is not None:
                try:
                    cfg["largura_css"] = float(lc)
                except (TypeError, ValueError):
                    falhar("mascaras: largura_css precisa ser numero")
                if cfg["largura_css"] <= 0:
                    falhar("mascaras: largura_css precisa ser > 0")
            todas = dados.get("todas", dados.get("mascaras", []))
            if isinstance(todas, dict):
                falhar('mascaras: "todas" precisa ser lista; para casar por arquivo use "por_arquivo"')
            cfg["todas"] = [ret(r, "todas") for r in (todas or [])]
            por = dados.get("por_arquivo", {}) or {}
            if not isinstance(por, dict):
                falhar('mascaras: "por_arquivo" precisa ser objeto {"padrao-glob": [retangulos]}')
            for padrao, lista in por.items():
                if not isinstance(lista, list):
                    falhar(f'mascaras: por_arquivo["{padrao}"] precisa ser lista')
                cfg["por_arquivo"].append((padrao, [ret(r, padrao) for r in lista]))
        else:
            falhar("mascaras: o JSON precisa ser lista de retangulos ou objeto {todas, por_arquivo, largura_css}")
    for s in inline or []:
        partes = [p.strip() for p in s.split(",")]
        if len(partes) != 4:
            falhar(f'--mascara "{s}": use x,y,w,h em pixels da imagem')
        r = ret(partes, "--mascara")
        r["motivo"] = "--mascara"
        r["imagem_px"] = True
        cfg["todas"].append(r)
    return cfg


def mascaras_para(cfg: dict, nome: str) -> list:
    lista = list(cfg["todas"])
    base = nome.rsplit("/", 1)[-1]
    for padrao, rets in cfg["por_arquivo"]:
        if fnmatch.fnmatch(nome, padrao) or fnmatch.fnmatch(base, padrao):
            lista.extend(rets)
    return lista


def chave(nome_rel: str, ignorar_prefixo: bool) -> str:
    p = Path(nome_rel)
    stem = p.stem
    if ignorar_prefixo:
        stem = re.sub(r"^\d+[-_]", "", stem)
    pasta = p.parent.as_posix()
    k = stem.lower()
    return k if pasta in ("", ".") else f"{pasta.lower()}/{k}"


def listar_imagens(pasta: Path, recursivo: bool, incluir_anotados: bool) -> list:
    itens = pasta.rglob("*") if recursivo else pasta.iterdir()
    saida = []
    for p in itens:
        if not p.is_file() or p.suffix.lower() not in EXTENSOES:
            continue
        if not incluir_anotados and p.stem.lower().endswith(SUFIXOS_ANOTADOS):
            continue
        saida.append(p.relative_to(pasta).as_posix())
    return sorted(saida)


def casar(base: Path, atual: Path, args) -> list:
    nb = listar_imagens(base, args.recursivo, args.incluir_anotados)
    na = listar_imagens(atual, args.recursivo, args.incluir_anotados)
    mapa_b: dict = {}
    mapa_a: dict = {}
    avisos = []
    for lista, mapa, lado in ((nb, mapa_b, "base"), (na, mapa_a, "atual")):
        for n in lista:
            k = chave(n, args.ignorar_prefixo)
            if k in mapa:
                avisos.append(f"{lado}: '{n}' e '{mapa[k]}' casam com o mesmo nome; usando '{mapa[k]}'")
                continue
            mapa[k] = n
    pares = []
    for k in sorted(set(mapa_b) | set(mapa_a)):
        pares.append((k, mapa_b.get(k), mapa_a.get(k)))
    return pares, avisos


def abrir(p: Path):
    with Image.open(p) as im:
        im.load()
        return im.convert("RGBA")


def em_canvas(im, w, h):
    if im.size == (w, h):
        return im
    c = Image.new("RGBA", (w, h), (0, 0, 0, 0))
    c.paste(im, (0, 0))
    return c


def regioes(binaria, celula: int, max_regioes: int) -> tuple:
    bbox = binaria.getbbox()
    if not bbox:
        return [], 0
    W, H = binaria.size
    cx0, cy0 = bbox[0] // celula, bbox[1] // celula
    cx1, cy1 = (bbox[2] - 1) // celula, (bbox[3] - 1) // celula
    ocupadas = set()
    for cy in range(cy0, cy1 + 1):
        for cx in range(cx0, cx1 + 1):
            caixa = (cx * celula, cy * celula, min(W, (cx + 1) * celula), min(H, (cy + 1) * celula))
            if binaria.crop(caixa).getbbox():
                ocupadas.add((cx, cy))
    grupos = []
    vistos = set()
    for inicio in sorted(ocupadas, key=lambda c: (c[1], c[0])):
        if inicio in vistos:
            continue
        pilha = [inicio]
        vistos.add(inicio)
        celulas = []
        while pilha:
            c = pilha.pop()
            celulas.append(c)
            for dx in (-1, 0, 1):
                for dy in (-1, 0, 1):
                    v = (c[0] + dx, c[1] + dy)
                    if v in ocupadas and v not in vistos:
                        vistos.add(v)
                        pilha.append(v)
        x0 = min(c[0] for c in celulas) * celula
        y0 = min(c[1] for c in celulas) * celula
        x1 = min(W, (max(c[0] for c in celulas) + 1) * celula)
        y1 = min(H, (max(c[1] for c in celulas) + 1) * celula)
        recorte = binaria.crop((x0, y0, x1, y1))
        justo = recorte.getbbox()
        if justo:
            x0, y0, x1, y1 = x0 + justo[0], y0 + justo[1], x0 + justo[2], y0 + justo[3]
        pixels = binaria.crop((x0, y0, x1, y1)).histogram()[255]
        grupos.append({"x": x0, "y": y0, "w": x1 - x0, "h": y1 - y0, "pixels": pixels})
    grupos.sort(key=lambda g: (-g["pixels"], g["y"], g["x"]))
    for i, g in enumerate(grupos, 1):
        g["n"] = i
    return grupos[:max_regioes], len(grupos)


def comparar(nome: str, nome_saida: str, pb: Path, pa: Path, cfg: dict, args, saida_dir: Path) -> dict:
    r = {"nome": nome, "base": str(pb), "atual": str(pa)}
    try:
        a = abrir(pb)
        b = abrir(pa)
    except (OSError, ValueError) as e:
        r.update(status="erro", reprova=True, erro=f"nao abriu: {e}")
        return r
    W, H = max(a.width, b.width), max(a.height, b.height)
    r["tamanho_base"] = [a.width, a.height]
    r["tamanho_atual"] = [b.width, b.height]
    ac, bc = em_canvas(a, W, H), em_canvas(b, W, H)

    dif = ImageChops.difference(ac, bc)
    cr, cg, cb, ca = dif.split()
    maximo = ImageChops.lighter(ImageChops.lighter(cr, cg), ImageChops.lighter(cb, ca))
    tol = args.tolerancia
    binaria = maximo.point(lambda v: 255 if v > tol else 0)

    za = ac.getchannel("A").point(lambda v: 255 if v == 0 else 0)
    zb = bc.getchannel("A").point(lambda v: 255 if v == 0 else 0)
    valido = ImageChops.invert(ImageChops.darker(za, zb))

    lista = mascaras_para(cfg, nome)
    escala = 1.0
    if cfg["largura_css"]:
        escala = b.width / cfg["largura_css"]
    mascara_img = Image.new("L", (W, H), 0)
    dm = ImageDraw.Draw(mascara_img)
    usadas = []
    for m in lista:
        e = 1.0 if m.get("imagem_px") else escala
        x0, y0 = int(math.floor(m["x"] * e)), int(math.floor(m["y"] * e))
        x1, y1 = int(math.ceil((m["x"] + m["w"]) * e)), int(math.ceil((m["y"] + m["h"]) * e))
        x0, y0, x1, y1 = max(0, x0), max(0, y0), min(W, x1), min(H, y1)
        if x1 <= x0 or y1 <= y0:
            continue
        dm.rectangle([x0, y0, x1 - 1, y1 - 1], fill=255)
        usadas.append({"x": x0, "y": y0, "w": x1 - x0, "h": y1 - y0, "motivo": m["motivo"]})
    valido = ImageChops.darker(valido, ImageChops.invert(mascara_img))
    binaria = ImageChops.darker(binaria, valido)

    comparados = valido.histogram()[255]
    diferentes = binaria.histogram()[255]
    if comparados == 0:
        r["aviso"] = "nenhum pixel comparado: tudo mascarado ou transparente"

    pct = (100.0 * diferentes / comparados) if comparados else 0.0
    tamanho_mudou = a.size != b.size
    r.update(pixels_comparados=comparados, pixels_diferentes=diferentes, percentual=round(pct, 4),
             mascaras_aplicadas=usadas, bbox=list(binaria.getbbox() or []) or None)

    if tamanho_mudou:
        status, reprova = "tamanho-diferente", True
    elif diferentes == 0:
        status, reprova = "igual", False
    elif pct > args.limiar and diferentes >= args.min_pixels:
        status, reprova = "acima-do-limiar", True
    else:
        status, reprova = "abaixo-do-limiar", False
    r["status"], r["reprova"] = status, reprova

    regs, total_regs = (regioes(binaria, args.celula, args.max_regioes) if diferentes else ([], 0))
    r["regioes"] = regs
    r["regioes_total"] = total_regs

    if diferentes == 0 and not tamanho_mudou:
        return r

    destino_base = saida_dir / nome_saida
    destino_base.parent.mkdir(parents=True, exist_ok=True)
    stem = destino_base.name
    for alvo in (pb, pa):
        for suf in ("-diff.png", "-comparacao.png", "-regioes.json"):
            if destino_base.with_name(stem + suf).resolve() == Path(alvo).resolve():
                falhar(f"a saida sobrescreveria a entrada {alvo}; use outro --saida-dir")

    fundo = ImageOps.grayscale(bc.convert("RGB")).convert("RGB")
    fundo = Image.blend(fundo, Image.new("RGB", (W, H), (255, 255, 255)), 0.6)
    vermelho = Image.new("RGB", (W, H), VERMELHO)
    img = Image.composite(vermelho, fundo, binaria)
    if usadas:
        azul = Image.new("RGB", (W, H), AZUL)
        sombra = mascara_img.point(lambda v: 70 if v else 0)
        img = Image.composite(azul, img, sombra)
    d = ImageDraw.Draw(img)
    esp = max(2, round(W / 640))
    for m in usadas:
        d.rectangle([m["x"], m["y"], m["x"] + m["w"] - 1, m["y"] + m["h"] - 1], outline=AZUL, width=esp)
    if tamanho_mudou:
        d.rectangle([0, 0, a.width - 1, a.height - 1], outline=AMARELO, width=esp)
    folga = 6 * esp
    for g in regs:
        x0, y0 = max(0, g["x"] - folga), max(0, g["y"] - folga)
        x1, y1 = min(W - 1, g["x"] + g["w"] + folga), min(H - 1, g["y"] + g["h"] + folga)
        d.rectangle([x0, y0, x1, y1], outline=VERMELHO, width=esp + 1)
        rotulo(d, (x0, max(0, y0 - (18 + 4 * esp))), str(g["n"]), VERMELHO, 14 + 2 * esp)
    p_diff = destino_base.with_name(stem + "-diff.png")
    img.save(p_diff)
    r["diff"] = str(p_diff)

    if args.lado_a_lado:
        cab = 44
        gut = 16
        comp = Image.new("RGB", (3 * W + 4 * gut, H + cab + 2 * gut), (255, 255, 255))
        paineis = [
            (ac, f"BASE {a.width}x{a.height}", (71, 85, 105)),
            (bc, f"ATUAL {b.width}x{b.height}", (71, 85, 105)),
            (img, f"DIFERENCA {diferentes} px ({pct:.3f}%)", VERMELHO),
        ]
        dc = ImageDraw.Draw(comp)
        for i, (pim, txt, cor) in enumerate(paineis):
            x = gut + i * (W + gut)
            fundo_p = Image.new("RGB", (W, H), (240, 242, 244))
            if pim.mode == "RGBA":
                fundo_p.paste(pim, (0, 0), pim)
            else:
                fundo_p.paste(pim, (0, 0))
            comp.paste(fundo_p, (x, gut + cab))
            rotulo(dc, (x, gut), txt, cor, 18)
        p_comp = destino_base.with_name(stem + "-comparacao.png")
        comp.save(p_comp)
        r["comparacao"] = str(p_comp)

    if regs:
        marcas = {"largura_css": b.width, "marcas": [
            {"x": g["x"], "y": g["y"], "w": g["w"], "h": g["h"], "n": g["n"],
             "texto": f"{g['pixels']} px diferentes"} for g in regs]}
        p_m = destino_base.with_name(stem + "-regioes.json")
        with open(p_m, "w", encoding="utf-8", newline="\n") as f:
            f.write(json.dumps(marcas, ensure_ascii=False, indent=2) + "\n")
        r["marcas_circular"] = str(p_m)
    return r


def rel(p, raiz: Path) -> str:
    if not p:
        return ""
    try:
        return Path(p).resolve().relative_to(raiz.resolve()).as_posix()
    except ValueError:
        return Path(p).as_posix()


def escrever_md(caminho: Path, resultados: list, contexto: dict, saida_dir: Path) -> None:
    cont: dict = {}
    for r in resultados:
        cont[r["status"]] = cont.get(r["status"], 0) + 1
    L = []
    L.append("# Comparação visual entre rodadas")
    L.append("")
    L.append(f"- **Base (baseline):** `{contexto['base']}`")
    L.append(f"- **Atual (rodada):** `{contexto['atual']}`")
    L.append(f"- **Gerado em:** {contexto['gerado_em']}")
    L.append(f"- **Tolerância por canal:** {contexto['tolerancia']} · **limiar:** {contexto['limiar']} % · "
             f"**mínimo de pixels:** {contexto['min_pixels']}")
    L.append(f"- **Máscaras:** {contexto['mascaras']}")
    L.append(f"- **Veredito:** {'REPROVOU' if contexto['reprovou'] else 'passou'} "
             f"({contexto['reprovadas']} de {len(resultados)} reprovada(s))")
    L.append("")
    L.append("> Diferença não é defeito: é um caso para olhar. Classifique cada par como regressão, mudança "
             "intencional (atualize a baseline só com registro) ou ruído (mascare a área e anote o motivo).")
    L.append("")
    L.append("## Resumo")
    L.append("")
    L.append("| Status | Quantidade | O que fazer |")
    L.append("|---|---:|---|")
    for s in STATUS_ORDEM:
        if s in cont:
            L.append(f"| {s} | {cont[s]} | {STATUS_LEGENDA[s]} |")
    L.append("")
    L.append("## Por imagem")
    L.append("")
    L.append("| Imagem | Status | Pixels diferentes | % | Tamanho base → atual | Regiões | Diferença |")
    L.append("|---|---|---:|---:|---|---:|---|")
    ordem = {s: i for i, s in enumerate(STATUS_ORDEM)}
    for r in sorted(resultados, key=lambda x: (ordem.get(x["status"], 99), -x.get("pixels_diferentes", 0), x["nome"])):
        tb = "×".join(map(str, r["tamanho_base"])) if r.get("tamanho_base") else "—"
        ta = "×".join(map(str, r["tamanho_atual"])) if r.get("tamanho_atual") else "—"
        dif = f"`{rel(r.get('diff'), saida_dir)}`" if r.get("diff") else (r.get("erro") or "—")
        pd = r.get("pixels_diferentes")
        L.append(f"| `{r['nome']}` | {r['status']} | {pd if pd is not None else '—'} | "
                 f"{r['percentual'] if r.get('percentual') is not None else '—'} | {tb} → {ta} | "
                 f"{r.get('regioes_total', 0)} | {dif} |")
    com_reg = [r for r in resultados if r.get("regioes")]
    if com_reg:
        L.append("")
        L.append("## Regiões que mudaram")
        L.append("")
        L.append("Coordenadas em pixels da imagem ATUAL. O arquivo `-regioes.json` já está no formato do "
                 "`circular.py` (escala 1): `circular.py <print-atual> --marcas <arquivo>-regioes.json`.")
        for r in com_reg:
            L.append("")
            L.append(f"### `{r['nome']}`")
            L.append("")
            for g in r["regioes"]:
                L.append(f"- **{g['n']}** · x {g['x']}, y {g['y']}, {g['w']}×{g['h']} · {g['pixels']} px")
            if r.get("regioes_total", 0) > len(r["regioes"]):
                L.append(f"- … e mais {r['regioes_total'] - len(r['regioes'])} região(ões) menores")
            if r.get("marcas_circular"):
                L.append(f"- marcas: `{rel(r['marcas_circular'], saida_dir)}`")
    if contexto.get("avisos"):
        L.append("")
        L.append("## Avisos")
        L.append("")
        for a in contexto["avisos"]:
            L.append(f"- {a}")
    caminho.parent.mkdir(parents=True, exist_ok=True)
    with open(caminho, "w", encoding="utf-8", newline="\n") as f:
        f.write("\n".join(L) + "\n")


EPILOGO = """\
como casa as pastas: pelo nome do arquivo (sem extensao, sem diferenciar caixa). Com
--ignorar-prefixo, "07-clientes-lista.png" casa com "03-clientes-lista.png". Arquivos
terminados em -circulado, -diff e -comparacao sao ignorados (use --incluir-anotados).

mascaras (JSON): lista de retangulos ou objeto
  {"largura_css": 1280,                       opcional: coordenadas em px CSS (escala pela imagem)
   "todas": [{"x":0,"y":0,"w":1280,"h":56,"motivo":"relogio no cabecalho"}],
   "por_arquivo": {"*clientes*": [{"x":900,"y":120,"w":200,"h":24,"motivo":"data de cadastro"}]}}
  sem largura_css as coordenadas sao pixels da imagem. --mascara x,y,w,h (px da imagem) e repetivel.
  medir no navegador:  JSON.stringify({largura_css: innerWidth, todas: [...document.querySelectorAll('SEL')]
    .map(e=>{const r=e.getBoundingClientRect();return {x:r.x,y:r.y,w:r.width,h:r.height,motivo:'SEL'}})})

reprova quando: tamanho mudou; ou percentual > --limiar E pixels >= --min-pixels.
--limiar 0 (padrao) reprova qualquer pixel acima da tolerancia: certo para prints da mesma
maquina, navegador, viewport e DPR. Entre maquinas diferentes, mascare o ruido antes de subir o limiar.

saidas (em --saida-dir): <nome>-diff.png (vermelho = mudou, azul = mascarado, amarelo = contorno
da base quando o tamanho mudou), <nome>-regioes.json (marcas para o circular.py),
<nome>-comparacao.png (com --lado-a-lado), visual-diff.md e visual-diff.json.

exemplos:
  visual_diff.py .qa/baseline/web .qa/2026-09-30-clientes/evidencias/visual --mascaras .qa/baseline/mascaras.json
  visual_diff.py antes.png depois.png --lado-a-lado -o .qa/2026-09-30-x/evidencias/visual
  visual_diff.py base/ atual/ --ignorar-prefixo --recursivo --limiar 0.05 --min-pixels 30

codigos de saida: 0 nada reprovou | 1 alguma imagem reprovou | 2 uso, arquivo ou mascara invalidos
(ou imagem que nao abriu) | 3 Pillow ausente
"""


def main(argv=None) -> int:
    configurar_saida()
    ap = ParserPT(prog="visual_diff.py",
                  description="Compara prints (arquivo x arquivo ou pasta x pasta) e destaca o que mudou.",
                  epilog=EPILOGO)
    ap.add_argument("base", help="imagem ou pasta da baseline (referencia)")
    ap.add_argument("atual", help="imagem ou pasta da rodada atual")
    ap.add_argument("-o", "--saida-dir", dest="saida_dir",
                    help="pasta de saida (padrao: <atual>-diff ao lado da pasta atual; ou a pasta do arquivo atual)")
    ap.add_argument("-m", "--mascaras", help="arquivo JSON (ou JSON inline) com retangulos ignorados")
    ap.add_argument("--mascara", action="append", default=[], help="retangulo x,y,w,h em pixels da imagem (repetivel)")
    ap.add_argument("--limiar", type=float, default=0.0,
                    help="%% de pixels diferentes acima do qual reprova (padrao 0: qualquer diferenca)")
    ap.add_argument("--min-pixels", type=int, default=0, dest="min_pixels",
                    help="diferenca com menos pixels que isto nao reprova (padrao 0)")
    ap.add_argument("--tolerancia", type=int, default=16,
                    help="diferenca por canal (0-255) ignorada: ruido de compressao e serrilhado (padrao 16)")
    ap.add_argument("--recursivo", action="store_true", help="inclui subpastas (casa pelo caminho relativo)")
    ap.add_argument("--ignorar-prefixo", action="store_true", dest="ignorar_prefixo",
                    help='ignora o prefixo numerico "NN-" do nome ao casar')
    ap.add_argument("--incluir-anotados", action="store_true", dest="incluir_anotados",
                    help="nao ignora arquivos -circulado, -diff e -comparacao")
    ap.add_argument("--lado-a-lado", action="store_true", dest="lado_a_lado",
                    help="grava tambem <nome>-comparacao.png (base | atual | diferenca)")
    ap.add_argument("--celula", type=int, default=24, help="tamanho da grade (px) para agrupar regioes (padrao 24)")
    ap.add_argument("--max-regioes", type=int, default=20, dest="max_regioes", help="regioes listadas por imagem (padrao 20)")
    ap.add_argument("--estrito", action="store_true",
                    help="print que so existe na base (sumiu da rodada) tambem reprova")
    ap.add_argument("--relatorio-md", dest="relatorio_md", help="caminho do relatorio Markdown (padrao <saida-dir>/visual-diff.md)")
    ap.add_argument("--relatorio-json", dest="relatorio_json", help="caminho do relatorio JSON (padrao <saida-dir>/visual-diff.json)")
    ap.add_argument("-q", "--quieto", action="store_true", help="so a linha de resumo na saida")
    args = ap.parse_args(argv)

    if Image is None:
        falhar("Pillow nao instalado. Instale com: python -m pip install Pillow", EXIT_SEM_PILLOW)
    if not 0 <= args.tolerancia <= 255:
        falhar("--tolerancia vai de 0 a 255")
    if args.limiar < 0 or args.limiar > 100:
        falhar("--limiar vai de 0 a 100 (%)")
    if args.min_pixels < 0 or args.celula < 4 or args.max_regioes < 1:
        falhar("--min-pixels >= 0, --celula >= 4 e --max-regioes >= 1")

    base = Path(args.base).expanduser()
    atual = Path(args.atual).expanduser()
    for p, nome in ((base, "base"), (atual, "atual")):
        if not p.exists():
            falhar(f"{nome} nao encontrado: {p}")
    if base.resolve() == atual.resolve():
        falhar("base e atual sao o mesmo caminho")
    modo_pasta = base.is_dir()
    if modo_pasta != atual.is_dir():
        falhar("compare arquivo com arquivo ou pasta com pasta")

    if args.saida_dir:
        saida_dir = Path(args.saida_dir).expanduser()
    elif modo_pasta:
        saida_dir = atual.parent / (atual.name + "-diff")
    else:
        saida_dir = atual.parent
    if modo_pasta:
        try:
            saida_dir.resolve().relative_to(base.resolve())
            dentro = True
        except ValueError:
            dentro = False
        if dentro:
            falhar(f"a saida ({saida_dir}) fica dentro da baseline ({base}): a baseline nunca recebe arquivo gerado")
    saida_dir.mkdir(parents=True, exist_ok=True)

    cfg = carregar_mascaras(args.mascaras, args.mascara)
    avisos: list = []
    resultados = []
    if modo_pasta:
        pares, avisos = casar(base, atual, args)
        if not pares:
            falhar("nenhuma imagem (.png .jpg .jpeg .webp .bmp) nas duas pastas")
        for k, nb, na in pares:
            if nb and na:
                resultados.append(comparar(na, str(Path(na).with_suffix("")), base / nb, atual / na,
                                           cfg, args, saida_dir))
            elif nb:
                resultados.append({"nome": nb, "base": str(base / nb), "atual": None, "status": "so-na-base",
                                   "reprova": bool(args.estrito)})
            else:
                resultados.append({"nome": na, "base": None, "atual": str(atual / na), "status": "so-na-atual",
                                   "reprova": False})
    else:
        if base.suffix.lower() not in EXTENSOES or atual.suffix.lower() not in EXTENSOES:
            avisos.append("extensao fora de .png/.jpg/.jpeg/.webp/.bmp: tentando abrir assim mesmo")
        resultados.append(comparar(atual.name, atual.stem, base, atual, cfg, args, saida_dir))

    for r in resultados:
        if r.get("aviso"):
            avisos.append(f"{r['nome']}: {r['aviso']}")
    reprovadas = sum(1 for r in resultados if r.get("reprova"))
    erros = sum(1 for r in resultados if r["status"] == "erro")
    n_masc = len(cfg["todas"]) + sum(len(x[1]) for x in cfg["por_arquivo"])
    contexto = {
        "base": str(base), "atual": str(atual), "gerado_em": datetime.now().astimezone().isoformat(timespec="seconds"),
        "tolerancia": args.tolerancia, "limiar": args.limiar, "min_pixels": args.min_pixels,
        "mascaras": (f"{args.mascaras or 'inline'} ({n_masc} retângulo(s)"
                     + (f", px CSS com largura {cfg['largura_css']:g}" if cfg["largura_css"] else ", px da imagem") + ")")
        if n_masc else "nenhuma",
        "reprovou": reprovadas > 0, "reprovadas": reprovadas, "avisos": avisos,
    }
    p_md = Path(args.relatorio_md).expanduser() if args.relatorio_md else saida_dir / "visual-diff.md"
    p_js = Path(args.relatorio_json).expanduser() if args.relatorio_json else saida_dir / "visual-diff.json"
    escrever_md(p_md, resultados, contexto, saida_dir)
    p_js.parent.mkdir(parents=True, exist_ok=True)
    with open(p_js, "w", encoding="utf-8", newline="\n") as f:
        f.write(json.dumps({"gerador": "qa-total/visual_diff.py", **contexto,
                            "parametros": {"tolerancia": args.tolerancia, "limiar": args.limiar,
                                           "min_pixels": args.min_pixels, "celula": args.celula,
                                           "recursivo": args.recursivo, "ignorar_prefixo": args.ignorar_prefixo,
                                           "estrito": args.estrito},
                            "imagens": resultados}, ensure_ascii=False, indent=2) + "\n")

    for a in avisos:
        print(f"aviso: {a}", file=sys.stderr)
    if not args.quieto:
        for r in resultados:
            if r["status"] == "igual":
                continue
            extra = ""
            if r.get("pixels_diferentes") is not None:
                extra = f" {r['pixels_diferentes']} px ({r['percentual']}%)"
            if r.get("diff"):
                extra += f" -> {r['diff']}"
            if r.get("erro"):
                extra += f" ({r['erro']})"
            print(f"{'REPROVA' if r.get('reprova') else 'olhar  '} {r['status']:<18} {r['nome']}{extra}")
    cont: dict = {}
    for r in resultados:
        cont[r["status"]] = cont.get(r["status"], 0) + 1
    print(f"{len(resultados)} imagem(ns): " + ", ".join(f"{s} {cont[s]}" for s in STATUS_ORDEM if s in cont)
          + f" | reprovadas {reprovadas} | relatorio {p_md}")
    if erros:
        return EXIT_USO
    return EXIT_REPROVOU if reprovadas else EXIT_OK


if __name__ == "__main__":
    sys.exit(main())

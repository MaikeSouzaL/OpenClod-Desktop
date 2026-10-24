#!/usr/bin/env python3
"""mensagens.py - rascunho das mensagens para o time a partir do ledger do QA (skill qa-total).

Le o cobertura.json da rodada e escreve, por defeito, as mensagens que o USUARIO vai mandar ao time:
- estilo "whatsapp" (padrao): um bloco copiavel por mensagem, sem tag de linguagem, linhas curtas,
  minusculas, sem pontuacao de fim, codigo/caminho/branch em bloco proprio, sintoma em vez de nome de
  classe, e a ressalva do que NAO foi testado sempre no fim, inteira;
- estilo "formal": assunto + corpo para e-mail ou PR;
- --oraculo: as duvidas de regra da rodada, juntas, como perguntas fechadas com o custo de cada opcao;
- --issue: um rascunho de issue por defeito, a partir de templates/issue.md.
O estilo vem do .qa/PERFIL.md (chaves estilo_mensagens e mensagens_*), e a linha de comando manda.

NAO envia nada e nao cria issue: quem envia e o usuario. Termina com o checklist "antes de mandar".

Somente biblioteca padrao. Python 3.9+. Windows, macOS e Linux.
"""
from __future__ import annotations

import argparse
import hashlib
import html
import json
import os
import re
import sys
import unicodedata
from datetime import datetime
from pathlib import Path

_AQUI = Path(__file__).resolve().parent
if str(_AQUI) not in sys.path:
    sys.path.insert(0, str(_AQUI))
import _mascara

NOME_LEDGER = "cobertura.json"
SEVERIDADES = ["critico", "alto", "medio", "baixo"]
ROTULO_SEVERIDADE = {"critico": "crítico", "alto": "alto", "medio": "médio", "baixo": "baixo"}
SEVERIDADE_FEMININO = {"critico": "crítica", "alto": "alta", "medio": "média", "baixo": "baixa"}
ROTULO_STATUS_DEFEITO = {"aberto": "aberto", "corrigido": "corrigido, sem reteste",
                         "retestado-ok": "corrigido e retestado", "nao-corrigido": "não corrigido"}
ROTULO_TIPO = {"defeito": "defeito", "melhoria": "melhoria", "decisao-de-produto": "decisão de produto",
               "retratado": "retratado"}
STATUS_NAO_VALIDADO = ("nao-validado", "bloqueado", "pendente")
EXT_IMAGEM = {".png", ".jpg", ".jpeg", ".gif", ".webp", ".bmp"}
EXT_TEXTO_ANEXO = {".json", ".txt", ".log", ".har", ".md", ".csv", ".yaml", ".yml", ".xml", ".jsonl", ".ndjson"}
EXT_JSON_ESTRUTURA = {".json", ".har", ".jsonl", ".ndjson"}
LIMITE_ANEXO_TEXTO = 3 * 1024 * 1024

EXIT_OK, EXIT_REVISAR, EXIT_USO = 0, 1, 2

PADRAO_CONFIG = {
    "estilo_mensagens": "whatsapp",
    "mensagens_minusculas": "sim",
    "mensagens_pontuacao_final": "nao",
    "mensagens_max_linha": "90",
    "mensagens_linhas_por_mensagem": "3",
    "mensagens_abertura": "",
    "mensagens_fecho": "",
    "mensagens_trocas": "",
    "mensagens_canal_tecnico": "",
    "mensagens_canal_negocio": "",
    "mensagens_canal_proibido": "",
    "mensagens_dizer_nao_commitado": "sim",
    "mensagens_codigo": "",
    "mensagens_numerar": "sim",
    "mensagens_saudacao_formal": "Olá,",
}

CONECTIVOS = [
    "ou seja", "portanto", "vale ressaltar que", "vale ressaltar", "vale destacar que", "além disso", "alem disso",
    "dessa forma", "desta forma", "no entanto", "contudo", "todavia", "assim sendo", "sendo assim",
    "por conseguinte", "nesse sentido", "neste sentido", "cabe destacar que", "cabe ressaltar que",
    "é importante notar que", "é importante ressaltar que", "e importante notar que", "em suma", "em resumo",
    "ademais", "outrossim", "diante disso", "dito isso",
]
RE_CONECTIVO = re.compile(r"^\s*(?:" + "|".join(re.escape(c) for c in sorted(CONECTIVOS, key=len, reverse=True))
                          + r")\b\s*,?\s*", re.I)
RE_ANALOGIA = re.compile(r"\b(é como|e como se|tipo um|tipo uma|é tipo|funciona como|imagine|parece um|parece uma)\b", re.I)
RE_CATEGORICO = re.compile(r"\b(nunca|sempre|todos|todas|nenhum|nenhuma|não existe|nao existe|impossível|impossivel|"
                           r"jamais|100 ?%)", re.I)
RE_ATRIBUICAO = re.compile(r"\b(teu|tua|seu commit|sua correção|sua correcao|sua mudança|culpa)\b", re.I)
RE_DUVIDA_DE_REGRA = re.compile(r"orac|regra|pergunt|decid|produto")
CODIGO = [
    (re.compile(r"(?:[\w.-]+[/\\])+[\w.-]+\.(?:tsx?|jsx?|mjs|cjs|cs|py|java|kt|go|rb|php|vue|svelte|sql|ya?ml|scss|css|html?)"
                r"(?::\d+)?"), "caminho de arquivo"),
    (re.compile(r"\b[\w-]+\.(?:tsx?|jsx?|cs|py|java|kt|go|rb|php|vue|svelte|sql):\d+\b"), "arquivo:linha"),
    (re.compile(r"\b\w+\(\)"), "chamada de função"),
    (re.compile(r"\b[a-z]+[A-Z][A-Za-z0-9]*\b"), "nome de código (camelCase)"),
    (re.compile(r"\b[A-Z][a-z0-9]+(?:[A-Z][a-z0-9]+)+\b"), "nome de código (PascalCase)"),
    (re.compile(r"\b[a-z]+_[a-z0-9]+(?:_[a-z0-9]+)*\b"), "nome de código (snake_case)"),
]
ABREVIACOES = {"ex", "etc", "obs", "sr", "sra", "dr", "dra", "p", "pg", "pág", "nº", "n", "vs", "aprox", "qtd",
               "cia", "ltda", "min", "máx", "max", "seg", "fig", "cf", "eg", "ie"}


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
    return re.sub(r"\s+", " ", str(valor)).strip()


def sem_acento(s: str) -> str:
    s = unicodedata.normalize("NFKD", s or "")
    return "".join(ch for ch in s if not unicodedata.combining(ch)).lower()


def sim(valor) -> bool:
    return sem_acento(texto(valor)) in ("sim", "s", "true", "yes", "y", "1", "on", "verdadeiro")


def caminho_ledger(alvo: str) -> Path:
    p = Path(alvo).expanduser()
    if p.suffix.lower() == ".json":
        return p
    return p / NOME_LEDGER


def carregar(p: Path) -> dict:
    if not p.exists():
        falhar(f"ledger nao encontrado: {p}  (crie com: cobertura.py init <pasta-rodada> --alvo ...)")
    try:
        dados = json.loads(p.read_text(encoding="utf-8-sig"))
    except json.JSONDecodeError as e:
        falhar(f"JSON invalido em {p}: linha {e.lineno}, coluna {e.colno}: {e.msg}")
    except OSError as e:
        falhar(f"nao consegui ler {p}: {e}")
    if not isinstance(dados, dict):
        falhar(f"a raiz de {p} precisa ser um objeto JSON")
    if not isinstance(dados.get("rodada"), dict):
        dados["rodada"] = {}
    for chave in ("itens", "casos", "defeitos", "sujeira"):
        if not isinstance(dados.get(chave), list):
            dados[chave] = []
        dados[chave] = [x for x in dados[chave] if isinstance(x, dict)]
    return dados


def lista(valor) -> list:
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
            saida[chave if chave in saida else "outras"].extend(lista(valor))
    else:
        saida["outras"].extend(lista(ev))
    return saida


def codigo_testado(rodada: dict) -> str:
    g = rodada.get("git")
    regs = [g] if isinstance(g, dict) else [x for x in (g or []) if isinstance(x, dict)] if isinstance(g, list) else []
    partes = []
    for x in regs:
        bc = " @ ".join(y for y in (texto(x.get("branch")), texto(x.get("commit"))) if y)
        if bc:
            partes.append(f"{texto(x.get('repo'))}: {bc}" if texto(x.get("repo")) else bc)
    return "; ".join(partes)


def caminho_evidencia(e):
    if isinstance(e, str):
        return e.strip() or None
    if isinstance(e, dict):
        for chave in ("arquivo", "caminho", "path"):
            if not vazio(e.get(chave)):
                return str(e[chave]).strip()
    return None


class Config:
    def __init__(self):
        self.valores = dict(PADRAO_CONFIG)
        self.fonte = "padrao da skill"
        self.ambiente_reteste = ""
        self.nomes_publicos: set = set()
        self.projeto_de_interface = False
        self.ressalva_pacote = ""

    def ler_perfil(self, caminho: Path) -> None:
        try:
            linhas = re.sub(r"<!--.*?-->", "", caminho.read_text(encoding="utf-8-sig"), flags=re.S).splitlines()
        except OSError:
            return
        achou = 0
        na_secao_reteste = False
        for bruta in linhas:
            linha = re.sub(r"<!--.*?-->", "", bruta)
            linha = linha.replace("**", "").replace("__", "").replace("`", "")
            if re.match(r"^\s*#{1,6}\s", linha):
                na_secao_reteste = bool(re.match(r"^\s*#{1,6}\s*3\.1\b", linha))
                continue
            if na_secao_reteste and not self.ambiente_reteste:
                mn = re.match(r"^\s*[-*+]\s*Nome\s*:\s*(.+?)\s*$", linha)
                if mn and not re.search(r"[<>]", mn.group(1)):
                    self.ambiente_reteste = mn.group(1).strip().strip('"').strip("'")
            m = re.match(r"^\s*(?:[-*+]\s*)?(?:\|\s*)?(estilo_mensagens|mensagens_[a-z_]+)\s*(?:[:=]|\|)\s*(.*?)\s*\|?\s*$",
                         linha)
            if not m:
                continue
            valor = m.group(2).strip().strip('"').strip("'").strip()
            if not valor or (valor.startswith("<") and valor.endswith(">")):
                continue
            self.valores[m.group(1)] = valor
            achou += 1
        if achou:
            self.fonte = f"{caminho} ({achou} chave(s))"

    def __getitem__(self, chave):
        return self.valores.get(chave, "")

    def inteiro(self, chave, padrao):
        try:
            return max(1, int(str(self[chave]).strip()))
        except ValueError:
            return padrao


def achar_perfil(explicito, dados: dict, pasta: Path):
    if explicito:
        p = Path(explicito).expanduser()
        if not p.exists():
            falhar(f"PERFIL nao encontrado: {p}")
        return p
    nomes = [texto(dados["rodada"].get("perfil")), ".qa/PERFIL.md", "PERFIL.md"]
    bases = [Path.cwd(), pasta, pasta.parent, pasta.parent.parent]
    for nome in [n for n in nomes if n]:
        bruto = Path(nome).expanduser()
        candidatos = [bruto] if bruto.is_absolute() else [b / bruto for b in bases]
        for c in candidatos:
            if c.is_file():
                return c
    return None


def impressao_alerta(txt: str) -> str:
    return hashlib.sha256(texto(txt).encode("utf-8")).hexdigest()[:12]


class Avisos:
    def __init__(self, estrito: bool = False, revisados=None):
        self.itens: list = []
        self.lacunas = 0
        self.segredos = 0
        self.anexos_faltando = 0
        self.anexos_fora = 0
        self.fora_do_formato = 0
        self.estrito = estrito
        self.revisados = set(revisados or ())

    def revisado(self, txt: str) -> bool:
        return impressao_alerta(txt) in self.revisados or texto(txt) in self.revisados

    def alertas_abertos(self) -> list:
        return [a for a in self.itens if not self.revisado(a)]

    def pendencias(self) -> int:
        base = self.lacunas + self.segredos + self.anexos_faltando + self.anexos_fora + self.fora_do_formato
        return base + (len(self.alertas_abertos()) if self.estrito else 0)

    def add(self, txt: str) -> None:
        if txt not in self.itens:
            self.itens.append(txt)


class Elemento:
    def __init__(self, tipo: str, conteudo, rotulo: str = ""):
        self.tipo = tipo
        self.conteudo = conteudo
        self.rotulo = rotulo


class Secao:
    def __init__(self, titulo: str, nota: str = "", nivel: int = 2):
        self.titulo = titulo
        self.nota = nota
        self.nivel = nivel
        self.elementos: list = []


def resumo(s: str, n: int = 45) -> str:
    s = texto(s)
    return s if len(s) <= n else s[: n - 1] + "…"


def mascarar(s: str, av: Avisos, onde: str = "") -> str:
    s, tipos = _mascara.mascarar_com_tipos(s, estrito=True)
    for nome in sorted(set(tipos)):
        av.segredos += tipos.count(nome)
        av.add(f"SEGREDO mascarado ({nome}), marcado [REMOVIDO] em \"{resumo(s)}\": nunca mande o original; "
               f"tire o dado do ledger tambem")
    return s


def limpar_markdown(s: str) -> str:
    s = texto(s)
    s = s.replace("**", "").replace("__", "").replace("`", "")
    s = re.sub(r"^\s*(?:#+|>|[-*+])\s+", "", s)
    return s.strip()


def frases(s: str) -> list:
    pedacos = [p for p in re.split(r"(?<=[.!?;])\s+(?=\S)", s) if p.strip()]
    saida = []
    for p in pedacos:
        if saida:
            ultima = saida[-1]
            m = re.search(r"(\S+)\.$", ultima)
            if m and m.group(1).lower().strip("(") in ABREVIACOES:
                saida[-1] = ultima + " " + p
                continue
        saida.append(p.strip())
    return saida


def equilibrado(prefixo: str) -> bool:
    return (prefixo.count("(") == prefixo.count(")") and prefixo.count("[") == prefixo.count("]")
            and prefixo.count("'") % 2 == 0 and prefixo.count('"') % 2 == 0)


def pedacos_seguros(frase: str, padrao: str = r"(?<=[,:])\s+") -> list:
    pedacos, inicio = [], 0
    for m in re.finditer(padrao, frase):
        if equilibrado(frase[:m.start()]):
            pedacos.append(frase[inicio:m.start()])
            inicio = m.end()
    pedacos.append(frase[inicio:])
    return [p for p in pedacos if p]


def quebrar(frase: str, maximo: int) -> list:
    if len(frase) <= maximo:
        return [frase]
    linhas, atual = [], ""
    for p in pedacos_seguros(frase):
        cand = f"{atual} {p}".strip() if atual else p
        if len(cand) <= maximo or not atual:
            atual = cand
        else:
            linhas.append(atual)
            atual = p
    if atual:
        linhas.append(atual)
    final = []
    for linha in linhas:
        if len(linha) <= maximo:
            final.append(linha)
            continue
        atual = ""
        for w in pedacos_seguros(linha, r"\s+"):
            cand = f"{atual} {w}".strip()
            if len(cand) <= maximo or not atual:
                atual = cand
            else:
                final.append(atual)
                atual = w
        if atual:
            final.append(atual)
    saida = []
    for linha in final:
        if saida and len(linha) < 16 and len(saida[-1]) + 1 + len(linha) <= int(maximo * 1.25):
            saida[-1] = f"{saida[-1]} {linha}"
        else:
            saida.append(linha)
    return saida


def minusculas_seguras(linha: str) -> str:
    def troca(m):
        tok = m.group(0)
        nucleo = tok.strip("()[]{}\"'.,;:!?¿¡«»“”‘’")
        if not nucleo or (tok.startswith("[") and tok.rstrip(".,;:!?").endswith("]")):
            return tok
        if re.search(r"\d", nucleo) or re.search(r"[/\\_@#=<>{}$%&*+|~^]", nucleo) or "://" in nucleo:
            return tok
        if "-" in nucleo and re.search(r"[A-Z]", nucleo):
            return tok
        if re.search(r"[a-z][A-Z]", nucleo) or re.search(r"[A-Z][a-z]+[A-Z]", nucleo):
            return tok
        return tok.lower()
    return re.sub(r"\S+", troca, linha)


def aplicar_trocas(linha: str, trocas: str) -> str:
    for par in re.split(r"\s*;\s*", trocas or ""):
        if "=" not in par and "→" not in par:
            continue
        de, para = re.split(r"\s*(?:=|→)\s*", par, maxsplit=1)
        if de:
            linha = re.sub(rf"(?<!\w){re.escape(de)}(?!\w)", para, linha)
    return linha


class Estilo:
    def __init__(self, cfg: Config, av: Avisos, estilo: str):
        self.cfg = cfg
        self.av = av
        self.estilo = estilo
        self.maximo = cfg.inteiro("mensagens_max_linha", 90)
        self.por_msg = cfg.inteiro("mensagens_linhas_por_mensagem", 3)
        self.minusculas = sim(cfg["mensagens_minusculas"])
        self.tira_ponto = not sim(cfg["mensagens_pontuacao_final"])

    def nome_publico(self, token: str, nome_regra: str) -> bool:
        """Em biblioteca, CLI ou API, o nome da funcao publica, do comando e da excecao e o proprio sintoma."""
        publicos = getattr(self.cfg, "nomes_publicos", None)
        if publicos is None or not getattr(self.cfg, "projeto_de_interface", False):
            return False
        if nome_regra in ("caminho de arquivo", "arquivo:linha"):
            return False
        t = token[:-2] if token.endswith("()") else token
        return t in publicos or bool(re.search(r"(?:Error|Exception)$", t))

    def checar(self, original: str, checar_tom: bool, campo_ledger: str = "") -> None:
        original = _mascara.mascarar(texto(original), estrito=True)[0]
        for rx, nome in ([] if self.estilo == "formal" else CODIGO):
            for m in rx.finditer(original):
                if self.nome_publico(m.group(0), nome):
                    continue
                if campo_ledger:
                    self.av.add(f"\"{resumo(original)}\": campo do ledger ({campo_ledger}) com detalhe de codigo ({nome} "
                                f"\"{m.group(0)}\"): confira e marque em --alertas-revisados")
                else:
                    self.av.add(f"\"{resumo(original)}\": {nome} \"{m.group(0)}\" — descreva o sintoma; se a pessoa "
                                f"pediu o detalhe, mande-o em bloco proprio (--com-codigo)")
                break
        if not checar_tom:
            return
        m = RE_CATEGORICO.search(original)
        if m:
            self.av.add(f"\"{resumo(original)}\": afirmacao categorica \"{m.group(0)}\" — confira o dado antes de mandar")
        m = RE_ANALOGIA.search(original)
        if m:
            self.av.add(f"\"{resumo(original)}\": possivel analogia \"{m.group(0)}\" — troque pelo fato")
        m = RE_ATRIBUICAO.search(original)
        if m:
            self.av.add(f"\"{resumo(original)}\": atribui a alguem (\"{m.group(0)}\") — confirme na base limpa que nao "
                        f"e efeito do seu proprio working tree")

    def linhas(self, ideia: str, checar_tom: bool = True, campo_ledger: str = "") -> list:
        bruto = mascarar(limpar_markdown(ideia), self.av, ideia)
        if not bruto:
            return []
        self.checar(bruto, checar_tom, campo_ledger)
        if self.estilo == "formal":
            return [bruto]
        saida = []
        for f in frases(bruto):
            sem = RE_CONECTIVO.sub("", f)
            if sem != f:
                self.av.add(f"conectivo de redacao removido em \"{resumo(f)}\"")
            for linha in quebrar(sem.strip(), self.maximo):
                if self.minusculas:
                    linha = minusculas_seguras(linha).replace("[preencha:", "[PREENCHA:")
                linha = aplicar_trocas(linha, self.cfg["mensagens_trocas"])
                if self.tira_ponto:
                    linha = re.sub(r"[\s.!;,…]+$", "", linha)
                if linha.strip():
                    saida.append(linha.strip())
        return saida

    def mensagens(self, ideias: list, checar_tom: bool = True, campo_ledger: str = "") -> list:
        saida, atual = [], []
        for ideia in ideias:
            linhas = self.linhas(ideia, checar_tom, campo_ledger)
            if not linhas:
                continue
            if atual and len(atual) + len(linhas) > self.por_msg:
                saida.append(atual)
                atual = []
            for i in range(0, len(linhas), self.por_msg):
                pedaco = linhas[i:i + self.por_msg]
                if atual and len(atual) + len(pedaco) > self.por_msg:
                    saida.append(atual)
                    atual = []
                atual = atual + pedaco
        if atual:
            saida.append(atual)
        return saida


def add_msgs(secao: Secao, est: Estilo, ideias: list, checar_tom: bool = True, campo_ledger: str = "") -> None:
    for linhas in est.mensagens([i for i in ideias if not vazio(i)], checar_tom, campo_ledger):
        secao.elementos.append(Elemento("msg", linhas))


PROPOSTA_NO_RELATORIO = "proposta registrada no relatório"


def add_bloco(secao: Secao, conteudo: str, av: Avisos, rotulo: str = "") -> None:
    secao.elementos.append(Elemento("bloco", mascarar(texto(conteudo), av, conteudo), rotulo))


def casos_do_defeito(dados: dict, did: str) -> list:
    return [c for c in dados["casos"] if texto(c.get("defeito_id")) == did]


def caso_original(casos_d: list):
    for st in ("falhou", "retratado", "bloqueado", "nao-validado"):
        for c in casos_d:
            if c.get("status") == st and c.get("tecnica") != "regressao":
                return c
    nao_reg = [c for c in casos_d if c.get("tecnica") != "regressao"]
    return nao_reg[0] if nao_reg else (casos_d[0] if casos_d else None)


def caso_reteste(casos_d: list):
    regs = [c for c in casos_d if c.get("tecnica") == "regressao" and c.get("status") == "passou"]
    return regs[-1] if regs else None


SUBPASTAS_PROVA = ("evidencias", "rede", "notas", "relatorio")


SUBPASTAS_LINK_AVISADAS: set = set()


def _mesmo_caminho(a: Path, b: Path) -> bool:
    return os.path.normcase(str(a)) == os.path.normcase(str(b))


def dentro_da_rodada(p: Path, rodada: Path) -> bool:
    """Anexo so entra se resolve dentro de evidencias/, rede/, notas/ ou relatorio/ da rodada. Subpasta que e link
    ou junction (resolve para outro lugar) conta como fora, com aviso unico; arquivo que e link para fora tambem."""
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


class Anexos:
    def __init__(self, pasta_rodada: Path, pasta_saida: Path, av: Avisos):
        self.pasta = pasta_rodada
        self.saida = pasta_saida
        self.av = av
        self.faltando: set = set()
        self.fora: set = set()
        self.varridos: set = set()

    def resolver(self, e):
        c = caminho_evidencia(e)
        if not c or re.match(r"^[a-z][a-z0-9+.-]*://", c, re.I):
            return None
        bruto = Path(c)
        alvo = bruto if bruto.is_absolute() else self.pasta / bruto
        if ".." in Path(c.replace("\\", "/")).parts or not dentro_da_rodada(alvo, self.pasta):
            nome_fora = _mascara.mascarar(Path(c.replace("\\", "/")).name or c, estrito=True)[0]
            if c not in self.fora:
                self.fora.add(c)
                self.av.anexos_fora += 1
            self.av.add(f"ARQUIVO FORA DA RODADA: {nome_fora} nao entra como anexo: copie a prova para evidencias/ "
                        f"da rodada e corrija o caminho no ledger")
            return None
        if alvo.suffix.lower() in EXT_IMAGEM and "-circulado" not in alvo.stem:
            circ = alvo.with_name(alvo.stem + "-circulado" + alvo.suffix)
            if circ.exists() and dentro_da_rodada(circ, self.pasta):
                alvo = circ
        existe = alvo.exists()
        try:
            rel = os.path.relpath(str(alvo), str(self.saida)).replace(os.sep, "/")
        except ValueError:
            rel = str(alvo)
        nome = mascarar(c, self.av, "anexo")
        rel = _mascara.mascarar(rel, estrito=True)[0]
        if not existe:
            self.av.add(f"evidencia citada nao existe em disco: {nome} (nao mande a mensagem sem a prova; salve o "
                        f"arquivo ou corrija o caminho no ledger)")
            if c not in self.faltando:
                self.faltando.add(c)
                self.av.anexos_faltando += 1
        elif alvo.suffix.lower() in EXT_TEXTO_ANEXO:
            self.checar_texto(alvo, nome)
        return {"rel": rel, "abs": alvo, "existe": existe, "imagem": alvo.suffix.lower() in EXT_IMAGEM,
                "circulado": "-circulado" in alvo.stem}

    def checar_texto(self, alvo: Path, nome: str) -> None:
        if alvo in self.varridos:
            return
        self.varridos.add(alvo)
        try:
            if alvo.stat().st_size > LIMITE_ANEXO_TEXTO:
                self.av.add(f"anexo {nome} passa de 3 MB e nao foi varrido atras de segredo: confira antes de anexar")
                return
            conteudo = alvo.read_text(encoding="utf-8-sig", errors="replace")
        except OSError:
            return
        tipos = _mascara.tipos_de_segredo(conteudo)
        if alvo.suffix.lower() in EXT_JSON_ESTRUTURA:
            _, n_estrutura = _mascara.mascarar_texto_de_arquivo(conteudo, alvo.suffix, texto_tambem=False)
            if n_estrutura and not tipos:
                tipos = ["campo sensivel em JSON (par nome/valor, JSON dentro de string ou chave sensivel)"]
        if tipos:
            self.av.segredos += 1
            self.av.add(f"SEGREDO: {nome} parece conter {tipos[0]}: mascare o arquivo antes de anexar, ou nao anexe")

    def do_defeito(self, d: dict, casos_d: list, so_imagem: bool) -> list:
        ev = evidencias_de_defeito(d)
        if not ev["antes"]:
            orig = caso_original(casos_d)
            if orig:
                ev["antes"] = lista(orig.get("evidencias"))
        if not ev["reteste"]:
            ret = caso_reteste(casos_d)
            if ret:
                ev["reteste"] = [e for e in lista(ret.get("evidencias")) if e not in ev["depois"]]
        saida, vistos = [], set()
        for grupo in ("antes", "depois", "reteste", "outras"):
            for e in ev[grupo]:
                info = self.resolver(e)
                if not info or info["rel"] in vistos:
                    continue
                if so_imagem and not info["imagem"]:
                    continue
                vistos.add(info["rel"])
                info["grupo"] = grupo
                saida.append(info)
        return saida


def add_anexos(secao: Secao, anexos: list) -> None:
    if anexos:
        secao.elementos.append(Elemento("anexo", anexos))


def grupo_do_defeito(d: dict) -> int:
    tipo = texto(d.get("tipo")) or "defeito"
    st = texto(d.get("status"))
    if tipo == "retratado":
        return 6
    if tipo == "decisao-de-produto":
        return 5
    if st == "retestado-ok":
        return 1
    if st == "corrigido":
        return 2
    if tipo == "melhoria":
        return 4
    return 3


TIPOS_DE_INTERFACE = ("biblioteca", "cli", "api")


def configurar_por_tipo(cfg: "Config", dados: dict) -> None:
    """Le rodada.tipos_projeto: em biblioteca, CLI ou API, nomes de funcao:, comando: e api: do ledger nao sao
    jargao; e um caso PJ-LIB-07 ou de comando: bloqueado diz que o reteste nao foi no pacote instalado."""
    r = dados.get("rodada") if isinstance(dados.get("rodada"), dict) else {}
    tipos = r.get("tipos_projeto") if isinstance(r.get("tipos_projeto"), list) else []
    if not tipos and r.get("tipo_projeto"):
        tipos = [r.get("tipo_projeto")]
    cfg.projeto_de_interface = any(str(t) in TIPOS_DE_INTERFACE for t in tipos)
    nomes = set()
    for it in dados.get("itens") or []:
        iid = texto(it.get("id")) if isinstance(it, dict) else ""
        if re.match(r"^(funcao|comando|api):", iid):
            nomes.update(re.findall(r"[A-Za-z_][A-Za-z0-9_]*", iid.split(":", 1)[1]))
    cfg.nomes_publicos = nomes
    for c in dados.get("casos") or []:
        if not isinstance(c, dict) or c.get("status") != "bloqueado":
            continue
        if "PJ-LIB-07" in texto(c.get("titulo")) or texto(c.get("item_id")).startswith("comando:"):
            cfg.ressalva_pacote = ", fora do pacote instalado (ver ressalva)"
            break


def onde_retestei(cfg: "Config") -> str:
    nome = texto(getattr(cfg, "ambiente_reteste", ""))
    return f"em {nome}" if nome else "no alvo"


def frase_retestado(cfg: "Config") -> str:
    return f"corrigi e testei de novo {onde_retestei(cfg)}{getattr(cfg, 'ressalva_pacote', '')}"


def frase_sem_reteste(cfg: "Config") -> str:
    return f"corrigi mas ainda não testei de novo {onde_retestei(cfg)}"


TITULO_GRUPO = {
    1: ("corrigido e retestado", "corrigi e testei de novo no alvo"),
    2: ("corrigido, falta retestar", "corrigi mas ainda não testei de novo no alvo"),
    3: ("precisa de alguém agir", ""),
    4: ("sugestões de melhoria", ""),
    5: ("decisões de regra (quem define o negócio responde)", ""),
    6: ("retratações (mande no mesmo canal em que mandou o erro)", ""),
}


def chave_ordem(d: dict):
    sev = d.get("severidade")
    return (grupo_do_defeito(d), SEVERIDADES.index(sev) if sev in SEVERIDADES else 9, texto(d.get("id")))


def decisao_tomada(d: dict) -> bool:
    return sem_acento(texto(d.get("correcao"))).startswith("decisao")


def parse_oraculo(txt: str) -> dict:
    t = re.sub(r"^\s*or[aá]culo\s*:\s*", "", texto(txt), flags=re.I)
    partes = [p.strip() for p in re.split(r"\s*\|\s*|\s+·\s+", t) if p.strip()]
    res = {"qid": None, "pergunta": "", "opcoes": [], "impacto": "", "prints": [], "para": "", "contexto": []}
    for p in partes:
        m = re.match(r"^(?:pergunta\s+)?Q\s*(\d+)\b\s*[:.)-]?\s*(.*)$", p, re.I)
        if m and res["qid"] is None:
            res["qid"] = int(m.group(1))
            p = m.group(2).strip()
            if not p:
                continue
        m = re.match(r"^([A-Ha-h])\s*[)\]:.-]\s+(.+)$", p)
        if m:
            corpo = m.group(2)
            pedacos = re.split(r"\s*(?:=>|⇒|\bcusto\s*:)\s*", corpo, maxsplit=1, flags=re.I)
            res["opcoes"].append((m.group(1).lower(), pedacos[0].strip(), pedacos[1].strip() if len(pedacos) > 1 else ""))
            continue
        m = re.match(r"^impacto\s*[:=]\s*(\S+)", p, re.I)
        if m:
            res["impacto"] = sem_acento(m.group(1))
            continue
        m = re.match(r"^print\s*[:=]\s*(.+)$", p, re.I)
        if m:
            res["prints"].append(m.group(1).strip())
            continue
        m = re.match(r"^(?:para|quem decide|decide)\s*[:=]\s*(.+)$", p, re.I)
        if m:
            res["para"] = m.group(1).strip()
            continue
        if not res["pergunta"]:
            res["pergunta"] = p
        else:
            res["contexto"].append(p)
    return res


def motivo_caso(c: dict, primeira_pessoa: bool = False) -> str:
    just = texto(c.get("justificativa"))
    if c.get("status") == "pendente":
        return "ainda não executei" if primeira_pessoa else "ainda não executado"
    if re.match(r"^\s*or[aá]culo\s*:", just, re.I):
        q = parse_oraculo(just)
        return "esperando a decisão de regra" + (f" da pergunta Q{q['qid']}" if q["qid"] is not None else "")
    return just or "sem motivo registrado no ledger"


def ressalvas(dados: dict, defeitos_sel: list, filtrado: bool) -> tuple:
    casos = dados["casos"]
    if filtrado:
        ids = {texto(d.get("id")) for d in defeitos_sel}
        ligados = [c for c in casos if texto(c.get("defeito_id")) in ids]
        itens = {c.get("item_id") for c in ligados}
        relevantes = [c for c in casos if (c in ligados or c.get("item_id") in itens)
                      and c.get("status") in STATUS_NAO_VALIDADO]
        fora = [c for c in casos if c.get("status") in STATUS_NAO_VALIDADO and c not in relevantes]
    else:
        relevantes = [c for c in casos if c.get("status") in STATUS_NAO_VALIDADO]
        fora = []
    sem_reteste = [d for d in defeitos_sel if d.get("status") == "corrigido"]
    return relevantes, fora, sem_reteste


def montar_whatsapp(dados: dict, defeitos: list, filtrado: bool, cfg: Config, av: Avisos, anx: Anexos,
                    args, alvo: str) -> list:
    est = Estilo(cfg, av, "whatsapp")
    secoes = []
    numerar = sim(cfg["mensagens_numerar"])
    com_codigo = args.com_codigo if args.com_codigo is not None else sim(cfg["mensagens_codigo"])
    todos_anexos = []

    corpo = []
    n = 0
    grupo_atual = None
    secao = None
    for d in sorted(defeitos, key=chave_ordem):
        g = grupo_do_defeito(d)
        if g != grupo_atual:
            grupo_atual = g
            secao = Secao(TITULO_GRUPO[g][0])
            corpo.append(secao)
        n += 1
        did = texto(d.get("id"))
        casos_d = casos_do_defeito(dados, did)
        orig = caso_original(casos_d)
        ret = caso_reteste(casos_d)
        tipo = texto(d.get("tipo")) or "defeito"
        st = texto(d.get("status"))
        pref = f"{n}) " if numerar else ""
        sec_d = Secao(f"{did} · {ROTULO_SEVERIDADE.get(texto(d.get('severidade')), texto(d.get('severidade')))} · "
                      f"{ROTULO_TIPO.get(tipo, tipo)} · {ROTULO_STATUS_DEFEITO.get(st, st)}", nivel=3)
        corpo.append(sec_d)
        titulo = texto(d.get("titulo")) or "[PREENCHA: o sintoma em uma frase]"
        if "[PREENCHA" in titulo:
            av.lacunas += 1
        obtido = texto(orig.get("resultado_obtido")) if orig else ""
        if tipo == "retratado":
            add_msgs(sec_d, est, [pref + f"sobre {titulo}", "não era bug"], checar_tom=False)
            causa = texto(d.get("causa"))
            if causa:
                add_msgs(sec_d, est, [f"o que aconteceu: {causa}"], checar_tom=False)
            add_msgs(sec_d, est, ["pode desconsiderar aquele ponto"], checar_tom=False)
            continue
        add_msgs(sec_d, est, [pref + titulo] + ([obtido] if obtido else []))
        if tipo == "decisao-de-produto":
            if decisao_tomada(d):
                add_msgs(sec_d, est, [f"ficou decidido: {texto(d.get('correcao'))}"], checar_tom=False,
                         campo_ledger="correcao")
            else:
                q = parse_oraculo(texto(d.get("justificativa")))
                if q["pergunta"]:
                    add_msgs(sec_d, est, [q["pergunta"]] + q["contexto"], checar_tom=False)
                if q["opcoes"]:
                    add_msgs(sec_d, est, [f"{l}) {t}" + (f" — {c}" if c else "") for l, t, c in q["opcoes"]], checar_tom=False)
                else:
                    add_msgs(sec_d, est, ["[PREENCHA: opções fechadas a) / b), com o efeito de cada uma]"], checar_tom=False)
                    av.lacunas += 1
                    av.add(f"{did}: decisao de produto sem opcoes fechadas — escreva a/b com o custo de cada uma "
                           f"(convencao em references/comunicacao-e-painel.md §8)")
        else:
            if orig and st in ("aberto", "nao-corrigido") and not vazio(orig.get("passos")):
                add_msgs(sec_d, est, [f"como reproduzir: {texto(orig.get('passos'))}"])
            if orig and not vazio(orig.get("resultado_esperado")) and st != "retestado-ok":
                add_msgs(sec_d, est, [f"o certo seria: {texto(orig.get('resultado_esperado'))}"])
            if tipo == "melhoria" and st not in ("retestado-ok", "corrigido") and not vazio(d.get("correcao")):
                if com_codigo:
                    add_msgs(sec_d, est, ["sugestão:"], checar_tom=False)
                    add_bloco(sec_d, texto(d.get("correcao")), av, "sugestão")
                else:
                    add_msgs(sec_d, est, [f"sugestão: {PROPOSTA_NO_RELATORIO}"], checar_tom=False)
            if st == "retestado-ok":
                add_msgs(sec_d, est, [frase_retestado(cfg)] + ([f"agora: {texto(ret.get('resultado_obtido'))}"]
                                                            if ret and not vazio(ret.get("resultado_obtido")) else []))
            elif st == "corrigido":
                add_msgs(sec_d, est, [frase_sem_reteste(cfg)] + ([texto(d.get("justificativa"))]
                                                            if not vazio(d.get("justificativa")) else []))
            elif st == "aberto":
                add_msgs(sec_d, est, ["ainda não corrigi"])
            elif st == "nao-corrigido" and tipo != "melhoria":
                add_msgs(sec_d, est, ["não mexi nisso"] + ([f"motivo: {texto(d.get('justificativa'))}"]
                                                         if not vazio(d.get("justificativa")) else []))
            elif tipo == "melhoria" and not vazio(d.get("justificativa")):
                add_msgs(sec_d, est, [texto(d.get("justificativa"))])
        if com_codigo:
            if not vazio(d.get("onde")):
                add_msgs(sec_d, est, ["onde tá no código:"], checar_tom=False)
                add_bloco(sec_d, texto(d.get("onde")), av, "caminho")
            if not vazio(d.get("causa")):
                add_msgs(sec_d, est, ["causa:"], checar_tom=False)
                add_bloco(sec_d, texto(d.get("causa")), av, "causa")
        anexos = anx.do_defeito(d, casos_d, so_imagem=True)
        add_anexos(sec_d, anexos)
        todos_anexos.extend(anexos)

    abertura = Secao("abertura")
    if cfg["mensagens_abertura"]:
        linhas_ab = [x.replace("{alvo}", alvo) for x in re.split(r"\s+/\s+", cfg["mensagens_abertura"])]
    else:
        linhas_ab = [f"testei {alvo}"] if alvo else ["terminei o teste"]
        if todos_anexos:
            linhas_ab.append("vou mandando por parte com print")
        if any(a["circulado"] for a in todos_anexos):
            linhas_ab.append("no print, vermelho é o erro e verde é o que ficou certo")
    add_msgs(abertura, est, linhas_ab, checar_tom=False)
    secoes.append(abertura)
    if not defeitos:
        vazio_s = Secao("defeitos")
        executados = [c for c in dados["casos"] if c.get("status") not in ("pendente",)]
        pendentes = len(dados["casos"]) - len(executados)
        if not executados:
            add_msgs(vazio_s, est, ["ainda não executei nenhum teste nesta rodada"], checar_tom=False)
            av.add("ledger sem caso executado: nao mande mensagem de resultado; diga so o que esta em andamento")
        elif pendentes:
            add_msgs(vazio_s, est, ["não achei defeito até agora"], checar_tom=False)
        else:
            add_msgs(vazio_s, est, ["não achei defeito nesta rodada"], checar_tom=False)
        secoes.append(vazio_s)
    secoes.extend(corpo)

    corrigidos = [d for d in defeitos if d.get("status") in ("corrigido", "retestado-ok")
                  and texto(d.get("tipo")) != "retratado"]
    if corrigidos and args.branch:
        sb = Secao("branch")
        add_msgs(sb, est, ["tá tudo na branch"], checar_tom=False)
        add_bloco(sb, args.branch, av, "branch")
        secoes.append(sb)
    elif corrigidos:
        av.add("ha correcao na mensagem e nenhuma branch: passe --branch <nome> para ela sair em bloco proprio")

    secoes.append(secao_ressalva(dados, defeitos, filtrado, cfg, est, av))
    return secoes


def secao_ressalva(dados, defeitos, filtrado, cfg, est: Estilo, av: Avisos) -> Secao:
    relevantes, fora, sem_reteste = ressalvas(dados, defeitos, filtrado)
    sr = Secao("o que eu não testei (vai no fim e nunca se corta)")
    add_msgs(sr, est, ["o que eu não testei:"], checar_tom=False)
    teve = False
    for c in relevantes:
        tit = texto(c.get("titulo")) or texto(c.get("resultado_esperado"))
        just = motivo_caso(c, primeira_pessoa=True)
        if not texto(c.get("justificativa")) and c.get("status") != "pendente":
            av.add(f"{c.get('id')}: {c.get('status')} sem justificativa no ledger — escreva o motivo e o que destrava")
        add_msgs(sr, est, [tit if tit.endswith(("?", ":")) else f"{tit}:", just], checar_tom=False)
        teve = True
    for d in sem_reteste:
        add_msgs(sr, est, [f"{texto(d.get('titulo'))}: corrigi mas não retestei {onde_retestei(cfg)}"]
                 + ([texto(d.get("justificativa"))] if not vazio(d.get("justificativa")) else []), checar_tom=False)
        teve = True
    if fora:
        add_msgs(sr, est, [f"fora isso, na rodada toda ficaram {len(fora)} teste{'s' if len(fora) != 1 else ''} "
                           f"sem validar, tá tudo no relatório"], checar_tom=False)
        teve = True
    pend = sum(1 for c in dados["casos"] if c.get("status") == "pendente")
    if pend and not filtrado:
        add_msgs(sr, est, [f"a rodada ainda não fechou: falta{'m' if pend != 1 else ''} {pend} "
                           f"teste{'s' if pend != 1 else ''}"], checar_tom=False)
    if not dados["casos"]:
        add_msgs(sr, est, ["ainda não testei nada, a rodada só começou"], checar_tom=False)
    elif not teve:
        add_msgs(sr, est, ["nada do que eu mandei acima ficou sem testar"], checar_tom=False)
        av.add("a ressalva diz que nada ficou sem testar: confira no ledger e no relatorio antes de afirmar")
    if sim(cfg["mensagens_dizer_nao_commitado"]):
        add_msgs(sr, est, ["e não commitei nada"], checar_tom=False)
        av.add("\"e não commitei nada\": confira com git status / git log antes de mandar (ou desligue "
               "mensagens_dizer_nao_commitado no PERFIL)")
    if cfg["mensagens_fecho"]:
        add_msgs(sr, est, re.split(r"\s+/\s+", cfg["mensagens_fecho"]), checar_tom=False)
    return sr


def montar_formal(dados: dict, defeitos: list, filtrado: bool, cfg: Config, av: Avisos, anx: Anexos,
                  args, alvo: str) -> list:
    est = Estilo(cfg, av, "formal")
    r = dados["rodada"]
    com_codigo = args.com_codigo if args.com_codigo is not None else (
        sim(cfg["mensagens_codigo"]) if cfg["mensagens_codigo"] else True)
    ordenados = sorted(defeitos, key=chave_ordem)
    if len(ordenados) == 1:
        d = ordenados[0]
        assunto = f"[QA] {texto(d.get('id'))} — {texto(d.get('titulo'))}"
    else:
        cont = {}
        for d in ordenados:
            cont[grupo_do_defeito(d)] = cont.get(grupo_do_defeito(d), 0) + 1
        partes = [f"{cont.get(1, 0) + cont.get(2, 0)} corrigido(s)", f"{cont.get(3, 0)} para agir",
                  f"{cont.get(5, 0)} decisão(ões)"]
        assunto = f"[QA] {alvo or 'rodada'}: " + ", ".join(partes)
    corpo = []
    saud = texto(cfg["mensagens_saudacao_formal"])
    if saud:
        corpo += [saud, ""]
    codigo = codigo_testado(r)
    contexto = ", ".join(x for x in (texto(r.get("ambiente")), f"código {codigo}" if codigo else "") if x)
    corpo.append(f"Segue o resultado do teste de {alvo or 'esta rodada'}" + (f" ({contexto})." if contexto else "."))
    corpo.append("")
    nomes_anexos = []
    for i, d in enumerate(ordenados, 1):
        did = texto(d.get("id"))
        casos_d = casos_do_defeito(dados, did)
        orig = caso_original(casos_d)
        ret = caso_reteste(casos_d)
        tipo = texto(d.get("tipo")) or "defeito"
        st = texto(d.get("status"))
        sev = SEVERIDADE_FEMININO.get(texto(d.get("severidade")), texto(d.get("severidade")) or "não informada")
        corpo.append(f"{i}. {did} — {est.linhas(texto(d.get('titulo')))[0] if texto(d.get('titulo')) else '[PREENCHA: título]'}"
                     f" (severidade {sev}; {ROTULO_TIPO.get(tipo, tipo)}; {ROTULO_STATUS_DEFEITO.get(st, st)})")
        campos = []
        if orig:
            campos += [("Como reproduzir", orig.get("passos")), ("Esperado", orig.get("resultado_esperado")),
                       ("Obtido", orig.get("resultado_obtido")), ("Papel", orig.get("papel"))]
        if com_codigo:
            campos += [("Onde", d.get("onde")), ("Causa", d.get("causa"))]
        if tipo == "decisao-de-produto" and not decisao_tomada(d):
            q = parse_oraculo(texto(d.get("justificativa")))
            campos.append(("Pergunta", q["pergunta"] or d.get("justificativa")))
            for letra, t, c in q["opcoes"]:
                campos.append((f"Opção {letra.upper()}", t + (f" (efeito: {c})" if c else "")))
        else:
            proposta = tipo == "melhoria" and st not in ("corrigido", "retestado-ok")
            campos.append(("Proposta" if proposta else "Correção",
                           d.get("correcao") if com_codigo else (PROPOSTA_NO_RELATORIO if proposta and not
                                                                 vazio(d.get("correcao")) else "")))
            if ret:
                campos.append(("Reteste", ret.get("resultado_obtido")))
            if st in ("nao-corrigido", "corrigido", "aberto"):
                campos.append(("Situação", d.get("justificativa")))
        for rot, val in campos:
            if not vazio(val):
                corpo.append(f"   {rot}: {est.linhas(texto(val))[0]}")
        anexos = anx.do_defeito(d, casos_d, so_imagem=False)
        if anexos:
            corpo.append("   Evidências (anexas): " + ", ".join(Path(a["rel"]).name for a in anexos))
            nomes_anexos.extend(anexos)
        corpo.append("")
    if not ordenados:
        if not [c for c in dados["casos"] if c.get("status") != "pendente"]:
            corpo += ["Nenhum caso de teste foi executado ainda nesta rodada.", ""]
            av.add("ledger sem caso executado: nao mande mensagem de resultado")
        else:
            corpo += ["Nenhum defeito registrado nesta rodada.", ""]
    relevantes, fora, sem_reteste = ressalvas(dados, defeitos, filtrado)
    corpo.append("O que não foi validado")
    linhas_nv = []
    for c in relevantes:
        just = motivo_caso(c)
        linhas_nv.append(f"- {texto(c.get('titulo')) or texto(c.get('resultado_esperado'))}: {est.linhas(just)[0]}")
    for d in sem_reteste:
        linhas_nv.append(f"- {texto(d.get('titulo'))}: corrigido, sem reteste {onde_retestei(cfg)}"
                         + (f" ({texto(d.get('justificativa'))})" if not vazio(d.get("justificativa")) else ""))
    if fora:
        linhas_nv.append(f"- Fora deste recorte, {len(fora)} caso(s) da rodada sem validação (detalhes no relatório).")
    if not dados["casos"]:
        linhas_nv.append("- Nenhum teste executado ainda.")
    elif not linhas_nv:
        linhas_nv.append("- Nada ligado aos itens acima ficou sem validação.")
        av.add("a ressalva diz que nada ficou sem validacao: confira no ledger antes de afirmar")
    corpo += linhas_nv
    if sim(cfg["mensagens_dizer_nao_commitado"]):
        corpo += ["", "Nada foi commitado."]
        av.add("\"Nada foi commitado\": confira com git status / git log antes de mandar")
    if args.branch:
        corpo += ["", f"Branch sugerida: {args.branch}"]
    s_assunto = Secao("assunto")
    add_bloco(s_assunto, assunto, av)
    s_corpo = Secao("corpo (e-mail ou descrição de PR)")
    s_corpo.elementos.append(Elemento("bloco", mascarar("\n".join(corpo), av, "corpo")))
    secoes = [s_assunto, s_corpo]
    if nomes_anexos:
        sa = Secao("anexos")
        add_anexos(sa, nomes_anexos)
        secoes.append(sa)
    return secoes


def coletar_perguntas(dados: dict, av: Avisos) -> list:
    grupos = {}
    sev_rank = {s: i for i, s in enumerate(SEVERIDADES)}

    def grupo_para(q, origem):
        chave = f"Q{q['qid']}" if q["qid"] is not None else "T:" + sem_acento(q["pergunta"])[:120]
        g = grupos.setdefault(chave, {"qid": q["qid"], "pergunta": "", "opcoes": [], "impacto": "", "prints": [],
                                      "para": "", "contexto": [], "casos": [], "defeitos": [], "sev": 9})
        if len(q["pergunta"]) > len(g["pergunta"]):
            g["pergunta"] = q["pergunta"]
        for o in q["opcoes"]:
            if o[0] not in [x[0] for x in g["opcoes"]]:
                g["opcoes"].append(o)
        g["impacto"] = g["impacto"] or q["impacto"]
        g["para"] = g["para"] or q["para"]
        g["prints"] += [p for p in q["prints"] if p not in g["prints"]]
        g["contexto"] += [c for c in q["contexto"] if c not in g["contexto"]]
        return g

    for c in dados["casos"]:
        just = texto(c.get("justificativa"))
        if not re.match(r"^\s*or[aá]culo\s*:", just, re.I):
            continue
        if c.get("status") in ("passou", "falhou", "nao-aplicavel", "retratado"):
            continue
        g = grupo_para(parse_oraculo(just), "caso")
        g["casos"].append(texto(c.get("id")))
        g["prints"] += [e for e in (caminho_evidencia(x) for x in lista(c.get("evidencias"))) if e and e not in g["prints"]]
    for d in dados["defeitos"]:
        if texto(d.get("tipo")) != "decisao-de-produto" or decisao_tomada(d) or d.get("status") == "retestado-ok":
            continue
        q = parse_oraculo(texto(d.get("justificativa")) or texto(d.get("titulo")))
        if not q["pergunta"]:
            q["pergunta"] = texto(d.get("titulo"))
        g = grupo_para(q, "defeito")
        g["defeitos"].append(texto(d.get("id")))
        g["sev"] = min(g["sev"], sev_rank.get(d.get("severidade"), 9))
        ev = evidencias_de_defeito(d)
        g["prints"] += [e for e in (caminho_evidencia(x) for x in ev["antes"] + ev["outras"]) if e and e not in g["prints"]]
    lista_g = list(grupos.values())
    usados = {g["qid"] for g in lista_g if g["qid"] is not None}
    prox = max(usados or {0}) + 1
    for g in lista_g:
        if g["qid"] is None:
            g["qid"] = prox
            prox += 1
        if not g["pergunta"]:
            g["pergunta"] = f"[PREENCHA: texto da pergunta Q{g['qid']}]"
            av.lacunas += 1
            av.add(f"Q{g['qid']}: nenhum caso traz o texto da pergunta — escreva-o na justificativa de um dos casos")
        if not g["opcoes"]:
            av.lacunas += 1
            av.add(f"Q{g['qid']}: pergunta sem opcoes fechadas — escreva \"A) ... => custo | B) ... => custo\"")
    impacto_rank = {"alto": 3, "medio": 2, "baixo": 1}
    lista_g.sort(key=lambda g: (-impacto_rank.get(g["impacto"], 2), -(len(g["casos"]) + len(g["defeitos"])),
                                g["sev"], g["qid"]))
    return lista_g


def casos_fora_do_formato(dados: dict) -> list:
    saida = []
    for c in dados["casos"]:
        if c.get("status") not in ("bloqueado", "nao-validado"):
            continue
        just = texto(c.get("justificativa"))
        if re.match(r"^\s*or[aá]culo\s*:", just, re.I):
            continue
        if RE_DUVIDA_DE_REGRA.search(sem_acento(just)):
            saida.append(c)
    return saida


def montar_oraculo(dados: dict, cfg: Config, av: Avisos, anx: Anexos, args, alvo: str, estilo: str) -> list:
    est = Estilo(cfg, av, estilo)
    perguntas = coletar_perguntas(dados, av)
    esperando = sorted({c for g in perguntas for c in g["casos"]})
    for c in casos_fora_do_formato(dados):
        av.fora_do_formato += 1
        just = _mascara.mascarar(texto(c.get("justificativa")), estrito=True)[0]
        av.add(f"caso {texto(c.get('id'))} parece dúvida de regra fora do formato (\"{resumo(just, 60)}\"): "
               f"ele NÃO entrou nas perguntas nem na contagem de quem espera. Reescreva com cobertura.py set "
               f"{texto(c.get('id'))} --oraculo-pergunta \"<pergunta fechada>\" --opcao \"<A> => <custo>\" "
               f"--opcao \"<B> => <custo>\" (ou, se não é dúvida de regra, diga o que falta e o que destrava)")
    secoes = []
    if estilo == "formal":
        linhas = []
        saud = texto(cfg["mensagens_saudacao_formal"])
        if saud:
            linhas += [saud, ""]
        linhas.append(f"Para fechar o teste de {alvo or 'esta rodada'} preciso de {len(perguntas)} decisão(ões) de regra. "
                      f"Segui testando o resto; só os casos abaixo aguardam.")
        linhas.append("")
        for i, g in enumerate(perguntas, 1):
            linhas.append(f"{i}. {g['pergunta']}" + (f" (para: {g['para']})" if g["para"] else ""))
            for c in g["contexto"]:
                linhas.append(f"   {c}")
            for letra, t, c in g["opcoes"]:
                linhas.append(f"   {letra.upper()}) {t}" + (f" — efeito: {c}" if c else ""))
            if not g["opcoes"]:
                linhas.append("   [PREENCHA: opções A/B com o efeito de cada uma]")
            linhas.append("")
        linhas.append(f"Enquanto não houver resposta, {len(esperando)} caso(s) de teste ficam aguardando.")
        s = Secao("corpo (e-mail)")
        s.elementos.append(Elemento("bloco", mascarar("\n".join(linhas), av, "oraculo")))
        secoes.append(s)
    else:
        ab = Secao("abertura")
        if not perguntas:
            add_msgs(ab, est, ["não ficou nenhuma dúvida de regra nesta rodada"], checar_tom=False)
            secoes.append(ab)
        else:
            n = len(perguntas)
            add_msgs(ab, est, [f"tenho {n} dúvida{'s' if n != 1 else ''} de regra pra fechar o teste de {alvo}".strip(),
                               "responde só com a letra que já me destrava",
                               "o resto eu segui testando"], checar_tom=False)
            secoes.append(ab)
        for i, g in enumerate(perguntas, 1):
            titulo = (f"Q{g['qid']} · impacto {ROTULO_SEVERIDADE.get(g['impacto'], g['impacto']) or 'não informado'} · "
                      f"{len(g['casos'])} caso(s) esperando" + (f" · {', '.join(g['defeitos'])}" if g["defeitos"] else ""))
            if i == 8:
                secoes.append(Secao("as outras, menos urgentes", "Mande junto, no mesmo lote: a ordem já diz a prioridade."))
            s = Secao(titulo, "as que mais travam" if i == 1 and n > 7 else "", nivel=3)
            add_msgs(s, est, [f"{i}) {g['pergunta']}"] + g["contexto"], checar_tom=False)
            if g["opcoes"]:
                add_msgs(s, est, [f"{l}) {t}" + (f" — {c}" if c else "") for l, t, c in g["opcoes"]], checar_tom=False)
            else:
                add_msgs(s, est, ["[PREENCHA: opções a) / b), com o custo de cada uma]"], checar_tom=False)
            prints = [anx.resolver(p) for p in g["prints"]]
            add_anexos(s, [p for p in prints if p and p["imagem"]])
            secoes.append(s)
        if perguntas:
            fim = Secao("o que fica parado (vai no fim)")
            add_msgs(fim, est, [f"enquanto isso {len(esperando)} teste{'s' if len(esperando) != 1 else ''} "
                                f"fica{'m' if len(esperando) != 1 else ''} esperando essas respostas"], checar_tom=False)
            secoes.append(fim)
    reg = Secao("como registrar a resposta (não copie)",
                "Registre a fala literal, quem, data e canal; reabra os casos e execute. Regra que vale para as próximas "
                "rodadas vai também para o .qa/PERFIL.md.")
    script = Path(__file__).resolve().parent / "cobertura.py"
    rodada = args.rodada_mostrada
    for g in perguntas:
        for cid in g["casos"]:
            reg.elementos.append(Elemento("bloco", f'python "{script}" set "{rodada}" {cid} --status pendente '
                                                   f'--obs "oraculo Q{g["qid"]} respondido: \'<fala literal>\' — <quem>, '
                                                   f'<data>, <canal>"', "comando"))
        for did in g["defeitos"]:
            reg.elementos.append(Elemento("bloco", f'python "{script}" set "{rodada}" {did} --correcao '
                                                   f'"Decisão: <o que ficou> — \'<fala literal>\', <quem>, <data>, <canal>"',
                                          "comando"))
    if reg.elementos:
        secoes.append(reg)
    return secoes


def montar_issues(dados: dict, defeitos: list, cfg: Config, av: Avisos, pasta: Path, args, template: Path) -> list:
    try:
        modelo = template.read_text(encoding="utf-8-sig")
    except OSError as e:
        falhar(f"nao consegui ler o template de issue {template}: {e}")
    modelo = re.sub(r"^\s*<!--.*?-->\s*", "", modelo, count=1, flags=re.S)
    r = dados["rodada"]
    destino = Path(args.saida).expanduser() if args.saida else pasta / "relatorio" / "issues"
    destino.mkdir(parents=True, exist_ok=True)
    anx = Anexos(pasta, destino.resolve(), av)
    gerados = []
    for d in sorted(defeitos, key=lambda x: texto(x.get("id"))):
        did = texto(d.get("id"))
        casos_d = casos_do_defeito(dados, did)
        orig = caso_original(casos_d)
        ret = caso_reteste(casos_d)
        tipo = texto(d.get("tipo")) or "defeito"
        st = texto(d.get("status"))

        def ou_lacuna(valor, pedido):
            if vazio(valor):
                av.lacunas += 1
                return f"[PREENCHA: {pedido}]"
            return mascarar(texto(valor), av, did)

        passos_txt = texto(orig.get("passos")) if orig else ""
        if passos_txt:
            passos = [p.strip() for p in re.split(r"\s*(?:;|\s→\s|\s->\s)\s*", passos_txt) if p.strip()]
            passos_md = "\n".join(f"{i}. {mascarar(p, av, did)}" for i, p in enumerate(passos, 1))
        else:
            passos_md = ou_lacuna("", "passos numerados, com o registro e o ambiente")
        anexos = anx.do_defeito(d, casos_d, so_imagem=False)
        rot_grupo = {"antes": "antes", "depois": "depois", "reteste": "reteste", "outras": "outra"}
        ev_md = "\n".join(
            f"- {rot_grupo.get(a['grupo'], a['grupo'])}: `{a['rel']}`"
            + ("" if a["existe"] else " (NÃO EXISTE EM DISCO)")
            + (" — anexe a imagem ao criar a issue" if a["imagem"] else " — confira se não tem dado sensível antes de anexar")
            for a in anexos) or ou_lacuna("", "print do problema (evidencias/NN-...-ANTES-circulado.png)")
        falhos = [texto(c.get("id")) for c in casos_d if c.get("status") == "falhou" and c.get("tecnica") != "regressao"]
        repro = texto(d.get("reproducao"))
        if repro:
            reproduzido = mascarar(repro, av, did) + (
                f" (e em {len(falhos)} casos do ledger: {', '.join(falhos)})" if len(falhos) >= 2 else "")
        elif len(falhos) >= 2:
            reproduzido = f"sim, em {len(falhos)} casos do ledger ({', '.join(falhos)})"
        else:
            reproduzido = ou_lacuna("", "segundo caminho que reproduziu (outra ferramenta, API direta, outro registro) "
                                        "ou \"não reproduzido por outro caminho\"")
        relevantes = [c for c in dados["casos"]
                      if (texto(c.get("defeito_id")) == did or (orig and c.get("item_id") == orig.get("item_id")))
                      and c.get("status") in STATUS_NAO_VALIDADO]
        nv = [f"- {texto(c.get('titulo')) or texto(c.get('resultado_esperado'))}: {motivo_caso(c)}" for c in relevantes]
        if st == "corrigido":
            nv.append(f"- Corrigido sem reteste {onde_retestei(cfg)}: {texto(d.get('justificativa')) or 'motivo não registrado'}")
        if not nv:
            nv = ["- Nada ligado a este defeito ficou sem validação no ledger da rodada."]
        resumo_txt = texto(orig.get("resultado_obtido")) if orig else ""
        if tipo == "decisao-de-produto" and not decisao_tomada(d):
            q = parse_oraculo(texto(d.get("justificativa")))
            resumo_txt = (resumo_txt + "\n\n" if resumo_txt else "") + "Pergunta para quem decide: " + (
                q["pergunta"] or texto(d.get("justificativa"))) + "".join(
                f"\n- {l.upper()}) {t}" + (f" — efeito: {c}" if c else "") for l, t, c in q["opcoes"])
        rotulos = {"defeito": "bug", "melhoria": "enhancement", "decisao-de-produto": "question",
                   "retratado": "invalid"}.get(tipo, "bug")
        valores = {
            "TITULO": ou_lacuna(d.get("titulo"), "o sintoma em uma frase, como quem usa descreveria"),
            "ID": did,
            "SEVERIDADE": ROTULO_SEVERIDADE.get(texto(d.get("severidade")), texto(d.get("severidade")) or "não informada"),
            "TIPO": ROTULO_TIPO.get(tipo, tipo),
            "STATUS": ROTULO_STATUS_DEFEITO.get(st, st),
            "RESUMO": ou_lacuna(resumo_txt, "o que acontece, com o valor medido"),
            "PASSOS": passos_md,
            "ESPERADO": ou_lacuna(orig.get("resultado_esperado") if orig else "", "o comportamento esperado"),
            "ORACULO": ou_lacuna(orig.get("oraculo") if orig else "", "de onde vem o esperado (regra, spec, código)"),
            "OBTIDO": ou_lacuna(orig.get("resultado_obtido") if orig else "", "o que aconteceu: status, texto, valor"),
            "EVIDENCIAS": ev_md,
            "REPRODUZIDO": reproduzido,
            "AMBIENTE": ou_lacuna(r.get("ambiente"), "front → API → banco"),
            "CODIGO_TESTADO": ou_lacuna(codigo_testado(r), "branch @ commit"),
            "PAPEL": texto(orig.get("papel")) if orig and orig.get("papel") else "não registrado",
            "ONDE": mascarar(texto(d.get("onde")), av, did) or "ainda não localizado",
            "CAUSA": mascarar(texto(d.get("causa")), av, did) or "ainda não diagnosticada",
            "CORRECAO": mascarar(texto(d.get("correcao")), av, did) or "nenhuma ainda",
            "CASOS": ", ".join(texto(c.get("id")) for c in casos_d) or "nenhum",
            "NAO_VALIDADO": mascarar("\n".join(nv), av, did),
            "RODADA": texto(r.get("id")) or pasta.name,
            "DATA": (texto(orig.get("atualizado_em")) if orig and orig.get("atualizado_em") else
                     texto(d.get("atualizado_em"))) or "não registrado",
            "ROTULOS": f"{rotulos}, severidade:{texto(d.get('severidade')) or 'n/d'}",
            "RETESTE": texto(ret.get("resultado_obtido")) if ret else "sem reteste registrado",
        }
        conteudo = re.sub(r"\{\{([A-Z_]+)\}\}", lambda m: valores.get(m.group(1), m.group(0)), modelo)
        restantes = re.findall(r"\{\{[^}]+\}\}", conteudo)
        if restantes:
            av.lacunas += len(restantes)
            av.add(f"{did}: o template tem marcador(es) que o gerador nao conhece: {', '.join(sorted(set(restantes)))}")
        arquivo = destino / f"{did}.md"
        cabeca = ("<!-- rascunho do QA: criar no GitHub/Jira so com ordem explicita do usuario; "
                  "revise as lacunas [PREENCHA] e os anexos antes -->\n")
        with open(arquivo, "w", encoding="utf-8", newline="\n") as f:
            f.write(cabeca + conteudo.rstrip("\n") + "\n")
        titulo_cmd = valores["TITULO"].replace('"', "'")
        gerados.append((arquivo, titulo_cmd, rotulos))
    return gerados


def cerca(conteudo: str) -> str:
    return "~~~~" if "```" in conteudo else "```"


def render_md(secoes: list, cabecalho: list, checklist: list) -> str:
    out = list(cabecalho)
    for s in secoes:
        out.append(f"{'#' * s.nivel} {s.titulo}")
        out.append("")
        if s.nota:
            out.append(f"_{s.nota}_")
            out.append("")
        for e in s.elementos:
            if e.tipo == "msg":
                corpo = "\n".join(e.conteudo)
                f = cerca(corpo)
                out += [f, corpo, f, ""]
            elif e.tipo == "bloco":
                f = cerca(e.conteudo)
                out += [f, e.conteudo, f, ""]
            elif e.tipo == "anexo":
                partes = [f"`{a['rel']}`" + (f" ({a['grupo']})" if a.get("grupo") else "")
                          + ("" if a["existe"] else " — NÃO EXISTE EM DISCO") for a in e.conteudo]
                out += ["anexe, nesta ordem: " + " · ".join(partes), ""]
            elif e.tipo == "nota":
                out += [texto(e.conteudo), ""]
    out.append("## antes de mandar (não copie isto)")
    out.append("")
    out += [f"- [ ] {c}" for c in checklist]
    out.append("")
    return "\n".join(out)


CSS_HTML = """:root{--bg:#F9FAFB;--card:#fff;--tx:#181B21;--mut:#5C6B7F;--bd:#D5DBE2;--ac:#0369A1;--av:#B45309;--avf:#FFFBEB}
@media (prefers-color-scheme:dark){:root{--bg:#181B21;--card:#232931;--tx:#F0F2F4;--mut:#ACB6C3;--bd:#45505F;--ac:#38BDF8;
--av:#FBBF24;--avf:#33270F}}
body{margin:0;background:var(--bg);color:var(--tx);font-family:"Segoe UI","Helvetica Neue",Arial,sans-serif;font-size:14px}
main{max-width:860px;margin:0 auto;padding:24px 16px 80px}h1{font-size:20px;margin:0 0 4px}
.sub{color:var(--mut);margin:0 0 18px;line-height:1.5}
h2{font-size:15px;margin:28px 0 8px;padding-bottom:6px;border-bottom:1px solid var(--bd)}
h3{font-size:13px;margin:20px 0 6px;color:var(--mut)}
.nota{color:var(--mut);font-style:italic;margin:0 0 8px}
.msg{display:flex;gap:10px;align-items:flex-start;background:var(--card);border:1px solid var(--bd);border-radius:6px;
padding:10px 12px;margin:8px 0}
.msg.codigo pre{font-family:Consolas,Menlo,monospace;font-size:13px}
.num{color:var(--mut);font-size:12px;min-width:24px;padding-top:2px;font-variant-numeric:tabular-nums}
pre{flex:1;margin:0;white-space:pre-wrap;word-break:break-word;font-family:inherit;font-size:14px;cursor:text}
button{border:1px solid var(--bd);background:transparent;color:var(--ac);border-radius:6px;padding:4px 10px;cursor:pointer;
font:inherit;font-size:12px}
button:focus-visible{outline:2px solid var(--ac);outline-offset:2px}
figure{margin:4px 0 16px 34px}img{max-width:100%;border:1px solid var(--bd);border-radius:6px;display:block}
figcaption{color:var(--mut);font-size:12px;margin-top:4px;word-break:break-all}
.falta{color:#B91C1C;font-weight:600}
.check{background:var(--avf);border:1px solid var(--av);border-radius:6px;padding:10px 14px;margin-top:28px}
.check h2{border:none;margin-top:4px;color:var(--av)}.check li{margin:4px 0}"""

JS_HTML = r"""(function(){
function selecionar(el){var r=document.createRange();r.selectNodeContents(el);var s=window.getSelection();s.removeAllRanges();s.addRange(r);}
function aviso(b,t){b.textContent=t;setTimeout(function(){b.textContent='copiar';},1500);}
function copiar(b){var pre=b.parentNode.querySelector('pre');var texto=pre.textContent;
var ta=document.createElement('textarea');ta.value=texto;ta.setAttribute('readonly','');ta.style.position='fixed';
ta.style.top='0';ta.style.left='0';ta.style.opacity='0';document.body.appendChild(ta);ta.focus();ta.select();
var ok=false;try{ok=document.execCommand('copy');}catch(e){}
document.body.removeChild(ta);
if(ok){aviso(b,'copiado');return;}
if(navigator.clipboard&&window.isSecureContext){navigator.clipboard.writeText(texto).then(function(){aviso(b,'copiado');},
function(){selecionar(pre);aviso(b,'Ctrl+C');});}else{selecionar(pre);aviso(b,'Ctrl+C');}}
[].slice.call(document.querySelectorAll('button.copiar')).forEach(function(b){b.addEventListener('click',function(){copiar(b);});});
[].slice.call(document.querySelectorAll('pre')).forEach(function(p){p.addEventListener('click',function(){selecionar(p);});});
})();"""


def esc(s) -> str:
    return html.escape(re.sub(r"[\x00-\x08\x0b\x0c\x0e-\x1f]", "", str(s)), quote=True)


def render_html(secoes: list, titulo: str, sub: str, checklist: list) -> str:
    h = ['<!DOCTYPE html>\n<html lang="pt-BR" xmlns="http://www.w3.org/1999/xhtml">\n<head>\n<meta charset="utf-8" />\n'
         '<meta name="viewport" content="width=device-width, initial-scale=1" />\n'
         f"<title>{esc(titulo)}</title>\n<style>/*<![CDATA[*/{CSS_HTML}/*]]>*/</style>\n</head>\n<body>\n<main>\n"
         f"<h1>{esc(titulo)}</h1>\n<p class=\"sub\">{esc(sub)}</p>\n"]
    n = 0
    for s in secoes:
        h.append(f"<h{s.nivel}>{esc(s.titulo)}</h{s.nivel}>\n")
        if s.nota:
            h.append(f'<p class="nota">{esc(s.nota)}</p>\n')
        for e in s.elementos:
            if e.tipo in ("msg", "bloco"):
                n += 1
                corpo = "\n".join(e.conteudo) if e.tipo == "msg" else e.conteudo
                classe = "msg" if e.tipo == "msg" else "msg codigo"
                h.append(f'<div class="{classe}"><span class="num">{n}</span><pre>{esc(corpo)}</pre>'
                         f'<button type="button" class="copiar">copiar</button></div>\n')
            elif e.tipo == "anexo":
                for a in e.conteudo:
                    rot = f"{a.get('grupo', '')} · {a['rel']}".strip(" ·")
                    if a["imagem"] and a["existe"]:
                        h.append(f'<figure><img src="{esc(a["rel"])}" alt="{esc(rot)}" loading="lazy" />'
                                 f"<figcaption>anexe: {esc(rot)}</figcaption></figure>\n")
                    else:
                        falta = "" if a["existe"] else ' <span class="falta">não existe em disco</span>'
                        h.append(f'<figure><figcaption>anexe: <a href="{esc(a["rel"])}">{esc(rot)}</a>{falta}'
                                 f"</figcaption></figure>\n")
            elif e.tipo == "nota":
                h.append(f'<p class="nota">{esc(e.conteudo)}</p>\n')
    h.append('<div class="check"><h2>antes de mandar (não copie isto)</h2><ul>'
             + "".join(f"<li>{esc(c)}</li>" for c in checklist) + "</ul></div>\n")
    h.append(f"</main>\n<script>//<![CDATA[\n{JS_HTML}\n//]]></script>\n</body>\n</html>\n")
    return "".join(h)


def checklist_base(cfg: Config, av: Avisos, tem_decisao: bool, oraculo: bool) -> list:
    canal_t = cfg["mensagens_canal_tecnico"] or ("grupo ou conversa técnica do time (achado de QA e dúvida técnica "
                                                 "não vão no grupo executivo)")
    itens = [f"Canal: {canal_t}."]
    if tem_decisao or oraculo:
        canal_n = cfg["mensagens_canal_negocio"] or "quem decide a regra de negócio, em poucas mensagens, já com a pergunta fechada"
        itens.append(f"Decisão de regra: {canal_n}; com o print (ou a saída) de onde aparece no alvo.")
    if cfg["mensagens_canal_proibido"]:
        itens.append(f"Não mande em: {cfg['mensagens_canal_proibido']}.")
    itens += [
        "Risco: para cada mensagem, se a pessoa acreditar e agir, onde ela vai parar? Frase verdadeira mas incompleta "
        "manda consertar metade; mal atribuída manda procurar no commit errado.",
        "Atribuição: antes de dizer que o defeito é de alguém (do commit, do back, da correção dele), reproduza na base "
        "limpa, sem as suas mudanças do working tree.",
        "Quem fez o quê: confira no registro de atividade/auditoria antes de afirmar, ou de concordar, que o sistema "
        "\"fez sozinho\" ou que fulano aprovou.",
        "Código de registro (pedido, cliente, id) vai com o ambiente junto: os códigos se repetem entre ambientes.",
        "Print anexado na mensagem certa, e sem token, senha ou dado pessoal desnecessário na imagem.",
        "A ressalva do que não foi testado está no fim e inteira. Mensagem informal não é motivo para cortá-la.",
        "Sintoma, não nome de classe: se a pessoa quiser a linha do código, ela pergunta.",
        "Quem envia é você. Este rascunho não foi enviado a ninguém.",
    ]
    if av.fora_do_formato:
        itens.insert(0, f"{av.fora_do_formato} caso(s) parecem dúvida de regra fora do formato \"oraculo: ...\" e não "
                        f"entraram nas perguntas: reescreva-os (veja os alertas) e gere de novo.")
    if av.anexos_faltando:
        itens.insert(0, f"PARE: {av.anexos_faltando} evidência(s) citada(s) não existem em disco. Não mande a mensagem "
                        f"sem a prova: salve o arquivo ou corrija o caminho no ledger.")
    if av.anexos_fora:
        itens.insert(0, f"PARE: {av.anexos_fora} evidência(s) fora de evidencias/, rede/, notas/ ou relatorio/ da rodada "
                        f"ficaram fora dos anexos: copie a prova para evidencias/ e corrija o caminho no ledger.")
    if av.segredos:
        itens.insert(0, f"PARE: {av.segredos} segredo(s) mascarado(s) no rascunho. Não mande o original; limpe o ledger.")
    if av.lacunas:
        itens.insert(0, f"Preencha as {av.lacunas} lacuna(s) [PREENCHA: ...] antes de usar.")
    abertos = av.alertas_abertos()
    if av.estrito and abertos:
        itens.insert(0, f"--estrito: {len(abertos)} alerta(s) sem revisão contam como pendência. Confira cada um e ponha a "
                        f"impressão (os 12 caracteres entre colchetes), uma por linha, no arquivo de --alertas-revisados.")
    return itens + [f"Alerta [{impressao_alerta(a)}]{'' if a in abertos else ' (revisado)'}: {a}" for a in av.itens]


def selecionar_defeitos(dados: dict, pedidos: list, incluir_retratados: bool, modo_issue: bool) -> tuple:
    todos = dados["defeitos"]
    if pedidos:
        ids = []
        for p in pedidos:
            ids += [x.strip().upper() for x in p.split(",") if x.strip()]
        mapa = {texto(d.get("id")).upper(): d for d in todos}
        faltam = [i for i in ids if i not in mapa]
        if faltam:
            falhar(f"defeito(s) inexistente(s) no ledger: {', '.join(faltam)} (existem: "
                   f"{', '.join(sorted(mapa)) or 'nenhum'})")
        return [mapa[i] for i in dict.fromkeys(ids)], True
    if modo_issue:
        return [d for d in todos if texto(d.get("tipo")) != "retratado" and d.get("status") != "retestado-ok"], False
    return [d for d in todos if incluir_retratados or texto(d.get("tipo")) != "retratado"], False


def montar_parser() -> ParserPT:
    ap = ParserPT(
        prog="mensagens.py",
        description="Rascunho das mensagens para o time (e dos rascunhos de issue) a partir do ledger do QA. Nao envia nada.",
        epilog=(
            "modos:\n"
            "  (padrao)    mensagens por defeito, no estilo do PERFIL (whatsapp se nao houver)\n"
            "  --oraculo   as duvidas de regra da rodada, juntas, como perguntas fechadas com o custo de cada opcao\n"
            "              (casos com justificativa \"oraculo: Q1 | pergunta | A) ... => custo | B) ... => custo\"; monte\n"
            "              com cobertura.py set C-NNNN --oraculo-pergunta \"...\" --opcao \"A => custo\" --opcao \"B => custo\").\n"
            "              Caso bloqueado/nao-validado que fala de regra, decisao ou produto fora desse formato vira\n"
            "              alerta e saida 1: ele nao entra nas perguntas. Sem --saida (e em md), imprime na tela E\n"
            "              grava <rodada>/relatorio/oraculo.md, o arquivo que o cobertura.py fechar procura.\n"
            "  --issue     um rascunho de issue por defeito (templates/issue.md) em <rodada>/relatorio/issues/\n\n"
            "estilo (PERFIL, secao Registro e entrega; a linha de comando manda):\n"
            "  - estilo_mensagens: whatsapp | formal\n"
            "  - mensagens_canal_tecnico / mensagens_canal_negocio / mensagens_canal_proibido: <texto>\n"
            "  - mensagens_abertura / mensagens_fecho: linha 1 / linha 2   ({alvo} vira o alvo da rodada)\n"
            "  - mensagens_trocas: é=eh; você=vc   - mensagens_minusculas: sim   - mensagens_max_linha: 90\n"
            "  - mensagens_linhas_por_mensagem: 3   - mensagens_dizer_nao_commitado: sim   - mensagens_codigo: nao\n\n"
            "exemplos:\n"
            "  mensagens.py .qa/2026-09-30-clientes\n"
            "  mensagens.py .qa/2026-09-30-clientes --defeito D-003 --branch fix/cnpj-invalido\n"
            "  mensagens.py .qa/2026-09-30-clientes --estilo formal --saida .qa/2026-09-30-clientes/relatorio/email.md\n"
            "  mensagens.py .qa/2026-09-30-clientes --formato html     (pagina com botao copiar e os prints)\n"
            "  mensagens.py .qa/2026-09-30-clientes --oraculo --saida .qa/2026-09-30-clientes/relatorio/oraculo.md\n"
            "      (o cobertura.py fechar procura relatorio/oraculo*.md citando cada caso 'oraculo: ...')\n"
            "  mensagens.py .qa/2026-09-30-clientes --issue --defeito D-002\n\n"
            "alertas (nome de codigo, afirmacao categorica, \"Nada foi commitado\"...): saem no checklist com uma\n"
            "impressao de 12 caracteres, ex. \"Alerta [3f9a0c1b2d4e]: ...\". Por padrao nao mudam a saida. Com\n"
            "--estrito, todo alerta nao revisado conta como pendencia (saida 1); depois de conferir, ponha a\n"
            "impressao (ou o texto inteiro do alerta) numa linha do arquivo de --alertas-revisados e gere de novo.\n"
            "Bloco proprio (caminho, causa e sugestao com --com-codigo, branch) nao gera alerta de nome de codigo;\n"
            "texto que vem de campo do ledger com detalhe de codigo (ex. a decisao gravada em correcao) gera o\n"
            "alerta 'campo do ledger com detalhe de codigo': confira e marque em --alertas-revisados.\n\n"
            "segredo: todo texto (mensagem, alvo, nome e caminho de anexo) passa pela mascara comum em modo estrito,\n"
            "e todo anexo de texto (.json, .txt, .log, .har, .jsonl, .ndjson, .md, .csv, .yaml, .yml, .xml, ate 3 MB)\n"
            "e varrido; .json, .har, .jsonl e .ndjson tambem como estrutura (par nome/valor de cookie, cabecalho e\n"
            "queryString, JSON dentro de string, chave sensivel).\n"
            "--issue preenche \"Reproduzido por outro caminho\" com defeitos[].reproducao (cobertura.py set D-NNN\n"
            "--repro \"...\") e os passos com o campo passos do caso (cobertura.py set C-NNNN --passos \"...\").\n\n"
            "anexo: so entra evidencia dentro de evidencias/, rede/, notas/ ou relatorio/ da rodada; caminho com '..'\n"
            "ou que resolve fora vira alerta 'ARQUIVO FORA DA RODADA' (copie a prova para evidencias/) e saida 1.\n"
            "Subpasta da rodada que e link ou junction para outro lugar conta como fora (aviso unico no stderr).\n\n"
            "tipo de projeto (rodada.tipos_projeto): com biblioteca, cli ou api, nome que aparece no id de um item\n"
            "funcao:, comando: ou api: do ledger, e nome terminado em Error/Exception, nao vira alerta de nome de\n"
            "codigo (ali o nome publico e o sintoma). A frase do reteste usa o Nome do PERFIL secao 3.1 ('testei de\n"
            "novo em <Nome>'; sem ele, 'no alvo') e avisa 'fora do pacote instalado' quando ha caso PJ-LIB-07 ou de\n"
            "comando: bloqueado.\n\n"
            "codigos de saida: 0 rascunho pronto para revisar | 1 gerado com pendencia (segredo mascarado, lacuna\n"
            "                  [PREENCHA], evidencia citada que nao existe em disco ou fora da rodada, anexo com\n"
            "                  segredo ou, no --oraculo,\n"
            "                  caso bloqueado/nao-validado com cara de duvida de regra fora do formato; com --estrito,\n"
            "                  tambem alerta nao revisado) | 2 uso, ledger ou defeito invalido"
        ),
    )
    ap.add_argument("rodada", help="pasta da rodada ou caminho do cobertura.json")
    modo = ap.add_mutually_exclusive_group()
    modo.add_argument("--oraculo", action="store_true", help="perguntas de regra agrupadas da rodada")
    modo.add_argument("--issue", action="store_true", help="rascunho de issue por defeito (nao cria nada)")
    ap.add_argument("--defeito", action="append", default=[], metavar="D-NNN",
                    help="so estes defeitos (repetivel ou separado por virgula)")
    ap.add_argument("--estilo", choices=["whatsapp", "formal"], help="sobrepoe estilo_mensagens do PERFIL")
    ap.add_argument("--formato", choices=["md", "html"], default="md",
                    help="md (padrao, blocos sem tag de linguagem) ou html (cartoes com botao copiar e os prints)")
    ap.add_argument("--perfil", help="caminho do PERFIL (padrao: o da rodada, ou .qa/PERFIL.md)")
    ap.add_argument("--branch", help="branch sugerida; sai em bloco proprio quando houver correcao")
    cod = ap.add_mutually_exclusive_group()
    cod.add_argument("--com-codigo", dest="com_codigo", action="store_true", default=None,
                     help="inclui arquivo:linha, causa e a proposta de melhoria (no whatsapp em bloco proprio, que nao "
                          "gera alerta de nome de codigo); padrao do formal")
    cod.add_argument("--sem-codigo", dest="com_codigo", action="store_false",
                     help="so sintoma, sem arquivo nem causa; a proposta de melhoria sai como 'proposta registrada no "
                          "relatório'; padrao do whatsapp")
    ap.add_argument("--incluir-retratados", action="store_true", help="inclui as retratacoes nas mensagens")
    ap.add_argument("--alvo", help="como chamar o alvo na abertura (padrao: rodada.alvo do ledger)")
    ap.add_argument("--max-linha", type=int, help="sobrepoe mensagens_max_linha")
    ap.add_argument("--template", help="template de issue (padrao: <skill>/templates/issue.md)")
    ap.add_argument("--saida", help="arquivo de saida (padrao: tela; no html, <rodada>/relatorio/mensagens.html; no "
                                    "--oraculo em md, tela e <rodada>/relatorio/oraculo.md); no --issue, a pasta "
                                    "(padrao: <rodada>/relatorio/issues)")
    ap.add_argument("--estrito", action="store_true",
                    help="todo alerta nao revisado conta como pendencia (saida 1)")
    ap.add_argument("--alertas-revisados", metavar="ARQ",
                    help="arquivo com um alerta ja conferido por linha: a impressao de 12 caracteres mostrada no "
                         "checklist ou o texto inteiro do alerta ('#' comenta)")
    return ap


def ler_revisados(caminho) -> set:
    if not caminho:
        return set()
    try:
        bruto = Path(caminho).expanduser().read_text(encoding="utf-8-sig")
    except OSError as e:
        falhar(f"nao consegui ler --alertas-revisados {caminho}: {e}")
    saida = set()
    for linha in bruto.splitlines():
        linha = linha.strip()
        if not linha or linha.startswith("#"):
            continue
        m = re.match(r"^(?:alerta\s*)?\[?([0-9a-f]{12})\]?(?:\s|:|$)", linha, re.I)
        saida.add(m.group(1).lower() if m else texto(linha))
    return saida


def main(argv=None) -> int:
    configurar_saida()
    args = montar_parser().parse_args(argv)
    p = caminho_ledger(args.rodada)
    dados = carregar(p)
    pasta = p.resolve().parent
    args.rodada_mostrada = args.rodada
    cfg = Config()
    perfil = achar_perfil(args.perfil, dados, pasta)
    if perfil:
        cfg.ler_perfil(perfil)
    configurar_por_tipo(cfg, dados)
    if args.max_linha:
        cfg.valores["mensagens_max_linha"] = str(args.max_linha)
    estilo = args.estilo or sem_acento(cfg["estilo_mensagens"]) or "whatsapp"
    if estilo not in ("whatsapp", "formal"):
        print(f"aviso: estilo_mensagens desconhecido \"{estilo}\" no PERFIL; usando whatsapp", file=sys.stderr)
        estilo = "whatsapp"
    av = Avisos(args.estrito, ler_revisados(args.alertas_revisados))
    alvo = mascarar(texto(args.alvo) or texto(dados["rodada"].get("alvo")), av, "alvo")

    if args.issue:
        defeitos, _ = selecionar_defeitos(dados, args.defeito, args.incluir_retratados, True)
        template = Path(args.template).expanduser() if args.template else \
            Path(__file__).resolve().parent.parent / "templates" / "issue.md"
        gerados = montar_issues(dados, defeitos, cfg, av, pasta, args, template)
        if not gerados:
            print("nenhum defeito precisa de issue (todos retestados ok ou retratados); use --defeito para forcar")
        for arq, tit, rot in gerados:
            print(f"rascunho: {arq}")
            print(f'  para criar (SO com ordem explicita do usuario): gh issue create --title "{tit}" '
                  f'--body-file "{arq}" --label "{rot}"')
        for a in av.itens:
            print(f"  alerta [{impressao_alerta(a)}]{' (revisado)' if av.revisado(a) else ''}: {a}")
        if av.estrito and av.alertas_abertos():
            print(f"  --estrito: {len(av.alertas_abertos())} alerta(s) sem revisao (veja --alertas-revisados)")
        if av.lacunas:
            print(f"  {av.lacunas} lacuna(s) [PREENCHA] para completar antes de usar")
        if av.anexos_faltando:
            print(f"  {av.anexos_faltando} evidencia(s) citada(s) nao existem em disco: salve-as ou corrija o ledger")
        if av.anexos_fora:
            print(f"  {av.anexos_fora} evidencia(s) fora da rodada ficaram fora dos anexos: copie a prova para evidencias/")
        return EXIT_REVISAR if av.pendencias() else EXIT_OK

    oraculo_na_tela_e_arquivo = bool(args.oraculo and not args.saida and args.formato == "md")
    if args.formato == "html" and not args.saida:
        saida = pasta / "relatorio" / ("perguntas.html" if args.oraculo else "mensagens.html")
    elif oraculo_na_tela_e_arquivo:
        saida = pasta / "relatorio" / "oraculo.md"
    else:
        saida = Path(args.saida).expanduser() if args.saida else None
    pasta_saida = (saida.parent if saida else Path.cwd()).resolve()
    if saida:
        pasta_saida.mkdir(parents=True, exist_ok=True)
    anx = Anexos(pasta, pasta_saida, av)

    if args.oraculo:
        secoes = montar_oraculo(dados, cfg, av, anx, args, alvo, estilo)
        tem_decisao = True
        titulo = f"Perguntas de regra — {alvo or pasta.name}"
    else:
        defeitos, filtrado = selecionar_defeitos(dados, args.defeito, args.incluir_retratados, False)
        montar = montar_formal if estilo == "formal" else montar_whatsapp
        secoes = montar(dados, defeitos, filtrado, cfg, av, anx, args, alvo)
        tem_decisao = any(texto(d.get("tipo")) == "decisao-de-produto" for d in defeitos)
        titulo = f"Mensagens para o time — {alvo or pasta.name}"
    checklist = checklist_base(cfg, av, tem_decisao, args.oraculo)
    sub = (f"rascunho gerado por mensagens.py em {agora_iso()} a partir de {p} · estilo {estilo} · "
           f"configuração: {cfg.fonte} · quem envia é você: copie um bloco por vez, na ordem, com o anexo indicado")
    sub = mascarar(sub, av, "cabecalho")
    if args.formato == "html":
        conteudo = render_html(secoes, titulo, sub, checklist)
    else:
        cab = [f"# {titulo}", "", f"> {sub}", ""]
        conteudo = render_md(secoes, cab, checklist)
    if oraculo_na_tela_e_arquivo:
        sys.stdout.write(conteudo)
    if saida:
        with open(saida, "w", encoding="utf-8", newline="\n") as f:
            f.write(conteudo)
        print(f"rascunho gravado: {saida}" + (" (o mesmo texto acima; o cobertura.py fechar procura este arquivo)"
                                              if oraculo_na_tela_e_arquivo else ""))
        print(f"  {sum(1 for s in secoes for e in s.elementos if e.tipo in ('msg', 'bloco'))} bloco(s) copiavel(is), "
              f"{len(av.itens)} alerta(s), {av.lacunas} lacuna(s), {av.segredos} segredo(s) mascarado(s), "
              f"{av.anexos_faltando} anexo(s) inexistente(s), {av.anexos_fora} anexo(s) fora da rodada, "
              f"{av.fora_do_formato} duvida(s) de regra fora do formato")
    else:
        sys.stdout.write(conteudo)
    if av.pendencias():
        abertos = f", {len(av.alertas_abertos())} alerta(s) sem revisao (--estrito)" if av.estrito else ""
        print(f"aviso: {av.lacunas} lacuna(s), {av.segredos} segredo(s) mascarado(s), {av.anexos_faltando} anexo(s) "
              f"inexistente(s), {av.anexos_fora} anexo(s) fora da rodada e {av.fora_do_formato} duvida(s) de regra "
              f"fora do formato{abertos}: revise antes de usar", file=sys.stderr)
    return EXIT_REVISAR if av.pendencias() else EXIT_OK


if __name__ == "__main__":
    sys.exit(main())

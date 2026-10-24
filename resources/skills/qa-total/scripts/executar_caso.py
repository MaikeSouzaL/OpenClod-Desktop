#!/usr/bin/env python3
"""executar_caso.py - executa um caso de CLI, biblioteca ou job e grava a transcricao (skill qa-total).

O harness padrao para o que nao tem tela: cada execucao roda numa pasta temporaria propria, com HOME,
XDG_CONFIG_HOME, XDG_DATA_HOME, XDG_CACHE_HOME, APPDATA, LOCALAPPDATA e USERPROFILE temporarios (nada
le nem grava a configuracao de quem roda), e grava em <rodada>/evidencias/<NN-slug>[-SUFIXO].txt:
o comando, a pasta de trabalho, o codigo de saida, o tempo, o stdout e o stderr, tudo passado pela
mascara de segredos. Antes disso, o argv (que o shell ja expandiu: $SENHA vira o valor) tem o valor de opcao de
credencial trocado por [REMOVIDO]: --password/--token/--api-key, -H com Authorization ou Cookie, a senha de
'usuario:senha' em curl -u e http -a, mysql -p<senha>, sqlcmd -P, redis-cli -a, mongo/sshpass -p e docker login -p.
As pastas temporarias sao apagadas no fim.

Subcomandos:
  cmd     roda um comando:   executar_caso.py cmd <rodada> --slug NN-slug -- <comando> [args...]
  chamar  chama uma funcao:  executar_caso.py chamar <rodada> --slug NN-slug --modulo pacote.modulo
                             --funcao nome --args '<json>'
          num subprocesso Python que importa e chama; codigo 0 com retorno, 1 com excecao (no stderr).

Somente biblioteca padrao. Python 3.9+. Windows, macOS e Linux.
"""
from __future__ import annotations

import argparse
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

EXIT_OK, EXIT_FALHOU, EXIT_USO = 0, 1, 2
SUFIXOS = ("ANTES", "CORRIGIDO", "RETESTE")
RE_SLUG = re.compile(r"[A-Za-z0-9][A-Za-z0-9._-]{0,120}")
VARIAVEIS_DE_USUARIO = ("HOME", "USERPROFILE", "XDG_CONFIG_HOME", "XDG_DATA_HOME", "XDG_CACHE_HOME", "APPDATA",
                        "LOCALAPPDATA")

CODIGO_CHAMAR = r"""
import importlib, json, sys, traceback
try:
    modulo = importlib.import_module(sys.argv[1])
    funcao = getattr(modulo, sys.argv[2])
    args = json.loads(sys.argv[3])
    if isinstance(args, list):
        retorno = funcao(*args)
    elif isinstance(args, dict):
        retorno = funcao(**args)
    else:
        retorno = funcao(args)
except BaseException:
    traceback.print_exc()
    sys.exit(1)
try:
    print(json.dumps(retorno, ensure_ascii=False, default=repr))
except Exception:
    print(repr(retorno))
"""


class ErroUso(Exception):
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
        self.add_argument("-h", "--help", action="help", default=argparse.SUPPRESS, help="mostra esta ajuda e sai")

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


def mascarar(texto: str) -> str:
    return _mascara.mascarar(texto or "", estrito=True)[0]


def pasta_da_rodada(valor: str) -> Path:
    p = Path(valor).expanduser()
    if p.is_file() and p.name == "cobertura.json":
        p = p.parent
    if not p.is_dir():
        raise ErroUso(f"pasta da rodada nao encontrada: {p}")
    return p.resolve()


def destino_da_evidencia(rodada: Path, slug: str, sufixo: str | None) -> Path:
    if not RE_SLUG.fullmatch(slug or "") or ".." in slug:
        raise ErroUso(f"slug invalido: {slug!r} (use NN-o-que-mostra: letras, numeros, '.', '_' e '-', sem "
                      f"separador de pasta nem '..')")
    nome = f"{slug}-{sufixo}.txt" if sufixo else f"{slug}.txt"
    pasta = rodada / "evidencias"
    destino = (pasta / nome).resolve()
    if destino.parent != pasta.resolve():
        raise ErroUso(f"slug invalido: {slug!r}")
    return destino


def ambiente_isolado(base: Path, extras: list) -> dict:
    env = dict(os.environ)
    for var in VARIAVEIS_DE_USUARIO:
        pasta = base / var.lower()
        pasta.mkdir(parents=True, exist_ok=True)
        env[var] = str(pasta)
    for item in extras or []:
        if "=" not in item or not item.split("=", 1)[0].strip():
            raise ErroUso(f"--env precisa ser NOME=valor: {item!r}")
        nome, valor = item.split("=", 1)
        env[nome.strip()] = valor
    return env


def cwd_visivel(cwd: Path, temporaria: bool) -> str:
    if temporaria:
        return "(pasta temporaria do caso, apagada no fim)"
    try:
        return Path(os.path.relpath(str(cwd), str(Path.cwd()))).as_posix()
    except ValueError:
        return cwd.as_posix()


MARCA = _mascara.MARCA
OPCOES_SEGREDO_GERAIS = {"--password", "--passwd", "--pass", "--http-password", "--proxy-password", "--ftp-password",
                         "--db-password", "--token", "--auth-token", "--access-token", "--api-key", "--apikey",
                         "--secret", "--client-secret", "--senha"}
OPCOES_USUARIO_SENHA = {"curl": {"-u", "--user", "-U", "--proxy-user"},
                        "http": {"-a", "--auth"}, "https": {"-a", "--auth"}, "xh": {"-a", "--auth"},
                        "xhs": {"-a", "--auth"}, "httpie": {"-a", "--auth"}}
OPCOES_SENHA_SEPARADA = {"sqlcmd": {"-P"}, "bcp": {"-P"}, "osql": {"-P"}, "isql": {"-P"}, "redis-cli": {"-a"},
                         "mongo": {"-p"}, "mongosh": {"-p"}, "mongodump": {"-p"}, "mongorestore": {"-p"},
                         "mongoexport": {"-p"}, "mongoimport": {"-p"}, "sshpass": {"-p"}}
OPCOES_SENHA_COLADA = {"mysql": "-p", "mysqldump": "-p", "mysqladmin": "-p", "mysqlimport": "-p", "mysqlshow": "-p",
                       "mariadb": "-p", "mariadb-dump": "-p", "sqlcmd": "-P", "bcp": "-P"}
PROGRAMAS_COM_LOGIN = ("docker", "podman", "helm", "oras", "skopeo", "nerdctl")
RE_CABECALHO_SEGREDO = re.compile(r"(?i)^\s*((?:proxy-)?authorization|cookie|set-cookie|x-api-key|x-auth-token|"
                                  r"api-key|x-csrf-token|x-xsrf-token)\s*:\s*(.*)$")
RE_ESQUEMA = re.compile(r"(?i)^(bearer|basic|digest|token|negotiate|ntlm)\s+")


def _programa(partes: list) -> str:
    nome = Path(str(partes[0])).name.lower() if partes else ""
    for ext in (".exe", ".cmd", ".bat", ".ps1"):
        if nome.endswith(ext):
            return nome[:-len(ext)]
    return nome


def _so_senha(valor: str, sempre: bool) -> str:
    """'usuario:senha' vira 'usuario:[REMOVIDO]'; sem ':' fica o usuario (curl pede a senha), salvo 'sempre'."""
    if ":" in valor:
        usuario, _, senha = valor.partition(":")
        return f"{usuario}:{MARCA}" if senha else valor
    return MARCA if sempre and valor else valor


def _cabecalho(valor: str) -> str:
    m = RE_CABECALHO_SEGREDO.match(valor)
    if not m or not m.group(2).strip():
        return valor
    nome, resto = m.group(1), m.group(2)
    if nome.lower() in ("cookie", "set-cookie"):
        limpo = _mascara.mascarar(f"{nome}: {resto}", estrito=True)[0]
        return limpo if MARCA in limpo else f"{nome}: {MARCA}"
    esquema = RE_ESQUEMA.match(resto)
    return f"{nome}: " + (esquema.group(0) if esquema else "") + MARCA


def mascarar_argv(partes: list) -> list:
    """Troca por [REMOVIDO] o valor de opcao de credencial antes de o comando ir para a transcricao: o shell ja
    expandiu $SENHA quando o argv chega aqui. Vale para --password, --token, --api-key... (qualquer programa),
    -H/--header com Authorization ou Cookie, a senha de 'usuario:senha' depois de -u/--user (curl) e -a/--auth
    (httpie), -p<senha> colado (mysql), -P <senha> (sqlcmd), -a <senha> (redis-cli), -p <senha> (mongo, sshpass,
    docker login). Opcao curta so nesses programas: '-p 8080:80' do docker run e '-u origin' do git ficam."""
    prog = _programa(partes)
    login = prog in PROGRAMAS_COM_LOGIN and "login" in [str(x) for x in partes[1:3]]
    usuario_senha = OPCOES_USUARIO_SENHA.get(prog, set())
    senha_separada = set(OPCOES_SENHA_SEPARADA.get(prog, set())) | ({"-p"} if login else set())
    colada = OPCOES_SENHA_COLADA.get(prog)
    saida, i = [str(x) for x in partes[:1]], 1
    while i < len(partes):
        a = str(partes[i])
        prox = str(partes[i + 1]) if i + 1 < len(partes) else None
        opcao, igual, valor = a.partition("=") if a.startswith("--") else (a, "", "")
        if opcao.lower() in OPCOES_SEGREDO_GERAIS or opcao in senha_separada:
            if igual:
                saida.append(f"{opcao}={MARCA}" if valor else a)
            elif prox is not None:
                saida += [a, MARCA]
                i += 1
            else:
                saida.append(a)
        elif opcao in ("-H", "--header"):
            if igual:
                saida.append(f"{opcao}={_cabecalho(valor)}")
            elif prox is not None:
                saida += [a, _cabecalho(prox)]
                i += 1
            else:
                saida.append(a)
        elif opcao in usuario_senha or (prog == "curl" and re.fullmatch(r"-[A-Za-z]+[uU]", a) and len(a) > 2):
            sempre = prog != "curl"
            if igual:
                saida.append(f"{opcao}={_so_senha(valor, sempre)}")
            elif prox is not None:
                saida += [a, _so_senha(prox, sempre)]
                i += 1
            else:
                saida.append(a)
        elif prog == "curl" and len(a) > 2 and a[:2] in ("-u", "-U") and not a.startswith("--"):
            saida.append(a[:2] + _so_senha(a[2:], False))
        elif colada and a.startswith(colada) and len(a) > len(colada) and not a.startswith("--"):
            saida.append(colada + MARCA)
        else:
            saida.append(a)
        i += 1
    return saida


def comando_visivel(partes: list) -> str:
    saida = []
    for p in mascarar_argv([str(x) for x in partes]):
        saida.append(p if p and re.fullmatch(r"[\w@%+=:,./\\\[\]-]+", p) else json.dumps(p, ensure_ascii=False))
    return " ".join(saida)


def resolver_executavel(partes: list, env: dict) -> list:
    if not partes:
        return partes
    achado = shutil.which(partes[0], path=env.get("PATH"))
    return [achado] + partes[1:] if achado else partes


def rodar(partes: list, cwd: Path, env: dict, stdin: Path | None, timeout: float) -> tuple:
    entrada = None
    if stdin is not None:
        try:
            entrada = stdin.read_bytes()
        except OSError as e:
            raise ErroUso(f"--stdin ilegivel: {stdin} ({e})")
    inicio = time.monotonic()
    try:
        proc = subprocess.run(resolver_executavel(partes, env), cwd=str(cwd), env=env, input=entrada,
                              stdin=None if entrada is not None else subprocess.DEVNULL, capture_output=True,
                              timeout=timeout)
        rc, saida, erro = proc.returncode, proc.stdout, proc.stderr
    except subprocess.TimeoutExpired as e:
        rc, saida, erro = None, e.stdout or b"", (e.stderr or b"") + f"\n[tempo esgotado: {timeout:g} s]".encode()
    except FileNotFoundError:
        rc, saida, erro = 127, b"", f"comando nao encontrado: {partes[0]}".encode("utf-8")
    except OSError as e:
        rc, saida, erro = 126, b"", f"nao consegui executar {partes[0]}: {e}".encode("utf-8", "replace")
    ms = int((time.monotonic() - inicio) * 1000)
    return rc, saida.decode("utf-8", "replace"), erro.decode("utf-8", "replace"), ms


def transcricao(cabeca: str, cwd_txt: str, nomes_env: list, stdin: Path | None, rc, ms: int, saida: str,
                erro: str) -> str:
    linhas = [f"$ {cabeca}", f"cwd: {cwd_txt}"]
    if nomes_env:
        linhas.append(f"env: {', '.join(nomes_env)} (valores omitidos)")
    if stdin is not None:
        linhas.append(f"stdin: {stdin.name}")
    linhas += [f"codigo de saida: {'tempo esgotado' if rc is None else rc}", f"tempo: {ms} ms",
               "--- stdout ---", saida.rstrip("\n"), "--- stderr ---", erro.rstrip("\n"), ""]
    return mascarar("\n".join(linhas))


def conferir(rc, saida: str, erro: str, esperado_rc, contem) -> list:
    falhas = []
    if esperado_rc is not None and rc != esperado_rc:
        falhas.append(f"codigo de saida {('tempo esgotado' if rc is None else rc)}, esperado {esperado_rc}")
    if contem is not None and contem not in saida and contem not in erro:
        falhas.append(f"o texto esperado nao apareceu no stdout nem no stderr: {mascarar(contem)!r}")
    return falhas


def executar(args, partes: list, cabeca: str, env_extra: dict | None = None) -> int:
    rodada = pasta_da_rodada(args.rodada)
    destino = destino_da_evidencia(rodada, args.slug, args.sufixo)
    stdin = Path(args.stdin).expanduser().resolve() if getattr(args, "stdin", None) else None
    if stdin is not None and not stdin.is_file():
        raise ErroUso(f"--stdin nao encontrado: {stdin}")
    base = Path(tempfile.mkdtemp(prefix="qa-caso-"))
    try:
        env = ambiente_isolado(base, args.env)
        env.update(env_extra or {})
        temporaria = not args.cwd
        if temporaria:
            cwd = base / "trabalho"
            cwd.mkdir()
        else:
            cwd = Path(args.cwd).expanduser().resolve()
            if not cwd.is_dir():
                raise ErroUso(f"--cwd nao encontrado: {cwd}")
        rc, saida, erro, ms = rodar(partes, cwd, env, stdin, args.timeout)
    finally:
        shutil.rmtree(base, ignore_errors=True)
    nomes_env = [i.split("=", 1)[0].strip() for i in args.env or []]
    texto = transcricao(cabeca, cwd_visivel(cwd, temporaria), nomes_env, stdin, rc, ms, saida, erro)
    destino.parent.mkdir(parents=True, exist_ok=True)
    with open(destino, "w", encoding="utf-8", newline="\n") as f:
        f.write(texto)
    print(destino)
    falhas = conferir(rc, saida, erro, args.esperado_rc, args.contem)
    for f in falhas:
        print(f"FALHOU: {f}", file=sys.stderr)
    return EXIT_FALHOU if falhas else EXIT_OK


def cmd_cmd(args) -> int:
    partes = list(args.comando or [])
    if not partes:
        raise ErroUso("falta o comando depois de --")
    return executar(args, partes, comando_visivel(partes))


def cmd_chamar(args) -> int:
    try:
        valor = json.loads(args.args)
    except json.JSONDecodeError as e:
        raise ErroUso(f"--args nao e JSON valido: {e.msg}")
    if not re.fullmatch(r"[A-Za-z_][\w]*(?:\.[A-Za-z_][\w]*)*", args.modulo or ""):
        raise ErroUso(f"--modulo invalido: {args.modulo!r}")
    if not re.fullmatch(r"[A-Za-z_][\w]*", args.funcao or ""):
        raise ErroUso(f"--funcao invalida: {args.funcao!r}")
    caminhos = [str(Path(p).expanduser().resolve()) for p in (args.pythonpath or [os.getcwd()])]
    anterior = os.environ.get("PYTHONPATH")
    pythonpath = os.pathsep.join(caminhos + ([anterior] if anterior else []))
    partes = [sys.executable, "-c", CODIGO_CHAMAR, args.modulo, args.funcao, json.dumps(valor, ensure_ascii=False)]
    cabeca = f"chamar {args.modulo}.{args.funcao}(" + (
        ", ".join(json.dumps(v, ensure_ascii=False) for v in valor) if isinstance(valor, list)
        else ", ".join(f"{k}={json.dumps(v, ensure_ascii=False)}" for k, v in valor.items()) if isinstance(valor, dict)
        else json.dumps(valor, ensure_ascii=False)) + ")"
    return executar(args, partes, cabeca, {"PYTHONPATH": pythonpath, "PYTHONIOENCODING": "utf-8",
                                           "PYTHONDONTWRITEBYTECODE": "1"})


EPILOGO = """\
exemplos:
  executar_caso.py cmd .qa/2026-09-30-cli --slug 50-cli-entrada-inexistente --esperado-rc 2 \\
      --contem nao-existe.json -- ferramenta exportar --entrada nao-existe.json --saida saida.csv
  executar_caso.py chamar .qa/2026-09-30-lib --slug 12-filtro-lista-vazia --sufixo ANTES \\
      --modulo vendas.filtros --funcao filtrar_por_cliente --args '[[], "C-1"]' --pythonpath src

grava <rodada>/evidencias/<slug>[-SUFIXO].txt com '$ <comando>', o cwd, 'codigo de saida: N', o tempo
em ms, o stdout e o stderr (mascarados) e imprime o caminho. No '$ <comando>', o valor de opcao de
credencial (--password, --token, -H "Authorization: ...", curl -u usuario:senha, mysql -p<senha>,
sqlcmd -P, redis-cli -a) ja sai como [REMOVIDO]; mesmo assim, prefira passar a credencial por
--env NOME=valor, que nao vai para a transcricao. Cada execucao tem pasta de trabalho e HOME,
XDG_CONFIG_HOME, XDG_DATA_HOME, XDG_CACHE_HOME, APPDATA, LOCALAPPDATA e USERPROFILE temporarios,
apagados no fim; --cwd usa outra pasta de trabalho (a configuracao continua isolada). --env NOME=valor
entra no ambiente e so o NOME vai para a transcricao. No chamar, o --pythonpath padrao e a pasta atual.

codigos de saida: 0 transcricao gravada (e --esperado-rc / --contem bateram) | 1 gravada, mas o codigo
de saida ou o texto esperado nao bateu (ou tempo esgotado com --esperado-rc) | 2 uso invalido
(slug com separador ou '..', rodada inexistente, --args que nao e JSON, comando ausente)
"""


def opcoes_comuns(p) -> None:
    p.add_argument("rodada", help="pasta da rodada (ou o cobertura.json dela)")
    p.add_argument("--slug", required=True, help="NN-o-que-mostra (vira evidencias/<slug>[-SUFIXO].txt)")
    p.add_argument("--sufixo", choices=SUFIXOS, help="ANTES, CORRIGIDO ou RETESTE")
    p.add_argument("--cwd", help="pasta de trabalho (padrao: uma temporaria, apagada no fim)")
    p.add_argument("--env", action="append", default=[], metavar="NOME=valor", help="variavel extra (repetivel)")
    p.add_argument("--timeout", type=float, default=120.0, help="limite em segundos (padrao 120)")
    p.add_argument("--esperado-rc", type=int, help="codigo de saida esperado; outro sai 1")
    p.add_argument("--contem", help="texto que precisa aparecer no stdout ou no stderr; ausente sai 1")


def main(argv=None) -> int:
    configurar_saida()
    ap = ParserPT(prog="executar_caso.py", description="Executa um caso de CLI, biblioteca ou job e grava a "
                  "transcricao (comando, codigo de saida, stdout, stderr) em evidencias/.", epilog=EPILOGO)
    sub = ap.add_subparsers(dest="subcomando", metavar="SUBCOMANDO", parser_class=ParserPT)
    sub.required = True
    c = sub.add_parser("cmd", help="roda um comando de terminal", epilog=EPILOGO,
                       usage="executar_caso.py cmd RODADA --slug NN-slug [opcoes] -- <comando> [args...]",
                       description="Roda <comando> [args...] (tudo depois de --) com pasta e configuracao isoladas.")
    opcoes_comuns(c)
    c.add_argument("--stdin", help="arquivo cujo conteudo vai para a entrada padrao")
    c.set_defaults(func=cmd_cmd)
    f = sub.add_parser("chamar", help="chama uma funcao publica num subprocesso Python", epilog=EPILOGO,
                       description="Importa pacote.modulo e chama a funcao com --args (lista = posicionais, objeto "
                                   "= nomeados, outro valor = um argumento). Codigo 0 com retorno, 1 com excecao.")
    opcoes_comuns(f)
    f.add_argument("--modulo", required=True, help="pacote.modulo a importar")
    f.add_argument("--funcao", required=True, help="nome da funcao")
    f.add_argument("--args", default="[]", help="JSON: lista, objeto ou valor (padrao: [])")
    f.add_argument("--pythonpath", action="append", metavar="PASTA", help="pasta no PYTHONPATH (padrao: a atual)")
    f.set_defaults(func=cmd_chamar)
    argv = list(sys.argv[1:] if argv is None else argv)
    comando = []
    if "--" in argv:
        i = argv.index("--")
        argv, comando = argv[:i], argv[i + 1:]
    args = ap.parse_args(argv)
    args.comando = comando
    if comando and args.subcomando != "cmd":
        print("erro: '-- <comando>' so vale no subcomando cmd", file=sys.stderr)
        return EXIT_USO
    try:
        return args.func(args)
    except ErroUso as e:
        print(f"erro: {e}", file=sys.stderr)
        return EXIT_USO
    except KeyboardInterrupt:
        return EXIT_USO


if __name__ == "__main__":
    sys.exit(main())

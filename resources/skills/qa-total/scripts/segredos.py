#!/usr/bin/env python3
"""segredos.py - procura segredos no repositorio e, opcionalmente, no historico (skill qa-total).

Varre os arquivos do projeto atras de credenciais versionadas: chaves de nuvem (AWS, GCP,
Azure), strings de conexao com senha, chaves privadas, tokens (JWT, Bearer, GitHub, Slack,
Stripe, SendGrid, Brevo, OpenAI...), token em query string de URL, chave de assinatura JWT em
appsettings, senhas em appsettings/.env/config, credencial em opcao de linha de comando (curl -u,
mysql -p, sqlcmd -P, redis-cli -a, --password), par nome/valor sensivel de HAR (cookie, cabecalho,
queryString) e, se pedido, textos de alta entropia. Chave
publica de cliente (Firebase, anon do Supabase, pk_ do Stripe, DSN do Sentry, pk. do Mapbox) sai
separada, como baixo, com a recomendacao certa.

Garantias:
  - NUNCA imprime o segredo inteiro. A saida mostra arquivo:linha:coluna, a regra, o valor
    mascarado (no maximo o prefixo publico do formato, ex. "AKIA") e uma impressao digital
    (sha256 truncado) para comparar achados sem expor o valor.
  - Somente leitura: nao altera arquivo nenhum, nao faz rede, nao testa a credencial.
  - Em repositorio git, respeita o .gitignore (usa git ls-files). --tudo varre o disco.

Python 3.9+, so biblioteca padrao. Windows, macOS e Linux.
"""
from __future__ import annotations

import argparse
import fnmatch
import hashlib
import json
import math
import os
import re
import subprocess
import sys
from pathlib import Path

EXIT_OK, EXIT_ACHOU, EXIT_USO = 0, 1, 2

SEVERIDADES = ["critico", "alto", "medio", "baixo"]
PESO = {s: i for i, s in enumerate(SEVERIDADES)}

DIRS_PESADOS = {
    ".git", "node_modules", ".next", ".nuxt", ".svelte-kit", "dist", "build", "out", "bin", "obj",
    ".venv", "venv", "env", "__pycache__", ".mypy_cache", ".pytest_cache", "target", "vendor",
    "coverage", ".gradle", ".idea", ".vs", ".terraform", ".turbo", ".cache", ".parcel-cache",
}

ARQUIVOS_SEM_ENTROPIA = (
    "package-lock.json", "yarn.lock", "pnpm-lock.yaml", "poetry.lock", "Pipfile.lock",
    "composer.lock", "Gemfile.lock", "Cargo.lock", "go.sum", "packages.lock.json",
    "*.min.js", "*.min.css", "*.map", "*.svg", "*.snap",
)

ARQUIVOS_SENSIVEIS = [
    (".env", "medio"), (".env.local", "medio"), (".env.production", "alto"),
    (".env.prod", "alto"), (".env.development", "medio"), (".env.staging", "medio"),
    ("*.pem", "alto"), ("*.key", "alto"), ("*.pfx", "alto"), ("*.p12", "alto"),
    ("*.jks", "alto"), ("*.keystore", "alto"), ("id_rsa", "critico"), ("id_dsa", "critico"),
    ("id_ecdsa", "critico"), ("id_ed25519", "critico"), (".htpasswd", "alto"),
    ("credentials.json", "alto"), ("service-account*.json", "alto"), (".npmrc", "baixo"),
    (".pypirc", "medio"), ("*.ovpn", "medio"), ("secrets.yml", "medio"), ("secrets.yaml", "medio"),
    ("*.tfstate", "alto"), ("*.kdbx", "alto"),
]
EXEMPLOS_DE_ENV = (".env.example", ".env.sample", ".env.template", ".env.dist", ".env.defaults")

MARCAS_IGNORAR = ("segredos:ignorar", "gitleaks:allow", "pragma: allowlist secret", "nosec")

PALAVRAS_PLACEHOLDER = {
    "password", "senha", "secret", "segredo", "token", "changeme", "changeit", "mudar", "trocar",
    "your_password", "yourpassword", "sua_senha", "suasenha", "minhasenha", "null", "none", "nil",
    "undefined", "true", "false", "redacted", "placeholder", "example", "exemplo", "sample", "todo",
    "string", "value", "valor", "xxx",
}


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


RE_REFERENCIA = re.compile(
    r"^(?:\$\{?\(?[A-Za-z_][A-Za-z0-9_.:\-]*\)?\}?|%[A-Za-z_][\w.\-]*%|\{\{?[^{}]*\}\}?|<[^<>]*>|#\{[^}]*\}"
    r"|\[[A-Z_]+\]|@Microsoft\.KeyVault\(.*\)|env:[\w.\-]+)$")


def eh_placeholder(valor: str) -> bool:
    v = (valor or "").strip().strip("'\"`")
    if not v:
        return True
    if RE_REFERENCIA.match(v):
        return True
    if re.fullmatch(r"[*xX.\-_=?]+", v):
        return True
    baixo = v.lower()
    if baixo in PALAVRAS_PLACEHOLDER:
        return True
    if re.search(r"(example|exemplo|placeholder|your[_-]|sua[_-]|seu[_-]|change[_-]?me|\$\{|\{\{)", baixo):
        return True
    return False


def entropia(texto: str) -> float:
    if not texto:
        return 0.0
    contagem = {}
    for ch in texto:
        contagem[ch] = contagem.get(ch, 0) + 1
    n = len(texto)
    return -sum((c / n) * math.log2(c / n) for c in contagem.values())


RE_CODIGO = re.compile(r"^(?:[A-Za-z_][\w]*\s*\(|[A-Za-z_]\w*(?:\.[A-Za-z_]\w*)+\(?\)?;?$|this\.|self\.)")
RE_MARCA_CONEXAO = re.compile(
    r"(?i)(?:server|data source|host|database|initial catalog|user id|userid|uid|username|user|addr|address|"
    r"port|sslmode|trusted_connection|encrypt)\s*=")


def parece_senha_real(valor: str, linha: str = "") -> bool:
    v = valor.strip().strip("'\"`")
    if eh_placeholder(v) or len(v) < 6:
        return False
    if " " in v or RE_CODIGO.match(v):
        return False
    if re.fullmatch(r"[a-z]+(?:[._-][a-z]+)+", v):
        return False
    if re.fullmatch(r"(?:https?:)?//\S+", v) or v.startswith("/"):
        return False
    if re.fullmatch(r"[A-Za-z_][\w.]*", v) and not re.search(r"\d", v):
        return False
    classes = sum(bool(re.search(p, v)) for p in (r"[a-z]", r"[A-Z]", r"\d", r"[^A-Za-z0-9]"))
    return classes >= 2 or len(v) >= 12


def _nao_placeholder(valor: str, linha: str = "") -> bool:
    return not eh_placeholder(valor) and not RE_CODIGO.match(valor.strip())


def _filtro_conexao(valor: str, linha: str = "") -> bool:
    return _nao_placeholder(valor, linha) and bool(RE_MARCA_CONEXAO.search(linha))


def _filtro_basic(valor: str, linha: str = "") -> bool:
    import base64
    import binascii
    v = valor.strip()
    if eh_placeholder(v):
        return False
    try:
        texto = base64.b64decode(v + "=" * (-len(v) % 4), validate=True).decode("utf-8")
    except (binascii.Error, ValueError, UnicodeDecodeError):
        return False
    usuario, separador, senha = texto.partition(":")
    if not separador or not senha or eh_placeholder(texto) or eh_placeholder(senha):
        return False
    return all(32 <= ord(c) < 127 for c in texto)


def _filtro_cookie(valor: str, linha: str = "") -> bool:
    v = valor.strip()
    if eh_placeholder(v) or RE_CODIGO.match(v):
        return False
    return len(v) >= 16 or (bool(re.search(r"\d", v)) and bool(re.search(r"[A-Za-z]", v)))


def _filtro_par(valor: str, linha: str = "") -> bool:
    v = valor.strip()
    if not v or eh_placeholder(v) or RE_CODIGO.match(v) or re.search(r"\s", v):
        return False
    return bool(re.search(r"\d", v) or re.search(r"[^A-Za-z]", v) or re.search(r"[a-z][A-Z]", v) or len(v) >= 12)


def _filtro_cli(valor: str, linha: str = "") -> bool:
    v = valor.strip().strip("'\"").rstrip(".,;:)]}")
    return len(v) >= 3 and bool(re.search(r"[A-Za-z0-9]", v)) and not eh_placeholder(v) and not RE_CODIGO.match(v)


def _filtro_cli_generico(valor: str, linha: str = "") -> bool:
    v = valor.strip().strip("'\"")
    if not _filtro_cli(v, linha):
        return False
    return parece_senha_real(v, linha) or (len(v) >= 4 and bool(re.search(r"[\d\W_]", v)))


ATRIBUTOS_SET_COOKIE ={"path", "domain", "expires", "samesite", "max-age", "secure", "httponly", "priority",
                        "partitioned", "version", "comment"}
RE_NOME_COOKIE_SECRETO = re.compile(r"(?i)(sess|sid|auth|token|identity|login|remember|jwt|^\.aspnetcore\.|_session$)")
RE_PAR_COOKIE = re.compile(r"(?:^|;|(?i:cookie)\s*:)\s*['\"]?([^=;\s,\"']+)\s*=\s*\"?([^;\s\",'<>\\]*)")


def pares_secretos_cookie(cabecalho: str) -> list:
    """Spans (ini, fim) dos VALORES secretos de um cabecalho Cookie/Set-Cookie, em todos os pares 'nome=valor':
    valor com 16+ caracteres ou nome de sessao/autenticacao. Atributo do Set-Cookie (Path, Domain, Expires,
    SameSite, Max-Age, Secure, HttpOnly...), par curto e neutro (lang=pt-BR) e placeholder ficam de fora."""
    spans = []
    for m in RE_PAR_COOKIE.finditer(cabecalho or ""):
        nome, valor = m.group(1), m.group(2)
        if not valor or nome.lower() in ATRIBUTOS_SET_COOKIE:
            continue
        if eh_placeholder(valor) or RE_CODIGO.match(valor):
            continue
        if len(valor) >= 16 or RE_NOME_COOKIE_SECRETO.search(nome):
            spans.append(m.span(2))
    return spans


def _so_env(nome: str) -> bool:
    return nome.startswith(".env") or nome.endswith(".env")


def _so_yaml_toml_env(nome: str) -> bool:
    return _so_env(nome) or nome.endswith((".yml", ".yaml", ".toml"))


def _so_ini_properties(nome: str) -> bool:
    return nome.endswith((".properties", ".ini", ".conf", ".cfg", ".config", ".tfvars"))


def _so_config_sem_aspas(nome: str) -> bool:
    return _so_yaml_toml_env(nome) or _so_ini_properties(nome)


def _sem_comentario_inline(valor: str, separadores: str = "#") -> str:
    return re.split(r"\s[" + separadores + "]", valor or "", maxsplit=1)[0].rstrip()


def _senha_sem_comentario(valor: str, linha: str = "") -> bool:
    return parece_senha_real(_sem_comentario_inline(valor), linha)


def _senha_ini(valor: str, linha: str = "") -> bool:
    v = (valor or "").rstrip()
    return parece_senha_real(v, linha) or parece_senha_real(_sem_comentario_inline(v, "#;"), linha)


def _env_sem_comentario(valor: str, linha: str = "") -> bool:
    v = _sem_comentario_inline(valor)
    return len(v) >= 4 and _nao_placeholder(v, linha)


def regra(rid, descricao, padrao, severidade, grupo=0, visivel=0, filtro=None, flags=0, aplica=None,
          multilinha=False, refinar=None):
    return {"id": rid, "descricao": descricao, "re": re.compile(padrao, flags), "severidade": severidade,
            "grupo": grupo, "visivel": visivel, "filtro": filtro, "aplica": aplica, "multilinha": multilinha,
            "refinar": refinar}


ID_PUBLICA = "chave-publica-cliente"
ID_CLI = "credencial-linha-de-comando"
DESCRICAO_CLI = ("credencial em opcao de linha de comando (curl -u, mysql -p, sqlcmd -P, redis-cli -a, docker login -p, "
                 "--password)")
DESCRICAO_COOKIE_CABECALHO ="cookie de sessao em cabecalho Cookie/Set-Cookie"
VALOR_ATE_COMENTARIO = r"(?:(?!\s+#|\s*$)[^\r\n])"
VALOR_ATE_FIM = r"(?:(?!\s*$)[^\r\n])"
CHAVES_SEM_ASPAS = (r"(?im)^\s*([\w.\-]*(?:password|passwd|pwd|secret|senha|api[_\-]?key|apikey|access[_\-]?key|"
                    r"auth[_\-]?token|client[_\-]?secret|(?:signing|jwt|encryption|hmac)[_\-]?key|token))\s*[:=]\s*")
RECOMENDACAO_PUBLICA = ("publica por desenho: confira restricao de referrer/app/API no console e as regras ou RLS "
                        "(DM-TEN)")
CHAVES_SENHA = (r"password|passwd|pwd|secret|senha|api[_\-]?key|apikey|access[_\-]?key|auth[_\-]?token|"
                r"client[_\-]?secret|private[_\-]?key|secret[_\-]?key|(?:signing|jwt|encryption|hmac)[_\-]?key|"
                r"chave[_\-]?api|token")

REGRAS = [
    regra("chave-privada", "chave privada (PEM/OpenSSH/PGP)",
          r"-----BEGIN (?:RSA |EC |DSA |OPENSSH |PGP |ENCRYPTED )?PRIVATE KEY(?: BLOCK)?-----", "critico"),
    regra("aws-access-key", "AWS access key id",
          r"\b((?:AKIA|ASIA|AGPA|AIDA|AROA|AIPA|ANPA|ANVA)[A-Z0-9]{16})\b", "critico", 1, 4),
    regra("aws-secret-key", "AWS secret access key",
          r"(?i)aws.{0,24}?(?:secret|private).{0,24}?[:=]\s*['\"]?([A-Za-z0-9/+=]{40})(?![A-Za-z0-9/+=])",
          "critico", 1),
    regra("gcp-service-account", "conta de servico do Google (JSON com private_key)",
          r"\"type\"\s*:\s*\"service_account\"", "alto"),
    regra("google-api-key", "chave de API do Google",
          r"\b(AIza[0-9A-Za-z\-_]{35})(?![0-9A-Za-z\-_])", "alto", 1, 4),
    regra("azure-storage", "string de conexao do Azure Storage com AccountKey",
          r"(?i)AccountKey\s*=\s*([A-Za-z0-9+/=]{30,})", "critico", 1),
    regra("azure-sas", "token SAS do Azure (sig=)",
          r"(?i)[?&]sig=([A-Za-z0-9%+/=]{30,})", "alto", 1),
    regra("azure-servicebus", "chave de acesso compartilhado (Service Bus/Event Hub/Cosmos)",
          r"(?i)(?:SharedAccessKey|AccountEndpoint=[^;]+;AccountKey)\s*=\s*([A-Za-z0-9+/=]{30,})", "critico", 1),
    regra("string-conexao-senha", "string de conexao com senha (Password=/Pwd=)",
          r"(?i)(?<![\w-])(?:password|pwd)\s*=\s*(?!['\"]?\s*[;'\"])([^;'\"\s<>]{1,200})", "alto", 1,
          filtro=_filtro_conexao),
    regra("url-com-credencial", "URL com usuario:senha embutidos",
          r"\b[a-z][a-z0-9+.\-]{1,20}://[^/\s:@'\"]{0,64}:([^/\s@'\"]{1,200})@[\w.\-]+", "alto", 1,
          filtro=_nao_placeholder, flags=re.I),
    regra(ID_CLI, DESCRICAO_CLI,
          r"(?i)\b(?:curl|wget|https?|xhs?|httpie)\b[^\n]*?\s(?:(?-i:-u|-U|-a)|--user|--http-user|--proxy-user|--auth)"
          r"(?:[\s=]+|(?=[^\s=-]))['\"]?[^\s:'\"]*:([^\s'\"]+)", "alto", 1, filtro=_filtro_cli),
    regra(ID_CLI, DESCRICAO_CLI,
          r"(?i)\b(?:mysql|mysqldump|mysqladmin|mysqlimport|mysqlshow|mariadb|mariadb-dump)\b[^\n]*?"
          r"\s(?:(?-i:-p)|--password=)['\"]?([^\s'\"]+)", "alto", 1, filtro=_filtro_cli),
    regra(ID_CLI, DESCRICAO_CLI,
          r"(?i)\b(?:sqlcmd|bcp|osql|isql)\b[^\n]*?\s(?-i:-P)\s*['\"]?([^\s'\"]+)", "alto", 1, filtro=_filtro_cli),
    regra(ID_CLI, DESCRICAO_CLI,
          r"(?i)\bredis-cli\b[^\n]*?\s(?:(?-i:-a)|--pass)\s+['\"]?([^\s'\"]+)", "alto", 1, filtro=_filtro_cli),
    regra(ID_CLI, DESCRICAO_CLI,
          r"(?i)\b(?:mongo|mongosh|mongodump|mongorestore|mongoexport|mongoimport|sshpass)\b[^\n]*?\s(?-i:-p)\s+"
          r"['\"]?([^\s'\"]+)", "alto", 1, filtro=_filtro_cli),
    regra(ID_CLI, DESCRICAO_CLI,
          r"(?i)\b(?:docker|podman|nerdctl|buildah|skopeo|oras)\b[^\n]*?\blogin\b[^\n]*?\s(?-i:-p)\s+"
          r"['\"]?([^\s'\"]+)", "alto", 1, filtro=_filtro_cli),
    regra(ID_CLI, DESCRICAO_CLI,
          r"(?i)(?<![\w-])--(?:http-|proxy-|ftp-|db-)?(?:password|passwd|pass)(?:=|\s+)['\"]?([^\s'\"]+)", "alto", 1,
          filtro=_filtro_cli_generico),
    regra("par-nome-valor", "campo sensivel em par nome/valor (HAR, lista de cabecalhos, cookies, queryString)",
          r"(?i)\"(?:name|key)\"\s*:\s*\"(?!:?authority\"|authors?\"|autor\")"
          r"(?:[^\"\\\r\n]{0,60}?(?:sess|sid|csrf|xsrf|auth|token|jwt|secret|segredo|senha|passw|pwd|api[_\-]?key|"
          r"apikey|credenc|credential)[^\"\\\r\n]{0,60}|\.aspnetcore\.[^\"\\\r\n]{1,80}|pass|pin)\""
          r"[^{}\[\]]*?\"value\"\s*:\s*\"(?:(?:bearer|basic|digest|token|negotiate)\s+)?([^\"\\\r\n]{4,})\"",
          "alto", 1, filtro=_filtro_par, multilinha=True),
    regra("jwt", "token JWT",
          r"\b(eyJ[A-Za-z0-9_\-]{10,}\.eyJ[A-Za-z0-9_\-]{10,}\.[A-Za-z0-9_\-]{10,})", "alto", 1, 3),
    regra("bearer", "token Bearer literal",
          r"(?i)\bbearer\s+([A-Za-z0-9\-._~+/]{20,}=*)", "alto", 1, filtro=_nao_placeholder),
    regra("basic-auth", "credencial Basic (usuario:senha em base64)",
          r"(?i)\bbasic\s+([A-Za-z0-9+/]{8,}={0,2})(?![A-Za-z0-9+/=])", "alto", 1, filtro=_filtro_basic),
    regra("cookie-sessao", "cookie ou id de sessao",
          r"(?i)(?<![\w.-])(?:connect\.sid|sessionid|session_id|session-id|jsessionid|phpsessid|asp\.net_sessionid|"
          r"laravel_session|_session_id|sid|ssid|auth_token|remember_token)=([^;\s'\"&<>]{8,})", "alto", 1,
          filtro=_filtro_cookie),
    regra("cookie-sessao", DESCRICAO_COOKIE_CABECALHO,
          r"(?i)(?<![\w-])(?:cookie|set-cookie)\s*:\s*([^\r\n]+)", "alto", 1, refinar=pares_secretos_cookie),
    regra("github-token", "token do GitHub",
          r"\b((?:gh[pousr]_[A-Za-z0-9]{36,})|(?:github_pat_[A-Za-z0-9_]{22,}))", "critico", 1, 4),
    regra("gitlab-token", "token do GitLab", r"\b(glpat-[A-Za-z0-9\-_]{20,})", "critico", 1, 6),
    regra("slack-token", "token do Slack", r"\b(xox[abposr]-[A-Za-z0-9\-]{10,})", "alto", 1, 4),
    regra("slack-webhook", "webhook do Slack",
          r"(https://hooks\.slack\.com/services/T[A-Z0-9]+/B[A-Z0-9]+/[A-Za-z0-9]+)", "alto", 1, 30),
    regra("stripe-secret", "chave secreta do Stripe", r"\b((?:sk|rk)_(?:live|test)_[A-Za-z0-9]{16,})", "critico", 1, 8),
    regra("sendgrid", "chave do SendGrid", r"\b(SG\.[A-Za-z0-9_\-]{22}\.[A-Za-z0-9_\-]{43})", "alto", 1, 3),
    regra("brevo", "chave do Brevo/Sendinblue", r"\b(x(?:key|smtp)sib-[a-f0-9]{64}-[A-Za-z0-9]{16})", "alto", 1, 8),
    regra("mailgun", "chave do Mailgun", r"\b(key-[0-9a-zA-Z]{32})\b", "alto", 1, 4),
    regra("twilio", "chave do Twilio", r"\b(SK[0-9a-fA-F]{32})\b", "alto", 1, 2),
    regra("anthropic", "chave da Anthropic", r"\b(sk-ant-[A-Za-z0-9_\-]{20,})", "critico", 1, 7),
    regra("openai", "chave da OpenAI", r"\b(sk-(?:proj-|svcacct-)?[A-Za-z0-9_\-]{32,})", "critico", 1, 3),
    regra("npm-token", "token do npm", r"\b(npm_[A-Za-z0-9]{36})\b", "alto", 1, 4),
    regra("npmrc-auth", "token em .npmrc (_authToken)", r"_authToken\s*=\s*([^\s]{8,})", "alto", 1,
          filtro=_nao_placeholder),
    regra("pypi-token", "token do PyPI", r"\b(pypi-AgEIcHlwaS5vcmc[A-Za-z0-9_\-]{50,})", "alto", 1, 5),
    regra("telegram-bot", "token de bot do Telegram", r"\b(\d{8,10}:AA[A-Za-z0-9_\-]{33})\b", "alto", 1),
    regra("discord-webhook", "webhook do Discord",
          r"(https://(?:ptb\.|canary\.)?discord(?:app)?\.com/api/webhooks/\d+/[A-Za-z0-9_\-]{30,})", "alto", 1, 34),
    regra("mapbox-secreto", "token secreto do Mapbox (sk.)",
          r"\b(sk\.eyJ[A-Za-z0-9_\-]{10,}\.[A-Za-z0-9_\-]{10,})", "alto", 1, 3),
    regra(ID_PUBLICA, "chave publicavel do Stripe (pk_)",
          r"\b(pk_(?:live|test)_[A-Za-z0-9]{16,})", "baixo", 1, 8),
    regra(ID_PUBLICA, "token publico do Mapbox (pk.)",
          r"\b(pk\.eyJ[A-Za-z0-9_\-]{10,}\.[A-Za-z0-9_\-]{10,})", "baixo", 1, 3),
    regra(ID_PUBLICA, "DSN publico do Sentry",
          r"(https?://[0-9a-f]{32}@[\w.\-]*sentry\.io/\d+)", "baixo", 1, 8),
    regra("token-em-url", "token ou chave em query string de URL",
          r"(?i)[?&](?:token|access_token|api_?key|apikey|key|sig|signature|auth)=([A-Za-z0-9\-_.%]{16,})", "alto", 1,
          filtro=_nao_placeholder),
    regra("jwt-key", "chave de assinatura JWT em configuracao (Jwt/Token: Key/SecretKey/SigningKey)",
          r"(?i)\"(?:Jwt|JwtSettings|Token)\"\s*:\s*\{[^}]*?\"(?:Key|SecretKey|SigningKey)\"\s*:\s*\"([^\"\r\n]{16,})\"",
          "alto", 1, filtro=_nao_placeholder, multilinha=True),
    regra("senha-em-config", "senha/segredo atribuido em arquivo de configuracao ou codigo",
          r"(?i)[\"']?\b([A-Za-z0-9_.\-]*(?:" + CHAVES_SENHA + r"))\b[\"']?"
          r"\s*[:=]\s*[\"']([^\"'\r\n]{6,300})[\"']",
          "medio", 2, filtro=parece_senha_real),
    regra("senha-em-env", "segredo em arquivo .env",
          r"(?im)^\s*(?:export\s+)?([A-Z0-9_]*(?:PASS|PASSWORD|PWD|SECRET|TOKEN|API_KEY|APIKEY|PRIVATE_KEY|"
          r"ACCESS_KEY|CLIENT_SECRET|SENHA)[A-Z0-9_]*)\s*=\s*['\"]?((?:(?!\s+#|\s*$)[^'\"\r\n]){4,300})", "medio", 2,
          filtro=_env_sem_comentario, aplica=_so_env),
    regra("senha-em-config-sem-aspas", "segredo sem aspas em YAML/TOML/.env (comentario so com espaco antes do #)",
          CHAVES_SEM_ASPAS + r"([^\s'\"#{\[|>&*]" + VALOR_ATE_COMENTARIO + r"{2,299})", "medio", 2,
          filtro=_senha_sem_comentario, aplica=_so_yaml_toml_env),
    regra("senha-em-config-sem-aspas", "segredo sem aspas em INI/properties/cfg/conf (o # no meio e da senha)",
          CHAVES_SEM_ASPAS + r"([^\s'\"{\[|>&*]" + VALOR_ATE_FIM + r"{2,299})", "medio", 2,
          filtro=_senha_ini, aplica=_so_ini_properties),
]
REGRA_ENTROPIA = {"id": "alta-entropia", "descricao": "texto de alta entropia entre aspas (possivel segredo)",
                  "severidade": "baixo", "visivel": 0}
RE_ENTROPIA = re.compile(r"[\"'`]([A-Za-z0-9+/=_\-]{20,200})[\"'`]")
RE_UUID = re.compile(r"^[0-9a-fA-F]{8}-?[0-9a-fA-F]{4}-?[0-9a-fA-F]{4}-?[0-9a-fA-F]{4}-?[0-9a-fA-F]{12}$")


def mascarar(valor: str, visivel: int) -> str:
    n = len(valor)
    if visivel and n > visivel + 6:
        return f"{valor[:visivel]}...({n} caracteres)"
    return f"****({n} caracteres)"


def impressao(regra_id: str, valor: str) -> str:
    return hashlib.sha256(f"{regra_id}\0{valor}".encode("utf-8", "replace")).hexdigest()[:12]


def casa_glob(caminho: str, padroes) -> bool:
    nome = caminho.rsplit("/", 1)[-1]
    for p in padroes:
        if fnmatch.fnmatch(caminho, p) or fnmatch.fnmatch(nome, p):
            return True
    return False


def decodificar(dados: bytes):
    if dados.startswith(b"\xff\xfe") or dados.startswith(b"\xfe\xff"):
        try:
            return dados.decode("utf-16")
        except UnicodeDecodeError:
            return None
    if dados.startswith(b"\xef\xbb\xbf"):
        dados = dados[3:]
    if b"\x00" in dados[:8192]:
        return None
    return dados.decode("utf-8", errors="replace")


def git(raiz: Path, *args, binario=False):
    try:
        r = subprocess.run(["git", "-C", str(raiz), *args], capture_output=True, check=False)
    except FileNotFoundError:
        return None
    if r.returncode != 0:
        return None
    return r.stdout if binario else r.stdout.decode("utf-8", "replace")


def listar_arquivos(raiz: Path, tudo: bool, so_rastreados: bool, excluir):
    avisos = []
    if not tudo:
        rastreados = git(raiz, "ls-files", "-z", binario=True)
        if rastreados is not None:
            nomes = [n for n in rastreados.decode("utf-8", "replace").split("\0") if n]
            modo = "git ls-files (rastreados)"
            if not so_rastreados:
                outros = git(raiz, "ls-files", "--others", "--exclude-standard", "-z", binario=True) or b""
                novos = [n for n in outros.decode("utf-8", "replace").split("\0") if n]
                nomes += novos
                modo = "git ls-files (rastreados + novos nao ignorados)"
            nomes = [n for n in nomes if not casa_glob(n, excluir)]
            return sorted(set(nomes)), modo, avisos
        avisos.append("nao e repositorio git (ou git ausente): varrendo o disco sem .gitignore")
    nomes = []
    for pasta, dirs, arquivos in os.walk(raiz):
        dirs[:] = [d for d in dirs if d not in DIRS_PESADOS]
        for a in arquivos:
            rel = os.path.relpath(os.path.join(pasta, a), raiz).replace(os.sep, "/")
            if not casa_glob(rel, excluir):
                nomes.append(rel)
    return sorted(nomes), "disco (--tudo, pastas pesadas excluidas)", avisos


def carregar_ignorados(caminho):
    impressoes, globs = set(), []
    if not caminho:
        return impressoes, globs
    p = Path(caminho)
    if not p.exists():
        raise SystemExit(f"erro: arquivo de ignorados nao encontrado: {p}")
    for linha in p.read_text(encoding="utf-8-sig").splitlines():
        linha = linha.split("#", 1)[0].strip()
        if not linha:
            continue
        if re.fullmatch(r"[0-9a-f]{12}", linha):
            impressoes.add(linha)
        else:
            globs.append(linha[5:] if linha.startswith("glob:") else linha)
    return impressoes, globs


def _sobrepoe(ini, fim, ocupados) -> bool:
    return any(not (fim <= a or ini >= b) for a, b, _ in ocupados)


def _entropia_suspeita(valor: str) -> bool:
    if RE_UUID.match(valor) or eh_placeholder(valor):
        return False
    eh_hex = re.fullmatch(r"[0-9a-fA-F]+", valor) is not None
    if eh_hex and len(valor) < 32:
        return False
    if not re.search(r"\d", valor) or not re.search(r"[A-Za-z]", valor):
        return False
    return entropia(valor) >= (3.5 if eh_hex else 4.3)


ARQUIVOS_GOOGLE_CLIENTE = ("google-services.json", "GoogleService-Info.plist")
RE_FIREBASE = re.compile(r"firebaseConfig|authDomain|messagingSenderId|firebaseapp\.com|initializeApp\s*\(")


def _payload_jwt(token: str) -> dict:
    import base64
    partes = token.split(".")
    if len(partes) < 2:
        return {}
    corpo = partes[1] + "=" * (-len(partes[1]) % 4)
    try:
        dados = json.loads(base64.urlsafe_b64decode(corpo.encode("ascii")).decode("utf-8", "replace"))
    except (ValueError, UnicodeError):
        return {}
    return dados if isinstance(dados, dict) else {}


def _como_publica(rg: dict, descricao: str) -> dict:
    return {"id": ID_PUBLICA, "descricao": descricao, "severidade": "baixo", "visivel": rg.get("visivel", 0)}


def _classificar(rg: dict, valor: str, num: int, nome: str, linhas_firebase) -> dict:
    if rg["id"] == "google-api-key":
        perto = any(abs((num - 1) - i) <= 15 for i in linhas_firebase)
        if nome in ARQUIVOS_GOOGLE_CLIENTE or perto:
            return _como_publica(rg, "chave de API do Google em configuracao de cliente (Firebase/google-services)")
    elif rg["id"] == "jwt":
        papel = str(_payload_jwt(valor).get("role") or "")
        if papel == "anon":
            return _como_publica(rg, "token JWT com role anon (chave anonima de cliente, ex. Supabase)")
        if papel == "service_role":
            return dict(rg, descricao="token JWT com role service_role (acesso total, ignora regras/RLS)")
    return rg


def varrer_texto(texto: str, arquivo: str, usar_entropia: bool):
    achados = []
    nome = arquivo.rsplit("/", 1)[-1]
    aplicaveis = [rg for rg in REGRAS if rg["aplica"] is None or rg["aplica"](nome)]
    regras = [rg for rg in aplicaveis if not rg.get("multilinha")]
    linhas = [ln[:-1] if ln.endswith("\r") else ln for ln in texto.split("\n")]
    linhas_firebase = [i for i, ln in enumerate(linhas) if RE_FIREBASE.search(ln)]
    pre_ocupados: dict = {}
    for rg in [r for r in aplicaveis if r.get("multilinha")]:
        for m in rg["re"].finditer(texto):
            g = rg["grupo"] if rg["grupo"] <= (m.re.groups or 0) else 0
            valor = m.group(g)
            if not valor or "\n" in valor:
                continue
            ini = m.start(g)
            num = texto.count("\n", 0, ini) + 1
            col0 = ini - (texto.rfind("\n", 0, ini) + 1)
            linha = linhas[num - 1] if num - 1 < len(linhas) else ""
            if any(mk in linha for mk in MARCAS_IGNORAR):
                continue
            if rg["filtro"] and not rg["filtro"](valor, linha):
                continue
            pre_ocupados.setdefault(num, []).append((col0, col0 + len(valor), (rg, valor)))
    for num, linha in enumerate(linhas, 1):
        if len(linha) > 5000:
            linha = linha[:5000]
        if any(m in linha for m in MARCAS_IGNORAR):
            continue
        ocupados = list(pre_ocupados.get(num, []))
        for rg in regras:
            for m in rg["re"].finditer(linha):
                g = rg["grupo"] if rg["grupo"] <= (m.re.groups or 0) else 0
                valor = m.group(g)
                if not valor:
                    continue
                ini, fim = m.span(g)
                if rg.get("refinar"):
                    livres = [(ini + a, ini + b) for a, b in rg["refinar"](valor)
                              if not _sobrepoe(ini + a, ini + b, ocupados)]
                    if not livres:
                        continue
                    ini, fim = livres[0]
                    valor = linha[ini:fim]
                if _sobrepoe(ini, fim, ocupados):
                    continue
                if rg["filtro"] and not rg["filtro"](valor, linha):
                    continue
                ocupados.append((ini, fim, (rg, valor)))
        if usar_entropia:
            for m in RE_ENTROPIA.finditer(linha):
                ini, fim = m.span(1)
                if not _sobrepoe(ini, fim, ocupados) and _entropia_suspeita(m.group(1)):
                    ocupados.append((ini, fim, (REGRA_ENTROPIA, m.group(1))))
        for ini, fim, (rg, valor) in ocupados:
            rg_final = _classificar(rg, valor, num, nome, linhas_firebase)
            achados.append(_achado(rg_final, arquivo, num, ini, valor, linha, ocupados))
    return achados


def _contexto(linha: str, ini: int, mascara: str, ocupados) -> str:
    janela_ini = max(0, ini - 40)
    pedacos, pos = [], janela_ini
    for a, b, _ in sorted(ocupados, key=lambda o: o[0]):
        if b <= janela_ini or a >= ini:
            continue
        pedacos.append(linha[pos:max(pos, a)])
        pedacos.append("****")
        pos = max(pos, b)
    pedacos.append(linha[pos:ini] if pos < ini else "")
    antes = "".join(pedacos).strip()
    return (("..." if janela_ini > 0 else "") + antes + " " + mascara).strip()


def _achado(rg, arquivo, num, coluna0, valor, linha, ocupados):
    mascara = mascarar(valor, rg.get("visivel", 0))
    achado = {
        "regra": rg["id"], "descricao": rg["descricao"], "severidade": rg["severidade"],
        "arquivo": arquivo, "linha": num, "coluna": coluna0 + 1,
        "valor_mascarado": mascara,
        "impressao": impressao(rg["id"], valor),
        "contexto": _contexto(linha, coluna0, mascara, ocupados),
    }
    if rg["id"] == ID_PUBLICA:
        achado["recomendacao"] = RECOMENDACAO_PUBLICA
    return achado


def arquivo_sensivel(rel: str):
    nome = rel.rsplit("/", 1)[-1]
    if nome in EXEMPLOS_DE_ENV or nome.endswith((".example", ".sample", ".template")):
        return None
    for padrao, sev in ARQUIVOS_SENSIVEIS:
        if fnmatch.fnmatch(nome, padrao):
            return sev
    return None


def rastreados(raiz: Path):
    saida = git(raiz, "ls-files", "-z", binario=True)
    if saida is None:
        return None
    return {n for n in saida.decode("utf-8", "replace").split("\0") if n}


def varrer_repo(raiz: Path, nomes, args, ign_impressoes, ign_globs):
    achados, varridos, pulados = [], 0, []
    versionados = rastreados(raiz)
    for rel in nomes:
        if casa_glob(rel, ign_globs):
            continue
        caminho = raiz / rel
        try:
            if not caminho.is_file():
                continue
            tamanho = caminho.stat().st_size
        except OSError:
            continue
        versionado = None if versionados is None else rel in versionados
        sev = arquivo_sensivel(rel)
        if sev and versionado is not False:
            achados.append({"regra": "arquivo-sensivel", "descricao": "arquivo de credencial/configuracao sensivel versionado",
                            "severidade": sev, "arquivo": rel, "linha": 0, "coluna": 0,
                            "valor_mascarado": "(arquivo inteiro)", "impressao": impressao("arquivo-sensivel", rel),
                            "contexto": "confira se deveria estar fora do controle de versao", "versionado": versionado})
        if tamanho > args.max_bytes:
            pulados.append(f"{rel} ({tamanho} bytes > --max-bytes)")
            continue
        try:
            dados = caminho.read_bytes()
        except OSError as e:
            pulados.append(f"{rel} (erro de leitura: {e.__class__.__name__})")
            continue
        texto = decodificar(dados)
        if texto is None:
            continue
        varridos += 1
        usar_ent = args.entropia and not casa_glob(rel, ARQUIVOS_SEM_ENTROPIA)
        for a in varrer_texto(texto, rel, usar_ent):
            a["versionado"] = versionado
            achados.append(a)
    achados = [a for a in achados if a["impressao"] not in ign_impressoes]
    return achados, varridos, pulados


RE_HUNK = re.compile(r"^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@")


def varrer_historico(raiz: Path, args, ign_impressoes, ign_globs):
    print("aviso: --historico le o diff de todos os commits (git log -p --all); em repositorio grande leva "
          "minutos e muita CPU. Limite com --max-commits.", file=sys.stderr)
    cmd = ["git", "-C", str(raiz), "-c", "core.quotePath=false", "log", "-p", "--all", "--no-color",
           "--no-ext-diff", "--unified=0", "--format=@@QA-COMMIT@@ %H %ad", "--date=short"]
    if args.max_commits:
        cmd.insert(cmd.index("log") + 1, f"--max-count={args.max_commits}")
    try:
        proc = subprocess.Popen(cmd, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL)
    except FileNotFoundError:
        raise SystemExit("erro: git nao encontrado no PATH")
    vistos = {}
    commit, data, arquivo, linha_nova, commits = "", "", None, 0, 0
    for bruto in proc.stdout:
        texto = bruto.decode("utf-8", "replace").rstrip("\r\n")
        if texto.startswith("@@QA-COMMIT@@ "):
            partes = texto.split()
            commit, data = partes[1][:10], (partes[2] if len(partes) > 2 else "")
            arquivo = None
            commits += 1
            continue
        if texto.startswith("+++ "):
            alvo = texto[4:]
            arquivo = None if alvo == "/dev/null" else (alvo[2:] if alvo.startswith("b/") else alvo)
            if arquivo and (casa_glob(arquivo, ign_globs) or casa_glob(arquivo, args.excluir)):
                arquivo = None
            continue
        m = RE_HUNK.match(texto)
        if m:
            linha_nova = int(m.group(1))
            continue
        if arquivo and texto.startswith("+") and not texto.startswith("+++"):
            usar_ent = args.entropia and not casa_glob(arquivo, ARQUIVOS_SEM_ENTROPIA)
            for a in varrer_texto(texto[1:], arquivo, usar_ent):
                if a["impressao"] in ign_impressoes:
                    continue
                a["linha"] = linha_nova
                chave = (a["regra"], a["impressao"])
                if chave in vistos:
                    vistos[chave]["ocorrencias"] += 1
                    vistos[chave]["commit"], vistos[chave]["data"] = commit, data
                    vistos[chave]["arquivo"], vistos[chave]["linha"] = a["arquivo"], a["linha"]
                else:
                    a.update({"commit": commit, "data": data, "ocorrencias": 1})
                    vistos[chave] = a
            linha_nova += 1
    proc.wait()
    return list(vistos.values()), commits


def ordenar(achados):
    return sorted(achados, key=lambda a: (PESO.get(a["severidade"], 9), a["arquivo"], a["linha"]))


def resumo_por_severidade(achados):
    cont = {s: 0 for s in SEVERIDADES}
    for a in achados:
        cont[a["severidade"]] = cont.get(a["severidade"], 0) + 1
    return cont


def imprimir_texto(rel):
    achados = rel["achados"]
    hist = rel.get("historico")
    print(f"segredos.py - raiz: {rel['raiz']}")
    print(f"modo: {rel['modo']} | arquivos varridos: {rel['arquivos_varridos']}")
    for av in rel["avisos"]:
        print(f"aviso: {av}")
    if achados:
        print("")
        print(f"ACHADOS NO ESTADO ATUAL ({len(achados)}):")
        for a in achados:
            local = a["arquivo"] if not a["linha"] else f"{a['arquivo']}:{a['linha']}:{a['coluna']}"
            marca = "  [nao versionado]" if a.get("versionado") is False else ""
            print(f"  [{a['severidade'].upper()}] {a['regra']}  {local}  {a['valor_mascarado']}  id={a['impressao']}{marca}")
            print(f"      {a['descricao']}; contexto: {a['contexto'][:120]}")
            if a.get("recomendacao"):
                print(f"      recomendacao: {a['recomendacao']}")
    else:
        print("")
        print("nenhum segredo encontrado no estado atual (dentro das regras desta ferramenta).")
    if hist is not None:
        print("")
        print(f"HISTORICO: {hist['commits_lidos']} commits lidos, {len(hist['achados'])} segredos distintos")
        for a in hist["achados"]:
            if a.get("ainda_no_estado_atual"):
                situacao = "AINDA NO HEAD"
            elif a.get("no_working_tree_nao_versionado"):
                situacao = ("removido do HEAD; o mesmo valor esta no working tree (nao versionado): "
                            + a["no_working_tree_nao_versionado"])
            else:
                situacao = "so no historico"
            print(f"  [{a['severidade'].upper()}] {a['regra']}  {a['arquivo']}:{a['linha']}  {a['valor_mascarado']}  "
                  f"id={a['impressao']}  introduzido ate {a['commit']} ({a['data']}), {a['ocorrencias']}x, {situacao}")
    total = rel["total_por_severidade"]
    print("")
    print("total: " + " | ".join(f"{s} {total.get(s, 0)}" for s in SEVERIDADES))
    todos = list(achados) + list((hist or {}).get("achados") or [])
    secretos = [a for a in todos if a.get("regra") != ID_PUBLICA]
    if secretos:
        print("proximo passo: NAO copie nem teste o valor. Relate arquivo:linha + regra + id; recomende rotacionar a")
        print("credencial (segredo que entrou no git esta exposto, mesmo apagado depois) e move-la para cofre/variavel")
        print("de ambiente. Falso positivo comprovado: ponha o id em um arquivo e passe --ignorar ARQ.")
    if any(a.get("regra") == ID_PUBLICA for a in todos):
        print(f"chave publica de cliente: nao precisa rotacionar nem ir para cofre; {RECOMENDACAO_PUBLICA}.")


def casos_autoteste() -> list:
    import base64
    b64 = base64.b64encode
    return [
        ("Authorization: Basic " + b64(b"admin:" + b"s3nha-forte").decode(), "log.txt", "basic-auth"),
        ("Authorization: Basic authentication is required", "doc.md", None),
        ("Basic " + b64(b"abcdefgh").decode(), "log.txt", None),
        ("Cookie: connect.sid" + "=s%3Aa1B2c3D4e5F6g7H8.xYz", "log.txt", "cookie-sessao"),
        ("Set-Cookie: sessionid" + "=k9Lm2Np4Qr6St8; Path=/; HttpOnly", "log.txt", "cookie-sessao"),
        ("Cookie: tema=escuro; idioma=pt-BR", "log.txt", None),
        ("const sid" + "=getSid();", "app.js", None),
        ("sessionid" + "=${SESSAO}", "config.yml", None),
        ("AKIA" + "IOSFODNN7EXEMPLO", "x.txt", "aws-access-key"),
        ("senha = Pr4ia" + "#Verde2026", "settings.ini", "senha-em-config-sem-aspas"),
        ("token = x9" + "#Lm2Qw7Zt4Vb8", "settings.ini", "senha-em-config-sem-aspas"),
        ("erp.senha=Ab" + "#12cd34EF", "app.properties", "senha-em-config-sem-aspas"),
        ("password: Pr4ia" + "#Verde2026", "c.yml", "senha-em-config-sem-aspas"),
        ("password: Pr4ia" + "Verde2026 # comentario", "c.yml", "senha-em-config-sem-aspas"),
        ("SENHA=Ab" + "#12cd34EF", ".env", "senha-em-env"),
        ("password: ${DB_PASS} # vem do ambiente", "d.yml", None),
        ("SENHA=${DB_PASS} # vem do ambiente", ".env", None),
        ("curl -u usuario:$SENHA https://api.exemplo.test/v1", "README.md", None),
        ("mysql -h db -u root -p banco_teste", "README.md", None),
        ("docker run -p 8080:80 -u 1000 imagem", "README.md", None),
        ("git push -u origin main", "README.md", None),
        ('{"name": "lang", "value": "pt-BR"}', "x.har", None),
        ('{"name": ":authority", "value": "api.exemplo.test"}', "x.har", None),
        ('{"key": "auth.titulo", "value": "Entrar na conta"}', "pt.json", None),
    ] + [(texto, "log.txt", ID_CLI) for texto, _ in CASOS_CLI_AUTOTESTE] + [
        ('{"name": "sessionid", "value": "' + _valor_falso_cookie() + '"}', "x.har", "par-nome-valor"),
        ('{\n  "name": "csrftoken",\n  "value": "Zr7Tq1' + 'Wv5Ns3"\n}', "x.har", "par-nome-valor"),
    ] + [("Cookie: lang=pt-BR; " + nome + "=" + _valor_falso_cookie(), "log.txt", "cookie-sessao")
         for nome in NOMES_COOKIE_AUTOTESTE]


SENHA_CLI_FALSA = "Xy9" + "pQ2wz#7"
CASOS_CLI_AUTOTESTE = (
    ("curl -s -u admin:" + SENHA_CLI_FALSA + " https://api.exemplo.test/v1/login", "curl -u"),
    ("curl --user=ana:" + SENHA_CLI_FALSA + " https://api.exemplo.test", "curl --user"),
    ("http -a ana:" + SENHA_CLI_FALSA + " GET https://api.exemplo.test", "http -a"),
    ("mysql -h db.exemplo.test -u root -p" + SENHA_CLI_FALSA + " banco", "mysql -p"),
    ("sqlcmd -S srv -U sa -P " + SENHA_CLI_FALSA + " -Q \"select 1\"", "sqlcmd -P"),
    ("redis-cli -h cache.exemplo.test -a " + SENHA_CLI_FALSA + " ping", "redis-cli -a"),
    ("docker login -u ci -p " + SENHA_CLI_FALSA + " registro.exemplo.test", "docker login -p"),
    ("osql -S srv -U sa -P " + SENHA_CLI_FALSA + " -Q \"select 1\"", "osql -P"),
    ("xhs -a ana:" + SENHA_CLI_FALSA + " https://api.exemplo.test", "xhs -a"),
    ("wget --http-password=" + SENHA_CLI_FALSA + " https://arquivos.exemplo.test/a.zip", "--http-password"),
    ("ferramenta exportar --password " + SENHA_CLI_FALSA + " --saida x.csv", "--password"),
)


NOMES_COOKIE_AUTOTESTE = (".AspNetCore.Cookies", ".AspNetCore.Identity.Application", "_gitlab_session",
                          "AUTH_SESSION_ID", "__Host-session", "KEYCLOAK_IDENTITY", "wordpress_logged_in_abc")


def _valor_falso_cookie() -> str:
    return "Qx7Lm2Np4Rs6Tu8V" + "w0Yz1Ab3Cd5Ef9Gh"


def autoteste_mascara() -> list:
    falhas = []
    sys.path.insert(0, str(Path(__file__).resolve().parent))
    try:
        import _mascara
    except Exception as e:
        return [f"nao deu para importar _mascara.py ({e.__class__.__name__})"]
    falso = _valor_falso_cookie()
    for nome in NOMES_COOKIE_AUTOTESTE:
        for texto, intactos in (
                ("Cookie: lang=pt-BR; " + nome + "=" + falso, ("lang=pt-BR",)),
                ("Set-Cookie: " + nome + "=" + falso + "; Path=/; Secure; HttpOnly; SameSite=Lax",
                 ("Path=/", "SameSite=Lax", "HttpOnly"))):
            s, _ = _mascara.mascarar(texto, estrito=True)
            if falso in s or nome + "=" + _mascara.MARCA not in s:
                falhas.append(f"_mascara deixou o cookie {nome} em claro")
            if any(x not in s for x in intactos):
                falhas.append(f"_mascara apagou parte neutra do cabecalho ({', '.join(intactos)}) com o cookie {nome}")
        estrutura, _ = _mascara.mascarar_estrutura({"headers": {"cookie": "lang=pt-BR; " + nome + "=" + falso}})
        if falso in str(estrutura) or "lang=pt-BR" not in str(estrutura):
            falhas.append(f"_mascara.mascarar_estrutura deixou o cookie {nome} em claro na chave 'cookie'")
    jwt3 = "eyJ" + "hbGciOiJIUzI1NiJ9." + "eyJzdWIiOiIxMjM0NTY3ODkwIn0." + "dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U"
    jwe5 = ("eyJ" + "hbGciOiJkaXIiLCJlbmMiOiJBMjU2R0NNIn0.." + "48V1_ALb6US04U3b." +
            "5eym8TW_c8SuK0ltJ3rpYIzOeDQz7TALvtu6UG9oMo4vpzs9tX_EFShS8iB7j6jiSdiwkIr3ajwQzaBtQD_A." +
            "XFBoMYUZodetZdvTiFvSkQ")
    for rotulo, token in (("JWT de 3 partes", jwt3), ("JWE de 5 partes", jwe5)):
        if not _mascara.RE_JWT.fullmatch(token):
            falhas.append(f"_mascara.RE_JWT nao cobre o {rotulo} inteiro")
        s, _ = _mascara.mascarar("resposta: " + token + " fim", estrito=False)
        if s != "resposta: " + _mascara.MARCA + " fim":
            falhas.append(f"_mascara deixou parte do {rotulo} em claro")
    falhas += autoteste_har(_mascara)
    for texto, rotulo in CASOS_CLI_AUTOTESTE:
        s, _ = _mascara.mascarar(texto, estrito=True)
        if SENHA_CLI_FALSA in s or not _mascara.tipos_de_segredo(texto):
            falhas.append(f"_mascara deixou a credencial de linha de comando ({rotulo}) em claro")
    url = ("https://app.exemplo.test/retorno?code=" + "4f9Xk2Lm8Qp7" + "&state=" + "Zr7Tq1Wv5Ns3" + "&lang=pt-BR")
    s, _ = _mascara.mascarar(url, estrito=True)
    if "4f9Xk2Lm8Qp7" in s or "Zr7Tq1Wv5Ns3" in s or "lang=pt-BR" not in s:
        falhas.append("_mascara nao trocou code/state da URL (ou apagou o parametro neutro lang)")
    for neutro in ("https://forja.exemplo.test/x/issues?state=closed&q=bug", "Sair remove app.token do localStorage",
                   "apaga o token do sessionStorage", "o cookie de sessao passou a ser httpOnly"):
        if _mascara.tipos_de_segredo(neutro):
            falhas.append(f"falso positivo da mascara num texto que devia passar: {neutro!r}")
    for frase in ("a senha do admin e " + "Abc12345", "a senha e " + "Abc12345", "pin do cartao e " + "4821"):
        if not _mascara.tipos_de_segredo(frase) or "Abc12345" in _mascara.mascarar(frase, True)[0] \
                or "4821" in _mascara.mascarar(frase, True)[0]:
            falhas.append(f"_mascara deixou a senha da frase em claro: {mascarar(frase, 6)}")
    return falhas


def har_sintetico() -> tuple:
    """HAR so com valores ficticios: cookie de sessao, access_token na queryString e na URL, senha no postData
    (JSON dentro de string, com aspa escapada no valor) e accessToken/refreshToken na resposta."""
    valores = {"cookie sessionid": "Ab12" + "Cd34Ef56Gh",
               "queryString access_token": "Tk9" + "fFakeQs1Zx",
               "postData senha": "cD9!x\"Y" + "z7Wq",
               "resposta accessToken": "AcTk" + "Fake123Lm",
               "resposta refreshToken": "RfTk" + "Fake456Np"}
    corpo = json.dumps({"usuario": "ana", "senha": valores["postData senha"]})
    resposta = json.dumps({"accessToken": valores["resposta accessToken"],
                           "refreshToken": valores["resposta refreshToken"], "expira": 3600})
    har = {"log": {"version": "1.2", "creator": {"name": "QA", "version": "1"}, "entries": [{
        "request": {
            "method": "POST",
            "url": "https://api.exemplo.test/login?access_token=" + valores["queryString access_token"],
            "headers": [{"name": ":authority", "value": "api.exemplo.test"},
                        {"name": "Accept", "value": "application/json"}],
            "cookies": [{"name": "sessionid", "value": valores["cookie sessionid"]},
                        {"name": "lang", "value": "pt-BR"}],
            "queryString": [{"name": "access_token", "value": valores["queryString access_token"]}],
            "postData": {"mimeType": "application/json", "text": corpo}},
        "response": {"status": 200, "content": {"mimeType": "application/json", "text": resposta}}}]}}
    return har, valores


def autoteste_har(_mascara) -> list:
    falhas = []
    har, valores = har_sintetico()
    for formato, texto in (("HAR indentado", json.dumps(har, indent=2)), ("HAR compacto", json.dumps(har))):
        if not _mascara.tipos_de_segredo(texto):
            falhas.append(f"_mascara.tipos_de_segredo nao achou nada no {formato}")
        s, n = _mascara.mascarar(texto, estrito=True)
        for rotulo, valor in valores.items():
            if valor in s or json.dumps(valor)[1:-1] in s or valor[:4] in s or valor[-4:] in s:
                falhas.append(f"_mascara deixou {rotulo} em claro no {formato} (texto)")
        if n < len(valores):
            falhas.append(f"_mascara trocou {n} trecho(s) no {formato}; esperado ao menos {len(valores)}")
        for neutro in ("api.exemplo.test", "pt-BR", "application/json"):
            if neutro not in s:
                falhas.append(f"_mascara apagou o dado neutro {neutro!r} do {formato}")
    estrutura, n = _mascara.mascarar_estrutura(har)
    serial = json.dumps(estrutura, ensure_ascii=False)
    for rotulo, valor in valores.items():
        if valor in serial or json.dumps(valor)[1:-1] in serial or valor[:4] in serial or valor[-4:] in serial:
            falhas.append(f"_mascara.mascarar_estrutura deixou {rotulo} em claro no HAR")
    if n < len(valores):
        falhas.append(f"_mascara.mascarar_estrutura trocou {n} valor(es) no HAR; esperado ao menos {len(valores)}")
    if "api.exemplo.test" not in serial or "pt-BR" not in serial:
        falhas.append("_mascara.mascarar_estrutura apagou dado neutro do HAR (:authority ou cookie lang)")
    if hasattr(_mascara, "mascarar_texto_de_arquivo"):
        s, n = _mascara.mascarar_texto_de_arquivo(json.dumps(har, indent=2), ".har")
        if any(v[:4] in s or v[-4:] in s for v in valores.values()) or n < len(valores):
            falhas.append("_mascara.mascarar_texto_de_arquivo deixou segredo do HAR em claro")
    return falhas


def autoteste() -> int:
    falhas = []
    casos = casos_autoteste()
    for texto, arquivo, esperado in casos:
        regras = {a["regra"] for a in varrer_texto(texto, arquivo, False)}
        if esperado and esperado not in regras:
            falhas.append(f"devia achar {esperado} em {arquivo}: {mascarar(texto, 6)}")
        if not esperado and regras:
            falhas.append(f"falso positivo ({', '.join(sorted(regras))}) em {arquivo}, num caso que devia passar limpo")
    falhas_mascara = autoteste_mascara()
    for f in falhas + falhas_mascara:
        print(f"FALHOU: {f}")
    print(f"autoteste: {len(casos) - len(falhas)} de {len(casos)} casos ok; mascara: "
          f"{'ok' if not falhas_mascara else str(len(falhas_mascara)) + ' falha(s)'}")
    falhas += falhas_mascara
    return EXIT_ACHOU if falhas else EXIT_OK


def montar_parser():
    p = ParserPT(
        prog="segredos.py",
        description=(
            "Procura segredos versionados (chaves de nuvem, strings de conexao com senha, chaves\n"
            "privadas, tokens, senhas em config/.env) e imprime cada achado MASCARADO, com\n"
            "arquivo:linha, regra e uma impressao digital. Nunca imprime o segredo inteiro."),
        epilog=(
            "exemplos:\n"
            "  python segredos.py                      varre o repositorio atual (git ls-files)\n"
            "  python segredos.py ../api --json        saida JSON\n"
            "  python segredos.py --tudo               varre o disco, inclusive o que o .gitignore esconde\n"
            "  python segredos.py --entropia           acrescenta textos de alta entropia (mais ruido)\n"
            "  python segredos.py --historico --max-commits 2000   tambem o historico do git (custo alto)\n"
            "  python segredos.py --ignorar .qa/segredos-ignorar.txt\n"
            "\n"
            "arquivo de --ignorar: uma entrada por linha; '#' comenta. Uma impressao (12 hex, da coluna id=)\n"
            "ignora aquele achado; qualquer outra linha e um glob de caminho (ex. tests/fixtures/*).\n"
            "Na propria linha do codigo, o comentario 'segredos:ignorar' tambem ignora.\n"
            "\n"
            "chave publica de cliente (regra chave-publica-cliente, severidade baixo): apiKey do Google dentro de\n"
            "firebaseConfig ou de google-services.json/GoogleService-Info.plist, JWT com role anon (Supabase),\n"
            "pk_live_/pk_test_ do Stripe, DSN publico do Sentry e pk. do Mapbox. Ela vai para o front por desenho:\n"
            "nao rotacione; confira a restricao de referrer/app/API no console e as regras ou RLS (DM-TEN).\n"
            "service_role, sk_ e AIza fora desses contextos continuam como segredo (alto ou critico).\n"
            "\n"
            "--historico: 'AINDA NO HEAD' so quando o mesmo valor esta num arquivo RASTREADO hoje; se ele so\n"
            "aparece num arquivo nao versionado, a saida diz 'removido do HEAD; o mesmo valor esta no working tree'.\n"
            "\n"
            "Basic auth (base64 que decodifica para usuario:senha) e cookie de sessao (connect.sid, sessionid,\n"
            "JSESSIONID, PHPSESSID... ou, num cabecalho Cookie/Set-Cookie, qualquer par com valor de 16+ caracteres\n"
            "ou nome de sessao/autenticacao, em qualquer posicao) tambem contam como segredo.\n"
            "Senha sem aspas: em INI/properties/cfg/conf o '#' no meio do valor faz parte dele; em YAML/TOML/.env\n"
            "so e comentario com espaco antes ('senha: Ab#12' e segredo; 'senha: ${X} # nota' nao).\n"
            "Credencial em opcao de linha de comando (log, README, transcricao): a senha de curl -u/--user e\n"
            "http -a usuario:senha, mysql -p<senha>, sqlcmd -P, redis-cli -a, mongo/sshpass -p, docker login -p e\n"
            "--password/--http-password; '$SENHA', '<senha>' e 'mysql -p banco' (pede a senha) ficam de fora.\n"
            "Par nome/valor de HAR e afins ({\"name\": \"sessionid\", \"value\": \"...\"}, tambem em varias linhas):\n"
            "valor de nome de sessao, csrf, auth, token, senha ou chave conta como segredo (':authority' nao).\n"
            "--autoteste roda os casos embutidos das regras e da mascara, inclusive um HAR ficticio com cookie,\n"
            "access_token, senha no postData e tokens na resposta (sai 1 se algum falhar).\n"
            "\n"
            "codigos de saida: 0 nada encontrado | 1 achou segredo (>= --min-severidade) | 2 uso ou erro"))
    p.add_argument("raiz", nargs="?", default=".", help="pasta a varrer (padrao: a atual)")
    p.add_argument("--tudo", action="store_true",
                   help="varre o disco ignorando o .gitignore (ainda pula .git, node_modules, bin, obj...)")
    p.add_argument("--so-rastreados", action="store_true",
                   help="em repositorio git, so arquivos rastreados (sem os novos nao ignorados)")
    p.add_argument("--historico", action="store_true",
                   help="tambem varre o historico (git log -p --all): demorado; use com autorizacao")
    p.add_argument("--max-commits", type=int, default=0, help="limite de commits no --historico (0 = todos)")
    p.add_argument("--entropia", action="store_true", help="inclui textos de alta entropia entre aspas (severidade baixo)")
    p.add_argument("--min-severidade", choices=SEVERIDADES, default="baixo",
                   help="menor severidade que conta para o codigo de saida e para a lista (padrao: baixo)")
    p.add_argument("--excluir", action="append", default=[], metavar="GLOB",
                   help="glob de caminho a pular (repetivel), ex. --excluir 'docs/*'")
    p.add_argument("--ignorar", metavar="ARQ", help="arquivo com impressoes e globs a ignorar")
    p.add_argument("--max-bytes", type=int, default=2_000_000, help="pula arquivos maiores que isto (padrao 2000000)")
    p.add_argument("--json", action="store_true", help="saida em JSON (stdout)")
    p.add_argument("--saida", metavar="ARQ", help="grava o resultado (texto ou JSON) neste arquivo, com fim de linha LF")
    p.add_argument("--autoteste", action="store_true", help="roda os casos embutidos das regras e sai")
    return p


def main(argv=None) -> int:
    configurar_saida()
    args = montar_parser().parse_args(argv)
    if args.autoteste:
        return autoteste()
    raiz = Path(args.raiz).expanduser()
    if not raiz.is_dir():
        print(f"erro: pasta nao encontrada: {raiz}", file=sys.stderr)
        return EXIT_USO
    if args.max_bytes <= 0 or args.max_commits < 0:
        print("erro: --max-bytes precisa ser > 0 e --max-commits >= 0", file=sys.stderr)
        return EXIT_USO
    try:
        ign_impressoes, ign_globs = carregar_ignorados(args.ignorar)
    except SystemExit as e:
        print(str(e), file=sys.stderr)
        return EXIT_USO
    nomes, modo, avisos = listar_arquivos(raiz, args.tudo, args.so_rastreados, args.excluir)
    achados, varridos, pulados = varrer_repo(raiz, nomes, args, ign_impressoes, ign_globs)
    if pulados:
        avisos.append(f"{len(pulados)} arquivo(s) pulado(s): " + "; ".join(pulados[:5]) + (" ..." if len(pulados) > 5 else ""))
    limite = PESO[args.min_severidade]
    achados = ordenar([a for a in achados if PESO.get(a["severidade"], 9) <= limite])
    relatorio = {"ferramenta": "segredos.py", "raiz": str(raiz.resolve()), "modo": modo,
                 "arquivos_varridos": varridos, "avisos": avisos, "achados": achados}
    todos = list(achados)
    if args.historico:
        if git(raiz, "rev-parse", "--git-dir") is None:
            print("erro: --historico exige repositorio git", file=sys.stderr)
            return EXIT_USO
        hist, commits = varrer_historico(raiz, args, ign_impressoes, ign_globs)
        rastreados_atuais = {(a["regra"], a["impressao"]) for a in achados if a.get("versionado") is not False}
        soltos = {}
        for a in achados:
            if a.get("versionado") is False:
                soltos.setdefault((a["regra"], a["impressao"]), a["arquivo"])
        hist = [h for h in hist if PESO.get(h["severidade"], 9) <= limite]
        for h in hist:
            chave = (h["regra"], h["impressao"])
            h["ainda_no_estado_atual"] = chave in rastreados_atuais
            if not h["ainda_no_estado_atual"] and chave in soltos:
                h["no_working_tree_nao_versionado"] = soltos[chave]
        relatorio["historico"] = {"commits_lidos": commits, "achados": ordenar(hist)}
        todos += hist
    relatorio["total_por_severidade"] = resumo_por_severidade(todos)
    if args.json:
        texto = json.dumps(relatorio, ensure_ascii=False, indent=2) + "\n"
        if args.saida:
            with open(args.saida, "w", encoding="utf-8", newline="\n") as f:
                f.write(texto)
            print(f"resultado gravado em {args.saida}")
        else:
            sys.stdout.write(texto)
    else:
        if args.saida:
            import io
            import contextlib
            buf = io.StringIO()
            with contextlib.redirect_stdout(buf):
                imprimir_texto(relatorio)
            with open(args.saida, "w", encoding="utf-8", newline="\n") as f:
                f.write(buf.getvalue())
            print(f"resultado gravado em {args.saida}")
        else:
            imprimir_texto(relatorio)
    return EXIT_ACHOU if todos else EXIT_OK


if __name__ == "__main__":
    sys.exit(main())

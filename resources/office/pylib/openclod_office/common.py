# -*- coding: utf-8 -*-
"""Helpers shared by the three document builders: pt-BR number formats and inline **bold** markup."""
import datetime as _dt
import re

DEFAULT_ACCENT = "1F4E79"
_BOLD = re.compile(r"(\*\*[^*\n]+\*\*)")


def _group(digits, sep="."):
    out = []
    while len(digits) > 3:
        out.insert(0, digits[-3:])
        digits = digits[:-3]
    out.insert(0, digits)
    return sep.join(out)


def num(value, decimals=0):
    """1234567.891 -> '1.234.568' (pt-BR: '.' groups thousands, ',' is the decimal mark)."""
    if value is None:
        return ""
    negative = value < 0
    whole, _, frac = ("%.*f" % (decimals, abs(value))).partition(".")
    text = _group(whole) + ("," + frac if decimals else "")
    return ("-" if negative and float(abs(value)) != 0 else "") + text


def brl(value, decimals=0):
    """639377 -> 'R$ 639.377'; with decimals=2 -> 'R$ 639.377,00'."""
    if value is None:
        return ""
    text = num(abs(value), decimals)
    return ("-R$ " if value < 0 else "R$ ") + text


def pct(fraction, decimals=1):
    """0.8312 -> '83,1%' (the argument is a fraction, as stored in a spreadsheet)."""
    if fraction is None:
        return ""
    return num(fraction * 100, decimals) + "%"


def today_br():
    return _dt.date.today().strftime("%d/%m/%Y")


FORMATTERS = {
    "text": lambda v: "" if v is None else str(v),
    "int": lambda v: num(v, 0),
    "num": lambda v: num(v, 2),
    "brl": lambda v: brl(v, 2),
    "brl0": lambda v: brl(v, 0),
    "pct": lambda v: pct(v, 1),
    "pct0": lambda v: pct(v, 0),
}
RIGHT_ALIGNED = {"int", "num", "brl", "brl0", "pct", "pct0"}


def fmt_value(value, kind):
    """Formats a table value by column kind ('text', 'int', 'num', 'brl', 'brl0', 'pct', 'pct0'); strings pass through."""
    if isinstance(value, str) or value is None:
        return "" if value is None else value
    if kind not in FORMATTERS:
        raise ValueError("formato desconhecido: %r (use %s)" % (kind, ", ".join(sorted(FORMATTERS))))
    return FORMATTERS[kind](value)


def split_bold(text):
    """'a **b** c' -> [('a ', False), ('b', True), (' c', False)]; text without ** comes back as one plain piece."""
    pieces = []
    for part in _BOLD.split(str(text)):
        if not part:
            continue
        if part.startswith("**") and part.endswith("**") and len(part) > 4:
            pieces.append((part[2:-2], True))
        else:
            pieces.append((part, False))
    return pieces or [("", False)]


def hex_to_rgb(color):
    color = color.lstrip("#")
    return int(color[0:2], 16), int(color[2:4], 16), int(color[4:6], 16)


def lighten(color, amount=0.88):
    """Mixes a hex color with white: lighten('1F4E79', 0.9) is a very light tint of the accent."""
    r, g, b = hex_to_rgb(color)
    mix = lambda c: int(round(c + (255 - c) * amount))
    return "%02X%02X%02X" % (mix(r), mix(g), mix(b))

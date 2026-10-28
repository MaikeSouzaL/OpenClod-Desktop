# -*- coding: utf-8 -*-
"""xlsx_book - a clean Excel workbook with REAL formulas (XlsxWriter underneath).

    from openclod_office.xlsx_book import Book
    book = Book(r"C:\\pasta\\analise.xlsx", title="Análise de vendas", author="Equipe Alfa")
    dados = book.sheet("Dados", ["Mês", "Região", "Receita"], rows, formats=["text", "text", "brl0"])
    resumo = book.sheet("Resumo")
    resumo.title("A1", "Resumo por região")
    resumo.header("A3", ["Região", "Receita", "Meta", "Atingimento"])
    resumo.put("A4", "Sul")
    resumo.formula("B4", "=SUMIF(Dados!$B$2:$B$37,A4,Dados!$C$2:$C$37)", value=150000, kind="brl0")   # value = what Python computed
    resumo.chart("column", "Receita por região", categories="A4:A6", values="B4:B6", at="F3")
    book.close()

Every formula is written with its cached `value` (compute it in Python from the same data), so a viewer that does not
calculate still shows numbers; Excel and LibreOffice recalculate on open. `book.workbook` / `sheet.ws` are the raw XlsxWriter objects.
Formulas use English function names and commas (=SUMIF(A:A,"x",B:B)), whatever the language of the Excel that opens them.
"""
import os

import xlsxwriter
from xlsxwriter.utility import xl_cell_to_rowcol, xl_col_to_name, xl_rowcol_to_cell

from .common import DEFAULT_ACCENT, FORMATTERS, fmt_value, lighten

NUMBER_FORMATS = {
    "text": None,
    "int": "#,##0",
    "num": "#,##0.00",
    "brl": '"R$" #,##0.00',
    "brl0": '"R$" #,##0',
    "pct": "0.0%",
    "pct0": "0%",
    "date": "dd/mm/yyyy",
    "month": "mmm/yyyy",
}
PALETTE = ["1F4E79", "2E75B6", "9DC3E6", "ED7D31", "A5A5A5", "70AD47"]


def _range_ref(sheet_name, cells):
    """'A4:A6' -> "='Resumo'!$A$4:$A$6" (a reference with a sheet name is used as is)."""
    if "!" in cells:
        return cells if cells.startswith("=") else "=" + cells
    start, _, end = cells.partition(":")
    end = end or start
    (r1, c1), (r2, c2) = xl_cell_to_rowcol(start), xl_cell_to_rowcol(end)
    quoted = "'%s'" % sheet_name.replace("'", "''")
    return "=%s!$%s$%d:$%s$%d" % (quoted, xl_col_to_name(c1), r1 + 1, xl_col_to_name(c2), r2 + 1)


class Sheet:
    def __init__(self, book, ws, name):
        self.book = book
        self.ws = ws
        self.name = name

    # ---------------------------------------------------------------- cells

    def title(self, cell, text, size=16):
        self.ws.write(cell, text, self.book.fmt("text", bold=True, size=size, color=self.book.accent))

    def note(self, cell, text):
        self.ws.write(cell, text, self.book.fmt("text", italic=True, color="7F7F7F", size=9))

    def header(self, cell, labels, formats=None):
        """A header row starting at `cell`; numeric columns (by `formats`) get right-aligned labels."""
        row, col = xl_cell_to_rowcol(cell)
        for offset, label in enumerate(labels):
            right = bool(formats) and formats[offset] not in (None, "text", "date", "month")
            self.ws.write(row, col + offset, label, self.book.fmt("text", header=True, align="right" if right else "left"))

    def put(self, cell, value, kind="text", bold=False, total=False):
        if value is None:
            self.ws.write_blank(cell, None, self.book.fmt(kind, bold=bold, total=total))
        else:
            self.ws.write(cell, value, self.book.fmt(kind, bold=bold, total=total))

    def formula(self, cell, expression, value=None, kind="num", bold=False, total=False):
        """A real formula (starts with '='). `value` is the result Python expects: it is stored as the cached value."""
        if not str(expression).startswith("="):
            raise ValueError("fórmula precisa começar com '=': %r" % (expression,))
        fmt = self.book.fmt(kind, bold=bold, total=total)
        if value is None:
            self.ws.write_formula(cell, expression, fmt)
        else:
            self.ws.write_formula(cell, expression, fmt, value)

    def rows(self, first_cell, rows, formats=None):
        """Writes a block of data rows starting at `first_cell`. Strings starting with '=' are written as formulas."""
        row, col = xl_cell_to_rowcol(first_cell)
        for r, values in enumerate(rows):
            for c, value in enumerate(values):
                kind = (formats[c] if formats else "text") or "text"
                fmt = self.book.fmt(kind)
                if isinstance(value, str) and value.startswith("="):
                    self.ws.write_formula(row + r, col + c, value, fmt)
                elif value is None:
                    self.ws.write_blank(row + r, col + c, None, fmt)
                else:
                    self.ws.write(row + r, col + c, value, fmt)

    def widths(self, widths):
        for index, width in enumerate(widths):
            self.ws.set_column(index, index, width)

    # ---------------------------------------------------------------- extras

    def chart(self, kind, title, categories, values, at, series_name=None, size=(560, 320), number_format=None, colors=None, legend=None):
        """
        kind: column, bar, line, pie, doughnut. categories/values: ranges of THIS sheet ('A4:A6') or 'Other!A1:A3'.
        `values` may be a list of ranges (one series each; `series_name` then a list of names).
        """
        chart = self.book.workbook.add_chart({"type": kind})
        ranges = values if isinstance(values, (list, tuple)) else [values]
        names = series_name if isinstance(series_name, (list, tuple)) else [series_name] * len(ranges)
        palette = colors or PALETTE
        for index, rng in enumerate(ranges):
            series = {
                "categories": _range_ref(self.name, categories),
                "values": _range_ref(self.name, rng),
                "data_labels": {"value": True, "font": {"size": 9}, **({"num_format": number_format} if number_format else {})},
            }
            if names[index]:
                series["name"] = names[index]
            if kind in ("pie", "doughnut"):
                series["points"] = [{"fill": {"color": "#" + palette[i % len(palette)]}} for i in range(12)]
            else:
                series["fill"] = {"color": "#" + palette[index % len(palette)]}
                series["line"] = {"color": "#" + palette[index % len(palette)]}
            chart.add_series(series)
        chart.set_title({"name": title, "name_font": {"size": 12, "bold": True}})
        show_legend = legend if legend is not None else (len(ranges) > 1 or kind in ("pie", "doughnut"))
        chart.set_legend({"position": "bottom"} if show_legend else {"none": True})
        if kind not in ("pie", "doughnut"):
            axis = {"major_gridlines": {"visible": True, "line": {"color": "#D9D9D9"}}}
            if number_format:
                axis["num_format"] = number_format
            if kind in ("column", "bar"):
                axis["min"] = 0  # bars start at zero, or their heights lie
            chart.set_y_axis(axis)
        chart.set_size({"width": size[0], "height": size[1]})
        self.ws.insert_chart(at, chart)
        return chart

    def goal_colors(self, cells, goal=1.0):
        """Green when the cell reaches `goal` (default 1 = 100%), red otherwise."""
        good = self.book.workbook.add_format({"bg_color": "#E2F0D9", "font_color": "#375623"})
        bad = self.book.workbook.add_format({"bg_color": "#FBE5D6", "font_color": "#9C2B0E"})
        self.ws.conditional_format(cells, {"type": "cell", "criteria": ">=", "value": goal, "format": good})
        self.ws.conditional_format(cells, {"type": "cell", "criteria": "<", "value": goal, "format": bad})


class Book:
    def __init__(self, path, title=None, author=None, accent=DEFAULT_ACCENT, font="Calibri"):
        self.path = path
        self.accent = accent
        self.font = font
        os.makedirs(os.path.dirname(os.path.abspath(path)), exist_ok=True)
        self.workbook = xlsxwriter.Workbook(path, {"use_future_functions": True})
        self.workbook.set_properties({"title": title or "", "author": author or "", "comments": "Criado no Openclod"})
        self._formats = {}
        self.sheets = {}

    def fmt(self, kind="text", bold=False, italic=False, size=11, color=None, header=False, total=False, align=None):
        key = (kind, bold, italic, size, color, header, total, align)
        if key not in self._formats:
            if kind not in NUMBER_FORMATS:
                raise ValueError("formato desconhecido: %r (use %s)" % (kind, ", ".join(NUMBER_FORMATS)))
            spec = {"font_name": self.font, "font_size": size, "valign": "vcenter", "bold": bold, "italic": italic}
            if NUMBER_FORMATS[kind]:
                spec["num_format"] = NUMBER_FORMATS[kind]
            if color:
                spec["font_color"] = "#" + color
            if header:
                spec.update({"bold": True, "font_color": "#FFFFFF", "bg_color": "#" + self.accent, "border": 1, "border_color": "#" + self.accent, "text_wrap": True})
            if total:
                spec.update({"bold": True, "bg_color": "#" + lighten(self.accent, 0.85), "top": 1, "top_color": "#" + self.accent})
            if align:
                spec["align"] = align
            self._formats[key] = self.workbook.add_format(spec)
        return self._formats[key]

    def sheet(self, name, header=None, rows=None, formats=None, widths=None, freeze=True, filter=True, zebra=True, tab_color=None):
        """
        Adds a sheet. With `header` (and `rows`) it writes the table at A1: styled header, formatted body, column widths from the
        content, frozen header row, filter and light zebra stripes. Without them it is an empty sheet to fill with put/formula.
        """
        ws = self.workbook.add_worksheet(name)
        sheet = Sheet(self, ws, name)
        self.sheets[name] = sheet
        ws.set_paper(9)  # A4
        ws.fit_to_pages(1, 0)  # printing or exporting to PDF: one page wide
        if tab_color:
            ws.set_tab_color("#" + tab_color)
        if header:
            rows = [list(r) for r in (rows or [])]
            formats = list(formats or ["text"] * len(header))
            sheet.header("A1", header, formats)
            sheet.rows("A2", rows, formats)
            ws.set_row(0, 22)
            if widths is None:
                widths = []
                for c, label in enumerate(header):
                    shown = [len(str(label)) + 2] + [len(str(fmt_value(r[c], formats[c] if formats[c] in FORMATTERS else "text"))) + 2 for r in rows if c < len(r)]
                    widths.append(max(9, min(max(shown), 48)))
            sheet.widths(widths)
            if freeze:
                ws.freeze_panes(1, 0)
            if filter and rows:
                ws.autofilter(0, 0, len(rows), len(header) - 1)
            if zebra and rows:
                stripe = self.workbook.add_format({"bg_color": "#" + lighten(self.accent, 0.94)})
                ws.conditional_format(1, 0, len(rows), len(header) - 1, {"type": "formula", "criteria": "=MOD(ROW(),2)=0", "format": stripe})
        return sheet

    def close(self):
        self.workbook.close()
        return self.path

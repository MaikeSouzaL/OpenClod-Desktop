# -*- coding: utf-8 -*-
"""docx_report - a professional Word report in a few calls (python-docx underneath).

    from openclod_office.docx_report import Report
    doc = Report("Relatório de vendas", subtitle="Diretoria Comercial", author="Equipe Alfa", footer="Preparado pela Equipe Alfa")
    doc.heading("Resumo executivo")
    doc.paragraph("A receita total foi de **R$ 639.377**, 4% acima da meta.")
    doc.bullets(["Sul cresceu 12%", "Nordeste abaixo da meta"])
    doc.table(["Região", "Receita"], [["Sul", 150000], ["Norte", 90000]], formats=["text", "brl0"], total=True, caption="Receita por região")
    doc.save(r"C:\\pasta\\relatorio.docx")

`doc.doc` is the python-docx Document for anything else. Text accepts **bold** inline.
"""
import copy
import os

from docx import Document
from docx.enum.section import WD_ORIENT
from docx.enum.table import WD_TABLE_ALIGNMENT
from docx.enum.text import WD_ALIGN_PARAGRAPH, WD_TAB_ALIGNMENT
from docx.oxml import OxmlElement
from docx.oxml.ns import qn
from docx.shared import Cm, Pt, RGBColor

from .common import DEFAULT_ACCENT, RIGHT_ALIGNED, fmt_value, hex_to_rgb, lighten, split_bold, today_br

_PAGES = {"A4": (21.0, 29.7), "Letter": (21.59, 27.94)}


def _rgb(color):
    return RGBColor(*hex_to_rgb(color))


def _set_fonts(rpr_owner, name):
    """Sets the font of a style/run properties and removes the theme font attributes that would override it."""
    rpr = rpr_owner.get_or_add_rPr()
    fonts = rpr.find(qn("w:rFonts"))
    if fonts is None:
        fonts = OxmlElement("w:rFonts")
        rpr.insert(0, fonts)
    for attr in ("w:asciiTheme", "w:hAnsiTheme", "w:eastAsiaTheme", "w:cstheme"):
        if fonts.get(qn(attr)) is not None:
            del fonts.attrib[qn(attr)]
    for attr in ("w:ascii", "w:hAnsi", "w:eastAsia", "w:cs"):
        fonts.set(qn(attr), name)


def _shade(cell, color):
    props = cell._element.get_or_add_tcPr()
    for old in props.findall(qn("w:shd")):
        props.remove(old)
    shade = OxmlElement("w:shd")
    shade.set(qn("w:val"), "clear")
    shade.set(qn("w:color"), "auto")
    shade.set(qn("w:fill"), color)
    props.append(shade)


def _borders(cell, **edges):
    """edges: top/bottom/left/right = (size_eighths_of_pt, 'RRGGBB') or None for no border."""
    props = cell._element.get_or_add_tcPr()
    for old in props.findall(qn("w:tcBorders")):
        props.remove(old)
    borders = OxmlElement("w:tcBorders")
    for edge in ("top", "left", "bottom", "right"):
        spec = edges.get(edge)
        node = OxmlElement("w:" + edge)
        if spec:
            node.set(qn("w:val"), "single")
            node.set(qn("w:sz"), str(spec[0]))
            node.set(qn("w:space"), "0")
            node.set(qn("w:color"), spec[1])
        else:
            node.set(qn("w:val"), "nil")
        borders.append(node)
    props.append(borders)


def _cell_margins(table, top=60, bottom=60, left=100, right=100):
    props = table._tbl.tblPr
    margins = OxmlElement("w:tblCellMar")
    for edge, value in (("top", top), ("left", left), ("bottom", bottom), ("right", right)):
        node = OxmlElement("w:" + edge)
        node.set(qn("w:w"), str(value))
        node.set(qn("w:type"), "dxa")
        margins.append(node)
    props.append(margins)


def _row_flags(row, header=False):
    props = row._tr.get_or_add_trPr()
    keep = OxmlElement("w:cantSplit")
    props.append(keep)
    if header:
        repeat = OxmlElement("w:tblHeader")
        props.append(repeat)


def _field(paragraph, instruction, size=None, color=None):
    """Inserts a Word field (PAGE, NUMPAGES...) as a run sequence."""
    parts = []
    for kind in ("begin", None, "separate", "text", "end"):
        run = paragraph.add_run()
        if size:
            run.font.size = Pt(size)
        if color:
            run.font.color.rgb = _rgb(color)
        if kind in ("begin", "separate", "end"):
            node = OxmlElement("w:fldChar")
            node.set(qn("w:fldCharType"), kind)
            run._r.append(node)
        elif kind is None:
            node = OxmlElement("w:instrText")
            node.set(qn("xml:space"), "preserve")
            node.text = " %s " % instruction
            run._r.append(node)
        else:
            run.text = "1"
        parts.append(run)
    return parts


class Report:
    def __init__(
        self,
        title,
        subtitle=None,
        author=None,
        date=None,
        footer=None,
        header=None,
        accent=DEFAULT_ACCENT,
        font="Calibri",
        page="A4",
        landscape=False,
        language="pt-BR",
        cover_meta=True,
        byline=None,
    ):
        self.doc = Document()
        self.accent = accent
        self.font = font
        self.table_count = 0
        self._numbering_cache = None
        self._setup_page(page, landscape)
        self._setup_styles(language)
        props = self.doc.core_properties
        props.title = title
        props.author = author or ""
        props.language = language
        if title:
            self._title_block(title, subtitle, byline or author, date, cover_meta)
        self._header_footer(header, footer)

    # ------------------------------------------------------------------ setup

    def _setup_page(self, page, landscape):
        width, height = _PAGES.get(page, _PAGES["A4"])
        section = self.doc.sections[0]
        if landscape:
            width, height = height, width
            section.orientation = WD_ORIENT.LANDSCAPE
        section.page_width, section.page_height = Cm(width), Cm(height)
        section.left_margin = section.right_margin = Cm(2.3)
        section.top_margin, section.bottom_margin = Cm(2.3), Cm(2.2)
        self.text_width_cm = width - 4.6

    def _setup_styles(self, language):
        styles = self.doc.styles
        normal = styles["Normal"]
        normal.font.size = Pt(11)
        normal.font.color.rgb = RGBColor(0x26, 0x26, 0x26)
        _set_fonts(normal.element, self.font)
        normal.paragraph_format.space_after = Pt(6)
        normal.paragraph_format.line_spacing = 1.15
        defaults = styles.element.find(qn("w:docDefaults"))
        if defaults is not None:
            for lang in defaults.iter(qn("w:lang")):
                lang.set(qn("w:val"), language)
        sizes = {"Title": (26, True, 0, 4), "Heading 1": (17, True, 16, 6), "Heading 2": (13.5, True, 12, 4), "Heading 3": (12, True, 10, 3)}
        for name, (size, bold, before, after) in sizes.items():
            style = styles[name]
            style.font.size = Pt(size)
            style.font.bold = bold
            style.font.color.rgb = _rgb(self.accent if name != "Heading 3" else "404040")
            _set_fonts(style.element, self.font)
            style.paragraph_format.space_before = Pt(before)
            style.paragraph_format.space_after = Pt(after)
            style.paragraph_format.keep_with_next = True
        # The template's Title has a bottom rule; the cover block draws its own accent line instead.
        title_ppr = styles["Title"].element.find(qn("w:pPr"))
        if title_ppr is not None:
            for border in title_ppr.findall(qn("w:pBdr")):
                title_ppr.remove(border)
        caption = styles["Caption"]
        caption.font.size = Pt(9.5)
        caption.font.italic = False
        caption.font.bold = True
        caption.font.color.rgb = RGBColor(0x59, 0x59, 0x59)
        _set_fonts(caption.element, self.font)
        caption.paragraph_format.space_after = Pt(4)
        caption.paragraph_format.keep_with_next = True

    def _title_block(self, title, subtitle, author, date, cover_meta):
        self.doc.add_paragraph(title, style="Title")
        if subtitle:
            p = self.doc.add_paragraph()
            run = p.add_run(subtitle)
            run.font.size = Pt(14)
            run.font.color.rgb = RGBColor(0x59, 0x59, 0x59)
            p.paragraph_format.space_after = Pt(4)
        meta = " · ".join(item for item in (author, date or today_br()) if item) if cover_meta else ""
        if meta:
            p = self.doc.add_paragraph()
            run = p.add_run(meta)
            run.font.size = Pt(10)
            run.font.color.rgb = RGBColor(0x7F, 0x7F, 0x7F)
        rule = self.doc.add_paragraph()
        rule.paragraph_format.space_after = Pt(10)
        ppr = rule._p.get_or_add_pPr()
        border = OxmlElement("w:pBdr")
        bottom = OxmlElement("w:bottom")
        for key, value in (("val", "single"), ("sz", "12"), ("space", "1"), ("color", self.accent)):
            bottom.set(qn("w:" + key), value)
        border.append(bottom)
        ppr.append(border)

    def _header_footer(self, header, footer):
        section = self.doc.sections[0]
        if header:
            p = section.header.paragraphs[0]
            p.text = ""
            run = p.add_run(header)
            run.font.size = Pt(9)
            run.font.color.rgb = RGBColor(0x7F, 0x7F, 0x7F)
            p.alignment = WD_ALIGN_PARAGRAPH.RIGHT
        p = section.footer.paragraphs[0]
        p.text = ""
        # The template's Footer style has its own centre/right tab stops; clear them so the page number sits at the right margin.
        for stop in self.doc.styles["Footer"].paragraph_format.tab_stops:
            p.paragraph_format.tab_stops.add_tab_stop(stop.position, WD_TAB_ALIGNMENT.CLEAR)
        p.paragraph_format.tab_stops.add_tab_stop(Cm(self.text_width_cm), WD_TAB_ALIGNMENT.RIGHT)
        if footer:
            run = p.add_run(footer)
            run.font.size = Pt(9)
            run.font.color.rgb = RGBColor(0x7F, 0x7F, 0x7F)
        tab = p.add_run("\t")
        tab.font.size = Pt(9)
        label = p.add_run("Página ")
        label.font.size = Pt(9)
        label.font.color.rgb = RGBColor(0x7F, 0x7F, 0x7F)
        _field(p, "PAGE", 9, "7F7F7F")
        of = p.add_run(" de ")
        of.font.size = Pt(9)
        of.font.color.rgb = RGBColor(0x7F, 0x7F, 0x7F)
        _field(p, "NUMPAGES", 9, "7F7F7F")

    # ------------------------------------------------------------------ content

    def _runs(self, paragraph, text, size=None, color=None, italic=False, bold=False):
        for piece, strong in split_bold(text):
            run = paragraph.add_run(piece)
            run.bold = bool(strong or bold)
            run.italic = italic
            if size:
                run.font.size = Pt(size)
            if color:
                run.font.color.rgb = _rgb(color)
        return paragraph

    def heading(self, text, level=1):
        return self.doc.add_heading(str(text), level=level)

    def paragraph(self, text, align=None, size=None, color=None, italic=False, bold=False, keep_with_next=False):
        p = self.doc.add_paragraph()
        self._runs(p, text, size=size, color=color, italic=italic, bold=bold)
        if align:
            p.alignment = {"left": WD_ALIGN_PARAGRAPH.LEFT, "center": WD_ALIGN_PARAGRAPH.CENTER, "right": WD_ALIGN_PARAGRAPH.RIGHT, "justify": WD_ALIGN_PARAGRAPH.JUSTIFY}[align]
        p.paragraph_format.keep_with_next = keep_with_next
        return p

    def _restart_numbering(self):
        """A new numId for 'List Number' that starts at 1 (otherwise every numbered list continues the previous one)."""
        numbering = self.doc.part.numbering_part.numbering_definitions._numbering
        style = self.doc.styles["List Number"]
        num_pr = style.element.pPr.numPr if style.element.pPr is not None else None
        if num_pr is None or num_pr.numId is None:
            return None
        base = next((n for n in numbering.findall(qn("w:num")) if n.get(qn("w:numId")) == str(num_pr.numId.val)), None)
        if base is None:
            return None
        abstract_id = base.find(qn("w:abstractNumId")).get(qn("w:val"))
        new_id = max(int(n.get(qn("w:numId"))) for n in numbering.findall(qn("w:num"))) + 1
        node = OxmlElement("w:num")
        node.set(qn("w:numId"), str(new_id))
        ref = OxmlElement("w:abstractNumId")
        ref.set(qn("w:val"), abstract_id)
        node.append(ref)
        override = OxmlElement("w:lvlOverride")
        override.set(qn("w:ilvl"), "0")
        start = OxmlElement("w:startOverride")
        start.set(qn("w:val"), "1")
        override.append(start)
        node.append(override)
        numbering.append(node)
        return new_id

    def bullets(self, items, numbered=False):
        """A bulleted (or numbered, restarting at 1) list. Each item may be 'text' or ('text', level) with level 0 or 1."""
        num_id = self._restart_numbering() if numbered else None
        made = []
        for item in items:
            text, level = (item if isinstance(item, tuple) else (item, 0))
            style = "List Number" if numbered else "List Bullet"
            if level:
                style += " 2"
            p = self.doc.add_paragraph(style=style)
            self._runs(p, text)
            p.paragraph_format.space_after = Pt(3)
            if num_id is not None and not level:
                ppr = p._p.get_or_add_pPr()
                num_pr = OxmlElement("w:numPr")
                ilvl = OxmlElement("w:ilvl")
                ilvl.set(qn("w:val"), "0")
                nid = OxmlElement("w:numId")
                nid.set(qn("w:val"), str(num_id))
                num_pr.append(ilvl)
                num_pr.append(nid)
                ppr.append(num_pr)
            made.append(p)
        if made:
            made[-1].paragraph_format.space_after = Pt(8)
        return made

    def callout(self, text, title=None):
        """A shaded box with an accent bar on the left, for the one thing the reader must not miss."""
        table = self.doc.add_table(rows=1, cols=1)
        table.alignment = WD_TABLE_ALIGNMENT.CENTER
        cell = table.rows[0].cells[0]
        _shade(cell, lighten(self.accent, 0.9))
        _borders(cell, left=(36, self.accent))
        _cell_margins(table, 100, 100, 160, 140)
        first = cell.paragraphs[0]
        if title:
            self._runs(first, title, bold=True, color=self.accent)
            self._runs(cell.add_paragraph(), text)
        else:
            self._runs(first, text)
        for p in cell.paragraphs:
            p.paragraph_format.space_after = Pt(2)
        self.doc.add_paragraph().paragraph_format.space_after = Pt(4)
        return table

    def table(self, header, rows, formats=None, widths_cm=None, total=False, caption=None, zebra=True, align=None):
        """
        header: column titles. rows: list of lists (numbers stay numbers; they are formatted by `formats`).
        formats: one of text/int/num/brl/brl0/pct/pct0 per column (numbers are right-aligned). Default: text.
        total=True makes the LAST row a bold total row. widths_cm: one width per column (default: shared equally).
        """
        cols = len(header)
        formats = list(formats or ["text"] * cols)
        if len(formats) != cols:
            raise ValueError("formats precisa ter %d itens (um por coluna)" % cols)
        if caption:
            self.table_count += 1
            self.doc.add_paragraph("Tabela %d — %s" % (self.table_count, caption), style="Caption")
        table = self.doc.add_table(rows=1 + len(rows), cols=cols)
        table.alignment = WD_TABLE_ALIGNMENT.CENTER
        table.autofit = False
        _cell_margins(table)
        widths = widths_cm or [self.text_width_cm / cols] * cols
        for index, width in enumerate(widths):
            table.columns[index].width = Cm(width)
        light = lighten(self.accent, 0.92)
        for r, values in enumerate([header] + [list(row) for row in rows]):
            row = table.rows[r]
            _row_flags(row, header=(r == 0))
            is_total = total and r == len(rows)
            for c in range(cols):
                cell = row.cells[c]
                cell.width = Cm(widths[c])
                kind = formats[c]
                raw = values[c] if c < len(values) else ""
                text = str(raw) if r == 0 else fmt_value(raw, kind)
                p = cell.paragraphs[0]
                p.paragraph_format.space_after = Pt(0)
                p.paragraph_format.line_spacing = 1.0
                run = p.add_run(text)
                run.font.size = Pt(10.5)
                if r == 0:
                    run.bold = True
                    run.font.color.rgb = RGBColor(0xFF, 0xFF, 0xFF)
                    _shade(cell, self.accent)
                    _borders(cell)
                else:
                    if is_total:
                        run.bold = True
                        _shade(cell, lighten(self.accent, 0.85))
                        _borders(cell, top=(12, self.accent), bottom=(12, self.accent))
                    else:
                        if zebra and r % 2 == 0:
                            _shade(cell, light)
                        _borders(cell, bottom=(4, "D9D9D9"))
                right = (align[c] == "right") if align else (kind in RIGHT_ALIGNED)
                if right:
                    p.alignment = WD_ALIGN_PARAGRAPH.RIGHT
        spacer = self.doc.add_paragraph()
        spacer.paragraph_format.space_after = Pt(6)
        return table

    def image(self, path, width_cm=14.0, caption=None):
        if not os.path.isfile(path):
            raise FileNotFoundError(path)
        self.doc.add_picture(path, width=Cm(min(width_cm, self.text_width_cm)))
        self.doc.paragraphs[-1].alignment = WD_ALIGN_PARAGRAPH.CENTER
        self.doc.paragraphs[-1].paragraph_format.keep_with_next = bool(caption)
        if caption:
            p = self.doc.add_paragraph(caption, style="Caption")
            p.alignment = WD_ALIGN_PARAGRAPH.CENTER
            p.paragraph_format.keep_with_next = False

    def page_break(self):
        self.doc.add_page_break()

    def save(self, path):
        folder = os.path.dirname(os.path.abspath(path))
        os.makedirs(folder, exist_ok=True)
        self.doc.save(path)
        return path

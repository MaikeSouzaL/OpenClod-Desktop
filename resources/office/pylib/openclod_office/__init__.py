# -*- coding: utf-8 -*-
"""openclod_office - builders for professional .docx / .xlsx / .pptx files on top of python-docx, XlsxWriter and python-pptx.

    from openclod_office import docx_report, xlsx_book, pptx_deck
    from openclod_office import brl, num, pct          # pt-BR number formatting

Each builder keeps the raw library reachable (`Report.doc`, `Book.workbook`, `Deck.prs`) for anything it does not cover.
Source of truth: resources/office/pylib (visible to the embedded Python through python310._pth; see scripts/embed-office.mjs).
"""
from .common import brl, num, pct, today_br  # noqa: F401

__all__ = ["brl", "num", "pct", "today_br", "docx_report", "xlsx_book", "pptx_deck"]

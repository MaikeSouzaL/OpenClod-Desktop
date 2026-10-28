# -*- coding: utf-8 -*-
"""charts - clean PNG charts (Pillow only) for places that cannot hold a native chart, such as a Word report.

    from openclod_office.charts import bar_png, line_png
    bar_png(r"C:\\temp\\receita.png", ["Sul", "Sudeste"], [150000, 260000], title="Receita por região", value_format=brl)
    doc.image(r"C:\\temp\\receita.png", width_cm=15, caption="Receita por região")

In Excel and PowerPoint use the native charts (xlsx_book.Sheet.chart, pptx_deck.Deck.chart_slide): they stay editable.
"""
from PIL import Image, ImageDraw, ImageFont

from .common import DEFAULT_ACCENT, hex_to_rgb, num

_FONT_FILES = ("calibri.ttf", "segoeui.ttf", "arial.ttf", "DejaVuSans.ttf")
_BOLD_FILES = ("calibrib.ttf", "segoeuib.ttf", "arialbd.ttf", "DejaVuSans-Bold.ttf")


def _font(size, bold=False):
    for name in (_BOLD_FILES if bold else _FONT_FILES):
        try:
            return ImageFont.truetype(name, size)
        except OSError:
            continue
    return ImageFont.load_default()


def _nice_ceiling(value):
    """Rounds the top of the axis up to 1, 2, 2.5, 5 or 10 times a power of ten."""
    if value <= 0:
        return 1.0
    magnitude = 10 ** (len(str(int(value))) - 1) if value >= 1 else 10 ** -3
    for step in (1, 2, 2.5, 5, 10):
        if value <= step * magnitude:
            return step * magnitude
    return 10 * magnitude


def _frame(width, height, title, scale):
    image = Image.new("RGB", (width * scale, height * scale), "white")
    draw = ImageDraw.Draw(image)
    if title:
        draw.text((24 * scale, 16 * scale), title, font=_font(26 * scale, True), fill=(38, 38, 38))
    return image, draw


def bar_png(path, labels, values, title=None, value_format=None, accent=DEFAULT_ACCENT, width=1100, height=620, scale=2):
    """Vertical bars from zero, value on top of each bar, light grid. `value_format`: function(number) -> text (default: 1.234)."""
    fmt = value_format or (lambda v: num(v, 0))
    image, draw = _frame(width, height, title, scale)
    left, right, top, bottom = 140 * scale, 30 * scale, 70 * scale, 80 * scale
    plot_w, plot_h = image.width - left - right, image.height - top - bottom
    ceiling = _nice_ceiling(max(max(values), 0))
    small = _font(19 * scale)
    for step in range(5):
        value = ceiling * step / 4
        y = top + plot_h - plot_h * step / 4
        draw.line([(left, y), (left + plot_w, y)], fill=(222, 222, 222), width=scale)
        text = fmt(value)
        draw.text((left - 12 * scale - draw.textlength(text, font=small), y - 9 * scale), text, font=small, fill=(110, 110, 110))
    slot = plot_w / max(len(values), 1)
    bar_w = min(slot * 0.55, 150 * scale)
    color = hex_to_rgb(accent)
    for index, (label, value) in enumerate(zip(labels, values)):
        x = left + slot * index + (slot - bar_w) / 2
        h = plot_h * (value / ceiling)
        draw.rectangle([x, top + plot_h - h, x + bar_w, top + plot_h], fill=color)
        text = fmt(value)
        draw.text((x + bar_w / 2 - draw.textlength(text, font=small) / 2, top + plot_h - h - 24 * scale), text, font=small, fill=(60, 60, 60))
        label = str(label)
        draw.text((x + bar_w / 2 - draw.textlength(label, font=small) / 2, top + plot_h + 14 * scale), label, font=small, fill=(60, 60, 60))
    draw.line([(left, top + plot_h), (left + plot_w, top + plot_h)], fill=(150, 150, 150), width=scale)
    image.resize((width, height), Image.LANCZOS).save(path)
    return path


def line_png(path, labels, series, title=None, value_format=None, colors=None, width=1100, height=620, scale=2):
    """Lines with markers. `series`: {'Nome': [valores]}; a legend appears when there is more than one."""
    fmt = value_format or (lambda v: num(v, 0))
    palette = colors or [DEFAULT_ACCENT, "ED7D31", "70AD47", "A5A5A5"]
    image, draw = _frame(width, height, title, scale)
    left, right, top, bottom = 140 * scale, 40 * scale, 70 * scale, 100 * scale
    plot_w, plot_h = image.width - left - right, image.height - top - bottom
    everything = [v for values in series.values() for v in values]
    low, high = min(0, min(everything)), _nice_ceiling(max(everything))
    small = _font(19 * scale)
    for step in range(5):
        value = low + (high - low) * step / 4
        y = top + plot_h - plot_h * step / 4
        draw.line([(left, y), (left + plot_w, y)], fill=(222, 222, 222), width=scale)
        text = fmt(value)
        draw.text((left - 12 * scale - draw.textlength(text, font=small), y - 9 * scale), text, font=small, fill=(110, 110, 110))
    count = max(len(labels) - 1, 1)
    for index, label in enumerate(labels):
        x = left + plot_w * index / count
        label = str(label)
        draw.text((x - draw.textlength(label, font=small) / 2, top + plot_h + 14 * scale), label, font=small, fill=(60, 60, 60))
    for number, (name, values) in enumerate(series.items()):
        color = hex_to_rgb(palette[number % len(palette)])
        points = [(left + plot_w * i / count, top + plot_h - plot_h * (v - low) / (high - low or 1)) for i, v in enumerate(values)]
        draw.line(points, fill=color, width=4 * scale, joint="curve")
        for x, y in points:
            draw.ellipse([x - 6 * scale, y - 6 * scale, x + 6 * scale, y + 6 * scale], fill=color, outline="white", width=scale)
        if len(series) > 1:
            lx = left + number * 190 * scale
            draw.rectangle([lx, image.height - 38 * scale, lx + 22 * scale, image.height - 26 * scale], fill=color)
            draw.text((lx + 30 * scale, image.height - 44 * scale), str(name), font=small, fill=(60, 60, 60))
    image.resize((width, height), Image.LANCZOS).save(path)
    return path

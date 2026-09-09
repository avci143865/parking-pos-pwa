"""تصدير طوابير FIFO إلى PDF بدعم العربية (RTL)."""

from __future__ import annotations

from datetime import datetime
from io import BytesIO
from pathlib import Path

from app.fifo_queue import DEFAULT_TRUCK_TYPE


def _load_fpdf_class():
    """fpdf2 يُستورد كـ fpdf — الحزمة القديمة fpdf 1.7 تتعارض معها."""
    try:
        import fpdf as fpdf_mod
    except ImportError as exc:
        raise ImportError(
            "مكتبة fpdf2 غير مثبتة. من داخل venv نفّذ:\n"
            "  pip uninstall fpdf -y\n"
            "  pip install -r requirements.txt\n"
            "ثم شغّل: python -m uvicorn app.main:app --reload"
        ) from exc
    ver = getattr(fpdf_mod, "__version__", "")
    if ver.startswith("1."):
        raise ImportError(
            "الحزمة fpdf 1.7 قديمة وغير متوافقة. نفّذ:\n"
            "  pip uninstall fpdf -y\n"
            "  pip install fpdf2"
        )
    try:
        from fpdf import FPDF
    except ImportError as exc:
        raise ImportError(
            "تثبيت fpdf2 غير مكتمل. نفّذ:\n"
            "  pip uninstall fpdf -y\n"
            "  pip install --force-reinstall fpdf2"
        ) from exc

    return FPDF


FONT_PATH = Path(__file__).resolve().parent / "assets" / "NotoSansArabic-Regular.ttf"

try:
    import arabic_reshaper
    from bidi.algorithm import get_display

    def shape_ar(text: str) -> str:
        if not text:
            return ""
        return get_display(arabic_reshaper.reshape(str(text)))

except ImportError:  # pragma: no cover

    def shape_ar(text: str) -> str:
        return str(text or "")


class FifoPdf:
    def __init__(self) -> None:
        FPDF = _load_fpdf_class()
        self._doc = FPDF(orientation="P", unit="mm", format="A4")
        self._doc.set_auto_page_break(auto=True, margin=12)
        if FONT_PATH.is_file():
            self._doc.add_font("NotoAr", "", str(FONT_PATH))
            self.font_name = "NotoAr"
        else:
            self.font_name = "Helvetica"
        self._doc.set_font(self.font_name, size=11)

    def __getattr__(self, name):
        return getattr(self._doc, name)

    def rtl_cell(self, w: float, h: float, txt: str, border: int = 0, align: str = "R") -> None:
        self._doc.cell(w, h, shape_ar(txt), border=border, align=align, new_x="LMARGIN", new_y="NEXT")

    def rtl_multi(self, w: float, h: float, txt: str) -> None:
        self._doc.multi_cell(w, h, shape_ar(txt), align="R")

    def output(self, *args, **kwargs):
        return self._doc.output(*args, **kwargs)


def _status_label(item: dict, allowed: int | None) -> str:
    label = item.get("status_label")
    if label:
        return str(label)
    if item.get("queue_status") == "ready_exit":
        return "قيد الخروج"
    return "في الانتظار"


def build_fifo_queues_pdf(
    *,
    title: str,
    exported_at: datetime,
    queues: list[dict],
) -> bytes:
    """queues: [{truck_type, waiting_count, current_allowed, items:[{...}]}]"""
    pdf = FifoPdf()
    pdf.add_page()
    pdf.set_font(pdf.font_name, size=16)
    pdf.rtl_cell(0, 10, title)
    pdf.set_font(pdf.font_name, size=10)
    pdf.rtl_cell(0, 7, f"تاريخ التصدير: {exported_at.strftime('%Y-%m-%d %H:%M')} (دمشق)")
    pdf.ln(4)

    col_w = (18, 28, 32, 32, 22, 38, 22)
    headers = (
        "الدور",
        "اللوحة",
        "السائق",
        "الشركة",
        "النوع",
        "وقت الدخول",
        "الحالة",
    )

    for q in queues:
        truck_type = q.get("truck_type") or DEFAULT_TRUCK_TYPE
        waiting = q.get("waiting_count", 0)
        total_waiting = q.get("total_waiting")
        export_limit = q.get("export_limit")
        allowed = q.get("current_allowed_queue_number")
        pdf.set_font(pdf.font_name, size=12)
        allowed_txt = str(allowed) if allowed is not None else "—"
        if export_limit and total_waiting is not None and int(export_limit) < int(total_waiting):
            scope = f"أول {waiting} من {total_waiting}"
        else:
            scope = f"منتظر: {waiting}"
        pdf.rtl_multi(
            0,
            8,
            f"نوع الشاحنة: {truck_type} | {scope} | الدور المسموح: {allowed_txt}",
        )
        pdf.set_font(pdf.font_name, size=9)
        pdf.set_fill_color(230, 236, 245)
        x0 = pdf.get_x()
        y0 = pdf.get_y()
        for i, htxt in enumerate(headers):
            pdf.set_xy(x0 + sum(col_w[:i]), y0)
            pdf.cell(col_w[i], 7, shape_ar(htxt), border=1, align="C")
        pdf.ln(7)

        for item in q.get("items") or []:
            entered = item.get("entered_at_display") or "—"
            row = (
                str(item.get("fifo_queue_number") or "—"),
                str(item.get("license_plate") or "—"),
                str(item.get("driver_name") or "—"),
                str(item.get("partnership_company") or "—"),
                str(item.get("fifo_truck_type") or truck_type),
                entered,
                _status_label(item, allowed),
            )
            y_row = pdf.get_y()
            for i, cell in enumerate(row):
                pdf.set_xy(x0 + sum(col_w[:i]), y_row)
                pdf.cell(col_w[i], 7, shape_ar(cell), border=1, align="C")
            pdf.ln(7)
        pdf.ln(3)

    raw = pdf.output()
    if isinstance(raw, (bytes, bytearray)):
        return bytes(raw)
    buf = BytesIO()
    pdf.output(buf)
    return buf.getvalue()



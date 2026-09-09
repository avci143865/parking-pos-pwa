"""نقل بيانات الموقف من قاعدة قديمة إلى قاعدة جديدة (مثلاً: Postgres على
حساب Railway قديم  ←  Postgres على حساب Railway جديد).

يعمل مع Postgres ← Postgres وأيضاً SQLite ← Postgres أو العكس، بدون pg_dump.

الاستخدام (PowerShell):
    $env:OLD_DATABASE_URL = "postgresql://user:pass@host:port/railway"   # القاعدة القديمة
    $env:NEW_DATABASE_URL = "postgresql://user:pass@host:port/railway"   # القاعدة الجديدة
    python scripts/migrate_railway_db.py            # يرفض إن كانت الجديدة فيها بيانات
    python scripts/migrate_railway_db.py --overwrite  # يمسح الجديدة أولاً ثم ينقل

ملاحظات:
- انسخ رابط الاتصال **العام (Public)** من خدمة Postgres في Railway، وفعّل
  Public Networking على القاعدة القديمة إن لزم الأمر.
- تُنسخ الجداول الأربعة: parking_settings ثم users ثم vehicle_profiles
  ثم parking_sessions (بهذا الترتيب بسبب المفاتيح الأجنبية).
- الصور (uploads/vehicle_photos) ملفات وليست في القاعدة — انسخها يدويًا.
"""

import os
import sys
from pathlib import Path

try:
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")
except Exception:
    pass

from sqlalchemy import MetaData, create_engine, select, text

BASE_DIR = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(BASE_DIR))

TABLES_IN_ORDER = [
    "parking_settings",
    "users",
    "vehicle_profiles",
    "parking_sessions",
]
SERIAL_TABLES = ["users", "vehicle_profiles", "parking_sessions"]


def _normalize(url: str) -> str:
    url = (url or "").strip()
    if url.startswith("postgres://"):
        return "postgresql+psycopg2://" + url.removeprefix("postgres://")
    if url.startswith("postgresql://") and "+psycopg" not in url.split("://", 1)[0]:
        return "postgresql+psycopg2://" + url.removeprefix("postgresql://")
    return url


def _count(engine, table) -> int:
    from sqlalchemy import func

    with engine.connect() as conn:
        return int(conn.execute(select(func.count()).select_from(table)).scalar() or 0)


def main() -> int:
    old_url = _normalize(os.environ.get("OLD_DATABASE_URL", ""))
    new_url = _normalize(os.environ.get("NEW_DATABASE_URL", ""))
    overwrite = "--overwrite" in sys.argv[1:]

    if not old_url or not new_url:
        print("حدّد المتغيرين OLD_DATABASE_URL و NEW_DATABASE_URL أولاً.")
        return 2
    if old_url == new_url:
        print("الرابطان متطابقان — لا شيء لنقله.")
        return 2

    old_eng = create_engine(old_url, pool_pre_ping=True)
    new_eng = create_engine(new_url, pool_pre_ping=True)

    # التأكد من وجود أحدث مخطط في القاعدة الجديدة.
    # (استيراد app.models ضروري لتسجيل الجداول في Base.metadata)
    from app.database import Base  # noqa: F401
    import app.models  # noqa: F401

    Base.metadata.create_all(bind=new_eng)

    old_meta = MetaData()
    old_meta.reflect(bind=old_eng)
    new_meta = MetaData()
    new_meta.reflect(bind=new_eng)

    for t in TABLES_IN_ORDER:
        if t not in old_meta.tables:
            print(f"تحذير: الجدول {t} غير موجود في القاعدة القديمة — يُتجاهل.")
    present = [t for t in TABLES_IN_ORDER if t in old_meta.tables and t in new_meta.tables]

    target_counts = {t: _count(new_eng, new_meta.tables[t]) for t in present}
    if any(target_counts.values()) and not overwrite:
        print("القاعدة الجديدة فيها بيانات مسبقًا:")
        for t, c in target_counts.items():
            print(f"  {t}: {c}")
        print("أعد التشغيل مع --overwrite لمسحها أولاً ثم النقل.")
        return 1
    if overwrite:
        with new_eng.begin() as conn:
            for t in reversed(present):
                conn.execute(new_meta.tables[t].delete())
        print("مُسحت بيانات القاعدة الجديدة.")

    total = 0
    for t in present:
        with old_eng.connect() as conn:
            rows = conn.execute(select(old_meta.tables[t])).mappings().all()
        target_cols = set(new_meta.tables[t].columns.keys())
        cleaned = [{k: v for k, v in dict(r).items() if k in target_cols} for r in rows]
        if cleaned:
            with new_eng.begin() as conn:
                conn.execute(new_meta.tables[t].insert(), cleaned)
        print(f"{t}: نُقل {len(cleaned)} صف.")
        total += len(cleaned)

    # إصلاح عدّادات SERIAL في Postgres الهدف حتى لا تتكرر المعرّفات.
    if new_eng.dialect.name == "postgresql":
        with new_eng.begin() as conn:
            for t in SERIAL_TABLES:
                if t in new_meta.tables:
                    conn.execute(
                        text(
                            f"SELECT setval(pg_get_serial_sequence('{t}', 'id'), "
                            f"COALESCE((SELECT MAX(id) FROM {t}), 0) + 1, false)"
                        )
                    )
        print("أُصلحت عدّادات التسلسل (sequences).")

    print(f"اكتمل النقل: {total} صف إجمالاً.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

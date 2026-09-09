"""Import shipping vehicle profiles from شحن.txt into vehicle_profiles."""

from __future__ import annotations

import os
import re
import sys
import uuid
from datetime import datetime, timezone
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))

from sqlalchemy import create_engine, select
from sqlalchemy.orm import sessionmaker

from app.database import ensure_schema_migrations
from app.fifo_queue import normalize_truck_type
from app.models import VehicleProfile

HEADER_TOKENS = {"النوع", "الشركة التضامنية", "اسم السائق", "رقم لوحة المركبة"}
PLATE_RE = re.compile(r"^[0-9A-Za-z\u0600-\u06FF -]{2,32}$")


def _normalize_db_url(url: str) -> str:
    url = url.strip()
    if url.startswith("postgres://"):
        return "postgresql+psycopg2://" + url.removeprefix("postgres://")
    if url.startswith("postgresql://") and "+psycopg2" not in url.split("://", 1)[0]:
        return "postgresql+psycopg2://" + url.removeprefix("postgresql://")
    return url


def _shipping_file() -> Path:
    for path in ROOT.glob("*.txt"):
        if path.name == "شحن.txt":
            return path
    matches = [p for p in ROOT.glob("*.txt") if p.name != "requirements.txt"]
    if len(matches) == 1:
        return matches[0]
    raise FileNotFoundError("Could not find شحن.txt")


def _fields(path: Path) -> list[str]:
    text = path.read_text(encoding="utf-8-sig")
    return [part.strip() for line in text.splitlines() for part in line.split("\r") if part.strip()]


def _looks_like_plate(value: str) -> bool:
    s = value.strip()
    return bool(PLATE_RE.match(s)) and any(ch.isdigit() for ch in s)


def parse_records(path: Path) -> list[dict[str, str | None]]:
    fields = [x for x in _fields(path) if x not in HEADER_TOKENS]
    records: list[dict[str, str | None]] = []
    i = 0
    while i + 3 < len(fields):
        vehicle_type, company, driver, plate = fields[i : i + 4]
        if not _looks_like_plate(plate):
            i += 1
            continue
        records.append(
            {
                "vehicle_type": normalize_truck_type(vehicle_type)[:64],
                "partnership_company": company[:128] or None,
                "driver_name": driver[:128] or None,
                "license_plate": plate.strip().upper()[:32],
            }
        )
        i += 4
    return records


def dedupe(records: list[dict[str, str | None]]) -> list[dict[str, str | None]]:
    seen: set[str] = set()
    unique: list[dict[str, str | None]] = []
    for row in records:
        plate = str(row["license_plate"] or "").upper()
        if not plate or plate in seen:
            continue
        seen.add(plate)
        unique.append(row)
    return unique


def import_to_db(records: list[dict[str, str | None]], database_url: str, *, dry_run: bool = False) -> tuple[int, int]:
    engine = create_engine(_normalize_db_url(database_url), pool_pre_ping=True)
    SessionLocal = sessionmaker(bind=engine)
    inserted = 0
    skipped = 0
    now = datetime.now(timezone.utc).replace(tzinfo=None)

    if dry_run:
        return len(records), 0

    with SessionLocal() as db:
        existing_plates = {
            (plate or "").upper()
            for plate in db.scalars(select(VehicleProfile.license_plate)).all()
        }
        batch: list[VehicleProfile] = []
        for row in records:
            plate = str(row["license_plate"] or "").upper()
            if plate in existing_plates:
                skipped += 1
                continue
            batch.append(
                VehicleProfile(
                    public_token=str(uuid.uuid4()),
                    license_plate=plate,
                    vehicle_make=None,
                    vehicle_type=row["vehicle_type"],
                    vehicle_color=None,
                    driver_name=row["driver_name"],
                    owner_name=None,
                    partnership_company=row["partnership_company"],
                    mechanical_number="",
                    photo_path=None,
                    created_at=now,
                )
            )
            existing_plates.add(plate)
            inserted += 1
            if len(batch) >= 200:
                db.add_all(batch)
                db.commit()
                batch.clear()
        if batch:
            db.add_all(batch)
            db.commit()
    return inserted, skipped


def main() -> None:
    file_path = _shipping_file()
    records = dedupe(parse_records(file_path))
    print(f"File: {file_path.name}")
    print(f"Parsed unique records: {len(records)}")
    for row in records[:5]:
        print(
            f"- {row['license_plate']} | {row['driver_name']} | "
            f"{row['partnership_company']} | {row['vehicle_type']}"
        )

    if "--dry-run" in sys.argv:
        return

    db_url = os.environ.get("DATABASE_URL") or os.environ.get("DATABASE_PUBLIC_URL")
    if not db_url:
        print("Set DATABASE_URL first.", file=sys.stderr)
        sys.exit(1)
    if "postgresql" not in db_url and "postgres:" not in db_url:
        print("DATABASE_URL must point to PostgreSQL.", file=sys.stderr)
        sys.exit(1)

    ensure_schema_migrations()
    inserted, skipped = import_to_db(records, db_url)
    print(f"Inserted: {inserted}")
    print(f"Skipped existing plates: {skipped}")


if __name__ == "__main__":
    main()

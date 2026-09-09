"""طوابير خروج FIFO حسب نوع الشاحنة (جلسة موقف نشطة واحدة لكل مركبة)."""

from __future__ import annotations

from sqlalchemy import func, select
from sqlalchemy.orm import Session

from app.models import ParkingSession, VehicleProfile

KNOWN_TRUCK_TYPES = ("براد", "سطحة", "شحن", "ناقلة")
DEFAULT_TRUCK_TYPE = "أخرى"
TRUCK_TYPE_ALIASES = {
    "قاطرة": "شحن",
}

FIFO_STATUS_WAITING = "waiting"
FIFO_STATUS_READY = "ready_exit"


def normalize_truck_type(value: str | None) -> str:
    s = (value or "").strip()
    s = TRUCK_TYPE_ALIASES.get(s, s)
    return s if s else DEFAULT_TRUCK_TYPE


def truck_type_from_profile(prof: VehicleProfile | None) -> str:
    if prof is None:
        return DEFAULT_TRUCK_TYPE
    return normalize_truck_type(prof.vehicle_type)


def next_fifo_queue_number(db: Session, truck_type: str) -> int:
    max_num = db.scalar(
        select(func.max(ParkingSession.fifo_queue_number)).where(
            ParkingSession.exited_at.is_(None),
            ParkingSession.fifo_truck_type == truck_type,
        )
    )
    return int(max_num or 0) + 1


def first_active_session_in_queue(db: Session, truck_type: str) -> ParkingSession | None:
    return db.scalar(
        select(ParkingSession)
        .where(
            ParkingSession.exited_at.is_(None),
            ParkingSession.fifo_truck_type == truck_type,
            ParkingSession.fifo_queue_number.isnot(None),
        )
        .order_by(
            ParkingSession.fifo_queue_number.asc(),
            ParkingSession.entered_at.asc(),
        )
        .limit(1)
    )


def first_ready_exit_session(db: Session, truck_type: str) -> ParkingSession | None:
    return db.scalar(
        select(ParkingSession)
        .where(
            ParkingSession.exited_at.is_(None),
            ParkingSession.fifo_truck_type == truck_type,
            ParkingSession.fifo_queue_number.isnot(None),
            ParkingSession.fifo_exit_released.is_(True),
        )
        .order_by(
            ParkingSession.fifo_queue_number.asc(),
            ParkingSession.entered_at.asc(),
        )
        .limit(1)
    )


def assign_fifo_to_session(db: Session, session: ParkingSession, truck_type: str) -> int:
    t = normalize_truck_type(truck_type)
    num = next_fifo_queue_number(db, t)
    session.fifo_truck_type = t
    session.fifo_queue_number = num
    session.fifo_exit_released = False
    return num


def active_sessions_in_queue(db: Session, truck_type: str, *, limit: int | None = None) -> list[ParkingSession]:
    stmt = (
        select(ParkingSession)
        .where(
            ParkingSession.exited_at.is_(None),
            ParkingSession.fifo_truck_type == truck_type,
            ParkingSession.fifo_queue_number.isnot(None),
        )
        .order_by(
            ParkingSession.fifo_queue_number.asc(),
            ParkingSession.entered_at.asc(),
        )
    )
    if limit is not None and limit > 0:
        stmt = stmt.limit(limit)
    return list(db.scalars(stmt).all())


def queue_status_for_session(session: ParkingSession) -> str:
    if session.fifo_exit_released:
        return FIFO_STATUS_READY
    return FIFO_STATUS_WAITING


def release_fifo_sessions(db: Session, truck_type: str, limit: int) -> int:
    """أول `limit` مركبة → قيد الخروج؛ الباقي في نفس الطابور → في الانتظار."""
    t = normalize_truck_type(truck_type)
    sessions = active_sessions_in_queue(db, t, limit=None)
    ready = 0
    for i, sess in enumerate(sessions):
        want = i < max(limit, 0)
        sess.fifo_exit_released = want
        if want:
            ready += 1
    return ready


def can_session_exit_fifo(db: Session, session: ParkingSession) -> bool:
    if session.fifo_queue_number is None or not session.fifo_truck_type:
        return True
    return bool(session.fifo_exit_released)


def current_allowed_queue_number(db: Session, truck_type: str) -> int | None:
    first = first_ready_exit_session(db, truck_type)
    return first.fifo_queue_number if first is not None else None


def ready_exit_count_for_type(db: Session, truck_type: str) -> int:
    n = db.scalar(
        select(func.count())
        .select_from(ParkingSession)
        .where(
            ParkingSession.exited_at.is_(None),
            ParkingSession.fifo_truck_type == truck_type,
            ParkingSession.fifo_queue_number.isnot(None),
            ParkingSession.fifo_exit_released.is_(True),
        )
    )
    return int(n or 0)


def waiting_in_queue_count_for_type(db: Session, truck_type: str) -> int:
    n = db.scalar(
        select(func.count())
        .select_from(ParkingSession)
        .where(
            ParkingSession.exited_at.is_(None),
            ParkingSession.fifo_truck_type == truck_type,
            ParkingSession.fifo_queue_number.isnot(None),
            ParkingSession.fifo_exit_released.is_(False),
        )
    )
    return int(n or 0)


def all_truck_types_for_export(discovered: list[str]) -> list[str]:
    ordered: list[str] = []
    seen: set[str] = set()
    for t in list(KNOWN_TRUCK_TYPES) + sorted(discovered):
        n = (t or "").strip() or DEFAULT_TRUCK_TYPE
        if n not in seen:
            seen.add(n)
            ordered.append(n)
    return ordered


def queue_status_label(status: str) -> str:
    if status == FIFO_STATUS_READY:
        return "قيد الخروج"
    return "في الانتظار"


def waiting_count_for_type(db: Session, truck_type: str) -> int:
    n = db.scalar(
        select(func.count())
        .select_from(ParkingSession)
        .where(
            ParkingSession.exited_at.is_(None),
            ParkingSession.fifo_truck_type == truck_type,
            ParkingSession.fifo_queue_number.isnot(None),
        )
    )
    return int(n or 0)

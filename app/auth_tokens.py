import os
from datetime import datetime, timedelta, timezone

from fastapi import HTTPException

JWT_SECRET = os.environ.get(
    "PARKING_JWT_SECRET",
    "dev-only-change-PARKING_JWT_SECRET-in-production-32chars",
)
JWT_ALGORITHM = "HS256"
JWT_HOURS = int(os.environ.get("PARKING_JWT_HOURS", "12"))


def _pyjwt():
    """PyJWT يُستورد كـ jwt — لا تثبّت الحزمة المنفصلة «jwt» من PyPI."""
    import jwt

    if not hasattr(jwt, "encode"):
        raise RuntimeError(
            "حزمة jwt الخاطئة مثبتة. نفّذ: pip uninstall jwt -y && pip install PyJWT==2.10.1"
        )
    return jwt


def create_access_token(*, username: str, role: str) -> str:
    jwt = _pyjwt()
    now = datetime.now(timezone.utc)
    payload = {
        "sub": username,
        "role": role,
        "iat": now,
        "exp": now + timedelta(hours=JWT_HOURS),
    }
    return jwt.encode(payload, JWT_SECRET, algorithm=JWT_ALGORITHM)


def decode_access_token(token: str) -> dict:
    jwt = _pyjwt()
    try:
        return jwt.decode(token, JWT_SECRET, algorithms=[JWT_ALGORITHM])
    except jwt.PyJWTError as e:
        raise HTTPException(
            status_code=401,
            detail="انتهت الجلسة أو رمز الدخول غير صالح.",
        ) from e

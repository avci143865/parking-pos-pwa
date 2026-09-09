from fastapi import Depends, HTTPException
from fastapi.security import HTTPAuthorizationCredentials, HTTPBearer
from sqlalchemy import select
from sqlalchemy.orm import Session

from app.auth_tokens import decode_access_token
from app.database import get_db
from app.models import User

ROLE_ADMIN = "admin"
ROLE_EMPLOYEE_IN = "employee_in"
ROLE_EMPLOYEE_OUT = "employee_out"
ROLE_LEGACY_EMPLOYEE = "employee"

security = HTTPBearer(auto_error=False)


def role_can_check_in(role: str) -> bool:
    return role in (ROLE_ADMIN, ROLE_EMPLOYEE_IN, ROLE_LEGACY_EMPLOYEE)


def role_can_check_out(role: str) -> bool:
    return role in (ROLE_ADMIN, ROLE_EMPLOYEE_OUT, ROLE_LEGACY_EMPLOYEE)


def user_permissions(user: User) -> tuple[bool, bool]:
    return role_can_check_in(user.role), role_can_check_out(user.role)


def get_current_user(
    creds: HTTPAuthorizationCredentials | None = Depends(security),
    db: Session = Depends(get_db),
) -> User:
    if creds is None or creds.scheme.lower() != "bearer":
        raise HTTPException(status_code=401, detail="يجب تسجيل الدخول.")
    payload = decode_access_token(creds.credentials)
    username = payload.get("sub")
    if not username or not isinstance(username, str):
        raise HTTPException(status_code=401, detail="رمز الدخول غير صالح.")
    user = db.scalar(select(User).where(User.username == username))
    if user is None:
        raise HTTPException(status_code=401, detail="المستخدم غير موجود.")
    if not user.is_active:
        raise HTTPException(status_code=403, detail="الحساب موقوف.")
    return user


def require_admin(user: User = Depends(get_current_user)) -> User:
    if user.role != ROLE_ADMIN:
        raise HTTPException(
            status_code=403,
            detail="هذه العملية للمدير فقط.",
        )
    return user


def require_check_in(user: User = Depends(get_current_user)) -> User:
    if not role_can_check_in(user.role):
        raise HTTPException(
            status_code=403,
            detail="ليس لديك صلاحية إدخال المركبات.",
        )
    return user


def require_check_out(user: User = Depends(get_current_user)) -> User:
    if not role_can_check_out(user.role):
        raise HTTPException(
            status_code=403,
            detail="ليس لديك صلاحية إخراج المركبات.",
        )
    return user

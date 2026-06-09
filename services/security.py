"""Security helpers for password hashing and verification."""

from __future__ import annotations

from argon2 import PasswordHasher, exceptions as argon_exc

# Argon2 parameters pinned explicitly so a future argon2-cffi release
# cannot silently change hashing behaviour. These match the current
# library defaults; existing hashes embed their own parameters and
# continue to verify.
ph = PasswordHasher(
    time_cost=3,
    memory_cost=65536,  # 64 MB
    parallelism=4,
    hash_len=32,
    salt_len=16,
)


def hash_password(plain_text: str) -> str:
    """Hash the provided password with Argon2."""
    if not plain_text:
        raise ValueError("Password must not be empty")
    return ph.hash(plain_text)


def verify_password(plain_text: str, hashed: str) -> bool:
    """Verify a password against an Argon2 hash."""
    if not plain_text or not hashed:
        return False

    try:
        return ph.verify(hashed, plain_text)
    except (argon_exc.VerificationError, argon_exc.InvalidHash):
        return False

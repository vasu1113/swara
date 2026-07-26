"""Configuration for the server.

Importing this module is deliberately safe without credentials.  Call
``require`` at the integration boundary that actually needs a credential.
"""

from __future__ import annotations

import os
from dataclasses import dataclass
from pathlib import Path

try:
    from dotenv import load_dotenv
except ImportError:  # Keep basic imports usable before dependencies are installed.
    def load_dotenv(*_: object, **__: object) -> bool:
        return False


ENV_FILE = Path(__file__).with_name(".env")
load_dotenv(ENV_FILE)


@dataclass(frozen=True)
class Settings:
    sarvam_api_key: str | None
    google_api_key: str | None
    supabase_url: str | None
    supabase_service_key: str | None

    def value_for(self, name: str) -> str | None:
        try:
            return {
                "SARVAM_API_KEY": self.sarvam_api_key,
                "GOOGLE_API_KEY": self.google_api_key,
                "SUPABASE_URL": self.supabase_url,
                "SUPABASE_SERVICE_KEY": self.supabase_service_key,
            }[name]
        except KeyError as exc:
            raise ValueError(f"Unknown configuration key: {name}") from exc


settings = Settings(
    sarvam_api_key=os.getenv("SARVAM_API_KEY"),
    google_api_key=os.getenv("GOOGLE_API_KEY"),
    supabase_url=os.getenv("SUPABASE_URL"),
    supabase_service_key=os.getenv("SUPABASE_SERVICE_KEY"),
)


def require(name: str) -> str:
    """Return a configured secret, or raise an actionable error when used."""
    value = settings.value_for(name)
    if not value:
        raise RuntimeError(
            f"Missing required configuration: {name}. "
            f"Set it in {ENV_FILE} or in the process environment."
        )
    return value

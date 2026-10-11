"""Open-Meteo CAMS Global air-quality forecast adapter.

The API provides modeled forecast/archived-forecast fields, not station observations.
The selected CAMS Global product has a documented native grid near 45 km and
3-hourly temporal resolution. Returned timestamps are requested in Unix time so
local conversion can use the requested IANA timezone, including DST transitions.
"""

from __future__ import annotations

import math
import logging
import threading
import time as monotonic_time
from dataclasses import dataclass
from datetime import date, datetime, timedelta, timezone
from typing import Any
from zoneinfo import ZoneInfo, ZoneInfoNotFoundError

import httpx


logger = logging.getLogger(__name__)
ENDPOINT = "https://air-quality-api.open-meteo.com/v1/air-quality"
MAX_FORECAST_DAYS = 7
MAX_PAST_DAYS = 92
CACHE_TTL_SECONDS = 15 * 60
_cache: dict[tuple[float, float, str, str], tuple[float, "HourlySeries"]] = {}
_cache_lock = threading.Lock()


class OpenMeteoError(Exception):
    def __init__(self, code: str, message: str, status_code: int | None = None):
        super().__init__(message)
        self.code = code
        self.status_code = status_code


@dataclass(frozen=True)
class HourlySample:
    timestamp: datetime
    pm25_ug_m3: float | None


@dataclass(frozen=True)
class HourlySeries:
    samples: tuple[HourlySample, ...]
    timezone_name: str
    units: str
    retrieved_at: datetime
    partial_response: bool = False

    @property
    def as_of(self) -> datetime | None:
        return self.samples[-1].timestamp if self.samples else None

    def public_hourly(self) -> list[dict[str, Any]]:
        return [
            {"timestamp": sample.timestamp.isoformat(), "pm25_ug_m3": sample.pm25_ug_m3}
            for sample in self.samples
        ]


def clear_cache() -> None:
    """Clear response cache; primarily useful for deterministic tests."""
    with _cache_lock:
        _cache.clear()


class OpenMeteoService:
    def __init__(self, transport: httpx.BaseTransport | None = None, timeout_seconds: float = 8.0):
        self.transport = transport
        self.timeout_seconds = timeout_seconds

    def fetch_hourly_pm25(
        self,
        latitude: float,
        longitude: float,
        target_date: date,
        timezone_name: str,
    ) -> HourlySeries:
        try:
            zone = ZoneInfo(timezone_name)
        except ZoneInfoNotFoundError as exc:
            raise OpenMeteoError("invalid_timezone", "Use a valid IANA time zone name.") from exc

        local_today = datetime.now(zone).date()
        if target_date < local_today - timedelta(days=MAX_PAST_DAYS) or target_date > local_today + timedelta(days=MAX_FORECAST_DAYS):
            raise OpenMeteoError(
                "outside_available_window",
                f"Open-Meteo CAMS Global supports dates from {local_today - timedelta(days=MAX_PAST_DAYS)} through {local_today + timedelta(days=MAX_FORECAST_DAYS)} for this request.",
            )

        cache_key = (round(latitude, 4), round(longitude, 4), target_date.isoformat(), timezone_name)
        now = monotonic_time.monotonic()
        if self.transport is None:
            with _cache_lock:
                cached = _cache.get(cache_key)
                if cached and now - cached[0] < CACHE_TTL_SECONDS:
                    return cached[1]
                if cached:
                    _cache.pop(cache_key, None)

        params = {
            "latitude": latitude,
            "longitude": longitude,
            "hourly": "pm2_5",
            "domains": "cams_global",
            "timezone": timezone_name,
            "timeformat": "unixtime",
            "start_date": target_date.isoformat(),
            "end_date": target_date.isoformat(),
        }
        try:
            # Do not inherit process-wide HTTP(S)_PROXY settings implicitly. A
            # stale or unrelated proxy can make the browser succeed while the
            # backend fails to connect. If a deployment requires a proxy, it
            # should configure it explicitly for this provider.
            with httpx.Client(timeout=self.timeout_seconds, transport=self.transport, trust_env=False) as client:
                response = client.get(ENDPOINT, params=params)
                response.raise_for_status()
                payload = response.json()
        except httpx.TimeoutException as exc:
            logger.warning(
                "Open-Meteo request timed out: exception_type=%s endpoint_host=%s timeout_seconds=%s",
                type(exc).__name__, httpx.URL(ENDPOINT).host, self.timeout_seconds,
            )
            raise OpenMeteoError("provider_timeout", "Open-Meteo did not respond before the timeout.") from exc
        except httpx.HTTPStatusError as exc:
            status = exc.response.status_code
            code = "rate_limited" if status == 429 else "provider_error"
            logger.warning(
                "Open-Meteo returned an HTTP error: exception_type=%s endpoint_host=%s status=%s reason=%s",
                type(exc).__name__, httpx.URL(ENDPOINT).host, status,
                (exc.response.reason_phrase or "unknown")[:80],
            )
            raise OpenMeteoError(code, f"Open-Meteo returned HTTP {status}.", status) from exc
        except httpx.RequestError as exc:
            cause = exc.__cause__
            cause_errno = getattr(cause, "errno", None)
            logger.warning(
                "Open-Meteo connection failed: exception_type=%s cause_type=%s cause_errno=%s endpoint_host=%s",
                type(exc).__name__, type(cause).__name__ if cause else "none",
                cause_errno, httpx.URL(ENDPOINT).host,
            )
            raise OpenMeteoError("provider_unavailable", "Could not reach Open-Meteo.") from exc
        except (ValueError, TypeError) as exc:
            raise OpenMeteoError("malformed_response", "Open-Meteo returned invalid JSON.") from exc

        series = self._parse_response(payload, zone, timezone_name)
        if self.transport is None:
            with _cache_lock:
                # Bound cache growth during a long-lived demo session.
                if len(_cache) >= 128:
                    oldest = min(_cache, key=lambda key: _cache[key][0])
                    _cache.pop(oldest, None)
                _cache[cache_key] = (monotonic_time.monotonic(), series)
        return series

    @staticmethod
    def _parse_response(payload: Any, zone: ZoneInfo, timezone_name: str) -> HourlySeries:
        if not isinstance(payload, dict):
            raise OpenMeteoError("malformed_response", "Expected an object from Open-Meteo.")
        hourly = payload.get("hourly")
        units = payload.get("hourly_units")
        if not isinstance(hourly, dict) or not isinstance(units, dict):
            raise OpenMeteoError("malformed_response", "Open-Meteo response is missing hourly data or units.")
        times = hourly.get("time")
        values = hourly.get("pm2_5")
        unit = units.get("pm2_5")
        if not isinstance(times, list) or not times or not isinstance(values, list) or not isinstance(unit, str):
            raise OpenMeteoError("malformed_response", "Open-Meteo response is missing hourly.time, hourly.pm2_5, or its unit.")
        normalized_unit = unit.replace("μ", "µ").replace("ug/m3", "µg/m³")
        if normalized_unit not in {"µg/m³", "μg/m³"}:
            raise OpenMeteoError("unexpected_units", f"Expected PM2.5 in µg/m³, received {unit!r}.")
        partial = len(values) != len(times)
        if len(values) > len(times):
            raise OpenMeteoError("malformed_response", "PM2.5 values exceed the number of timestamps.")
        values = values + [None] * (len(times) - len(values))
        samples: list[HourlySample] = []
        try:
            for raw_timestamp, raw_value in zip(times, values):
                if isinstance(raw_timestamp, bool) or not isinstance(raw_timestamp, (int, float)):
                    raise ValueError("Expected Unix timestamp")
                timestamp = datetime.fromtimestamp(raw_timestamp, tz=timezone.utc).astimezone(zone)
                if raw_value is None:
                    value = None
                elif isinstance(raw_value, bool) or not isinstance(raw_value, (int, float)):
                    value = None
                    partial = True
                elif not math.isfinite(raw_value) or raw_value < 0:
                    value = None
                    partial = True
                else:
                    value = float(raw_value)
                samples.append(HourlySample(timestamp, value))
        except (OverflowError, OSError, ValueError) as exc:
            raise OpenMeteoError("malformed_response", "Open-Meteo returned an invalid hourly timestamp.") from exc
        samples.sort(key=lambda sample: sample.timestamp)
        if len({sample.timestamp for sample in samples}) != len(samples):
            raise OpenMeteoError("malformed_response", "Open-Meteo returned duplicate timestamps.")
        return HourlySeries(tuple(samples), timezone_name, "µg/m³", datetime.now(timezone.utc), partial)

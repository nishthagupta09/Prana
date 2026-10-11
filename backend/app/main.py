from __future__ import annotations

from datetime import date, datetime, time, timedelta, timezone
from enum import Enum
from typing import Literal
from uuid import uuid4
from zoneinfo import ZoneInfo, ZoneInfoNotFoundError

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel, Field, model_validator

from app.services.bedrock import BedrockExplanationService, ExplanationRequest
from app.services.open_meteo import HourlySeries, OpenMeteoError, OpenMeteoService


class Environment(str, Enum):
    outdoor = "outdoor"
    indoor = "indoor"
    mixed = "mixed"
    unknown = "unknown"


class Flexibility(str, Enum):
    fixed = "fixed"
    limited = "limited"
    flexible = "flexible"


class PlanBlock(BaseModel):
    id: str = Field(default_factory=lambda: str(uuid4()))
    title: str = Field(min_length=1, max_length=120)
    start: time
    end: time
    location: str = Field(default="", max_length=160)
    environment: Environment
    flexibility: Flexibility = Flexibility.flexible
    # Used only in explicit illustrative mode; ignored for Open-Meteo requests.
    pm25: float | None = Field(default=None, ge=0, le=2000)

    @model_validator(mode="after")
    def valid_interval(self):
        if self.end <= self.start:
            raise ValueError("Activity end must be later than start on the same day")
        return self


class DayAnalysisRequest(BaseModel):
    date: date
    timezone: str = Field(min_length=1, max_length=64)
    location_label: str = Field(default="New Delhi", max_length=120)
    latitude: float = Field(default=28.6139, ge=-90, le=90)
    longitude: float = Field(default=77.2090, ge=-180, le=180)
    data_mode: Literal["live", "illustrative"] = "live"
    blocks: list[PlanBlock] = Field(default_factory=list, max_length=80)

    @model_validator(mode="after")
    def valid_schedule(self):
        try:
            ZoneInfo(self.timezone)
        except ZoneInfoNotFoundError as exc:
            raise ValueError("Use a valid IANA time zone name") from exc
        ordered = sorted(self.blocks, key=lambda block: block.start)
        seen_ids: set[str] = set()
        for block in ordered:
            if block.id in seen_ids:
                raise ValueError(f"Duplicate activity id: {block.id}")
            seen_ids.add(block.id)
        for previous, current in zip(ordered, ordered[1:]):
            if current.start < previous.end:
                raise ValueError(f"Activities overlap: {previous.id} and {current.id}")
        return self


class ScenarioRequest(BaseModel):
    baseline: DayAnalysisRequest
    alternatives: list[DayAnalysisRequest] = Field(min_length=1, max_length=3)

    @model_validator(mode="after")
    def consistent_scenario_inputs(self):
        for candidate in self.alternatives:
            if candidate.data_mode != self.baseline.data_mode:
                raise ValueError("Baseline and alternatives must use the same data mode")
        return self


class FeedbackRequest(BaseModel):
    recommendation_id: str
    decision: Literal["accepted", "modified", "rejected", "kept"]
    reason: str | None = Field(default=None, max_length=500)
    follow_through: Literal["complete", "partial", "not_followed", "unknown"] = "unknown"


app = FastAPI(title="Prana API", version="0.2.0", description="Deterministic ambient air planning API")
app.add_middleware(
    CORSMiddleware,
    allow_origins=["http://localhost:5173", "http://127.0.0.1:5173"],
    allow_methods=["GET", "POST", "OPTIONS"],
    allow_headers=["Content-Type"],
)

open_meteo = OpenMeteoService()
bedrock_explanations = BedrockExplanationService()


def block_hours(block: PlanBlock) -> float:
    start = block.start.hour * 60 + block.start.minute
    end = block.end.hour * 60 + block.end.minute
    return (end - start) / 60


def _base_provenance(request: DayAnalysisRequest) -> dict:
    return {
        "provider": "Open-Meteo Air Quality API",
        "model": "CAMS Global atmospheric composition forecast",
        "evidence_type": "modelled_forecast",
        "data_classification": "forecast_or_archived_forecast",
        "retrieved_at": None,
        "timezone": request.timezone,
        "coordinates": {"latitude": request.latitude, "longitude": request.longitude},
        "spatial_resolution_km": 45,
        "native_temporal_resolution_hours": 3,
        "units": "µg/m³",
        "is_live": True,
        "is_station_observation": False,
        "limitations": [
            "CAMS Global is a modeled atmospheric composition forecast on an approximately 45 km native grid with 3-hourly resolution.",
            "Values are not CPCB station measurements or street-level observations.",
            "Ambient concentration-time index is not inhaled mass or individual health risk.",
            "Indoor, mixed, unknown, and missing-value intervals are not imputed.",
        ],
    }


def _unavailable_result(request: DayAnalysisRequest, error: OpenMeteoError) -> dict:
    excluded = []
    for block in request.blocks:
        if block.environment == Environment.outdoor:
            excluded.append({"block_id": block.id, "reason": error.code})
        else:
            excluded.append({"block_id": block.id, "reason": f"{block.environment.value}_ambient_concentration_not_estimated"})
    provenance = _base_provenance(request)
    provenance.update({"status": "unavailable", "is_live": False, "error_code": error.code, "message": str(error)})
    return {
        "date": request.date.isoformat(),
        "timezone": request.timezone,
        "data_mode": request.data_mode,
        "status": "unavailable",
        "summary": {
            "concentration_time_index": None,
            "unit": "µg·h/m³",
            "evaluated_blocks": 0,
            "excluded_blocks": len(excluded),
            "planned_hours": round(sum(block_hours(b) for b in request.blocks), 4),
            "outdoor_planned_hours": round(sum(block_hours(b) for b in request.blocks if b.environment == Environment.outdoor), 4),
            "supported_hours": 0,
            "coverage_fraction": 0,
        },
        "blocks": [],
        "excluded": excluded,
        "recommendations": [],
        "hourly": [],
        "provenance": provenance,
        "cigarette_equivalent": {"status": "disabled_methodology_unvalidated", "value": None},
    }


def _integrate_block(request: DayAnalysisRequest, block: PlanBlock, series: HourlySeries) -> dict:
    zone = ZoneInfo(request.timezone)
    start = datetime.combine(request.date, block.start, zone)
    end = datetime.combine(request.date, block.end, zone)
    valid_seconds = 0.0
    missing_seconds = 0.0
    index = 0.0
    for sample_index, sample in enumerate(series.samples):
        if sample_index + 1 < len(series.samples):
            next_time = series.samples[sample_index + 1].timestamp
            interval_end = min(next_time, sample.timestamp + timedelta(hours=3))
        else:
            interval_end = sample.timestamp + timedelta(hours=3)
        overlap_start = max(start, sample.timestamp)
        overlap_end = min(end, interval_end)
        seconds = (overlap_end - overlap_start).total_seconds()
        if seconds <= 0:
            continue
        if sample.pm25_ug_m3 is None:
            missing_seconds += seconds
        else:
            valid_seconds += seconds
            index += sample.pm25_ug_m3 * seconds / 3600

    duration_seconds = (end - start).total_seconds()
    estimated_hours = valid_seconds / 3600
    missing_hours = missing_seconds / 3600
    if valid_seconds == 0:
        reason = "missing_pm25_value" if missing_seconds else "outside_available_window"
        return {"excluded": {"block_id": block.id, "reason": reason}}
    return {
        "block_id": block.id,
        "title": block.title,
        "duration_hours": round(duration_seconds / 3600, 4),
        "estimated_hours": round(estimated_hours, 4),
        "missing_hours": round(missing_hours, 4),
        "mean_pm25_ug_m3": round(index / estimated_hours, 3),
        "concentration_time_index_ug_h_m3": round(index, 4),
        "coverage_fraction": round(valid_seconds / duration_seconds, 4),
        "evidence_type": "modelled_forecast",
    }


def calculate_live(request: DayAnalysisRequest, series: HourlySeries) -> dict:
    evaluated: list[dict] = []
    excluded: list[dict] = []
    recommendations: list[dict] = []
    outdoor_planned = sum(block_hours(block) for block in request.blocks if block.environment == Environment.outdoor)
    for block in request.blocks:
        if block.environment != Environment.outdoor:
            excluded.append({"block_id": block.id, "reason": f"{block.environment.value}_ambient_concentration_not_estimated"})
            continue
        result = _integrate_block(request, block, series)
        if "excluded" in result:
            excluded.append(result["excluded"])
            continue
        evaluated.append(result)
        if block.flexibility != Flexibility.fixed:
            recommendations.append({
                "id": f"compare-{block.id}",
                "block_id": block.id,
                "kind": "compare_alternative_window",
                "status": "comparison_prompt",
                "reason": "This outdoor block is marked flexible. Compare another time if it fits your schedule; regional modeled estimates cannot establish a personal exposure difference.",
            })
    total = round(sum(row["concentration_time_index_ug_h_m3"] for row in evaluated), 4) if evaluated else None
    supported = round(sum(row["estimated_hours"] for row in evaluated), 4)
    provenance = _base_provenance(request)
    provenance.update({
        "status": "partial" if series.partial_response else "available",
        "data_classification": "archived_forecast" if request.date < datetime.now(ZoneInfo(request.timezone)).date() else "forecast",
        "retrieved_at": series.retrieved_at.isoformat(),
        "api_timezone": series.timezone_name,
        "native_temporal_resolution_hours": 3,
        "cache_ttl_seconds": 900,
    })
    return {
        "date": request.date.isoformat(),
        "timezone": request.timezone,
        "data_mode": "live",
        "status": "partial" if excluded or series.partial_response else "available",
        "summary": {
            "concentration_time_index": total,
            "unit": "µg·h/m³",
            "evaluated_blocks": len(evaluated),
            "excluded_blocks": len(excluded),
            "planned_hours": round(sum(block_hours(block) for block in request.blocks), 4),
            "outdoor_planned_hours": round(outdoor_planned, 4),
            "supported_hours": supported,
            "coverage_fraction": round(supported / outdoor_planned, 4) if outdoor_planned else 0,
        },
        "blocks": evaluated,
        "excluded": excluded,
        "recommendations": recommendations,
        "hourly": series.public_hourly(),
        "provenance": provenance,
        "cigarette_equivalent": {"status": "disabled_methodology_unvalidated", "value": None},
    }


def calculate_illustrative(request: DayAnalysisRequest) -> dict:
    evaluated = []
    excluded = []
    recommendations = []
    for block in request.blocks:
        if block.environment != Environment.outdoor:
            excluded.append({"block_id": block.id, "reason": f"{block.environment.value}_ambient_concentration_not_estimated"})
            continue
        if block.pm25 is None:
            excluded.append({"block_id": block.id, "reason": "missing_pm25_value"})
            continue
        hours = block_hours(block)
        evaluated.append({
            "block_id": block.id,
            "title": block.title,
            "duration_hours": round(hours, 4),
            "estimated_hours": round(hours, 4),
            "missing_hours": 0,
            "pm25_ug_m3": block.pm25,
            "mean_pm25_ug_m3": block.pm25,
            "concentration_time_index_ug_h_m3": round(block.pm25 * hours, 4),
            "coverage_fraction": 1,
            "evidence_type": "illustrative_mock",
        })
        if block.flexibility != Flexibility.fixed:
            recommendations.append({"id": f"compare-{block.id}", "block_id": block.id, "kind": "compare_alternative_window", "status": "illustrative_only", "reason": "This outdoor block is marked flexible. You can compare example times, but illustrative values do not describe local conditions."})
    total = round(sum(row["concentration_time_index_ug_h_m3"] for row in evaluated), 4) if evaluated else None
    outdoor = sum(block_hours(block) for block in request.blocks if block.environment == Environment.outdoor)
    supported = sum(row["estimated_hours"] for row in evaluated)
    return {
        "date": request.date.isoformat(), "timezone": request.timezone, "data_mode": "illustrative", "status": "illustrative",
        "summary": {
            "concentration_time_index": total, "unit": "µg·h/m³", "evaluated_blocks": len(evaluated), "excluded_blocks": len(excluded),
            "planned_hours": round(sum(block_hours(b) for b in request.blocks), 4), "outdoor_planned_hours": round(outdoor, 4),
            "supported_hours": round(supported, 4), "coverage_fraction": round(supported / outdoor, 4) if outdoor else 0,
        },
        "blocks": evaluated, "excluded": excluded, "recommendations": recommendations,
        "hourly": [],
        "provenance": {
            "provider": "Prana illustrative fixture", "model": None, "evidence_type": "illustrative_mock", "data_classification": "illustrative",
            "retrieved_at": None, "timezone": request.timezone, "coordinates": {"latitude": request.latitude, "longitude": request.longitude},
            "spatial_resolution_km": None, "native_temporal_resolution_hours": None, "units": "µg/m³", "is_live": False, "is_station_observation": False,
            "limitations": ["Values are illustrative fixtures, not live observations.", "The index is ambient concentration multiplied by time, not inhaled mass or individual health risk."],
        },
        "cigarette_equivalent": {"status": "disabled_methodology_unvalidated", "value": None},
    }


def analyze_request(request: DayAnalysisRequest, provider: OpenMeteoService | None = None) -> dict:
    if request.data_mode == "illustrative":
        return calculate_illustrative(request)
    try:
        series = (provider or open_meteo).fetch_hourly_pm25(request.latitude, request.longitude, request.date, request.timezone)
    except OpenMeteoError as error:
        return _unavailable_result(request, error)
    return calculate_live(request, series)


@app.get("/health")
def health():
    return {"status": "ok", "service": "prana-api", "version": app.version}


@app.post("/api/day/analyze")
def analyze_day(request: DayAnalysisRequest):
    return analyze_request(request)


@app.post("/api/scenarios/compare")
def compare_scenarios(request: ScenarioRequest):
    return _compare_scenarios(request)


def _compare_scenarios(request: ScenarioRequest, provider: OpenMeteoService | None = None):
    baseline = analyze_request(request.baseline, provider=provider)
    alternatives = [analyze_request(item, provider=provider) for item in request.alternatives]
    baseline_index = baseline["summary"]["concentration_time_index"]
    rows = []
    for index, result in enumerate(alternatives):
        baseline_blocks = {row["block_id"]: row for row in baseline["blocks"]}
        alternative_blocks = {row["block_id"]: row for row in result["blocks"]}
        compatible = (
            baseline["status"] not in {"unavailable"} and result["status"] not in {"unavailable"}
            and request.baseline.latitude == request.alternatives[index].latitude
            and request.baseline.longitude == request.alternatives[index].longitude
            and request.baseline.date == request.alternatives[index].date
            and baseline_blocks.keys() == alternative_blocks.keys()
            and all(
                baseline_blocks[key]["duration_hours"] == alternative_blocks[key]["duration_hours"]
                and baseline_blocks[key]["estimated_hours"] == alternative_blocks[key]["estimated_hours"]
                for key in baseline_blocks
            )
        )
        value = result["summary"]["concentration_time_index"]
        same_source = baseline["provenance"]["provider"] == result["provenance"]["provider"]
        comparable = compatible and same_source and baseline_index is not None and value is not None
        rows.append({
            "scenario_index": index,
            "result": result,
            "difference_ug_h_m3": round(baseline_index - value, 4) if comparable else None,
            "status": "inconclusive" if comparable and request.baseline.data_mode == "live" else "illustrative_only" if comparable else "unavailable",
            "comparison_note": "Forecast/model uncertainty is not quantified here; the numerical difference does not establish a personal exposure or health-risk change." if comparable else "The plans do not have matching supported intervals and coverage.",
        })
    return {"baseline": baseline, "alternatives": rows, "applied": False}


@app.post("/api/impact/records")
def record_impact(request: FeedbackRequest):
    return {"record_id": str(uuid4()), "record": request.model_dump(), "storage": "request_only_no_server_persistence"}


@app.post("/api/impact/summary")
def impact_summary():
    return {"period_days": 7, "records": [], "message": "No server-side impact history is stored in this prototype."}


@app.post("/api/reports/end-of-day")
def end_of_day(request: DayAnalysisRequest):
    result = analyze_request(request)
    result["report_status"] = "provisional"
    result["cigarette_equivalent"] = {"status": "disabled_methodology_unvalidated", "value": None}
    return result


@app.post("/api/explanations")
def explain(payload: ExplanationRequest):
    return bedrock_explanations.explain(payload)

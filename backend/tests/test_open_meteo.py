import unittest
import json
from datetime import date, datetime, time, timedelta
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from threading import Thread
from zoneinfo import ZoneInfo

import httpx
from pydantic import ValidationError
from unittest.mock import patch

from app.main import DayAnalysisRequest, Environment, Flexibility, PlanBlock, ScenarioRequest, _compare_scenarios, analyze_request, calculate_live
from app.services.open_meteo import HourlySample, HourlySeries, OpenMeteoError, OpenMeteoService


ZONE = ZoneInfo("Asia/Kolkata")
TODAY = datetime.now(ZONE).date()


def response_payload(times, values, unit="μg/m³"):
    return {"timezone": "Asia/Kolkata", "utc_offset_seconds": 19800,
            "hourly_units": {"time": "unixtime", "pm2_5": unit},
            "hourly": {"time": times, "pm2_5": values}}


def request_for(blocks, data_mode="live", target_date=TODAY):
    return DayAnalysisRequest(date=target_date, timezone="Asia/Kolkata", data_mode=data_mode, blocks=blocks)


def outdoor(start="12:30", end="14:30", pm25=None):
    return PlanBlock(id="run", title="Run", start=time.fromisoformat(start), end=time.fromisoformat(end),
                     environment=Environment.outdoor, flexibility=Flexibility.flexible, pm25=pm25)


class OpenMeteoAdapterTests(unittest.TestCase):
    def test_provider_request_ignores_stale_process_proxy_settings(self):
        timestamp = int(datetime.combine(TODAY, time(12), ZONE).timestamp())
        payload = json.dumps(response_payload([timestamp], [24.0])).encode()

        class Handler(BaseHTTPRequestHandler):
            def do_GET(self):
                self.send_response(200)
                self.send_header("Content-Type", "application/json")
                self.send_header("Content-Length", str(len(payload)))
                self.end_headers()
                self.wfile.write(payload)

            def log_message(self, *_args):
                pass

        server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        thread = Thread(target=server.serve_forever, daemon=True)
        thread.start()
        try:
            with patch.dict("os.environ", {
                "HTTP_PROXY": "http://127.0.0.1:9", "HTTPS_PROXY": "http://127.0.0.1:9",
                "ALL_PROXY": "http://127.0.0.1:9", "http_proxy": "http://127.0.0.1:9",
                "https_proxy": "http://127.0.0.1:9", "all_proxy": "http://127.0.0.1:9",
                "NO_PROXY": "", "no_proxy": "",
            }), patch("app.services.open_meteo.ENDPOINT", f"http://127.0.0.1:{server.server_port}/air-quality"):
                result = OpenMeteoService().fetch_hourly_pm25(28.6139, 77.209, TODAY, "Asia/Kolkata")
        finally:
            server.shutdown()
            server.server_close()
            thread.join(timeout=2)

        self.assertEqual(result.samples[0].pm25_ug_m3, 24.0)

    def test_connection_failure_logs_diagnostic_without_request_coordinates(self):
        service = OpenMeteoService(httpx.MockTransport(
            lambda request: (_ for _ in ()).throw(httpx.ConnectError("connection refused", request=request))
        ))
        with self.assertLogs("app.services.open_meteo", level="WARNING") as captured:
            with self.assertRaises(OpenMeteoError) as context:
                service.fetch_hourly_pm25(28.6139, 77.209, TODAY, "Asia/Kolkata")

        self.assertEqual(context.exception.code, "provider_unavailable")
        diagnostic = " ".join(captured.output)
        self.assertIn("exception_type=ConnectError", diagnostic)
        self.assertIn("endpoint_host=air-quality-api.open-meteo.com", diagnostic)
        self.assertNotIn("28.6139", diagnostic)
        self.assertNotIn("77.209", diagnostic)

    def test_success_uses_explicit_global_domain_and_parses_units_and_timezone(self):
        local_times = [datetime.combine(TODAY, time(hour), ZONE) for hour in range(24)]
        timestamps = [int(item.timestamp()) for item in local_times]
        requested = []

        def handler(request):
            requested.append(request)
            return httpx.Response(200, json=response_payload(timestamps, [15.0] * 24))

        series = OpenMeteoService(httpx.MockTransport(handler)).fetch_hourly_pm25(28.6139, 77.209, TODAY, "Asia/Kolkata")
        params = dict(requested[0].url.params)
        self.assertEqual(requested[0].url.host, "air-quality-api.open-meteo.com")
        self.assertEqual(params["domains"], "cams_global")
        self.assertEqual(params["hourly"], "pm2_5")
        self.assertEqual(params["timeformat"], "unixtime")
        self.assertEqual(series.samples[0].timestamp.hour, 0)
        self.assertEqual(series.samples[0].timestamp.tzinfo, ZONE)
        self.assertEqual(series.samples[0].pm25_ug_m3, 15)
        self.assertEqual(series.units, "µg/m³")

    def test_missing_values_and_short_arrays_are_preserved_as_missing(self):
        payload = response_payload([1_791_598_800, 1_791_602_400], [None])
        series = OpenMeteoService._parse_response(payload, ZONE, "Asia/Kolkata")
        self.assertTrue(series.partial_response)
        self.assertEqual([sample.pm25_ug_m3 for sample in series.samples], [None, None])

    def test_malformed_units_and_excess_values_are_rejected(self):
        with self.assertRaises(OpenMeteoError) as unit_error:
            OpenMeteoService._parse_response(response_payload([1_791_598_800], [10], "ppm"), ZONE, "Asia/Kolkata")
        self.assertEqual(unit_error.exception.code, "unexpected_units")
        with self.assertRaises(OpenMeteoError) as shape_error:
            OpenMeteoService._parse_response(response_payload([1_791_598_800], [10, 11]), ZONE, "Asia/Kolkata")
        self.assertEqual(shape_error.exception.code, "malformed_response")

    def test_invalid_or_missing_timestamps_are_rejected(self):
        with self.assertRaises(OpenMeteoError):
            OpenMeteoService._parse_response(response_payload(["not-a-timestamp"], [10]), ZONE, "Asia/Kolkata")

    def test_interval_integration_respects_local_hours_and_missing_hours(self):
        start = datetime.combine(TODAY, time(12), ZONE)
        series = HourlySeries(tuple(
            HourlySample(start + timedelta(hours=i), value)
            for i, value in enumerate([10.0, 20.0, None, 40.0])
        ), "Asia/Kolkata", "µg/m³", datetime.now().astimezone())
        request = request_for([outdoor()])
        result = calculate_live(request, series)
        block = result["blocks"][0]
        self.assertEqual(block["concentration_time_index_ug_h_m3"], 25)
        self.assertEqual(block["estimated_hours"], 1.5)
        self.assertEqual(block["missing_hours"], 0.5)
        self.assertEqual(block["coverage_fraction"], 0.75)
        self.assertEqual(result["summary"]["coverage_fraction"], 0.75)

    def test_live_flexible_block_gets_neutral_prompt_at_low_concentration(self):
        start = datetime.combine(TODAY, time(12), ZONE)
        series = HourlySeries(tuple(
            HourlySample(start + timedelta(hours=i), 8.0)
            for i in range(3)
        ), "Asia/Kolkata", "µg/m³", datetime.now().astimezone())
        result = calculate_live(request_for([outdoor("12:00", "13:00")]), series)
        self.assertEqual(result["recommendations"][0]["status"], "comparison_prompt")
        self.assertIn("marked flexible", result["recommendations"][0]["reason"])
        self.assertNotIn("higher", result["recommendations"][0]["reason"])

    def test_activity_outside_returned_time_series_is_excluded_not_zero_filled(self):
        start = datetime.combine(TODAY, time(12), ZONE)
        series = HourlySeries((HourlySample(start, 18.0),), "Asia/Kolkata", "µg/m³", datetime.now().astimezone())
        result = calculate_live(request_for([outdoor("18:00", "19:00")]), series)
        self.assertEqual(result["blocks"], [])
        self.assertEqual(result["excluded"][0]["reason"], "outside_available_window")
        self.assertIsNone(result["summary"]["concentration_time_index"])
        self.assertEqual(result["summary"]["coverage_fraction"], 0)

    def test_out_of_range_dates_are_unavailable_without_provider_call(self):
        called = []
        def handler(request):
            called.append(request)
            return httpx.Response(200, json={})
        service = OpenMeteoService(httpx.MockTransport(handler))
        old_date = datetime.now(ZONE).date() - timedelta(days=100)
        with self.assertRaises(OpenMeteoError) as context:
            service.fetch_hourly_pm25(28.6139, 77.209, old_date, "Asia/Kolkata")
        self.assertEqual(context.exception.code, "outside_available_window")
        self.assertEqual(called, [])

    def test_provider_timeout_and_rate_limit_are_classified(self):
        timeout_service = OpenMeteoService(httpx.MockTransport(lambda request: (_ for _ in ()).throw(httpx.ReadTimeout("timeout"))))
        with self.assertRaises(OpenMeteoError) as timeout:
            timeout_service.fetch_hourly_pm25(28.6139, 77.209, TODAY, "Asia/Kolkata")
        self.assertEqual(timeout.exception.code, "provider_timeout")

        rate_service = OpenMeteoService(httpx.MockTransport(lambda request: httpx.Response(429)))
        with self.assertRaises(OpenMeteoError) as rate:
            rate_service.fetch_hourly_pm25(28.6139, 77.209, TODAY, "Asia/Kolkata")
        self.assertEqual(rate.exception.code, "rate_limited")

    def test_live_mode_ignores_fixture_pm25_and_unavailable_never_uses_fixture(self):
        timestamps = [int(datetime.combine(TODAY, time(hour), ZONE).timestamp()) for hour in range(24)]
        service = OpenMeteoService(httpx.MockTransport(lambda request: httpx.Response(200, json=response_payload(timestamps, [20.0] * 24))))
        result = analyze_request(request_for([outdoor("12:00", "13:00", pm25=999)]), provider=service)
        self.assertEqual(result["blocks"][0]["mean_pm25_ug_m3"], 20)
        self.assertEqual(result["provenance"]["evidence_type"], "modelled_forecast")

        failing_service = OpenMeteoService(httpx.MockTransport(lambda request: httpx.Response(503)))
        unavailable = analyze_request(request_for([outdoor("12:00", "13:00", pm25=999)]), provider=failing_service)
        self.assertEqual(unavailable["status"], "unavailable")
        self.assertIsNone(unavailable["summary"]["concentration_time_index"])
        self.assertEqual(unavailable["blocks"], [])

    def test_live_and_illustrative_scenarios_cannot_be_mixed(self):
        live = request_for([outdoor()])
        demo = request_for([outdoor()], data_mode="illustrative")
        from app.main import ScenarioRequest
        with self.assertRaises(ValidationError):
            ScenarioRequest(baseline=live, alternatives=[demo])

    def test_scenario_comparison_uses_matching_provider_series_and_stays_inconclusive(self):
        timestamps = [int(datetime.combine(TODAY, time(hour), ZONE).timestamp()) for hour in range(24)]
        values = [25.0 if hour == 11 else 90.0 if hour == 12 else 30.0 for hour in range(24)]
        service = OpenMeteoService(httpx.MockTransport(
            lambda request: httpx.Response(200, json=response_payload(timestamps, values))
        ))
        baseline = request_for([outdoor("12:00", "13:00")])
        alternative = request_for([outdoor("11:00", "12:00")])
        response = _compare_scenarios(ScenarioRequest(baseline=baseline, alternatives=[alternative]), provider=service)
        comparison = response["alternatives"][0]
        self.assertEqual(comparison["difference_ug_h_m3"], 65)
        self.assertEqual(comparison["status"], "inconclusive")
        self.assertFalse(response["applied"])
        self.assertEqual(comparison["result"]["provenance"]["evidence_type"], "modelled_forecast")


if __name__ == "__main__":
    unittest.main()

import asyncio
import json
import os
import unittest
from types import SimpleNamespace
from unittest.mock import Mock, patch

from httpx import ASGITransport, AsyncClient

import app.main as api
from app.services.gemini import GeminiExplanationService, ExplanationRecommendation, ExplanationRequest


def explanation_request(data_mode="live", scenario=None):
    return ExplanationRequest.model_validate({
        "analysis": {
            "status": "partial",
            "data_mode": data_mode,
            "summary": {
                "concentration_time_index": 82.5,
                "evaluated_blocks": 1,
                "excluded_blocks": 2,
                "planned_hours": 8.0,
                "outdoor_planned_hours": 1.0,
                "supported_hours": 0.75,
                "coverage_fraction": 0.75,
            },
            "blocks": [{
                "block_id": "run-123",
                "mean_pm25_ug_m3": 110.0,
                "estimated_hours": 0.75,
                "missing_hours": 0.25,
                "coverage_fraction": 0.75,
            }],
            "excluded": [{"block_id": "commute-456", "reason": "mixed_ambient_concentration_not_estimated"}],
            "recommendations": [{"kind": "compare_alternative_window", "status": "inconclusive"}],
            "provenance": {
                "provider": "Open-Meteo Air Quality API",
                "model": "CAMS Global atmospheric composition forecast",
                "evidence_type": "modelled_forecast",
                "data_classification": "forecast",
                "spatial_resolution_km": 45,
                "native_temporal_resolution_hours": 3,
                "is_station_observation": False,
            },
        },
        "activities": [{
            "block_id": "run-123", "start": "17:00", "end": "18:00",
            "environment": "outdoor", "flexibility": "flexible",
        }],
        "scenario": scenario,
    })


def generate_response(text):
    return SimpleNamespace(text=text)


class GeminiExplanationTests(unittest.TestCase):
    def test_environment_selects_api_key_and_model_and_sdk_timeout(self):
        from google.genai import types

        with patch.dict(os.environ, {"GEMINI_API_KEY": "test-env-key", "GEMINI_MODEL": "gemini-test-flash"}):
            service = GeminiExplanationService()
        self.assertEqual(service.api_key, "test-env-key")
        self.assertEqual(service.model, "gemini-test-flash")
        with patch("google.genai.Client") as sdk_client:
            service._client()
        sdk_client.assert_called_once()
        kwargs = sdk_client.call_args.kwargs
        self.assertEqual(kwargs["api_key"], "test-env-key")
        self.assertIsInstance(kwargs["http_options"], types.HttpOptions)
        self.assertEqual(kwargs["http_options"].timeout, 12_000)

    def test_comparison_prompt_status_is_valid_explanation_context(self):
        recommendation = ExplanationRecommendation(kind="compare_alternative_window", status="comparison_prompt")
        self.assertEqual(recommendation.status, "comparison_prompt")

    def test_generate_content_receives_aggregate_context_and_returns_valid_structure(self):
        client = Mock()
        client.models.generate_content.return_value = generate_response(json.dumps({
            "headline": "Partial plan estimate",
            "explanation": "Some planned outdoor time has supported estimates; other periods remain unknown.",
        }))
        service = GeminiExplanationService(client=client, api_key="test-key", model="sample-model")

        result = service.explain(explanation_request())

        self.assertEqual(result["provider"], "gemini")
        self.assertEqual(result["status"], "generated")
        self.assertEqual(result["next_step"], "Review coverage and missing intervals before using the comparison.")
        call = client.models.generate_content.call_args.kwargs
        self.assertEqual(call["model"], "sample-model")
        self.assertEqual(call["config"]["max_output_tokens"], 220)
        context = json.loads(call["contents"])
        self.assertEqual(context["summary"]["coverage_fraction"], 0.75)
        self.assertEqual(context["source"]["provider"], "Open-Meteo Air Quality API")
        self.assertEqual(context["recommendations"][0]["status"], "inconclusive")
        self.assertEqual(context["excluded_reason_counts"], {"mixed_ambient_concentration_not_estimated": 1})
        serialized = json.dumps(context)
        self.assertNotIn("coordinates", serialized)
        self.assertNotIn("latitude", serialized)
        self.assertNotIn("location", serialized)
        self.assertNotIn("run-123", serialized)
        self.assertNotIn("110.0", serialized)
        self.assertNotIn("17:00", serialized)
        self.assertNotIn("concentration_time_index", serialized)

    def test_unconfigured_gemini_uses_fallback_without_creating_sdk_client(self):
        client = Mock()
        with patch.dict(os.environ, {"GEMINI_API_KEY": "", "GEMINI_MODEL": ""}):
            with self.assertLogs("app.services.gemini", level="WARNING") as captured:
                result = GeminiExplanationService(client=client).explain(explanation_request())
        self.assertEqual(result["provider"], "deterministic_fallback")
        self.assertEqual(result["status"], "fallback")
        self.assertIn("GEMINI_API_KEY is not configured", captured.output[0])
        client.models.generate_content.assert_not_called()

    def test_no_deterministic_recommendation_uses_fallback(self):
        client = Mock()
        request = explanation_request()
        request.analysis.recommendations = []
        result = GeminiExplanationService(client=client, api_key="test-key").explain(request)
        self.assertEqual(result["provider"], "deterministic_fallback")
        client.models.generate_content.assert_not_called()

    def test_gemini_exception_and_malformed_response_use_fallback(self):
        for reply in [RuntimeError("offline"), SimpleNamespace(text=None), generate_response("not json")]:
            client = Mock()
            if isinstance(reply, Exception):
                client.models.generate_content.side_effect = reply
            else:
                client.models.generate_content.return_value = reply
            result = GeminiExplanationService(client=client, api_key="test-key", model="sample-model").explain(explanation_request())
            self.assertEqual(result["provider"], "deterministic_fallback")
            self.assertEqual(result["status"], "fallback")

    def test_numeric_or_unsupported_model_text_is_rejected(self):
        for explanation in ["The estimate is 110 for this period.", "The model identified two periods.", "This option is cleaner and safer for your health.", "This option has a lower result.", "This option is less polluted.", "This will protect your lungs."]:
            client = Mock()
            client.models.generate_content.return_value = generate_response(json.dumps({
                "headline": "Plan overview",
                "explanation": explanation,
            }))
            result = GeminiExplanationService(client=client, api_key="test-key", model="sample-model").explain(explanation_request(scenario={"status": "inconclusive", "difference_ug_h_m3": 70}))
            self.assertEqual(result["provider"], "deterministic_fallback")

    def test_pollutant_name_is_allowed_but_not_a_numeric_value(self):
        client = Mock()
        client.models.generate_content.return_value = generate_response(json.dumps({
            "headline": "Plan estimate summary",
            "explanation": "PM2.5 estimates cover some outdoor time; other periods remain unknown.",
        }))
        result = GeminiExplanationService(client=client, api_key="test-key", model="sample-model").explain(explanation_request())
        self.assertEqual(result["provider"], "gemini")

    def test_fastapi_explanation_route_accepts_typed_request_and_returns_stable_shape(self):
        client = Mock()
        client.models.generate_content.return_value = generate_response(json.dumps({
            "headline": "Plan estimate summary",
            "explanation": "Supported outdoor periods are summarized; missing periods remain unknown.",
        }))
        previous = api.explanation_service
        api.explanation_service = GeminiExplanationService(client=client, api_key="test-key", model="sample-model")
        try:
            async def post_explanation():
                async with AsyncClient(transport=ASGITransport(app=api.app), base_url="http://test") as test_client:
                    return await test_client.post("/api/explanations", json=explanation_request().model_dump(mode="json"))

            response = asyncio.run(post_explanation())
        finally:
            api.explanation_service = previous
        self.assertEqual(response.status_code, 200)
        body = response.json()
        self.assertEqual(body["provider"], "gemini")
        self.assertEqual(body["status"], "generated")
        self.assertEqual(set(body), {"headline", "explanation", "next_step", "scenario_explanation", "scenario_status", "provider", "status"})

    def test_inconclusive_scenario_uses_fixed_noncomparative_message(self):
        client = Mock()
        client.models.generate_content.return_value = generate_response(json.dumps({
            "headline": "Scenario estimate",
            "explanation": "The calculation summarizes supported outdoor periods and leaves missing periods unknown.",
        }))
        scenario = {"status": "inconclusive", "difference_ug_h_m3": 70}
        result = GeminiExplanationService(client=client, api_key="test-key", model="sample-model").explain(explanation_request(scenario=scenario))
        self.assertEqual(result["scenario_status"], "inconclusive")
        self.assertEqual(result["scenario_explanation"], "The available data cannot establish a meaningful difference between these options.")
        prompt = json.loads(client.models.generate_content.call_args.kwargs["contents"])
        self.assertEqual(prompt["scenario_status"], "inconclusive")

    def test_illustrative_mode_never_calls_gemini(self):
        client = Mock()
        result = GeminiExplanationService(client=client, api_key="test-key", model="sample-model").explain(explanation_request("illustrative"))
        self.assertEqual(result["provider"], "deterministic_fallback")
        client.models.generate_content.assert_not_called()


    def test_fastapi_insights_route_alias_returns_identical_structure(self):
        client = Mock()
        client.models.generate_content.return_value = generate_response(json.dumps({
            "headline": "Plan estimate summary",
            "explanation": "Supported outdoor periods are summarized; missing periods remain unknown.",
        }))
        previous = api.explanation_service
        api.explanation_service = GeminiExplanationService(client=client, api_key="test-key", model="sample-model")
        try:
            async def post_insights():
                async with AsyncClient(transport=ASGITransport(app=api.app), base_url="http://test") as test_client:
                    return await test_client.post("/api/insights", json=explanation_request().model_dump(mode="json"))

            response = asyncio.run(post_insights())
        finally:
            api.explanation_service = previous
        self.assertEqual(response.status_code, 200)
        body = response.json()
        self.assertEqual(body["provider"], "gemini")
        self.assertEqual(body["status"], "generated")

    def test_fastapi_insights_route_rejects_invalid_payload_with_422(self):
        async def post_invalid():
            async with AsyncClient(transport=ASGITransport(app=api.app), base_url="http://test") as test_client:
                return await test_client.post("/api/insights", json={"analysis": {"invalid": True}})

        response = asyncio.run(post_invalid())
        self.assertEqual(response.status_code, 422)


if __name__ == "__main__":
    unittest.main()

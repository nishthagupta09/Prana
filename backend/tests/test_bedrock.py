import asyncio
import json
import os
import unittest
from unittest.mock import Mock, patch

from httpx import ASGITransport, AsyncClient

import app.main as api
from app.services.bedrock import BedrockExplanationService, ExplanationRecommendation, ExplanationRequest


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


def converse_response(text):
    return {"output": {"message": {"content": [{"text": text}]}}}


class BedrockExplanationTests(unittest.TestCase):
    def test_comparison_prompt_status_is_valid_explanation_context(self):
        recommendation = ExplanationRecommendation(kind="compare_alternative_window", status="comparison_prompt")
        self.assertEqual(recommendation.status, "comparison_prompt")

    def test_converse_receives_compact_calculated_context_and_returns_valid_structure(self):
        client = Mock()
        client.converse.return_value = converse_response(json.dumps({
            "headline": "Partial plan estimate",
            "explanation": "Some planned outdoor time has supported estimates; other periods remain unknown.",
            "next_step": "Review missing periods before comparing your schedule.",
        }))
        service = BedrockExplanationService(client=client, region="us-east-1", model_id="sample-model")

        result = service.explain(explanation_request())

        self.assertEqual(result["provider"], "bedrock")
        self.assertEqual(result["status"], "generated")
        call = client.converse.call_args.kwargs
        self.assertEqual(call["modelId"], "sample-model")
        self.assertEqual(call["inferenceConfig"]["maxTokens"], 220)
        context = json.loads(call["messages"][0]["content"][0]["text"])
        self.assertEqual(context["summary"]["coverage_fraction"], 0.75)
        self.assertEqual(context["source"]["model"], "CAMS Global atmospheric composition forecast")
        self.assertEqual(context["activities"][0]["flexibility"], "flexible")
        self.assertEqual(context["activities"][0]["missing_hours"], 0.25)
        self.assertEqual(context["excluded_activity_reasons"], ["mixed_ambient_concentration_not_estimated"])
        serialized = json.dumps(context)
        self.assertNotIn("coordinates", serialized)
        self.assertNotIn("latitude", serialized)
        self.assertNotIn("location", serialized)
        self.assertNotIn("run-123", serialized)

    def test_unconfigured_bedrock_uses_fallback_without_creating_sdk_client(self):
        client = Mock()
        with patch.dict(os.environ, {"AWS_REGION": "", "AWS_DEFAULT_REGION": "", "BEDROCK_MODEL_ID": ""}):
            result = BedrockExplanationService(client=client).explain(explanation_request())
        self.assertEqual(result["provider"], "deterministic_fallback")
        self.assertEqual(result["status"], "fallback")
        client.converse.assert_not_called()

    def test_bedrock_exception_and_malformed_response_use_fallback(self):
        for reply in [RuntimeError("offline"), {"output": {"message": {"content": []}}}, converse_response("not json")]:
            client = Mock()
            if isinstance(reply, Exception):
                client.converse.side_effect = reply
            else:
                client.converse.return_value = reply
            result = BedrockExplanationService(client=client, region="us-east-1", model_id="sample-model").explain(explanation_request())
            self.assertEqual(result["provider"], "deterministic_fallback")
            self.assertEqual(result["status"], "fallback")

    def test_numeric_or_unsupported_model_text_is_rejected(self):
        for explanation in ["The estimate is 110 for this period.", "The model identified two periods.", "This option is cleaner and safer for your health.", "This option has a lower result.", "This option is less polluted.", "This will protect your lungs."]:
            client = Mock()
            client.converse.return_value = converse_response(json.dumps({
                "headline": "Plan overview",
                "explanation": explanation,
                "next_step": "Review the available source details.",
            }))
            result = BedrockExplanationService(client=client, region="us-east-1", model_id="sample-model").explain(explanation_request(scenario={"status": "inconclusive", "difference_ug_h_m3": 70}))
            self.assertEqual(result["provider"], "deterministic_fallback")

    def test_pollutant_name_is_allowed_but_not_a_numeric_value(self):
        client = Mock()
        client.converse.return_value = converse_response(json.dumps({
            "headline": "Plan estimate summary",
            "explanation": "PM2.5 estimates cover some outdoor time; other periods remain unknown.",
            "next_step": "Review source coverage before comparing your plan.",
        }))
        result = BedrockExplanationService(client=client, region="us-east-1", model_id="sample-model").explain(explanation_request())
        self.assertEqual(result["provider"], "bedrock")

    def test_fastapi_explanation_route_accepts_typed_request_and_returns_stable_shape(self):
        client = Mock()
        client.converse.return_value = converse_response(json.dumps({
            "headline": "Plan estimate summary",
            "explanation": "Supported outdoor periods are summarized; missing periods remain unknown.",
            "next_step": "Review the source coverage details.",
        }))
        previous = api.bedrock_explanations
        api.bedrock_explanations = BedrockExplanationService(client=client, region="us-east-1", model_id="sample-model")
        try:
            async def post_explanation():
                async with AsyncClient(transport=ASGITransport(app=api.app), base_url="http://test") as test_client:
                    return await test_client.post("/api/explanations", json=explanation_request().model_dump(mode="json"))

            response = asyncio.run(post_explanation())
        finally:
            api.bedrock_explanations = previous
        self.assertEqual(response.status_code, 200)
        body = response.json()
        self.assertEqual(body["provider"], "bedrock")
        self.assertEqual(body["status"], "generated")
        self.assertEqual(set(body), {"headline", "explanation", "next_step", "scenario_explanation", "scenario_status", "provider", "status"})

    def test_inconclusive_scenario_uses_fixed_noncomparative_message(self):
        client = Mock()
        client.converse.return_value = converse_response(json.dumps({
            "headline": "Scenario estimate",
            "explanation": "The calculation summarizes supported outdoor periods and leaves missing periods unknown.",
            "next_step": "Review the source and coverage details.",
        }))
        scenario = {"status": "inconclusive", "difference_ug_h_m3": 70}
        result = BedrockExplanationService(client=client, region="us-east-1", model_id="sample-model").explain(explanation_request(scenario=scenario))
        self.assertEqual(result["scenario_status"], "inconclusive")
        self.assertEqual(result["scenario_explanation"], "The available data cannot establish a meaningful difference between these options.")
        prompt = json.loads(client.converse.call_args.kwargs["messages"][0]["content"][0]["text"])
        self.assertEqual(prompt["scenario"]["status"], "inconclusive")

    def test_illustrative_mode_never_calls_bedrock(self):
        client = Mock()
        result = BedrockExplanationService(client=client, region="us-east-1", model_id="sample-model").explain(explanation_request("illustrative"))
        self.assertEqual(result["provider"], "deterministic_fallback")
        client.converse.assert_not_called()


    def test_fastapi_insights_route_alias_returns_identical_structure(self):
        client = Mock()
        client.converse.return_value = converse_response(json.dumps({
            "headline": "Plan estimate summary",
            "explanation": "Supported outdoor periods are summarized; missing periods remain unknown.",
            "next_step": "Review the source coverage details.",
        }))
        previous = api.bedrock_explanations
        api.bedrock_explanations = BedrockExplanationService(client=client, region="us-east-1", model_id="sample-model")
        try:
            async def post_insights():
                async with AsyncClient(transport=ASGITransport(app=api.app), base_url="http://test") as test_client:
                    return await test_client.post("/api/insights", json=explanation_request().model_dump(mode="json"))

            response = asyncio.run(post_insights())
        finally:
            api.bedrock_explanations = previous
        self.assertEqual(response.status_code, 200)
        body = response.json()
        self.assertEqual(body["provider"], "bedrock")
        self.assertEqual(body["status"], "generated")

    def test_fastapi_insights_route_rejects_invalid_payload_with_422(self):
        async def post_invalid():
            async with AsyncClient(transport=ASGITransport(app=api.app), base_url="http://test") as test_client:
                return await test_client.post("/api/insights", json={"analysis": {"invalid": True}})

        response = asyncio.run(post_invalid())
        self.assertEqual(response.status_code, 422)


if __name__ == "__main__":
    unittest.main()

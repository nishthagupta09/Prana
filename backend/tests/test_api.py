import unittest
from datetime import date, time

from pydantic import ValidationError

from app.main import (
    DayAnalysisRequest,
    PlanBlock,
    ScenarioRequest,
    _unavailable_result,
    analyze_day,
    compare_scenarios,
    end_of_day,
)


def block(identifier, start, end, environment="outdoor", pm25=40, flexibility="flexible"):
    return PlanBlock(
        id=identifier,
        title=identifier,
        start=time.fromisoformat(start),
        end=time.fromisoformat(end),
        environment=environment,
        flexibility=flexibility,
        pm25=pm25,
    )


def plan(*blocks, data_mode="illustrative"):
    return DayAnalysisRequest(date=date(2026, 10, 10), timezone="Asia/Calcutta", data_mode=data_mode, blocks=list(blocks))


class CalculationAndApiTests(unittest.TestCase):
    def test_flexible_activity_gets_neutral_comparison_prompt_without_pollution_threshold(self):
        result = analyze_day(plan(
            block("flex-low", "08:00", "09:00", pm25=12, flexibility="flexible"),
            block("fixed-high", "10:00", "11:00", pm25=900, flexibility="fixed"),
        ))
        self.assertEqual([item["block_id"] for item in result["recommendations"]], ["flex-low"])
        prompt = result["recommendations"][0]
        self.assertEqual(prompt["status"], "illustrative_only")
        self.assertIn("marked flexible", prompt["reason"])
        self.assertNotIn("higher", prompt["reason"])
        self.assertNotIn("100", prompt["reason"])

    def test_concentration_time_index_uses_outdoor_values_only(self):
        result = analyze_day(plan(
            block("outside", "08:00", "09:30", pm25=40),
            block("inside", "10:00", "11:00", environment="indoor", pm25=500),
            block("missing", "11:00", "12:00", pm25=None),
        ))
        self.assertEqual(result["summary"]["concentration_time_index"], 60)
        self.assertEqual(result["summary"]["evaluated_blocks"], 1)
        self.assertEqual(result["summary"]["excluded_blocks"], 2)
        self.assertEqual(result["provenance"]["is_live"], False)

    def test_zero_duration_and_reversed_time_are_rejected(self):
        with self.assertRaises(ValidationError):
            block("zero", "09:00", "09:00")
        with self.assertRaises(ValidationError):
            block("reverse", "10:00", "09:00")

    def test_overlapping_blocks_and_duplicate_ids_are_rejected(self):
        with self.assertRaises(ValidationError):
            plan(block("first", "08:00", "10:00"), block("second", "09:30", "11:00"))
        with self.assertRaises(ValidationError):
            plan(block("same", "08:00", "09:00"), block("same", "09:00", "10:00"))

    def test_touching_intervals_are_allowed(self):
        request = plan(block("first", "08:00", "09:00"), block("next", "09:00", "10:00"))
        self.assertEqual(len(analyze_day(request)["blocks"]), 2)

    def test_scenario_comparison_is_inconclusive_for_mock_values(self):
        baseline = plan(block("run", "17:00", "18:00", pm25=180))
        alternative = plan(block("run", "16:00", "17:00", pm25=110))
        result = compare_scenarios(ScenarioRequest(baseline=baseline, alternatives=[alternative]))
        self.assertEqual(result["alternatives"][0]["difference_ug_h_m3"], 70)
        self.assertEqual(result["alternatives"][0]["status"], "illustrative_only")
        indoor = plan(block("run", "16:00", "17:00", environment="indoor", pm25=None))
        unavailable = compare_scenarios(ScenarioRequest(baseline=baseline, alternatives=[indoor]))
        self.assertIsNone(unavailable["alternatives"][0]["difference_ug_h_m3"])
        self.assertEqual(unavailable["alternatives"][0]["status"], "unavailable")

    def test_scenario_comparison_illustrative_identical_pm25_retains_illustrative_only_zero_difference(self):
        # When shifting time in illustrative mode, the copied fixture PM2.5 value produces difference 0.
        # It must retain status illustrative_only, never claiming measured improvement.
        baseline = plan(block("run", "17:30", "18:30", pm25=185), data_mode="illustrative")
        alternative = plan(block("run", "16:00", "17:00", pm25=185), data_mode="illustrative")
        result = compare_scenarios(ScenarioRequest(baseline=baseline, alternatives=[alternative]))
        alt = result["alternatives"][0]
        self.assertEqual(alt["status"], "illustrative_only")
        self.assertEqual(alt["difference_ug_h_m3"], 0)
        self.assertEqual(alt["result"]["blocks"][0]["mean_pm25_ug_m3"], 185)
        self.assertIn("Forecast/model uncertainty is not quantified here", alt["comparison_note"])

    def test_scenario_comparison_provider_outage_returns_unavailable_without_fabricated_values(self):
        from unittest.mock import Mock
        from app.main import _compare_scenarios
        from app.services.open_meteo import OpenMeteoError, OpenMeteoService

        failing_service = Mock(spec=OpenMeteoService)
        failing_service.fetch_hourly_pm25.side_effect = OpenMeteoError(code="upstream_503", message="Service Unavailable")

        baseline = plan(block("run", "17:30", "18:30"), data_mode="live")
        alternative = plan(block("run", "16:00", "17:00"), data_mode="live")
        req = ScenarioRequest(baseline=baseline, alternatives=[alternative])

        result = _compare_scenarios(req, provider=failing_service)
        self.assertEqual(result["baseline"]["status"], "unavailable")
        self.assertEqual(result["baseline"]["blocks"], [])
        self.assertIsNone(result["baseline"]["summary"]["concentration_time_index"])

        alt = result["alternatives"][0]
        self.assertEqual(alt["status"], "unavailable")
        self.assertIsNone(alt["difference_ug_h_m3"])
        self.assertEqual(alt["result"]["status"], "unavailable")
        self.assertEqual(alt["result"]["blocks"], [])
        self.assertIsNone(alt["result"]["summary"]["concentration_time_index"])
        self.assertIn("do not have matching supported intervals", alt["comparison_note"])
        self.assertFalse(result["applied"])

    def test_report_keeps_cigarette_equivalent_disabled(self):
        result = end_of_day(plan(block("run", "17:00", "18:00")))
        self.assertEqual(result["cigarette_equivalent"]["status"], "disabled_methodology_unvalidated")
        self.assertIsNone(result["cigarette_equivalent"]["value"])

    def test_multiple_flexible_activities_deterministic_ordering_and_plan_aware_text(self):
        result = analyze_day(plan(
            block("walk", "07:00", "07:30", pm25=50, flexibility="flexible"),
            block("run", "08:00", "09:00", pm25=30, flexibility="flexible"),
            block("cycle", "06:00", "07:00", pm25=40, flexibility="limited"),
        ))
        # Fully flexible ranked before limited; longer duration before shorter
        self.assertEqual([item["block_id"] for item in result["recommendations"]], ["run", "walk", "cycle"])
        recs = {item["block_id"]: item for item in result["recommendations"]}
        self.assertIn("'run' (08:00–09:00, 60 min) is an outdoor block marked flexible", recs["run"]["reason"])
        self.assertIn("'walk' (07:00–07:30, 30 min) is an outdoor block marked flexible", recs["walk"]["reason"])
        self.assertIn("'cycle' (06:00–07:00, 60 min) is an outdoor block marked limited", recs["cycle"]["reason"])

    def test_no_eligible_activities_returns_empty_recommendations(self):
        # All indoor
        indoor_result = analyze_day(plan(
            block("gym", "08:00", "09:00", environment="indoor", pm25=20, flexibility="flexible"),
            block("desk", "10:00", "12:00", environment="indoor", pm25=15, flexibility="flexible"),
        ))
        self.assertEqual(indoor_result["recommendations"], [])

        # Outdoor but all fixed
        fixed_result = analyze_day(plan(
            block("commute", "08:00", "09:00", environment="outdoor", pm25=50, flexibility="fixed"),
        ))
        self.assertEqual(fixed_result["recommendations"], [])

        # Outdoor flexible but missing pm25 in illustrative mode (excluded)
        missing_result = analyze_day(plan(
            block("run", "08:00", "09:00", environment="outdoor", pm25=None, flexibility="flexible"),
        ))
        self.assertEqual(missing_result["recommendations"], [])

    def test_unavailable_data_returns_empty_recommendations(self):
        from app.services.open_meteo import OpenMeteoError
        req = plan(block("run", "08:00", "09:00", environment="outdoor", pm25=40, flexibility="flexible"))
        res = _unavailable_result(req, OpenMeteoError(code="upstream_503", message="Service Unavailable"))
        self.assertEqual(res["status"], "unavailable")
        self.assertEqual(res["recommendations"], [])

    def test_deterministic_output_across_input_permutations(self):
        b1 = block("b-run", "08:00", "09:00", pm25=30, flexibility="flexible")
        b2 = block("a-walk", "07:00", "07:30", pm25=50, flexibility="flexible")
        result1 = analyze_day(plan(b1, b2))
        result2 = analyze_day(plan(b2, b1))
        self.assertEqual(
            [item["block_id"] for item in result1["recommendations"]],
            [item["block_id"] for item in result2["recommendations"]],
        )
        self.assertEqual(
            result1["recommendations"][0]["reason"],
            result2["recommendations"][0]["reason"],
        )


if __name__ == "__main__":
    unittest.main()

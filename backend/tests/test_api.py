import unittest
from datetime import date, time

from pydantic import ValidationError

from app.main import (
    DayAnalysisRequest,
    PlanBlock,
    ScenarioRequest,
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

    def test_report_keeps_cigarette_equivalent_disabled(self):
        result = end_of_day(plan(block("run", "17:00", "18:00")))
        self.assertEqual(result["cigarette_equivalent"]["status"], "disabled_methodology_unvalidated")
        self.assertIsNone(result["cigarette_equivalent"]["value"])


if __name__ == "__main__":
    unittest.main()

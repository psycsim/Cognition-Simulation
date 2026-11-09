"""Run with: cd backend && python -m unittest discover tests"""

import unittest
from types import SimpleNamespace

from utils.llm import extract_usage
from utils.pricing import (
    RUN_FEE_USD,
    compute_cost_for_model,
    compute_prompt_and_eval_cost,
    estimate_run_cost,
)


class PricingTests(unittest.TestCase):
    def test_gemini_aliases_bill_at_2_5_flash_rates(self):
        for name in ("gemini", "gemini-2.0-flash", "gemini-2.5-flash", ""):
            self.assertAlmostEqual(compute_cost_for_model(name, 1_000_000, 1_000_000), 2.80)

    def test_unknown_model_bills_at_highest_known_rate(self):
        with self.assertLogs("utils.pricing", level="WARNING"):
            cost = compute_cost_for_model("some-new-model", 1_000_000, 0)
        self.assertAlmostEqual(cost, 0.30)

    def test_prompt_and_eval_split(self):
        prompt, ev = compute_prompt_and_eval_cost(1_000_000, 0, 0, 1_000_000, "gemini")
        self.assertAlmostEqual(prompt, 0.30)
        self.assertAlmostEqual(ev, 2.50)

    def test_estimate_includes_fee_and_scales(self):
        est = estimate_run_cost(10, 5)
        self.assertAlmostEqual(est["expected"], 0.0007 * 50 + 0.0004 * 10 + RUN_FEE_USD, places=4)
        self.assertLess(est["low"], est["expected"])
        self.assertGreater(est["high"], est["expected"])
        self.assertGreater(estimate_run_cost(50, 5)["expected"], est["expected"])
        self.assertAlmostEqual(estimate_run_cost(0, 0)["expected"], RUN_FEE_USD)


class UsageTests(unittest.TestCase):
    def _msg(self, **meta):
        return SimpleNamespace(usage_metadata=meta)

    def test_thinking_tokens_count_as_output(self):
        # output_tokens excludes 900 thinking tokens; total includes them.
        usage = extract_usage(self._msg(input_tokens=1000, output_tokens=100, total_tokens=2000))
        self.assertEqual(usage["output_tokens"], 1000)
        self.assertEqual(usage["total_tokens"], 2000)

    def test_output_already_including_thinking_is_unchanged(self):
        usage = extract_usage(self._msg(input_tokens=1000, output_tokens=1000, total_tokens=2000))
        self.assertEqual(usage["output_tokens"], 1000)

    def test_missing_metadata(self):
        self.assertEqual(extract_usage(None)["total_tokens"], 0)
        self.assertEqual(extract_usage(SimpleNamespace(usage_metadata=None))["output_tokens"], 0)


if __name__ == "__main__":
    unittest.main()

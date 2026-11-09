"""
Pricing utility for LLM token cost calculation, run charges and estimates.

Rates are static and keyed by the canonical model ID the app actually calls
(see utils.llm.resolve_model_name). The app calls the Gemini *Developer* API
(google_api_key), so rates come from https://ai.google.dev/gemini-api/docs/pricing
(Standard / paid tier, text). Thinking tokens are billed at the output rate.
"""

import logging
from typing import Dict, Tuple

from utils.llm import resolve_model_name

logger = logging.getLogger(__name__)

# Static pricing table (USD per 1M tokens), keyed by canonical API model ID.
# Verified against ai.google.dev/gemini-api/docs/pricing on 2026-11-08.
MODEL_PRICING: Dict[str, Dict[str, float]] = {
    "gemini-2.5-flash": {"input_per_million": 0.30, "output_per_million": 2.50},
    # Future models — set correct rates when adding support:
    # "gpt-4o":            {"input_per_million": 2.50, "output_per_million": 10.00},
    # "claude-sonnet-...": {"input_per_million": 3.00, "output_per_million": 15.00},
}

# ---------------------------------------------------------------------------
# Billing policy
# ---------------------------------------------------------------------------
CREDITS_PER_USD = 100          # $1 = 100 credits (display unit)
RUN_FEE_USD = 0.05             # flat server fee added to every simulation run
MIN_BALANCE_USD = 1.00         # a user needs at least this much to start a run
FREE_GRANT_USD = 5.00          # free credits granted to every user

# Run-cost estimate, fitted against 128 completed runs in the `tokens` table
# (re-priced at gemini-2.5-flash rates):
#     cost ≈ EST_PER_SAMPLE_STEP * samples * steps + EST_PER_SAMPLE * samples
# Median relative error ~14%, p90 ~80% (thinking-token usage varies a lot),
# hence the wide low/high band.
EST_PER_SAMPLE_STEP = 0.0007
EST_PER_SAMPLE = 0.0004
EST_LOW_FACTOR = 0.6
EST_HIGH_FACTOR = 2.0


def _rates_for(model_name: str) -> Tuple[float, float]:
    """Return (input_rate, output_rate) in USD per token for a model."""
    canonical = resolve_model_name(model_name)
    rates = MODEL_PRICING.get(canonical)
    if rates is None:
        # Never under-bill an unknown model: use the most expensive known rate.
        rates = max(
            MODEL_PRICING.values(),
            key=lambda r: r["input_per_million"] + r["output_per_million"],
        )
        logger.warning(
            "Model %r (resolved %r) not in MODEL_PRICING; billing at highest known rate",
            model_name,
            canonical,
        )
    return rates["input_per_million"] / 1_000_000, rates["output_per_million"] / 1_000_000


def compute_cost_for_model(model_name: str, input_tokens: int, output_tokens: int) -> float:
    """Total token cost in USD for a given model."""
    input_rate, output_rate = _rates_for(model_name)
    return (input_tokens or 0) * input_rate + (output_tokens or 0) * output_rate


def compute_cost(input_tokens: int, output_tokens: int, model_name: str = "") -> float:
    """Token cost in USD (defaults to the app's default model)."""
    return compute_cost_for_model(model_name, input_tokens, output_tokens)


def compute_prompt_and_eval_cost(
    prompt_input: int,
    prompt_output: int,
    eval_input: int,
    eval_output: int,
    model_name: str = "",
) -> Tuple[float, float]:
    """Return (prompt_cost_usd, eval_cost_usd) for a given model."""
    prompt_cost = compute_cost_for_model(model_name, prompt_input, prompt_output)
    eval_cost = compute_cost_for_model(model_name, eval_input, eval_output)
    return round(prompt_cost, 6), round(eval_cost, 6)


def estimate_run_cost(num_samples: int, num_steps: int) -> Dict[str, float]:
    """
    Rough USD estimate (including RUN_FEE_USD) for a simulation run.
    Returns {"low", "expected", "high"}.
    """
    n = max(int(num_samples or 0), 0)
    s = max(int(num_steps or 0), 0)
    tokens = EST_PER_SAMPLE_STEP * n * s + EST_PER_SAMPLE * n
    return {
        "low": round(tokens * EST_LOW_FACTOR + RUN_FEE_USD, 4),
        "expected": round(tokens + RUN_FEE_USD, 4),
        "high": round(tokens * EST_HIGH_FACTOR + RUN_FEE_USD, 4),
    }


def pricing_params() -> Dict[str, float]:
    """Parameters the frontend needs to mirror estimates and conversions."""
    return {
        "credits_per_usd": CREDITS_PER_USD,
        "min_balance_usd": MIN_BALANCE_USD,
        "run_fee_usd": RUN_FEE_USD,
        "free_grant_usd": FREE_GRANT_USD,
        "est_per_sample_step": EST_PER_SAMPLE_STEP,
        "est_per_sample": EST_PER_SAMPLE,
        "est_low_factor": EST_LOW_FACTOR,
        "est_high_factor": EST_HIGH_FACTOR,
    }

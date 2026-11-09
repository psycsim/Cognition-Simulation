import { supabase } from "./supabase";

/**
 * Credits helpers. The backend (`GET /api/credits`) is the single source of
 * truth for balances and pricing parameters; balances are stored in USD and
 * shown to users as credits ($1 = `credits_per_usd` credits).
 */

export interface CreditsInfo {
  free_usd: number;
  paid_usd: number;
  total_usd: number;
  /** Expected cost of this user's runs that are still in progress. */
  reserved_usd: number;
  available_usd: number;
  credits_per_usd: number;
  min_balance_usd: number;
  run_fee_usd: number;
  free_grant_usd: number;
  est_per_sample_step: number;
  est_per_sample: number;
  est_low_factor: number;
  est_high_factor: number;
}

export interface RunEstimate {
  low: number;
  expected: number;
  high: number;
}

/** A "typical" run used to express balances as a number of runs. */
export const REFERENCE_RUN = { samples: 10, steps: 5 };

export const backendBaseUrl = (): string => {
  const prod = process.env.NEXT_PUBLIC_DEV || "production";
  return prod === "development"
    ? "http://127.0.0.1:5000"
    : "https://cognition-backend-81313456654.us-west1.run.app";
};

/** Fetch the signed-in user's balance + pricing params, or null on failure. */
export async function fetchCredits(): Promise<CreditsInfo | null> {
  try {
    const {
      data: { session },
    } = await supabase.auth.getSession();
    if (!session?.access_token) return null;
    const res = await fetch(`${backendBaseUrl()}/api/credits`, {
      headers: { Authorization: `Bearer ${session.access_token}` },
    });
    if (!res.ok) return null;
    return (await res.json()) as CreditsInfo;
  } catch (err) {
    console.error("Failed to fetch credits:", err);
    return null;
  }
}

export const usdToCredits = (usd: number, info?: Pick<CreditsInfo, "credits_per_usd"> | null): number =>
  usd * (info?.credits_per_usd ?? 100);

/** Format a USD amount as a whole-number credit string, e.g. "1,250". */
export const formatCredits = (usd: number, info?: Pick<CreditsInfo, "credits_per_usd"> | null): string =>
  Math.round(usdToCredits(usd, info)).toLocaleString("en-US");

/** Estimated USD cost of a run (mirrors backend utils/pricing.estimate_run_cost). */
export function estimateRunUsd(samples: number, steps: number, info: CreditsInfo): RunEstimate {
  const n = Math.max(0, Math.floor(samples || 0));
  const s = Math.max(0, Math.floor(steps || 0));
  const tokens = info.est_per_sample_step * n * s + info.est_per_sample * n;
  return {
    low: tokens * info.est_low_factor + info.run_fee_usd,
    expected: tokens + info.run_fee_usd,
    high: tokens * info.est_high_factor + info.run_fee_usd,
  };
}

/** Estimated credit cost of a run, rounded up to whole credits. */
export function estimateRunCredits(samples: number, steps: number, info: CreditsInfo): RunEstimate {
  const usd = estimateRunUsd(samples, steps, info);
  const c = (v: number) => Math.max(1, Math.ceil(usdToCredits(v, info)));
  return { low: c(usd.low), expected: c(usd.expected), high: c(usd.high) };
}

/** Approximate number of runs a USD amount covers, at a given run size. */
export function runsLeft(
  usd: number,
  info: CreditsInfo,
  run: { samples: number; steps: number } = REFERENCE_RUN
): number {
  const per = estimateRunUsd(run.samples, run.steps, info).expected;
  if (per <= 0) return 0;
  return Math.max(0, Math.floor(usd / per));
}

/** True when the user can start a run (enough available after in-progress runs). */
export const canRun = (info: CreditsInfo | null): boolean =>
  !!info && info.available_usd >= info.min_balance_usd;

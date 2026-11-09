"use client";

import React from "react";
import Link from "next/link";
import { Gift, AlertTriangle } from "lucide-react";
import { canRun, formatCredits, runsLeft, REFERENCE_RUN, type CreditsInfo } from "../utils/credits";

/** Below this many estimated free runs, the banner switches to a warning. */
const LOW_FREE_RUNS = 5;

/**
 * Thin full-width bar telling the user how many free runs they have left.
 * Renders nothing until credits have loaded.
 */
export default function CreditsBanner({ credits }: { credits: CreditsInfo | null }) {
  if (!credits) return null;

  const freeRuns = runsLeft(credits.free_usd, credits);
  const buyLink = (
    <Link href="/account?tab=billing" className="underline font-semibold whitespace-nowrap">
      Buy credits
    </Link>
  );
  const basis = `based on a ${REFERENCE_RUN.samples}-sample, ${REFERENCE_RUN.steps}-step run`;

  // Out of money entirely: can't run anything.
  if (!canRun(credits)) {
    return (
      <div className="w-full bg-red-50 border-b border-red-200 text-red-700 px-3 py-1.5 text-xs flex items-center justify-center gap-2">
        <AlertTriangle className="w-3.5 h-3.5 flex-shrink-0" />
        <span>
          You need at least {formatCredits(credits.min_balance_usd, credits)} credits to run a simulation
          {" "}(you have {formatCredits(Math.max(0, credits.available_usd), credits)} available). {buyLink}
        </span>
      </div>
    );
  }

  // Free credits used up, running on purchased credits.
  if (credits.free_usd <= 0.0001) {
    return (
      <div className="w-full bg-gray-50 border-b border-gray-200 text-gray-600 px-3 py-1.5 text-xs text-center">
        Free credits used up — runs now use your purchased credits ({formatCredits(credits.paid_usd, credits)} left).
      </div>
    );
  }

  const low = freeRuns < LOW_FREE_RUNS;
  return (
    <div
      className={`w-full border-b px-3 py-1.5 text-xs flex items-center justify-center gap-2 ${
        low ? "bg-amber-50 border-amber-200 text-amber-800" : "bg-blue-50 border-blue-100 text-blue-800"
      }`}
      title={`Estimate ${basis}. Larger runs use more credits.`}
    >
      <Gift className="w-3.5 h-3.5 flex-shrink-0" />
      <span>
        {low ? "Only " : "You have "}
        <strong>
          about {freeRuns} free run{freeRuns === 1 ? "" : "s"}
        </strong>{" "}
        left ({formatCredits(credits.free_usd, credits)} free credits, {basis}).
        {low && <> {buyLink}</>}
      </span>
    </div>
  );
}

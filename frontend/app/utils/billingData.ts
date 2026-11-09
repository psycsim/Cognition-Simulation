import { supabase } from "./supabase";

/**
 * Billing helpers for the Account → Billing tab.
 *
 * Every billed operation writes one row to the `tokens` table
 * (`backend/app.py`): simulations, step generation and PDF import. Each row
 * holds the token counts, the raw LLM token cost (`total_cost`) and, since
 * credits were introduced, what was actually deducted (`charged_amount`).
 * Simulations pay token cost + a flat server fee; other operations pay token
 * cost only.
 */

/**
 * Flat infrastructure fee added to every simulation on top of the raw token
 * cost. Kept as a single constant so the charge can be re-priced in one place.
 */
export const SERVER_FEE_PER_SIMULATION = 0.05;

const OPERATION_LABELS: Record<string, string> = {
  generate_steps: "AI step generation",
  parse_pdf: "PDF import",
};

export interface SimulationCharge {
  /** tokens.id (one row per billed operation). */
  id: string;
  /** tokens.operation: "simulation" | "generate_steps" | "parse_pdf". */
  operation: string;
  experimentId: string;
  title: string;
  /** Pre-formatted date for display, e.g. "Apr 5, 2026". */
  date: string;
  /** Raw ISO timestamp for sorting against credit purchases. */
  createdAt: string | null;
  promptInputToken: number;
  promptOutputToken: number;
  evalInputToken: number;
  evalOutputToken: number;
  totalTokens: number;
  /** Raw LLM token cost from tokens.total_cost (the "cost of tokens"). */
  tokenCost: number;
  /** Flat server/infrastructure fee for this simulation. */
  serverCost: number;
  /** What the user is charged (charged_amount when recorded). */
  totalCost: number;
  /** Portion of totalCost paid from free credits (null for older rows). */
  freePortion: number | null;
}

const formatDate = (iso: string | null): string => {
  if (!iso) return "";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  return d.toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
  });
};

const num = (value: unknown): number => {
  const n = typeof value === "string" ? parseFloat(value) : (value as number);
  return typeof n === "number" && !Number.isNaN(n) ? n : 0;
};

/**
 * Fetch every simulation charge for a user: the token usage/cost rows joined
 * with their experiment's title and creation date. Sorted newest-first.
 *
 * Returns `[]` if the `tokens` rows aren't readable (e.g. row-level security
 * hides them from the browser client) so the billing page degrades gracefully.
 */
export async function fetchSimulationCharges(
  userId: string
): Promise<SimulationCharge[]> {
  const { data: tokenRows, error } = await supabase
    .from("tokens")
    .select(
      "id, experiment_id, prompt_input_token, prompt_output_token, " +
        "eval_input_token, eval_output_token, total_tokens, total_cost, " +
        "operation, created_at, charged_amount, free_portion"
    )
    .eq("user_id", userId);

  if (error) {
    console.error("Error fetching simulation charges:", error);
    return [];
  }
  if (!tokenRows || tokenRows.length === 0) return [];

  // Pull the matching experiments for a human title + a real timestamp
  // (the tokens row itself has no title/date we can rely on).
  const experimentIds = Array.from(
    new Set(
      (tokenRows as any[])
        .map((r) => r.experiment_id)
        .filter((id): id is string => typeof id === "string" && id.length > 0)
    )
  );

  const expMeta = new Map<string, { title: string; createdAt: string | null }>();
  if (experimentIds.length > 0) {
    const { data: exps } = await supabase
      .from("experiments")
      .select("experiment_id, created_at, experiment_data, simulation_name")
      .in("experiment_id", experimentIds);
    for (const row of (exps ?? []) as any[]) {
      const expData = row.experiment_data || {};
      expMeta.set(row.experiment_id, {
        title: expData.title || row.simulation_name || "Simulation",
        createdAt: row.created_at ?? null,
      });
    }
  }

  const charges: SimulationCharge[] = (tokenRows as any[]).map((r) => {
    const operation: string = r.operation || "simulation";
    const isSimulation = operation === "simulation";
    const meta = expMeta.get(r.experiment_id) ?? {
      title: OPERATION_LABELS[operation] ?? "Simulation",
      createdAt: null,
    };
    const createdAt = meta.createdAt ?? r.created_at ?? null;
    const tokenCost = num(r.total_cost);
    const serverCost = isSimulation ? SERVER_FEE_PER_SIMULATION : 0;
    const charged = r.charged_amount == null ? null : num(r.charged_amount);
    return {
      id: String(r.id ?? r.experiment_id),
      operation,
      experimentId: r.experiment_id,
      title: meta.title,
      date: formatDate(createdAt),
      createdAt,
      promptInputToken: num(r.prompt_input_token),
      promptOutputToken: num(r.prompt_output_token),
      evalInputToken: num(r.eval_input_token),
      evalOutputToken: num(r.eval_output_token),
      totalTokens: num(r.total_tokens),
      tokenCost,
      serverCost,
      totalCost: charged ?? Math.round((tokenCost + serverCost) * 1e6) / 1e6,
      freePortion: r.free_portion == null ? null : num(r.free_portion),
    };
  });

  // Newest first; rows without a timestamp sink to the bottom.
  charges.sort((a, b) => {
    const ta = a.createdAt ? new Date(a.createdAt).getTime() : 0;
    const tb = b.createdAt ? new Date(b.createdAt).getTime() : 0;
    return tb - ta;
  });

  return charges;
}

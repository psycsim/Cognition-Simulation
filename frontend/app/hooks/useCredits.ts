import { useCallback, useEffect, useState } from "react";
import { fetchCredits, type CreditsInfo } from "../utils/credits";

/**
 * Loads the signed-in user's credit balance from the backend.
 * Call `refresh()` after anything that changes the balance (a run finishing,
 * a purchase). Refreshes automatically when the tab regains focus.
 */
export function useCredits(enabled: boolean = true) {
  const [credits, setCredits] = useState<CreditsInfo | null>(null);
  const [loading, setLoading] = useState<boolean>(enabled);

  const refresh = useCallback(async () => {
    const info = await fetchCredits();
    setCredits(info);
    setLoading(false);
    return info;
  }, []);

  useEffect(() => {
    if (!enabled) return;
    void refresh();
    const onFocus = () => void refresh();
    window.addEventListener("focus", onFocus);
    return () => window.removeEventListener("focus", onFocus);
  }, [enabled, refresh]);

  return { credits, loading, refresh };
}

/**
 * Tier → feature mapping. Single source of truth, deliberately in code rather
 * than the database so a feature rollout is a code change with review and
 * history, not a hand-edited row.
 *
 * Adding a future gated feature (e.g. add-to-cart) means adding ONE key here —
 * every gate reads `store.features.<name>`, so no new gating logic is needed
 * anywhere else.
 */
export const TIERS = {
  regular: { abandonedCart: false },
  premium: { abandonedCart: true },
};

export const DEFAULT_TIER = "regular";

export const VALID_TIERS = Object.keys(TIERS);

/** Feature set for a tier; unknown/missing tiers fall back to the safest one. */
export function featuresForTier(tier) {
  return { ...(TIERS[tier] ?? TIERS[DEFAULT_TIER]) };
}

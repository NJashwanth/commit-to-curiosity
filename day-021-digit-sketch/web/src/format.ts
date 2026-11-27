/** Small pure helpers for the readout. */

/** 0.9831 -> "98.3%". Tiny values show as "<0.1%" and exact ones as "100%" or "0%". */
export function formatPercent(p: number): string {
  if (!(p > 0)) return "0%";
  if (p >= 0.9995) return "100%";
  if (p < 0.001) return "<0.1%";
  return `${(p * 100).toFixed(1)}%`;
}

/** Digits ordered by probability, most likely first (ties keep digit order). */
export function ranking(probs: ArrayLike<number>): number[] {
  return Array.from({ length: probs.length }, (_, i) => i).sort((a, b) => probs[b] - probs[a] || a - b);
}

export type Verdict = "empty" | "unsure" | "likely" | "confident";

/** How much to trust a prediction, for the headline under the bars. */
export function verdict(confidence: number, empty: boolean): Verdict {
  if (empty) return "empty";
  if (confidence < 0.5) return "unsure";
  if (confidence < 0.9) return "likely";
  return "confident";
}

export function headline(label: number, confidence: number, empty: boolean): string {
  switch (verdict(confidence, empty)) {
    case "empty":
      return "Draw a digit";
    case "unsure":
      return `Not sure (best guess ${label})`;
    case "likely":
      return `Probably ${label}`;
    default:
      return `${label}`;
  }
}

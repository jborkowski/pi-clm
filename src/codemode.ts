/**
 * Typed programmatic interface for code-mode agents (issue #9).
 *
 * Code-mode sandboxes get structured JSON answers from the CLM classifier
 * instead of parsing rendered tool text. The surface mirrors the `px`
 * extension's `createPx` pattern: a small factory returning typed helpers
 * (`bool`, `choice`, `score`) that resolve to plain `ClmAnswer` objects and
 * compose naturally with `Promise.all`.
 *
 * The helpers reuse the extension's existing typed-question machinery (the
 * `typesafe-system-one` classify call); only the calling surface is new.
 */

import type { ClassifierContext, ClassifierQuestion, ClassifierResult, JsonObject } from "@earendil-works/pi-ai";

/** A structured answer over a set of labeled criteria. */
export interface ClmAnswer<T extends string = string> {
  /** The chosen criterion — "yes" | "no" for bool questions. */
  answer: T;
  /** Full probability distribution over the criteria keys. */
  probabilities: Record<T, number>;
  /** Probability of the chosen answer (0–1). */
  confidence: number;
  /** The question that was asked. */
  question: string;
}

export type ClmBoolAnswer = ClmAnswer<"yes" | "no">;

/** Score answers carry a numeric value; the wire protocol reports no distribution. */
export interface ClmScoreAnswer {
  answer: string;
  value: number;
  confidence: number;
  question: string;
}

/** Criteria labels for `score` when none are supplied: 1 (lowest) … 5 (highest). */
export const DEFAULT_SCORE_CRITERIA: readonly string[] = ["1", "2", "3", "4", "5"];

/** Minimal classify surface the helpers need (satisfied by the extension's classify wrapper). */
export type ClmClassify = (context: ClassifierContext) => Promise<ClassifierResult>;

function requireAnswer(result: ClassifierResult, key: string): NonNullable<ClassifierResult["answers"][string]> {
  if (result.stopReason === "error") {
    throw new Error(result.errorMessage ?? `classifier failed: ${JSON.stringify(result)}`);
  }
  const answer = result.answers?.[key];
  if (!answer) throw new Error(`classifier returned no answer for "${key}"`);
  return answer;
}

/** Pick the highest-probability key from a distribution. */
function argmax<T extends string>(probabilities: Record<T, number>): T {
  let best: T | undefined;
  let bestP = -1;
  for (const key of Object.keys(probabilities) as T[]) {
    const p = probabilities[key];
    if (p > bestP) {
      best = key;
      bestP = p;
    }
  }
  if (best === undefined) throw new Error("classifier returned an empty probability distribution");
  return best;
}

/**
 * Build the typed `clm` helpers over a classify function. Each call answers a
 * single question about `state` (defaulting to `{ message: question }`), so
 * calls are independent and compose with `Promise.all`.
 */
export function createClm(classify: ClmClassify) {
  const ask = (instructions: string, question: ClassifierQuestion, state?: JsonObject) =>
    classify({ state: state ?? { message: instructions }, questions: { q: question } });

  return {
    /** Ask a yes/no question; returns a ClmAnswer over "yes" | "no". */
    async bool(question: string, state?: JsonObject): Promise<ClmBoolAnswer> {
      const result = await ask(question, { type: "bool", instructions: question, criteria: { true: "yes", false: "no" } }, state);
      const answer = requireAnswer(result, "q");
      if (answer.type !== "bool") throw new Error(`expected a bool answer, got "${answer.type}"`);
      const yes = answer.probability;
      return {
        answer: yes > 0.5 ? "yes" : "no",
        probabilities: { yes, no: 1 - yes },
        confidence: Math.max(yes, 1 - yes),
        question,
      };
    },

    /** Ask a single-choice question over the given criteria; typed over the criteria keys. */
    async choice<T extends string>(
      question: string,
      criteria: Record<T, string>,
      state?: JsonObject,
    ): Promise<ClmAnswer<T>> {
      const result = await ask(question, { type: "choice", instructions: question, criteria }, state);
      const answer = requireAnswer(result, "q");
      if (answer.type !== "choice") throw new Error(`expected a choice answer, got "${answer.type}"`);
      const probabilities = answer.probabilities as Record<T, number>;
      const chosen = (answer.choice as T) in probabilities ? (answer.choice as T) : argmax(probabilities);
      return {
        answer: chosen,
        probabilities,
        confidence: probabilities[chosen] ?? 0,
        question,
      };
    },

    /** Ask for a score; criteria default to the labels "1"…"5". */
    async score(
      question: string,
      criteria: readonly (string | number)[] = DEFAULT_SCORE_CRITERIA,
      state?: JsonObject,
    ): Promise<ClmScoreAnswer> {
      const labels = criteria.map(String);
      const result = await ask(
        question,
        { type: "score", instructions: question, criteria: labels },
        state,
      );
      const answer = requireAnswer(result, "q");
      if (answer.type !== "score") throw new Error(`expected a score answer, got "${answer.type}"`);
      const index = Math.max(0, Math.min(labels.length - 1, Math.round(answer.score)));
      const label = labels[index];
      const numeric = Number(label);
      return {
        answer: label,
        value: Number.isFinite(numeric) ? numeric : index,
        confidence: answer.confidence,
        question,
      };
    },
  };
}

export type Clm = ReturnType<typeof createClm>;

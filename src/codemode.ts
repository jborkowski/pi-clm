/**
 * Typed judgment primitives for code-mode agents.
 *
 * One call judges one `state` — the evidence under consideration — against a
 * fan-out of independent, caller-labeled questions. Questions are a
 * discriminated union of three kinds (`bool`, `choice`, `score`), and every
 * answer carries its full probability distribution as first-class data:
 *
 * - `bool` answers report `probability` of true (0–1). No separate
 *   confidence: the probability is the whole story.
 * - `choice` answers report the chosen key plus the distribution, with a
 *   derived confidence of `(pmax - 1/n) / (1 - 1/n)` — 0 for a uniform
 *   distribution, 1 for certainty.
 * - `score` answers report the probability-weighted position across the
 *   ordered levels (normalized 0–1, so it can fall between levels), a legend
 *   mapping level positions to their texts, the distribution, and a derived
 *   confidence that accounts for the distance between levels: mass split
 *   between adjacent levels is less uncertain than mass split between
 *   extremes.
 *
 * What to do with a probability or confidence is application policy — these
 * primitives report distributions and never bake in thresholds.
 */

import type { ClassifierContext, ClassifierQuestion, ClassifierResult, JsonObject, JsonValue } from "@earendil-works/pi-ai";

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

/** Free-form field text: a string or a structured object. */
export type ClmText = string | Record<string, unknown>;

/**
 * The evidence being judged, given once per call. Plain objects pass through
 * as-is; scalars and arrays are wrapped so the classifier still sees labeled
 * text (`message` for scalars, `items` for arrays).
 */
export type ClmEvidence = string | number | boolean | Record<string, unknown> | unknown[];

/** Normalize any `ClmEvidence` into the object the classifier context requires. */
function normalizeState(state: ClmEvidence): JsonObject {
  if (typeof state === "object" && state !== null && !Array.isArray(state)) return state as JsonObject;
  if (Array.isArray(state)) return { items: state as JsonValue[] };
  return { message: state };
}

/** Render a criterion value as the text the classifier sees. */
function criterionText(value: ClmText | null | undefined): string {
  if (typeof value === "string") return value;
  if (value === null || value === undefined) return "";
  return JSON.stringify(value);
}

// ---------------------------------------------------------------------------
// Questions
// ---------------------------------------------------------------------------

/** A yes/no question; the answer reports P(true). */
export interface ClmBoolQuestion {
  kind: "bool";
  instructions: ClmText;
  criteria?: { true?: ClmText | null; false?: ClmText | null };
}

/** A single-choice question over caller-named criteria. */
export interface ClmChoiceQuestion {
  kind: "choice";
  instructions: ClmText;
  criteria: Record<string, ClmText | null>;
}

/** A scoring question over ordered levels (2–10, lowest to highest). */
export interface ClmScoreQuestion {
  kind: "score";
  instructions: ClmText;
  criteria: Array<ClmText>;
}

export type ClmQuestion = ClmBoolQuestion | ClmChoiceQuestion | ClmScoreQuestion;

/** A set of questions keyed by caller-chosen stable ids. */
export type ClmQuestionSet = Record<string, ClmQuestion>;

// ---------------------------------------------------------------------------
// Answers
// ---------------------------------------------------------------------------

export interface ClmBoolAnswer {
  kind: "bool";
  /** P(true), 0–1. */
  probability: number;
}

export interface ClmChoiceAnswer {
  kind: "choice";
  /** The highest-probability key. */
  choice: string;
  /** Full distribution over the criteria keys. */
  probabilities: Record<string, number>;
  /** `(pmax - 1/n) / (1 - 1/n)`: 0 for uniform, 1 for certain. */
  confidence: number;
}

export interface ClmScoreAnswer {
  kind: "score";
  /**
   * Probability-weighted position across the levels, normalized 0–1
   * (level `i` of `n` sits at `i / (n - 1)`), so it can fall between levels.
   */
  score: number;
  /** Level position → level text, for interpretation. */
  legend: Record<string, string>;
  /** Distribution over the level positions. */
  probabilities: Record<string, number>;
  /** Distance-aware confidence: adjacent splits count less than extreme splits. */
  confidence: number;
}

/** The answer type a question kind produces. */
export type ClmAnswerFor<Q extends ClmQuestion> =
  Q extends ClmBoolQuestion ? ClmBoolAnswer
  : Q extends ClmChoiceQuestion ? ClmChoiceAnswer
  : Q extends ClmScoreQuestion ? ClmScoreAnswer
  : never;

/** Answers keyed by the same ids as the questions. */
export type ClmAnswers<Q extends ClmQuestionSet> = { [K in keyof Q]: ClmAnswerFor<Q[K]> };

// ---------------------------------------------------------------------------
// Derived confidence
// ---------------------------------------------------------------------------

const clamp01 = (n: number): number => Math.max(0, Math.min(1, n));

/** Choice confidence: 0 for a uniform distribution, 1 for certainty. */
function choiceConfidence(probabilities: number[]): number {
  const n = probabilities.length;
  if (n < 2) return 1;
  const pmax = Math.max(...probabilities);
  return clamp01((pmax - 1 / n) / (1 - 1 / n));
}

/**
 * Score confidence: `1 - 2·sqrt(Σ p_i · d_i²)` where `d_i` is each level's
 * distance from the expected position on a 0–1 scale. All mass on one level
 * gives 1; a spread counts for more the farther apart the levels carrying it.
 */
function scoreConfidence(positions: number[], probabilities: number[], expected: number): number {
  let variance = 0;
  for (let i = 0; i < positions.length; i++) variance += probabilities[i] * (positions[i] - expected) ** 2;
  return clamp01(1 - 2 * Math.sqrt(variance));
}

// ---------------------------------------------------------------------------
// Wire translation
// ---------------------------------------------------------------------------

function instructionText(instructions: ClmText): string {
  return typeof instructions === "string" ? instructions : JSON.stringify(instructions);
}

/**
 * Translate a question to the classifier wire protocol. Score questions ride
 * the choice wire as an ordered set of indexed level candidates — the same
 * candidate texts a score question produces — so the full distribution over
 * levels comes back as first-class data.
 */
export function toWireQuestion(question: ClmQuestion): ClassifierQuestion {
  const instructions = instructionText(question.instructions);
  switch (question.kind) {
    case "bool":
      return {
        type: "bool",
        instructions,
        criteria: {
          true: criterionText(question.criteria?.true),
          false: criterionText(question.criteria?.false),
        },
      };
    case "choice": {
      const entries = Object.entries(question.criteria);
      if (entries.length < 1) {
        throw new Error("choice questions need a non-empty criteria object");
      }
      if (entries.length > 256) {
        throw new Error("choice questions need at most 256 criteria");
      }
      const criteria: Record<string, string> = {};
      for (const [key, value] of entries) criteria[key] = criterionText(value);
      return { type: "choice", instructions, criteria };
    }
    case "score": {
      if (question.criteria.length < 2 || question.criteria.length > 10) {
        throw new Error("score questions need an ordered list of 2–10 levels");
      }
      const criteria: Record<string, string> = {};
      question.criteria.forEach((level, i) => {
        criteria[String(i)] = criterionText(level);
      });
      return { type: "choice", instructions, criteria };
    }
  }
}

/** Pick the highest-probability key from a distribution. */
function argmax(probabilities: Record<string, number>): string {
  let best: string | undefined;
  let bestP = -1;
  for (const [key, p] of Object.entries(probabilities)) {
    if (p > bestP) {
      best = key;
      bestP = p;
    }
  }
  if (best === undefined) throw new Error("classifier returned an empty probability distribution");
  return best;
}

// ---------------------------------------------------------------------------
// Client
// ---------------------------------------------------------------------------

/** Minimal classify surface (satisfied by the extension's classify wrapper). */
export type ClmClassify = (context: ClassifierContext) => Promise<ClassifierResult>;

function requireAnswer(result: ClassifierResult, key: string): NonNullable<ClassifierResult["answers"][string]> {
  if (result.stopReason === "error") {
    throw new Error(result.errorMessage ?? `classifier failed: ${JSON.stringify(result)}`);
  }
  const answer = result.answers?.[key];
  if (!answer) throw new Error(`classifier returned no answer for "${key}"`);
  return answer;
}

/** Assemble the public answer for one question from its wire answer. */
function deriveAnswer(question: ClmQuestion, raw: ClassifierResult["answers"][string]): ClmAnswerFor<ClmQuestion> {
  switch (question.kind) {
    case "bool": {
      if (raw.type !== "bool") throw new Error(`expected a bool answer, got "${raw.type}"`);
      return { kind: "bool", probability: clamp01(raw.probability) };
    }
    case "choice": {
      if (raw.type !== "choice") throw new Error(`expected a choice answer, got "${raw.type}"`);
      const probabilities = raw.probabilities;
      const choice = argmax(probabilities);
      const confidence = choiceConfidence(Object.values(probabilities));
      return { kind: "choice", choice, probabilities, confidence };
    }
    case "score": {
      if (raw.type !== "choice") throw new Error(`expected a score (choice) answer, got "${raw.type}"`);
      const levelTexts = question.criteria.map(criterionText);
      const probabilities = raw.probabilities;
      const legend: Record<string, string> = {};
      const positions: number[] = [];
      const weights: number[] = [];
      let expected = 0;
      levelTexts.forEach((_, i) => {
        const p = probabilities[String(i)] ?? 0;
        legend[String(i)] = levelTexts[i];
        positions.push(i / (levelTexts.length - 1));
        weights.push(p);
        expected += (i / (levelTexts.length - 1)) * p;
      });
      const confidence = scoreConfidence(positions, weights, expected);
      return { kind: "score", score: clamp01(expected), legend, probabilities, confidence };
    }
  }
}

/**
 * Build the typed `clm` client over a classify function. `ask` is the whole
 * surface: one state, any number of independent questions, typed answers
 * keyed by the same ids — fan-out without `Promise.all`.
 */
export function createClm(classify: ClmClassify) {
  return {
    async ask<Q extends ClmQuestionSet>(state: ClmEvidence, questions: Q): Promise<ClmAnswers<Q>> {
      const ids = Object.keys(questions);
      if (ids.length < 1 || ids.length > 64) {
        throw new Error("questions must contain 1–64 questions");
      }
      const wireQuestions: Record<string, ClassifierQuestion> = {};
      for (const id of ids) wireQuestions[id] = toWireQuestion(questions[id]);
      const result = await classify({ state: normalizeState(state), questions: wireQuestions });
      const answers: Record<string, unknown> = {};
      for (const [id, question] of Object.entries(questions)) {
        answers[id] = deriveAnswer(question, requireAnswer(result, id));
      }
      return answers as ClmAnswers<Q>;
    },
  };
}

export type Clm = ReturnType<typeof createClm>;

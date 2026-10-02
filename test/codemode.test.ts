import test from "node:test";
import assert from "node:assert/strict";
import type { ClassifierContext, ClassifierResult } from "@earendil-works/pi-ai";
import { createClm, type Clm } from "../src/codemode.ts";

/**
 * Mock classify answering every question from a canned distribution, so a
 * single fan-out call gets distinct per-id answers.
 */
function mockClassify(canned: {
  probabilities?: Record<string, number>;
  probability?: number;
  stopReason?: ClassifierResult["stopReason"];
  errorMessage?: string;
  capture?: (context: ClassifierContext) => void;
} = {}): (context: ClassifierContext) => Promise<ClassifierResult> {
  return async (context) => {
    canned.capture?.(context);
    const answers: Record<string, ClassifierResult["answers"][string]> = {};
    for (const [id, question] of Object.entries(context.questions)) {
      if (question.type === "bool") {
        answers[id] = { type: "bool", probability: canned.probability ?? 0.9 };
      } else {
        const probabilities = canned.probabilities ?? { a: 0.7, b: 0.3 };
        const choice = Object.entries(probabilities).sort((x, y) => y[1] - x[1])[0][0];
        answers[id] = { type: "choice", choice, probabilities, confidence: probabilities[choice] };
      }
    }
    return {
      api: "typesafe-system-one",
      provider: "clm-local",
      model: "clm-latest",
      answers,
      stopReason: canned.stopReason ?? "stop",
      errorMessage: canned.errorMessage,
      timestamp: Date.now(),
    };
  };
}

test("fan-out: one call, one shared state, three typed answers", async () => {
  const contexts: ClassifierContext[] = [];
  const clm: Clm = createClm(mockClassify({ capture: (c) => contexts.push(c) }));
  const answers = await clm.ask(
    { message: "Customer was charged twice" },
    {
      urgent: { kind: "bool", instructions: "Is this urgent?" },
      action: {
        kind: "choice",
        instructions: "How should this be handled?",
        criteria: { refund: "Issue a refund", deny: "Deny the claim" },
      },
      severity: { kind: "score", instructions: "Rate severity.", criteria: ["low", "medium", "high"] },
    },
  );
  // Exactly one classify call: fan-out happens inside, not via Promise.all.
  assert.equal(contexts.length, 1);
  // All questions saw the same state.
  assert.deepEqual(contexts[0].state, { message: "Customer was charged twice" });
  // Answers are keyed by the question ids and carry their kinds.
  assert.deepEqual(Object.keys(answers), ["urgent", "action", "severity"]);
  assert.equal(answers.urgent.kind, "bool");
  assert.equal(answers.action.kind, "choice");
  assert.equal(answers.severity.kind, "score");
});

test("bool answer reports P(true) with no separate confidence", async () => {
  const clm = createClm(mockClassify({ probability: 0.8 }));
  const { yes } = await clm.ask("state", {
    yes: { kind: "bool", instructions: "Is this urgent?" },
  });
  assert.deepEqual(yes, { kind: "bool", probability: 0.8 });
});

test("choice confidence is (pmax - 1/n) / (1 - 1/n)", async () => {
  const clm = createClm(mockClassify({ probabilities: { refund: 0.2, deny: 0.7, escalate: 0.1 } }));
  const { action } = await clm.ask("state", {
    action: { kind: "choice", instructions: "Pick", criteria: { refund: "r", deny: "d", escalate: "e" } },
  });
  assert.equal(action.choice, "deny");
  assert.equal(action.confidence, (0.7 - 1 / 3) / (1 - 1 / 3));
  // Uniform over n gives 0; certain gives 1.
  const uniform = createClm(mockClassify({ probabilities: { a: 0.5, b: 0.5 } }));
  const { q: u } = await uniform.ask("state", { q: { kind: "choice", instructions: "Pick", criteria: { a: "A", b: "B" } } });
  assert.equal(u.confidence, 0);
  const certain = createClm(mockClassify({ probabilities: { a: 1, b: 0 } }));
  const { q: c } = await certain.ask("state", { q: { kind: "choice", instructions: "Pick", criteria: { a: "A", b: "B" } } });
  assert.equal(c.confidence, 1);
});

test("score is the probability-weighted position with a legend", async () => {
  const clm = createClm(mockClassify({ probabilities: { "0": 0.2, "1": 0.6, "2": 0.2 } }));
  const { severity } = await clm.ask("state", {
    severity: { kind: "score", instructions: "Rate severity.", criteria: ["low", "medium", "high"] },
  });
  // Level i of n sits at i/(n-1): E = 0.2*0 + 0.6*0.5 + 0.2*1 = 0.5.
  assert.equal(severity.score, 0.5);
  assert.deepEqual(severity.legend, { "0": "low", "1": "medium", "2": "high" });
  assert.deepEqual(severity.probabilities, { "0": 0.2, "1": 0.6, "2": 0.2 });
});

test("score confidence counts distance between levels", async () => {
  // Same 50/50 split, adjacent levels vs opposite extremes on a 5-level scale.
  const adjacent = createClm(mockClassify({ probabilities: { "0": 0, "1": 0, "2": 0.5, "3": 0.5, "4": 0 } }));
  const { a } = await adjacent.ask("state", {
    a: { kind: "score", instructions: "Rate", criteria: ["1", "2", "3", "4", "5"] },
  });
  const extremes = createClm(mockClassify({ probabilities: { "0": 0.5, "1": 0, "2": 0, "3": 0, "4": 0.5 } }));
  const { b } = await extremes.ask("state", {
    b: { kind: "score", instructions: "Rate", criteria: ["1", "2", "3", "4", "5"] },
  });
  // Adjacent split: positions 0.5/0.75, E = 0.625, d = ±0.125 → conf = 1 - 2*0.125 = 0.75.
  assert.ok(Math.abs(a.confidence - 0.75) < 1e-12);
  // Extremes: maximal spread → 0.
  assert.equal(b.confidence, 0);
  assert.ok(a.confidence > b.confidence);
  // All mass on one level → 1.
  const single = createClm(mockClassify({ probabilities: { "0": 0, "1": 1, "2": 0 } }));
  const { s } = await single.ask("state", {
    s: { kind: "score", instructions: "Rate", criteria: ["low", "medium", "high"] },
  });
  assert.equal(s.confidence, 1);
});

test("score rejects level counts outside 2-10", async () => {
  const clm = createClm(mockClassify());
  await assert.rejects(
    clm.ask("state", { q: { kind: "score", instructions: "Rate", criteria: ["low"] } }),
    /2–10 levels/,
  );
  await assert.rejects(
    clm.ask("state", { q: { kind: "score", instructions: "Rate", criteria: ["a", "b", "c", "d", "e", "f", "g", "h", "i", "j", "k"] } }),
    /2–10 levels/,
  );
});

test("non-object state is wrapped: scalars as message, arrays as items", async () => {
  const contexts: ClassifierContext[] = [];
  const clm = createClm(mockClassify({ capture: (c) => contexts.push(c) }));
  await clm.ask("double charge", { q: { kind: "bool", instructions: "Urgent?" } });
  await clm.ask(["a", "b"], { q: { kind: "bool", instructions: "Urgent?" } });
  assert.deepEqual(contexts[0].state, { message: "double charge" });
  assert.deepEqual(contexts[1].state, { items: ["a", "b"] });
});

test("questions translate to the wire protocol", async () => {
  const contexts: ClassifierContext[] = [];
  const clm = createClm(mockClassify({ capture: (c) => contexts.push(c) }));
  await clm.ask("state", {
    b: { kind: "bool", instructions: "Urgent?", criteria: { true: "Payment captured", false: null } },
    c: { kind: "choice", instructions: "Pick", criteria: { a: "Option A", b: "" } },
    s: { kind: "score", instructions: "Rate", criteria: ["low", "high"] },
  });
  const [b, c, s] = ["b", "c", "s"].map((id) => contexts[0].questions[id]);
  assert.deepEqual(b, { type: "bool", instructions: "Urgent?", criteria: { true: "Payment captured", false: "" } });
  assert.deepEqual(c, { type: "choice", instructions: "Pick", criteria: { a: "Option A", b: "" } });
  // Score rides the choice wire as indexed level candidates.
  assert.deepEqual(s, { type: "choice", instructions: "Rate", criteria: { "0": "low", "1": "high" } });
});

test("errors surface instead of malformed answers", async () => {
  const failing = createClm(mockClassify({ stopReason: "error", errorMessage: "server exploded" }));
  await assert.rejects(
    failing.ask("state", { q: { kind: "bool", instructions: "Urgent?" } }),
    /server exploded/,
  );

  const noAnswer = createClm(
    async () =>
      ({
        api: "typesafe-system-one",
        provider: "clm-local",
        model: "clm-latest",
        answers: {},
        stopReason: "stop",
        timestamp: Date.now(),
      }) as ClassifierResult,
  );
  await assert.rejects(
    noAnswer.ask("state", { q: { kind: "bool", instructions: "Urgent?" } }),
    /no answer/,
  );
});

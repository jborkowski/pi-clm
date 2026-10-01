import test from "node:test";
import assert from "node:assert/strict";
import type { ClassifierContext, ClassifierResult, JsonObject } from "@earendil-works/pi-ai";
import { createClm, DEFAULT_SCORE_CRITERIA, type Clm } from "../src/codemode.ts";

/** Build a mock classify fn answering `q` from a canned per-type answer. */
function mockClassify(canned: {
  bool?: { probability: number };
  choice?: { choice: string; probabilities: Record<string, number>; confidence: number };
  score?: { score: number; confidence: number };
  stopReason?: ClassifierResult["stopReason"];
  errorMessage?: string;
  capture?: (context: ClassifierContext) => void;
} = {}): (context: ClassifierContext) => Promise<ClassifierResult> {
  return async (context) => {
    canned.capture?.(context);
    const question = context.questions.q;
    const answers: Record<string, ClassifierResult["answers"][string]> = {};
    if (question.type === "bool") {
      answers.q = { type: "bool", probability: canned.bool?.probability ?? 0.9 };
    } else if (question.type === "choice") {
      answers.q = {
        type: "choice",
        choice: canned.choice?.choice ?? "",
        probabilities: canned.choice?.probabilities ?? {},
        confidence: canned.choice?.confidence ?? 1,
      };
    } else {
      answers.q = { type: "score", score: canned.score?.score ?? 3, confidence: canned.score?.confidence ?? 0.8 };
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

test("createClm bool maps probability to a yes/no ClmAnswer", async () => {
  const clm = createClm(mockClassify({ bool: { probability: 0.8 } }));
  const answer = await clm.bool("Is this urgent?");
  assert.deepEqual(answer, {
    answer: "yes",
    probabilities: { yes: 0.8, no: 0.19999999999999996 },
    confidence: 0.8,
    question: "Is this urgent?",
  });
});

test("createClm bool below 0.5 flips to no", async () => {
  const clm = createClm(mockClassify({ bool: { probability: 0.25 } }));
  const answer = await clm.bool("Should we escalate?");
  assert.equal(answer.answer, "no");
  assert.equal(answer.confidence, 0.75);
});

test("createClm choice returns distribution over criteria keys", async () => {
  const clm = createClm(
    mockClassify({
      choice: {
        choice: "deny",
        probabilities: { refund: 0.2, deny: 0.7, escalate: 0.1 },
        confidence: 0.7,
      },
    }),
  );
  const answer = await clm.choice("How should this be handled?", {
    refund: "Issue a refund",
    deny: "Deny the claim",
    escalate: "Escalate to a human",
  });
  assert.equal(answer.answer, "deny");
  assert.equal(answer.confidence, 0.7);
  assert.deepEqual(Object.keys(answer.probabilities).sort(), ["deny", "escalate", "refund"]);
});

test("createClm choice falls back to argmax when the reported choice is unknown", async () => {
  const clm = createClm(
    mockClassify({
      choice: { choice: "nonsense", probabilities: { a: 0.3, b: 0.6 }, confidence: 0.6 },
    }),
  );
  const answer = await clm.choice("Pick one", { a: "Option A", b: "Option B" });
  assert.equal(answer.answer, "b");
  assert.equal(answer.confidence, 0.6);
});

test("createClm score maps the index to the criterion label and numeric value", async () => {
  const clm = createClm(mockClassify({ score: { score: 4, confidence: 0.9 } }));
  const answer = await clm.score("Rate severity.");
  assert.deepEqual(answer, {
    answer: "5",
    value: 5,
    confidence: 0.9,
    question: "Rate severity.",
  });
  assert.equal(DEFAULT_SCORE_CRITERIA.length, 5);
});

test("createClm score accepts custom numeric criteria", async () => {
  const clm = createClm(mockClassify({ score: { score: 0, confidence: 0.5 } }));
  const answer = await clm.score("Rate effort", [0, 2, 5, 8]);
  assert.equal(answer.answer, "0");
  assert.equal(answer.value, 0);
});

test("createClm score rounds a fractional index to the nearest criterion", async () => {
  const clm = createClm(mockClassify({ score: { score: 2.2, confidence: 0.6 } }));
  const answer = await clm.score("Rate severity.");
  assert.deepEqual(answer, {
    answer: "3",
    value: 3,
    confidence: 0.6,
    question: "Rate severity.",
  });
});

test("createClm score clamps a fractional index outside the criteria range", async () => {
  const high = createClm(mockClassify({ score: { score: 4.7, confidence: 0.4 } }));
  assert.deepEqual(await high.score("Rate severity."), {
    answer: "5",
    value: 5,
    confidence: 0.4,
    question: "Rate severity.",
  });
  const low = createClm(mockClassify({ score: { score: -0.3, confidence: 0.4 } }));
  assert.deepEqual(await low.score("Rate severity."), {
    answer: "1",
    value: 1,
    confidence: 0.4,
    question: "Rate severity.",
  });
});

test("createClm score maps fractional indices through custom numeric criteria", async () => {
  const clm = createClm(mockClassify({ score: { score: 2.4, confidence: 0.7 } }));
  const answer = await clm.score("Rate effort", [0, 2, 5, 8]);
  assert.equal(answer.answer, "5");
  assert.equal(answer.value, 5);
});

test("createClm score with non-numeric labels picks the nearest label for integer and fractional indices", async () => {
  for (const serverScore of [2, 1.6]) {
    const clm = createClm(mockClassify({ score: { score: serverScore, confidence: 0.5 } }));
    const answer = await clm.score("How bad?", ["low", "medium", "high"]);
    assert.equal(answer.answer, "high", `server score ${serverScore}`);
    assert.equal(answer.value, 2, `server score ${serverScore}`);
  }
});

test("createClm calls compose with Promise.all over one shared classify fn", async () => {
  let calls = 0;
  const classify = mockClassify({
    score: { score: 2, confidence: 0.8 },
    choice: { choice: "a", probabilities: { a: 0.6, b: 0.4 }, confidence: 0.6 },
    capture: () => {
      calls++;
    },
  });
  const clm: Clm = createClm(classify);
  const [boolAnswer, choiceAnswer, scoreAnswer] = await Promise.all([
    clm.bool("Urgent?"),
    clm.choice("Action?", { a: "Do a", b: "Do b" }),
    clm.score("Severity?"),
  ]);
  assert.equal(boolAnswer.answer, "yes");
  assert.equal(choiceAnswer.answer, "a");
  assert.equal(scoreAnswer.value, 3);
  assert.equal(calls, 3);
});

test("createClm defaults state to { message: question } and passes custom state through", async () => {
  let seen: ClassifierContext | undefined;
  const classify = mockClassify({ capture: (c) => (seen = c) });
  const clm = createClm(classify);

  await clm.bool("Is this urgent?");
  assert.deepEqual(seen?.state, { message: "Is this urgent?" });

  const custom: JsonObject = { message: "Customer was charged twice" };
  await clm.bool("Is this urgent?", custom);
  assert.equal(seen?.state, custom);
});

test("createClm surfaces classifier errors instead of malformed answers", async () => {
  const failing = createClm(mockClassify({ stopReason: "error", errorMessage: "server exploded" }));
  await assert.rejects(failing.bool("Urgent?"), /server exploded/);

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
  await assert.rejects(noAnswer.bool("Urgent?"), /no answer/);
});

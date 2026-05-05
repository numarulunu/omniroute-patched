import assert from "node:assert/strict";
import test from "node:test";

import { FORMATS } from "../../open-sse/translator/formats.ts";
import { classifyRequestIntent } from "../../open-sse/handlers/requestIntent.ts";

test("request intent treats Codex /responses/compact as a dedicated compaction lane", () => {
  const intent = classifyRequestIntent({
    provider: "codex",
    sourceFormat: FORMATS.OPENAI_RESPONSES,
    endpointPath: "/v1/responses/compact",
    nativeCodexPassthrough: true,
  });

  assert.equal(intent.kind, "responses_compact");
  assert.equal(intent.requestType, "responses_compact");
  assert.equal(intent.forceNonStreamingJson, true);
  assert.equal(intent.preserveNativeResponse, true);
  assert.equal(intent.allowSemanticCache, false);
  assert.equal(intent.allowMemory, false);
  assert.equal(intent.allowSkills, false);
  assert.equal(intent.allowResponseSanitizer, false);
  assert.equal(intent.allowUsageBuffer, false);
  assert.equal(intent.allowPostCallGuardrails, false);
  assert.equal(intent.allowIdempotency, false);
});

test("request intent leaves normal Responses traffic on the regular lane", () => {
  const intent = classifyRequestIntent({
    provider: "codex",
    sourceFormat: FORMATS.OPENAI_RESPONSES,
    endpointPath: "/v1/responses",
    nativeCodexPassthrough: true,
  });

  assert.equal(intent.kind, "responses");
  assert.equal(intent.requestType, null);
  assert.equal(intent.forceNonStreamingJson, false);
  assert.equal(intent.preserveNativeResponse, false);
  assert.equal(intent.allowSemanticCache, true);
  assert.equal(intent.allowMemory, true);
  assert.equal(intent.allowSkills, true);
  assert.equal(intent.allowResponseSanitizer, true);
  assert.equal(intent.allowUsageBuffer, true);
  assert.equal(intent.allowPostCallGuardrails, true);
  assert.equal(intent.allowIdempotency, true);
});

import test from "node:test";
import assert from "node:assert/strict";
import {
  MAX_BODY_BYTES,
  MAX_BODY_BYTES_AUDIO,
  MAX_BODY_BYTES_LLM,
  checkBodySize,
  getBodySizeLimit,
} from "../../src/shared/middleware/bodySizeGuard.ts";
import { requestBodyLimitMbToBytes } from "../../src/shared/constants/bodySize.ts";

function requestWithLength(bytes: number): Request {
  return new Request("http://localhost/api/v1/responses", {
    method: "POST",
    headers: { "content-length": String(bytes) },
  });
}

test("body size guard uses maxBodySizeMb from settings for regular API routes", () => {
  assert.equal(
    getBodySizeLimit("/api/settings", { maxBodySizeMb: 100 }),
    requestBodyLimitMbToBytes(100)
  );
});

test("body size guard keeps dedicated upload limits as lower bounds", () => {
  assert.equal(
    getBodySizeLimit("/api/v1/audio/transcriptions", { maxBodySizeMb: 1 }),
    MAX_BODY_BYTES_AUDIO
  );
  assert.equal(
    getBodySizeLimit("/api/v1/audio/transcriptions", { maxBodySizeMb: 200 }),
    requestBodyLimitMbToBytes(200)
  );
});

test("body size guard allows larger LLM payloads before compaction can run", () => {
  assert.equal(getBodySizeLimit("/api/settings"), MAX_BODY_BYTES);
  assert.equal(getBodySizeLimit("/api/v1/responses"), MAX_BODY_BYTES_LLM);
  assert.equal(getBodySizeLimit("/api/v1/responses/input_items"), MAX_BODY_BYTES_LLM);
  assert.equal(getBodySizeLimit("/api/v1/chat/completions"), MAX_BODY_BYTES_LLM);
  assert.equal(getBodySizeLimit("/api/v1/messages"), MAX_BODY_BYTES_LLM);
  assert.equal(getBodySizeLimit("/api/v1/providers/codex/chat/completions"), MAX_BODY_BYTES_LLM);
});

test("body size guard lets settings raise LLM limits above the built-in floor", () => {
  assert.equal(
    getBodySizeLimit("/api/v1/responses", { maxBodySizeMb: 100 }),
    requestBodyLimitMbToBytes(100)
  );
});

test("checkBodySize reports the configured request limit in 413 responses", async () => {
  const limit = requestBodyLimitMbToBytes(100);
  const request = requestWithLength(limit + 1);

  const response = checkBodySize(request, limit);

  assert.ok(response);
  assert.equal(response.status, 413);
  const body = await response.json();
  assert.equal(body.error.code, "PAYLOAD_TOO_LARGE");
  assert.match(body.error.message, /100 MB/);
});

test("LLM routes reject bodies above their larger guardrail", async () => {
  assert.equal(checkBodySize(requestWithLength(MAX_BODY_BYTES + 1), MAX_BODY_BYTES_LLM), null);

  const response = checkBodySize(requestWithLength(MAX_BODY_BYTES_LLM + 1), MAX_BODY_BYTES_LLM);

  assert.ok(response);
  assert.equal(response.status, 413);
  assert.match(await response.text(), /64 MB/);
});

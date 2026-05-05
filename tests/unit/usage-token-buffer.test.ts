import assert from "node:assert/strict";
import test from "node:test";

import {
  addBufferToUsage,
  invalidateBufferTokensCache,
} from "../../open-sse/utils/usageTracking.ts";

test("usage buffer defaults to the documented 100-token headroom", () => {
  const previousBuffer = process.env.USAGE_TOKEN_BUFFER;
  delete process.env.USAGE_TOKEN_BUFFER;
  invalidateBufferTokensCache();

  try {
    const buffered = addBufferToUsage({
      prompt_tokens: 10,
      completion_tokens: 5,
      total_tokens: 15,
    });

    assert.equal(buffered.prompt_tokens, 110);
    assert.equal(buffered.completion_tokens, 5);
    assert.equal(buffered.total_tokens, 115);
  } finally {
    if (previousBuffer === undefined) {
      delete process.env.USAGE_TOKEN_BUFFER;
    } else {
      process.env.USAGE_TOKEN_BUFFER = previousBuffer;
    }
    invalidateBufferTokensCache();
  }
});

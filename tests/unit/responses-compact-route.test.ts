import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

const wildcardRoutePath = "src/app/api/v1/responses/[...path]/route.ts";

test("wildcard Responses route does not initialize translators in the Next route handler", () => {
  const source = fs.readFileSync(wildcardRoutePath, "utf8");

  assert.equal(
    source.includes("initTranslators"),
    false,
    "Responses subpaths must delegate directly to handleChat; initTranslators caused Next route-handler crashes before compact requests reached the pipeline"
  );
});

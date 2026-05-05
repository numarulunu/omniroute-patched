import { isCompactResponsesEndpoint } from "../executors/codex.ts";
import { FORMATS } from "../translator/formats.ts";

export type RequestIntentKind = "chat" | "responses" | "responses_compact";

export type RequestIntent = {
  kind: RequestIntentKind;
  requestType: string | null;
  isResponses: boolean;
  isExplicitCompaction: boolean;
  forceNonStreamingJson: boolean;
  preserveNativeResponse: boolean;
  allowSemanticCache: boolean;
  allowMemory: boolean;
  allowSkills: boolean;
  allowResponseSanitizer: boolean;
  allowUsageBuffer: boolean;
  allowPostCallGuardrails: boolean;
  allowIdempotency: boolean;
};

type ClassifyRequestIntentInput = {
  provider?: string | null;
  sourceFormat?: string | null;
  endpointPath?: string | null;
  nativeCodexPassthrough?: boolean;
};

function isResponsesFormat(sourceFormat: string | null | undefined): boolean {
  return sourceFormat === FORMATS.OPENAI_RESPONSES;
}

export function classifyRequestIntent({
  provider,
  sourceFormat,
  endpointPath,
  nativeCodexPassthrough = false,
}: ClassifyRequestIntentInput): RequestIntent {
  const isResponses = isResponsesFormat(sourceFormat);
  const isExplicitCodexCompaction =
    provider === "codex" &&
    isResponses &&
    nativeCodexPassthrough === true &&
    isCompactResponsesEndpoint(endpointPath);

  if (isExplicitCodexCompaction) {
    return {
      kind: "responses_compact",
      requestType: "responses_compact",
      isResponses: true,
      isExplicitCompaction: true,
      forceNonStreamingJson: true,
      preserveNativeResponse: true,
      allowSemanticCache: false,
      allowMemory: false,
      allowSkills: false,
      allowResponseSanitizer: false,
      allowUsageBuffer: false,
      allowPostCallGuardrails: false,
      allowIdempotency: false,
    };
  }

  return {
    kind: isResponses ? "responses" : "chat",
    requestType: null,
    isResponses,
    isExplicitCompaction: false,
    forceNonStreamingJson: false,
    preserveNativeResponse: false,
    allowSemanticCache: true,
    allowMemory: true,
    allowSkills: true,
    allowResponseSanitizer: true,
    allowUsageBuffer: true,
    allowPostCallGuardrails: true,
    allowIdempotency: true,
  };
}

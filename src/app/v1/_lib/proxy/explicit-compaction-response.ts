import type { ExplicitCompactionUpstreamMode } from "./explicit-compaction-transport";
import type { ExplicitCompactionVersion } from "./remote-compaction";

export type CompactionValidationReason =
  | "malformed_compaction_response"
  | "missing_successful_terminal"
  | "failed_compaction_terminal"
  | "missing_compaction_output"
  | "multiple_compaction_outputs"
  | "empty_compaction_encrypted_content"
  | "inconsistent_compaction_output";

export type CompactionValidationOutcome =
  | "valid"
  | "invalid"
  | "overflow"
  | "timeout"
  | "aborted"
  | "bypassed"
  | "upstream_error";

export interface ExplicitCompactionValidationEvidence {
  transport: "json" | "sse";
  version: ExplicitCompactionVersion;
  responseBytes: number;
  terminalSeen: boolean;
  compactionItemCount: number;
  sourceCount: number;
  timeoutKind?: "validation" | "transport";
  transportFailureReason?: "first_byte_timeout" | "idle_timeout";
}

export interface ExplicitCompactionValidationResult {
  outcome: CompactionValidationOutcome;
  reason?: CompactionValidationReason;
  usage: Record<string, unknown> | null;
  evidence: ExplicitCompactionValidationEvidence;
}

type CompactionCandidate = {
  id: string | null;
  outputIndex: number | null;
  encryptedContent: string | null;
  fingerprint: string;
};

type SseEvent = {
  event: string | null;
  data: unknown;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function getUsage(value: unknown): Record<string, unknown> | null {
  return isRecord(value) ? value : null;
}

function candidateFromItem(
  item: unknown,
  outputIndex?: unknown,
  allowSub2Alias = false
): CompactionCandidate | null {
  if (
    !isRecord(item) ||
    (item.type !== "compaction" && !(allowSub2Alias && item.type === "compaction_summary"))
  ) {
    return null;
  }
  const id = typeof item.id === "string" && item.id.length > 0 ? item.id : null;
  const index = Number.isInteger(outputIndex) ? (outputIndex as number) : null;
  const encryptedContent =
    typeof item.encrypted_content === "string" ? item.encrypted_content : null;
  return {
    id,
    outputIndex: index,
    encryptedContent,
    fingerprint: JSON.stringify({ type: "compaction", encrypted_content: encryptedContent }),
  };
}

function candidatesFromOutput(output: unknown, allowSub2Alias = false): CompactionCandidate[] {
  if (!Array.isArray(output)) return [];
  return output.flatMap((item, index) => {
    const candidate = candidateFromItem(item, index, allowSub2Alias);
    return candidate ? [candidate] : [];
  });
}

function normalizeCompactionItem(item: unknown, allowSub2Alias: boolean): unknown {
  if (!isRecord(item)) return item;
  if (allowSub2Alias && item.type === "compaction_summary") {
    return { ...item, type: "compaction" };
  }
  return item;
}

function hasFailedStatus(payload: Record<string, unknown>): boolean {
  return (
    payload.error != null || (typeof payload.status === "string" && payload.status !== "completed")
  );
}

function invalid(
  version: ExplicitCompactionVersion,
  transport: "json" | "sse",
  responseBytes: number,
  reason: CompactionValidationReason,
  options: {
    terminalSeen?: boolean;
    compactionItemCount?: number;
    sourceCount?: number;
    usage?: Record<string, unknown> | null;
    timeoutKind?: "validation" | "transport";
  } = {}
): ExplicitCompactionValidationResult {
  return {
    outcome: "invalid",
    reason,
    usage: options.usage ?? null,
    evidence: {
      transport,
      version,
      responseBytes,
      terminalSeen: options.terminalSeen ?? false,
      compactionItemCount: options.compactionItemCount ?? 0,
      sourceCount: options.sourceCount ?? 0,
      ...(options.timeoutKind ? { timeoutKind: options.timeoutKind } : {}),
    },
  };
}

function validateCandidates(
  candidates: CompactionCandidate[],
  version: ExplicitCompactionVersion,
  transport: "json" | "sse",
  responseBytes: number,
  terminalSeen: boolean,
  sourceCount: number,
  usage: Record<string, unknown> | null
): ExplicitCompactionValidationResult {
  if (candidates.length === 0) {
    return invalid(version, transport, responseBytes, "missing_compaction_output", {
      terminalSeen,
      sourceCount,
      usage,
    });
  }
  if (candidates.length > 1) {
    return invalid(version, transport, responseBytes, "multiple_compaction_outputs", {
      terminalSeen,
      compactionItemCount: candidates.length,
      sourceCount,
      usage,
    });
  }
  if (!candidates[0].encryptedContent?.trim()) {
    return invalid(version, transport, responseBytes, "empty_compaction_encrypted_content", {
      terminalSeen,
      compactionItemCount: 1,
      sourceCount,
      usage,
    });
  }
  return {
    outcome: "valid",
    usage,
    evidence: {
      transport,
      version,
      responseBytes,
      terminalSeen,
      compactionItemCount: 1,
      sourceCount,
    },
  };
}

function parseSse(text: string): SseEvent[] | null {
  const normalized = text.replace(/\r\n/g, "\n");
  const events: SseEvent[] = [];
  for (const block of normalized.split("\n\n")) {
    if (!block.trim()) continue;
    let event: string | null = null;
    const dataLines: string[] = [];
    for (const line of block.split("\n")) {
      if (line.startsWith(":")) continue;
      if (line.startsWith("event:")) event = line.slice(6).trim();
      if (line.startsWith("data:")) dataLines.push(line.slice(5).trimStart());
    }
    if (dataLines.length === 0) continue;
    const dataText = dataLines.join("\n");
    if (dataText === "[DONE]") continue;
    try {
      events.push({ event, data: JSON.parse(dataText) as unknown });
    } catch {
      return null;
    }
  }
  return events;
}

function deduplicateSseCandidates(candidates: CompactionCandidate[]): {
  candidates: CompactionCandidate[];
  inconsistent: boolean;
} {
  const canonical: CompactionCandidate[] = [];
  const positionsById = new Map<string, number>();
  const positionsByIndex = new Map<number, number>();
  for (const candidate of candidates) {
    const idPosition = candidate.id ? positionsById.get(candidate.id) : undefined;
    const indexPosition =
      candidate.outputIndex !== null ? positionsByIndex.get(candidate.outputIndex) : undefined;
    if (idPosition !== undefined && indexPosition !== undefined && idPosition !== indexPosition) {
      return { candidates: canonical, inconsistent: true };
    }
    const position = idPosition ?? indexPosition;
    if (position === undefined) {
      const nextPosition = canonical.length;
      canonical.push(candidate);
      if (candidate.id) positionsById.set(candidate.id, nextPosition);
      if (candidate.outputIndex !== null) {
        positionsByIndex.set(candidate.outputIndex, nextPosition);
      }
      continue;
    }
    const previous = canonical[position];
    if (
      previous.fingerprint !== candidate.fingerprint ||
      previous.encryptedContent !== candidate.encryptedContent ||
      (previous.id !== null && candidate.id !== null && previous.id !== candidate.id) ||
      (previous.outputIndex !== null &&
        candidate.outputIndex !== null &&
        previous.outputIndex !== candidate.outputIndex)
    ) {
      return { candidates: canonical, inconsistent: true };
    }
    if (candidate.id) positionsById.set(candidate.id, position);
    if (candidate.outputIndex !== null) {
      positionsByIndex.set(candidate.outputIndex, position);
    }
  }
  return { candidates: canonical, inconsistent: false };
}

function normalizeSseForClient(text: string, isSub2Api: boolean): string {
  const events = parseSse(text);
  if (!events) return text;
  return events
    .map(({ event, data }) => {
      if (!isRecord(data)) return null;
      const normalized = structuredClone(data);
      const type = typeof normalized.type === "string" ? normalized.type : event;
      if (type === "response.done") {
        normalized.type = "response.completed";
        if (isRecord(normalized.response) && normalized.response.status === undefined) {
          normalized.response.status = "completed";
        }
      }
      if (type === "response.output_item.done" && normalized.item) {
        normalized.item = normalizeCompactionItem(normalized.item, isSub2Api);
      }
      if (isRecord(normalized.response) && Array.isArray(normalized.response.output)) {
        normalized.response.output = normalized.response.output.map((item) =>
          normalizeCompactionItem(item, isSub2Api)
        );
      }
      const outputEvent = type === "response.done" ? "response.completed" : event;
      return `event: ${outputEvent ?? normalized.type ?? "message"}\ndata: ${JSON.stringify(normalized)}\n\n`;
    })
    .filter((event): event is string => event !== null)
    .join("");
}

function normalizeBridgeV1Json(text: string, isSub2Api: boolean): string | null {
  const events = parseSse(text);
  if (!events) return null;
  let terminal: Record<string, unknown> | null = null;
  const itemOutputs: Array<{ index: number; item: unknown }> = [];
  for (const parsed of events) {
    if (!isRecord(parsed.data)) continue;
    const type = typeof parsed.data.type === "string" ? parsed.data.type : parsed.event;
    if (type === "response.output_item.done" && parsed.data.item) {
      const index = Number.isInteger(parsed.data.output_index)
        ? (parsed.data.output_index as number)
        : itemOutputs.length;
      itemOutputs.push({
        index,
        item: normalizeCompactionItem(parsed.data.item, isSub2Api),
      });
    }
    if (
      (type === "response.completed" || type === "response.done") &&
      isRecord(parsed.data.response)
    ) {
      terminal = structuredClone(parsed.data.response);
    }
  }
  if (!terminal) return null;
  const terminalOutput = Array.isArray(terminal.output)
    ? terminal.output.map((item) => normalizeCompactionItem(item, isSub2Api))
    : null;
  terminal.output =
    terminalOutput && terminalOutput.length > 0
      ? terminalOutput
      : itemOutputs.sort((a, b) => a.index - b.index).map(({ item }) => item);
  terminal.object = "response.compaction";
  if (terminal.status === undefined) terminal.status = "completed";
  return JSON.stringify(terminal);
}

function extractPartialUsage(chunks: Uint8Array[], isSse: boolean): Record<string, unknown> | null {
  if (chunks.length === 0) return null;
  const text = new TextDecoder().decode(concatBytes(chunks));
  if (!isSse) {
    try {
      const payload = JSON.parse(text) as unknown;
      return isRecord(payload) ? getUsage(payload.usage) : null;
    } catch {
      return null;
    }
  }
  const events = parseSse(text);
  if (!events) return null;
  let usage: Record<string, unknown> | null = null;
  for (const parsed of events) {
    if (!isRecord(parsed.data)) continue;
    const response = isRecord(parsed.data.response) ? parsed.data.response : null;
    usage = getUsage(parsed.data.usage) ?? getUsage(response?.usage) ?? usage;
  }
  return usage;
}

function concatBytes(chunks: Uint8Array[]): Uint8Array {
  const total = chunks.reduce((sum, chunk) => sum + chunk.byteLength, 0);
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}

export function validateExplicitCompactionPayload(input: {
  bytes: Uint8Array;
  contentType: string;
  isSub2Api?: boolean;
  version: ExplicitCompactionVersion;
}): ExplicitCompactionValidationResult {
  const { bytes, version } = input;
  const responseBytes = bytes.byteLength;
  const text = new TextDecoder().decode(bytes);
  const transport = input.contentType.toLowerCase().includes("text/event-stream") ? "sse" : "json";

  if (transport === "json") {
    let payload: unknown;
    try {
      payload = JSON.parse(text) as unknown;
    } catch {
      return invalid(version, transport, responseBytes, "malformed_compaction_response");
    }
    if (!isRecord(payload)) {
      return invalid(version, transport, responseBytes, "malformed_compaction_response");
    }
    // The documented standalone endpoint returns a CompactedResponse. v2 is a
    // Codex wire protocol, so its enclosing response object remains deliberately
    // permissive while we validate the consumable compaction item itself.
    if (version === "v1" && payload.object !== "response.compaction") {
      return invalid(version, transport, responseBytes, "malformed_compaction_response", {
        usage: getUsage(payload.usage),
      });
    }
    if (hasFailedStatus(payload)) {
      return invalid(version, transport, responseBytes, "failed_compaction_terminal", {
        terminalSeen: true,
        usage: getUsage(payload.usage),
      });
    }
    return validateCandidates(
      candidatesFromOutput(payload.output, input.isSub2Api === true),
      version,
      transport,
      responseBytes,
      true,
      1,
      getUsage(payload.usage)
    );
  }

  const events = parseSse(text);
  if (!events) {
    return invalid(version, transport, responseBytes, "malformed_compaction_response");
  }

  let terminal: Record<string, unknown> | null = null;
  let failedTerminal = false;
  let usage: Record<string, unknown> | null = null;
  const candidates: CompactionCandidate[] = [];
  let sourceCount = 0;

  for (const parsedEvent of events) {
    if (!isRecord(parsedEvent.data)) continue;
    const eventResponse = isRecord(parsedEvent.data.response) ? parsedEvent.data.response : null;
    usage = getUsage(parsedEvent.data.usage) ?? getUsage(eventResponse?.usage) ?? usage;
    const eventType =
      typeof parsedEvent.data.type === "string" ? parsedEvent.data.type : parsedEvent.event;
    if (
      eventType === "response.failed" ||
      eventType === "response.incomplete" ||
      eventType === "error"
    ) {
      failedTerminal = true;
    }
    if (eventType === "response.output_item.done") {
      const candidate = candidateFromItem(
        parsedEvent.data.item,
        parsedEvent.data.output_index,
        input.isSub2Api === true
      );
      if (candidate) {
        candidates.push(candidate);
        sourceCount++;
      }
    }
    if (
      (eventType === "response.completed" || eventType === "response.done") &&
      isRecord(parsedEvent.data.response)
    ) {
      terminal = parsedEvent.data.response;
      usage = getUsage(terminal.usage) ?? usage;
      const terminalCandidates = candidatesFromOutput(terminal.output, input.isSub2Api === true);
      candidates.push(...terminalCandidates);
      sourceCount += terminalCandidates.length > 0 ? 1 : 0;
    }
  }

  if (failedTerminal) {
    return invalid(version, transport, responseBytes, "failed_compaction_terminal", {
      terminalSeen: terminal !== null,
      sourceCount,
      usage,
    });
  }
  if (!terminal) {
    return invalid(version, transport, responseBytes, "missing_successful_terminal", {
      sourceCount,
      usage,
    });
  }
  if (hasFailedStatus(terminal)) {
    return invalid(version, transport, responseBytes, "failed_compaction_terminal", {
      terminalSeen: true,
      sourceCount,
      usage,
    });
  }

  const deduplicated = deduplicateSseCandidates(candidates);
  if (deduplicated.inconsistent) {
    return invalid(version, transport, responseBytes, "inconsistent_compaction_output", {
      terminalSeen: true,
      sourceCount,
      usage,
    });
  }
  return validateCandidates(
    deduplicated.candidates,
    version,
    transport,
    responseBytes,
    true,
    sourceCount,
    usage
  );
}

export class ExplicitCompactionResponseError extends Error {
  constructor(
    public readonly validation: ExplicitCompactionValidationResult,
    public readonly publicCode:
      | "remote_compaction_invalid_response"
      | "remote_compaction_response_too_large"
      | "remote_compaction_timeout"
  ) {
    super(publicCode);
    this.name = "ExplicitCompactionResponseError";
  }
}

export class ExplicitCompactionAttemptInterruptedError extends Error {
  readonly code?: string;

  constructor(
    public readonly validation: ExplicitCompactionValidationResult,
    original: unknown
  ) {
    super(original instanceof Error ? original.message : "Explicit compaction interrupted", {
      cause: original,
    });
    this.name = original instanceof Error ? original.name : "Error";
    this.code =
      original && typeof original === "object" && "code" in original
        ? String((original as { code?: unknown }).code ?? "") || undefined
        : undefined;
  }
}

export async function collectExplicitCompactionResponse(input: {
  response: Response;
  version: ExplicitCompactionVersion;
  isSub2Api?: boolean;
  upstreamMode?: ExplicitCompactionUpstreamMode;
  maxBytes: number;
  timeoutMs: number;
  idleTimeoutMs?: number;
  abortSignal?: AbortSignal | null;
  responseTimeoutSignal?: AbortSignal | null;
  onFirstByte?: () => void;
  bypassValidation?: boolean;
}): Promise<{
  response: Response;
  validation: ExplicitCompactionValidationResult;
}> {
  const { response } = input;
  if (!response.body) {
    const validation = invalid(input.version, "json", 0, "malformed_compaction_response");
    throw new ExplicitCompactionResponseError(validation, "remote_compaction_invalid_response");
  }

  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let totalBytes = 0;
  let firstByteSeen = false;
  let timedOut = false;
  let idleTimedOut = false;
  const timeoutId = setTimeout(() => {
    timedOut = true;
    void reader.cancel("remote_compaction_validation_timeout").catch(() => undefined);
  }, input.timeoutMs);
  const isSse = response.headers.get("content-type")?.includes("text/event-stream") ?? false;
  let idleTimeoutId: NodeJS.Timeout | null = null;
  const clearIdleTimeout = () => {
    if (idleTimeoutId) clearTimeout(idleTimeoutId);
    idleTimeoutId = null;
  };
  const resetIdleTimeout = () => {
    if (!input.idleTimeoutMs || input.idleTimeoutMs <= 0) return;
    clearIdleTimeout();
    idleTimeoutId = setTimeout(() => {
      idleTimedOut = true;
      void reader.cancel("remote_compaction_streaming_idle_timeout").catch(() => undefined);
    }, input.idleTimeoutMs);
  };

  const abortListener = () => {
    void reader.cancel(input.abortSignal?.reason).catch(() => undefined);
  };
  input.abortSignal?.addEventListener("abort", abortListener, { once: true });

  try {
    while (true) {
      if (input.abortSignal?.aborted) {
        throw new DOMException("Request aborted", "AbortError");
      }
      const { done, value } = await reader.read();
      if (done) break;
      if (!firstByteSeen) {
        firstByteSeen = true;
        input.onFirstByte?.();
      }
      resetIdleTimeout();
      totalBytes += value.byteLength;
      chunks.push(value);
      if (totalBytes > input.maxBytes) {
        await reader.cancel("remote_compaction_response_too_large").catch(() => undefined);
        const validation: ExplicitCompactionValidationResult = {
          outcome: "overflow",
          usage: extractPartialUsage(chunks, isSse),
          evidence: {
            transport: response.headers.get("content-type")?.includes("text/event-stream")
              ? "sse"
              : "json",
            version: input.version,
            responseBytes: totalBytes,
            terminalSeen: false,
            compactionItemCount: 0,
            sourceCount: 0,
          },
        };
        throw new ExplicitCompactionResponseError(
          validation,
          "remote_compaction_response_too_large"
        );
      }
    }
    if (timedOut || idleTimedOut || input.responseTimeoutSignal?.aborted) {
      const transportTimeout = idleTimedOut || input.responseTimeoutSignal?.aborted;
      const validation: ExplicitCompactionValidationResult = {
        outcome: "timeout",
        usage: extractPartialUsage(chunks, isSse),
        evidence: {
          transport: isSse ? "sse" : "json",
          version: input.version,
          responseBytes: totalBytes,
          terminalSeen: false,
          compactionItemCount: 0,
          sourceCount: 0,
          timeoutKind: transportTimeout ? "transport" : "validation",
          ...(transportTimeout
            ? {
                transportFailureReason: idleTimedOut
                  ? ("idle_timeout" as const)
                  : ("first_byte_timeout" as const),
              }
            : {}),
        },
      };
      throw new ExplicitCompactionResponseError(validation, "remote_compaction_timeout");
    }
    if (input.abortSignal?.aborted) {
      throw new DOMException("Request aborted", "AbortError");
    }
  } catch (error) {
    if (error instanceof ExplicitCompactionResponseError) throw error;
    const timeout = timedOut || idleTimedOut || input.responseTimeoutSignal?.aborted;
    const transportTimeout = idleTimedOut || input.responseTimeoutSignal?.aborted;
    const outcome = timeout ? "timeout" : "aborted";
    const validation: ExplicitCompactionValidationResult = {
      outcome,
      usage: extractPartialUsage(chunks, isSse),
      evidence: {
        transport: isSse ? "sse" : "json",
        version: input.version,
        responseBytes: totalBytes,
        terminalSeen: false,
        compactionItemCount: 0,
        sourceCount: 0,
        ...(timeout
          ? { timeoutKind: transportTimeout ? ("transport" as const) : ("validation" as const) }
          : {}),
        ...(transportTimeout
          ? {
              transportFailureReason: idleTimedOut
                ? ("idle_timeout" as const)
                : ("first_byte_timeout" as const),
            }
          : {}),
      },
    };
    if (timeout) {
      throw new ExplicitCompactionResponseError(validation, "remote_compaction_timeout");
    }
    throw new ExplicitCompactionAttemptInterruptedError(validation, error);
  } finally {
    clearTimeout(timeoutId);
    clearIdleTimeout();
    input.abortSignal?.removeEventListener("abort", abortListener);
  }

  const bytes = concatBytes(chunks);

  const parsedValidation = validateExplicitCompactionPayload({
    bytes,
    contentType: response.headers.get("content-type") ?? "application/json",
    isSub2Api: input.isSub2Api,
    version: input.version,
  });
  const validation: ExplicitCompactionValidationResult = input.bypassValidation
    ? {
        outcome: "bypassed",
        usage: parsedValidation.usage,
        evidence: parsedValidation.evidence,
      }
    : parsedValidation;
  if (!input.bypassValidation && validation.outcome !== "valid") {
    throw new ExplicitCompactionResponseError(validation, "remote_compaction_invalid_response");
  }

  let outputBytes = bytes;
  let outputContentType = response.headers.get("content-type") ?? "application/json";
  const text = new TextDecoder().decode(bytes);
  if (isSse && input.upstreamMode === "sub2api_v1_bridge") {
    const normalizedJson = normalizeBridgeV1Json(text, input.isSub2Api === true);
    if (normalizedJson !== null) {
      outputBytes = new TextEncoder().encode(normalizedJson);
      outputContentType = "application/json";
    }
  } else if (isSse) {
    outputBytes = new TextEncoder().encode(normalizeSseForClient(text, input.isSub2Api === true));
    outputContentType = "text/event-stream";
  }

  const headers = new Headers(response.headers);
  headers.delete("transfer-encoding");
  headers.delete("content-encoding");
  headers.set("content-type", outputContentType);
  headers.set("content-length", String(outputBytes.byteLength));
  return {
    response: new Response(outputBytes as unknown as BodyInit, {
      status: response.status,
      statusText: response.statusText,
      headers,
    }),
    validation,
  };
}

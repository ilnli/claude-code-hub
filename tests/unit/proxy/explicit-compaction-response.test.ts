import { describe, expect, it, vi } from "vitest";
import {
  collectExplicitCompactionResponse,
  validateExplicitCompactionPayload,
} from "@/app/v1/_lib/proxy/explicit-compaction-response";

const encoder = new TextEncoder();

function validateJson(payload: unknown) {
  return validateExplicitCompactionPayload({
    bytes: encoder.encode(JSON.stringify(payload)),
    contentType: "application/json",
    version: "v1",
  });
}

describe("explicit compaction response validation", () => {
  it("accepts one compaction among ordinary output items", () => {
    const result = validateJson({
      object: "response.compaction",
      output: [
        { type: "message", content: [] },
        { type: "compaction", id: "cmp_1", encrypted_content: "opaque" },
      ],
      usage: { input_tokens: 10, output_tokens: 2 },
    });

    expect(result.outcome).toBe("valid");
    expect(result.usage).toEqual({ input_tokens: 10, output_tokens: 2 });
  });

  it("rejects zero, multiple, and empty compaction outputs", () => {
    expect(validateJson({ object: "response.compaction", output: [] }).reason).toBe(
      "missing_compaction_output"
    );
    expect(
      validateJson({
        object: "response.compaction",
        output: [
          { type: "compaction", encrypted_content: "a" },
          { type: "compaction", encrypted_content: "b" },
        ],
      }).reason
    ).toBe("multiple_compaction_outputs");
    expect(
      validateJson({
        object: "response.compaction",
        output: [{ type: "compaction", encrypted_content: "  " }],
      }).reason
    ).toBe("empty_compaction_encrypted_content");
  });

  it("rejects malformed and failed JSON results", () => {
    expect(
      validateExplicitCompactionPayload({
        bytes: encoder.encode("{"),
        contentType: "application/json",
        version: "v2",
      }).reason
    ).toBe("malformed_compaction_response");
    expect(
      validateJson({
        object: "response.compaction",
        status: "failed",
        output: [{ type: "compaction", encrypted_content: "opaque" }],
      }).reason
    ).toBe("failed_compaction_terminal");
    expect(
      validateJson({
        object: "response",
        output: [{ type: "compaction", encrypted_content: "opaque" }],
      }).reason
    ).toBe("malformed_compaction_response");
  });

  it("deduplicates matching SSE done and terminal representations", () => {
    const sse = [
      "event: response.output_item.done",
      'data: {"type":"response.output_item.done","output_index":0,"item":{"id":"cmp_1","type":"compaction","encrypted_content":"opaque"}}',
      "",
      "event: response.completed",
      'data: {"type":"response.completed","response":{"status":"completed","output":[{"id":"cmp_1","type":"compaction","encrypted_content":"opaque"}],"usage":{"input_tokens":4}}}',
      "",
    ].join("\n");
    const result = validateExplicitCompactionPayload({
      bytes: encoder.encode(sse),
      contentType: "text/event-stream",
      version: "v2",
    });

    expect(result.outcome).toBe("valid");
    expect(result.evidence.compactionItemCount).toBe(1);
    expect(result.usage).toEqual({ input_tokens: 4 });
  });

  it("deduplicates by output index when optional item identity is absent in one view", () => {
    const sse = [
      'data: {"type":"response.output_item.done","output_index":0,"item":{"id":"cmp_1","type":"compaction","encrypted_content":"opaque"}}',
      "",
      'data: {"type":"response.completed","response":{"status":"completed","output":[{"type":"compaction","encrypted_content":"opaque"}]}}',
      "",
    ].join("\n");
    const result = validateExplicitCompactionPayload({
      bytes: encoder.encode(sse),
      contentType: "text/event-stream",
      version: "v2",
    });

    expect(result.outcome).toBe("valid");
    expect(result.evidence.compactionItemCount).toBe(1);
  });

  it("rejects inconsistent duplicate SSE representations", () => {
    const sse = [
      'data: {"type":"response.output_item.done","output_index":0,"item":{"id":"cmp_1","type":"compaction","encrypted_content":"first"}}',
      "",
      'data: {"type":"response.completed","response":{"output":[{"id":"cmp_1","type":"compaction","encrypted_content":"second"}]}}',
      "",
    ].join("\n");
    const result = validateExplicitCompactionPayload({
      bytes: encoder.encode(sse),
      contentType: "text/event-stream",
      version: "v2",
    });

    expect(result.reason).toBe("inconsistent_compaction_output");
  });

  it("requires a successful SSE terminal event", () => {
    const result = validateExplicitCompactionPayload({
      bytes: encoder.encode(
        'data: {"type":"response.output_item.done","item":{"type":"compaction","encrypted_content":"opaque"}}\n\n'
      ),
      contentType: "text/event-stream",
      version: "v2",
    });
    expect(result.reason).toBe("missing_successful_terminal");
  });

  it("preserves the validated response bytes", async () => {
    const raw =
      '{ "object":"response.compaction", "output": [{"type":"compaction","encrypted_content":"opaque"}] }';
    const collected = await collectExplicitCompactionResponse({
      response: new Response(raw, { headers: { "content-type": "application/json" } }),
      version: "v1",
      maxBytes: 1024,
      timeoutMs: 1000,
    });

    expect(await collected.response.text()).toBe(raw);
  });

  it("records bypassed validation while preserving returned usage", async () => {
    const raw = JSON.stringify({
      output: [{ type: "message", content: [] }],
      usage: { input_tokens: 12, output_tokens: 3 },
    });
    const collected = await collectExplicitCompactionResponse({
      response: new Response(raw, { headers: { "content-type": "application/json" } }),
      version: "v2",
      maxBytes: 1024,
      timeoutMs: 1000,
      bypassValidation: true,
    });

    expect(collected.validation.outcome).toBe("bypassed");
    expect(collected.validation.usage).toEqual({ input_tokens: 12, output_tokens: 3 });
    expect(await collected.response.text()).toBe(raw);
  });

  it("rejects a response over the configured byte limit", async () => {
    await expect(
      collectExplicitCompactionResponse({
        response: new Response("12345", { headers: { "content-type": "application/json" } }),
        version: "v1",
        maxBytes: 4,
        timeoutMs: 1000,
      })
    ).rejects.toMatchObject({ publicCode: "remote_compaction_response_too_large" });
  });

  it("applies the provider streaming idle timeout after the first SSE byte", async () => {
    vi.useFakeTimers();
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(encoder.encode('data: {"type":"response.created"}\n\n'));
      },
    });

    const promise = collectExplicitCompactionResponse({
      response: new Response(body, { headers: { "content-type": "text/event-stream" } }),
      version: "v2",
      maxBytes: 1024,
      timeoutMs: 10_000,
      idleTimeoutMs: 100,
    });
    const assertion = expect(promise).rejects.toMatchObject({
      publicCode: "remote_compaction_timeout",
    });
    try {
      await vi.advanceTimersByTimeAsync(100);
      await assertion;
    } finally {
      vi.useRealTimers();
    }
  });
});

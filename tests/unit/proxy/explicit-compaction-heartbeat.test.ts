import { describe, expect, it, vi } from "vitest";
import { createExplicitCompactionV2HeartbeatResponse } from "@/app/v1/_lib/proxy/explicit-compaction-heartbeat";

describe("explicit compaction v2 downstream heartbeat", () => {
  it("emits comments before the validated semantic response", async () => {
    vi.useFakeTimers();
    let resolveResponse: ((response: Response) => void) | null = null;
    const response = createExplicitCompactionV2HeartbeatResponse({
      fallbackErrorMessage: "failed",
      heartbeatIntervalMs: 100,
      requestId: "req_1",
      execute: () =>
        new Promise<Response>((resolve) => {
          resolveResponse = resolve;
        }),
    });
    const reader = response.body?.getReader();
    expect(reader).toBeDefined();
    try {
      const firstRead = reader!.read();
      await vi.advanceTimersByTimeAsync(100);
      expect(new TextDecoder().decode((await firstRead).value)).toBe(
        ": cch-compaction-heartbeat\n\n"
      );

      const finalRead = reader!.read();
      resolveResponse!(
        new Response('event: response.completed\ndata: {"type":"response.completed"}\n\n', {
          headers: { "content-type": "text/event-stream" },
        })
      );
      expect(new TextDecoder().decode((await finalRead).value)).toContain("response.completed");
    } finally {
      vi.useRealTimers();
    }
  });

  it("converts an HTTP error into response.failed after the stream is committed", async () => {
    const response = createExplicitCompactionV2HeartbeatResponse({
      fallbackErrorMessage: "failed",
      requestId: "req_2",
      execute: async () =>
        new Response(
          JSON.stringify({ error: { code: "remote_compaction_timeout", message: "timeout" } }),
          { status: 504, headers: { "content-type": "application/json" } }
        ),
    });

    expect(response.status).toBe(200);
    const text = await response.text();
    expect(text).toContain("event: response.failed");
    expect(text).toContain('"code":"remote_compaction_timeout"');
    expect(text).toContain('"id":"req_2"');
  });
});

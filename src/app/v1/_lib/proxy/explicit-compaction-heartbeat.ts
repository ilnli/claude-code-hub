const DEFAULT_HEARTBEAT_INTERVAL_MS = 15_000;
const encoder = new TextEncoder();

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function asSseEvent(event: string, data: unknown): Uint8Array {
  return encoder.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
}

async function readErrorPayload(
  response: Response,
  fallbackMessage: string
): Promise<{
  code: string;
  message: string;
}> {
  try {
    const payload = (await response.json()) as unknown;
    if (isRecord(payload) && isRecord(payload.error)) {
      return {
        code:
          typeof payload.error.code === "string" ? payload.error.code : `http_${response.status}`,
        message:
          typeof payload.error.message === "string" ? payload.error.message : fallbackMessage,
      };
    }
  } catch {
    // Fall through to the stable public error below.
  }
  return { code: `http_${response.status}`, message: fallbackMessage };
}

async function responseBytesAsSse(
  response: Response,
  requestId: string | null,
  fallbackMessage: string
): Promise<Uint8Array> {
  if (!response.ok) {
    const error = await readErrorPayload(response, fallbackMessage);
    return asSseEvent("response.failed", {
      type: "response.failed",
      response: {
        id: requestId,
        object: "response",
        status: "failed",
        output: [],
        error,
      },
    });
  }

  const contentType = response.headers.get("content-type")?.toLowerCase() ?? "";
  if (contentType.includes("text/event-stream")) {
    return new Uint8Array(await response.arrayBuffer());
  }

  const text = await response.text();
  let payload: unknown = text;
  try {
    payload = JSON.parse(text) as unknown;
  } catch {
    // The validator normally rejects this; keep a parse-safe envelope here.
  }
  return asSseEvent("response.completed", {
    type: "response.completed",
    response: payload,
  });
}

export function createExplicitCompactionV2HeartbeatResponse(input: {
  execute: () => Promise<Response>;
  fallbackErrorMessage: string;
  heartbeatIntervalMs?: number;
  onSettled?: () => Promise<void> | void;
  requestId: string | null;
}): Response {
  let cancelled = false;
  let heartbeat: ReturnType<typeof setInterval> | null = null;
  let settled = false;

  const settle = async () => {
    if (settled) return;
    settled = true;
    if (heartbeat) clearInterval(heartbeat);
    heartbeat = null;
    try {
      await input.onSettled?.();
    } catch {
      // Response delivery is already terminal; counter cleanup is best-effort here.
    }
  };

  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      heartbeat = setInterval(() => {
        if (!cancelled) controller.enqueue(encoder.encode(": cch-compaction-heartbeat\n\n"));
      }, input.heartbeatIntervalMs ?? DEFAULT_HEARTBEAT_INTERVAL_MS);

      void (async () => {
        try {
          const response = await input.execute();
          const bytes = await responseBytesAsSse(
            response,
            input.requestId,
            input.fallbackErrorMessage
          );
          if (heartbeat) clearInterval(heartbeat);
          heartbeat = null;
          if (!cancelled) {
            controller.enqueue(bytes);
            controller.close();
          }
        } catch {
          if (heartbeat) clearInterval(heartbeat);
          heartbeat = null;
          if (!cancelled) {
            controller.enqueue(
              asSseEvent("response.failed", {
                type: "response.failed",
                response: {
                  id: input.requestId,
                  object: "response",
                  status: "failed",
                  output: [],
                  error: {
                    code: "internal_server_error",
                    message: input.fallbackErrorMessage,
                  },
                },
              })
            );
            controller.close();
          }
        } finally {
          await settle();
        }
      })();
    },
    async cancel() {
      cancelled = true;
      await settle();
    },
  });

  return new Response(body, {
    status: 200,
    headers: {
      "cache-control": "no-cache, no-transform",
      "content-type": "text/event-stream; charset=utf-8",
      "x-accel-buffering": "no",
    },
  });
}

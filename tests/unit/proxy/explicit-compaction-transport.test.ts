import { describe, expect, it } from "vitest";
import { prepareExplicitCompactionTransport } from "@/app/v1/_lib/proxy/explicit-compaction-transport";

describe("explicit compaction upstream transport", () => {
  it("turns sub2api v1 into the existing body-signal SSE bridge", () => {
    const prepared = prepareExplicitCompactionTransport({
      body: JSON.stringify({ model: "gpt-5.5", input: [{ type: "message" }] }),
      headers: new Headers({
        "content-type": "application/json",
        "x-codex-beta-features": "responses_websockets_v2, remote_compaction_v2",
      }),
      isStreaming: false,
      isSub2Api: true,
      message: {
        model: "gpt-5.5",
        input: [{ type: "message", role: "user", content: "keep" }],
        prompt_cache_key: "cache-1",
      },
      url: "https://sub2.example/v1/responses/compact?trace=1",
      version: "v1",
    });

    expect(prepared.mode).toBe("sub2api_v1_bridge");
    expect(prepared.isStreaming).toBe(true);
    expect(prepared.url).toBe("https://sub2.example/v1/responses?trace=1");
    expect(prepared.headers.get("x-codex-beta-features")).toBe("responses_websockets_v2");
    expect(JSON.parse(String(prepared.body))).toMatchObject({
      stream: true,
      prompt_cache_key: "cache-1",
      input: [{ type: "message", role: "user", content: "keep" }, { type: "compaction_trigger" }],
    });
  });

  it("ensures the native v2 feature without replacing other features", () => {
    const body = JSON.stringify({
      model: "gpt-5.6-sol",
      stream: true,
      input: [{ type: "compaction_trigger" }],
    });
    const prepared = prepareExplicitCompactionTransport({
      body,
      headers: new Headers({ "x-codex-beta-features": "responses_websockets_v2" }),
      isStreaming: true,
      isSub2Api: true,
      message: JSON.parse(body),
      url: "https://sub2.example/v1/responses",
      version: "v2",
    });

    expect(prepared.mode).toBe("sub2api_native_v2");
    expect(prepared.body).toBe(body);
    expect(prepared.headers.get("x-codex-beta-features")).toBe(
      "responses_websockets_v2, remote_compaction_v2"
    );
  });

  it("leaves generic providers unchanged", () => {
    const body = JSON.stringify({ model: "gpt-5", input: [] });
    const prepared = prepareExplicitCompactionTransport({
      body,
      headers: new Headers(),
      isStreaming: false,
      isSub2Api: false,
      message: { model: "gpt-5", input: [] },
      url: "https://newapi.example/v1/responses/compact",
      version: "v1",
    });
    expect(prepared).toMatchObject({ body, mode: "standard", isStreaming: false });
  });

  it("requires streaming for sub2api native v2", () => {
    expect(() =>
      prepareExplicitCompactionTransport({
        body: "{}",
        headers: new Headers(),
        isStreaming: false,
        isSub2Api: true,
        message: { stream: false },
        url: "https://sub2.example/v1/responses",
        version: "v2",
      })
    ).toThrow("remote_compaction_v2_requires_stream");
  });
});

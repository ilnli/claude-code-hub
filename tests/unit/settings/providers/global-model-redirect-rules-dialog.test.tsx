/** @vitest-environment happy-dom */
import { NextIntlClientProvider } from "next-intl";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { GlobalModelRedirectRulesDialog } from "@/app/[locale]/settings/providers/_components/global-model-redirect-rules-dialog";
import type { ProviderDisplay } from "@/types/provider";
import settings from "../../../../messages/en/settings";
import ui from "../../../../messages/en/ui.json";

const api = vi.hoisted(() => ({ load: vi.fn(), save: vi.fn() }));
vi.mock("@/lib/api-client/v1/actions/system-config", () => ({
  fetchSystemSettings: api.load,
  saveSystemSettings: api.save,
}));
vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

const providers = [
  { id: 1, name: "Alpha", modelRedirects: null },
  {
    id: 2,
    name: "Beta",
    modelRedirects: [{ matchType: "exact", source: "a", target: "provider-result" }],
  },
] as ProviderDisplay[];
let root: Root;
let container: HTMLDivElement;

async function click(selector: string) {
  const element = document.querySelector<HTMLButtonElement>(selector);
  expect(element, selector).toBeTruthy();
  await act(async () => {
    element!.click();
  });
}
async function input(selector: string, value: string) {
  await act(async () => {
    const element = document.querySelector<HTMLInputElement>(selector)!;
    element.value = value;
    element.dispatchEvent(new Event("input", { bubbles: true }));
  });
}
async function open() {
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  await act(async () => {
    root.render(
      <NextIntlClientProvider locale="en" messages={{ settings, ui }} timeZone="UTC">
        <GlobalModelRedirectRulesDialog providers={providers} />
      </NextIntlClientProvider>
    );
  });
  await click("[data-global-redirect-trigger]");
}

beforeEach(() => {
  api.load.mockResolvedValue({
    ok: true,
    data: {
      globalModelRedirects: [
        { matchType: "exact", source: "a", target: "b", excludedProviderIds: [] },
        { matchType: "exact", source: "b", target: "c", excludedProviderIds: [] },
      ],
    },
  });
  api.save.mockResolvedValue({ ok: true, data: {} });
});
afterEach(async () => {
  await act(async () => {
    root?.unmount();
  });
  container?.remove();
  vi.clearAllMocks();
});

describe("global model redirects", () => {
  test("saves ordered edits and exclusions, defaulting new rules to all providers", async () => {
    await open();
    await click('[data-global-redirect-exclusions="0"]');
    await click('[data-global-redirect-exclude="2"]');
    await click('[data-global-redirect-exclusions="0"]');
    await click('[data-redirect-edit="0"]');
    await input('[data-redirect-edit-target="0"]', "edited");
    await click('[data-redirect-save="0"]');
    await click('[data-redirect-move-down="0"]');
    await input("#new-source", "new");
    await input("#new-target", "result");
    await click("[data-redirect-add]");
    await click('[data-redirect-edit="2"]');
    await input('[data-redirect-edit-target="2"]', "result-edited");
    await click('[data-redirect-save="2"]');
    await click("[data-global-redirect-save]");
    expect(api.save).toHaveBeenCalledWith({
      globalModelRedirects: [
        { matchType: "exact", source: "b", target: "c", excludedProviderIds: [] },
        { matchType: "exact", source: "a", target: "edited", excludedProviderIds: [2] },
        { matchType: "exact", source: "new", target: "result-edited", excludedProviderIds: [] },
      ],
    });
    expect(document.querySelector('[role="dialog"]')).toBeNull();
  });

  test("previews every global step and provider precedence using the selected provider", async () => {
    await open();
    await input("#global-model-preview", "a");
    expect(document.querySelector("[data-global-redirect-preview]")?.textContent).toContain("a");
    expect(document.querySelectorAll("[data-global-redirect-step]")).toHaveLength(2);
    expect(document.querySelector("[data-global-redirect-preview]")?.textContent).toContain("c");
    await act(async () => {
      const select = document.querySelector<HTMLSelectElement>("#global-provider-preview")!;
      select.value = "2";
      select.dispatchEvent(new Event("change", { bubbles: true }));
    });
    expect(document.querySelectorAll("[data-global-redirect-step]")).toHaveLength(1);
    expect(document.querySelector("[data-global-redirect-preview]")?.textContent).toContain(
      "provider-result"
    );
    expect(document.querySelector("[data-global-redirect-preview]")?.textContent).toContain(
      "Provider rule matched"
    );
  });

  test("keeps the dialog open and shows save failures", async () => {
    api.save.mockResolvedValue({ ok: false, error: "Write failed" });
    await open();
    await click("[data-global-redirect-save]");
    expect(document.querySelector('[role="dialog"]')).not.toBeNull();
    expect(document.querySelector('[role="alert"]')?.textContent).toContain("Write failed");
  });

  test("prevents replacing settings after a failed load and allows retry", async () => {
    api.load.mockResolvedValueOnce({ ok: false, error: "Read failed" });
    await open();
    expect(document.querySelector('[role="alert"]')?.textContent).toContain("Read failed");
    expect(document.querySelector("[data-global-redirect-save]")).toBeNull();
    await click("[data-global-redirect-retry]");
    expect(document.querySelector('[data-redirect-edit="0"]')).not.toBeNull();
  });
  test("removing exclusions restores the full preview and deleting a rule changes the saved draft", async () => {
    await open();
    await input("#global-model-preview", "a");
    await click('[data-global-redirect-exclusions="0"]');
    await click('[data-global-redirect-exclude="1"]');
    expect(document.querySelectorAll("[data-global-redirect-step]")).toHaveLength(0);
    await click('[data-global-redirect-exclude="1"]');
    expect(document.querySelectorAll("[data-global-redirect-step]")).toHaveLength(2);
    await click('[data-global-redirect-exclude="1"]');
    const clear = Array.from(document.querySelectorAll<HTMLButtonElement>("button")).find(
      (button) => button.textContent === "Clear exclusions"
    )!;
    await act(async () => {
      clear.click();
    });
    expect(document.querySelectorAll("[data-global-redirect-step]")).toHaveLength(2);
    await input("#excluded-search-0", "missing");
    expect(document.body.textContent).toContain("No providers found.");
    await click('[data-global-redirect-exclusions="0"]');
    await click('[data-redirect-remove="1"]');
    expect(document.querySelectorAll("[data-global-redirect-step]")).toHaveLength(1);
    await click("[data-global-redirect-save]");
    expect(api.save).toHaveBeenCalledWith({
      globalModelRedirects: [
        { matchType: "exact", source: "a", target: "b", excludedProviderIds: [] },
      ],
    });
  });

  test("discards cancelled changes when reopened and handles an empty rule list", async () => {
    api.load.mockResolvedValue({ ok: true, data: { globalModelRedirects: [] } });
    await open();
    await input("#new-source", "draft");
    await input("#new-target", "target");
    await click("[data-redirect-add]");
    const cancel = Array.from(document.querySelectorAll<HTMLButtonElement>("button")).find(
      (button) => button.textContent === "Cancel"
    )!;
    await act(async () => {
      cancel.click();
    });
    await click("[data-global-redirect-trigger]");
    expect(document.querySelector('[data-redirect-edit="0"]')).toBeNull();
    await click("[data-global-redirect-save]");
    expect(api.save).toHaveBeenCalledWith({ globalModelRedirects: [] });
  });

  test("renders translated errors when a request throws", async () => {
    api.load.mockRejectedValueOnce(new Error("Network unavailable"));
    await open();
    expect(document.querySelector('[role="alert"]')?.textContent).toContain(
      "Could not load model mappings."
    );
    await click("[data-global-redirect-retry]");
    api.save.mockRejectedValueOnce(new Error("Network unavailable"));
    await click("[data-global-redirect-save]");
    expect(document.querySelector('[role="alert"]')?.textContent).toContain(
      "Could not save model mappings."
    );
  });
  test("keeps identical-source rules independent and permits adding another scoped rule", async () => {
    api.load.mockResolvedValue({
      ok: true,
      data: {
        globalModelRedirects: [
          { matchType: "exact", source: "a", target: "alpha", excludedProviderIds: [2] },
          { matchType: "exact", source: "a", target: "beta", excludedProviderIds: [1] },
        ],
      },
    });
    await open();
    await act(async () => {
      document.querySelectorAll<HTMLButtonElement>("[data-redirect-edit]")[1].click();
    });
    await input("[data-redirect-edit-target]", "beta-edited");
    await click("[data-redirect-save]");
    await act(async () => {
      document.querySelectorAll<HTMLButtonElement>("[data-redirect-remove]")[0].click();
    });
    await input("#new-source", "a");
    await input("#new-target", "fallback");
    await click("[data-redirect-add]");
    await click("[data-global-redirect-save]");
    expect(api.save).toHaveBeenCalledWith({
      globalModelRedirects: [
        { matchType: "exact", source: "a", target: "beta-edited", excludedProviderIds: [1] },
        { matchType: "exact", source: "a", target: "fallback", excludedProviderIds: [] },
      ],
    });
  });
});

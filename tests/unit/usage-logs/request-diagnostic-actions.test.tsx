import { NextIntlClientProvider } from "next-intl";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, test, vi } from "vitest";
import messages from "../../../messages/en/dashboard.json";
import { RequestDiagnosticActions } from "@/app/[locale]/dashboard/logs/_components/error-details-dialog/components/RequestDiagnosticActions";

const mocks = vi.hoisted(() => ({ copy: vi.fn(), success: vi.fn(), error: vi.fn() }));
vi.mock("@/lib/utils/clipboard", () => ({ copyTextToClipboard: mocks.copy }));
vi.mock("sonner", () => ({ toast: { success: mocks.success, error: mocks.error } }));

const details = {
  requestId: 901,
  statusCode: 500,
  errorMessage: "Client aborted request",
  inputTokens: null,
  costUsd: "0",
};

function render() {
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  act(() =>
    root.render(
      <NextIntlClientProvider locale="en" messages={{ dashboard: messages }}>
        <RequestDiagnosticActions details={details} />
      </NextIntlClientProvider>
    )
  );
  return {
    click: async (action: string) => {
      await act(async () => {
        container
          .querySelector<HTMLButtonElement>(`[data-request-diagnostic-action="${action}"]`)!
          .click();
      });
    },
    cleanup: () => {
      act(() => root.unmount());
      container.remove();
    },
  };
}

afterEach(() => vi.restoreAllMocks());

describe("request diagnostic actions", () => {
  test("copies the request snapshot as formatted JSON", async () => {
    mocks.copy.mockResolvedValue(true);
    const ui = render();
    try {
      await ui.click("copy");
      expect(JSON.parse(mocks.copy.mock.calls[0][0]).request).toEqual(details);
      expect(mocks.success).toHaveBeenCalledWith("Request diagnostics copied");
    } finally {
      ui.cleanup();
    }
  });

  test.each(["denied", "throws"])("reports a %s clipboard failure", async (failure) => {
    if (failure === "throws") mocks.copy.mockRejectedValue(new Error("clipboard unavailable"));
    else mocks.copy.mockResolvedValue(false);
    const ui = render();
    try {
      await ui.click("copy");
      expect(mocks.error).toHaveBeenCalledWith("Copy failed. Try exporting JSON.");
      expect(mocks.success).not.toHaveBeenCalled();
    } finally {
      ui.cleanup();
    }
  });

  test("downloads a JSON file containing the same diagnostic fields", async () => {
    const createUrl = vi.spyOn(URL, "createObjectURL").mockReturnValue("blob:diagnostic-export");
    const revoke = vi.spyOn(URL, "revokeObjectURL").mockImplementation(() => {});
    let filename: string | undefined;
    vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(function () {
      filename = this.download;
    });
    const ui = render();
    try {
      await ui.click("download");
      expect(filename).toBe("cch-request-901.json");
      const blob = createUrl.mock.calls[0][0] as Blob;
      expect(JSON.parse(await blob.text()).request).toEqual(details);
      await vi.waitFor(() => expect(revoke).toHaveBeenCalledWith("blob:diagnostic-export"));
      expect(document.querySelector('a[download="cch-request-901.json"]')).toBeNull();
    } finally {
      ui.cleanup();
    }
  });

  test("reports a download failure", async () => {
    vi.spyOn(URL, "createObjectURL").mockImplementation(() => {
      throw new Error("no blob support");
    });
    const ui = render();
    try {
      await ui.click("download");
      expect(mocks.error).toHaveBeenCalledWith("Could not export request diagnostics");
    } finally {
      ui.cleanup();
    }
  });
});

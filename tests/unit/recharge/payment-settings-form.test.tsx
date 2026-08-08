/** @vitest-environment happy-dom */

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const getConfigMock = vi.fn();
const updateConfigMock = vi.fn();
const testConfigMock = vi.fn();
const toastErrorMock = vi.fn();
const toastSuccessMock = vi.fn();

vi.mock("next-intl", () => {
  const translate = (key: string) => key;
  return { useTranslations: () => translate };
});
vi.mock("sonner", () => ({ toast: { error: toastErrorMock, success: toastSuccessMock } }));
vi.mock("@/lib/api-client/v1/actions/recharge", () => ({
  getRechargePaymentConfig: getConfigMock,
  testRechargePaymentConfig: testConfigMock,
  updateRechargePaymentConfig: updateConfigMock,
}));
vi.mock("@/components/section", () => ({
  Section: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
}));
vi.mock("@/components/ui/alert", () => ({
  Alert: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  AlertDescription: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
}));
vi.mock("@/components/ui/button", () => ({
  Button: ({ children, onClick, disabled }: any) => (
    <button type="button" onClick={onClick} disabled={disabled}>
      {children}
    </button>
  ),
}));
vi.mock("@/components/ui/checkbox", () => ({
  Checkbox: ({ checked, onCheckedChange, id }: any) => (
    <input
      id={id}
      type="checkbox"
      checked={checked}
      onChange={(event) => onCheckedChange(event.currentTarget.checked)}
    />
  ),
}));
vi.mock("@/components/ui/input", () => ({
  Input: (props: any) => <input {...props} />,
}));
vi.mock("@/components/ui/label", () => ({
  Label: ({ children, htmlFor }: any) => <label htmlFor={htmlFor}>{children}</label>,
}));
vi.mock("@/components/ui/switch", () => ({
  Switch: ({ checked, onCheckedChange }: any) => (
    <input
      type="checkbox"
      checked={checked}
      onChange={(event) => onCheckedChange(event.currentTarget.checked)}
    />
  ),
}));
vi.mock("@/components/ui/textarea", () => ({
  Textarea: (props: any) => <textarea {...props} />,
}));

describe("PaymentSettingsForm key replacement", () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    vi.clearAllMocks();
    getConfigMock.mockResolvedValue({
      id: 1,
      enabled: true,
      appId: "app",
      privateKeyConfigured: true,
      alipayPublicKeyConfigured: true,
      productName: "SKHUB",
      notifyDomain: null,
      feeRatePercent: "0.0000",
      minCreditUsd: "1.00",
      maxCreditUsd: "1000.00",
      createdAt: new Date().toISOString(),
    });
    updateConfigMock.mockRejectedValue(new Error("request failed"));
    testConfigMock.mockResolvedValue({ success: true, orderNo: "RCTEST123" });
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  it("keeps replacement secrets after a failed save", async () => {
    const { PaymentSettingsForm } = await import(
      "@/app/[locale]/settings/payment/payment-settings-form"
    );
    await act(async () => {
      root.render(<PaymentSettingsForm />);
    });

    const replace = container.querySelector<HTMLInputElement>("#replacePaymentKeys");
    expect(replace?.checked).toBe(false);
    await act(async () => {
      replace?.click();
    });

    const textareas = container.querySelectorAll<HTMLTextAreaElement>("textarea");
    expect(textareas[0]?.disabled).toBe(false);
    await act(async () => {
      setTextareaValue(textareas[0], "new-private");
      setTextareaValue(textareas[1], "new-public");
    });

    const save = Array.from(container.querySelectorAll("button")).find((button) =>
      button.textContent?.includes("save")
    );
    await act(async () => {
      save?.click();
    });

    expect(updateConfigMock).toHaveBeenCalledWith(
      expect.objectContaining({ privateKey: "new-private", alipayPublicKey: "new-public" })
    );
    expect(textareas[0]?.value).toBe("new-private");
    expect(textareas[1]?.value).toBe("new-public");
    expect(toastErrorMock).toHaveBeenCalledWith("saveFailed");
  });

  it("tests replacement secrets without saving them", async () => {
    const { PaymentSettingsForm } = await import(
      "@/app/[locale]/settings/payment/payment-settings-form"
    );
    await act(async () => {
      root.render(<PaymentSettingsForm />);
    });

    const replace = container.querySelector<HTMLInputElement>("#replacePaymentKeys");
    await act(async () => {
      replace?.click();
    });
    const textareas = container.querySelectorAll<HTMLTextAreaElement>("textarea");
    await act(async () => {
      setTextareaValue(textareas[0], "new-private");
      setTextareaValue(textareas[1], "new-public");
    });

    const test = Array.from(container.querySelectorAll("button")).find((button) =>
      button.textContent?.includes("test")
    );
    await act(async () => {
      test?.click();
    });

    expect(testConfigMock).toHaveBeenCalledWith(
      expect.objectContaining({ privateKey: "new-private", alipayPublicKey: "new-public" })
    );
    expect(updateConfigMock).not.toHaveBeenCalled();
    expect(toastSuccessMock).toHaveBeenCalledWith("testSucceeded", {
      description: "testOrder",
    });
  });
});

function setTextareaValue(element: HTMLTextAreaElement, value: string): void {
  const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")?.set;
  setter?.call(element, value);
  element.dispatchEvent(new Event("input", { bubbles: true }));
}

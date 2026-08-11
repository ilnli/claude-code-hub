import { beforeEach, describe, expect, it, vi } from "vitest";

type FluentQuery = Record<string, ReturnType<typeof vi.fn>> & PromiseLike<unknown>;

let selectMock: ReturnType<typeof vi.fn>;
let insertMock: ReturnType<typeof vi.fn>;
let updateMock: ReturnType<typeof vi.fn>;
let deleteMock: ReturnType<typeof vi.fn>;
let transactionMock: ReturnType<typeof vi.fn>;

vi.mock("@/drizzle/db", () => ({
  db: {
    select: (...args: unknown[]) => selectMock(...args),
    insert: (...args: unknown[]) => insertMock(...args),
    update: (...args: unknown[]) => updateMock(...args),
    delete: (...args: unknown[]) => deleteMock(...args),
    transaction: (...args: unknown[]) => transactionMock(...args),
  },
}));

import {
  deleteEmptyUpstreamSite,
  findUpstreamSites,
  getOrCreateUpstreamSiteIdForUrl,
  tryDeleteUnconfiguredUpstreamSiteIfEmpty,
} from "@/repository/upstream-site";

function fluent(result: unknown): FluentQuery {
  const query = {} as FluentQuery;
  for (const method of [
    "select",
    "from",
    "where",
    "orderBy",
    "limit",
    "for",
    "values",
    "onConflictDoNothing",
    "returning",
    "set",
  ]) {
    query[method] = vi.fn(() => query);
  }
  // biome-ignore lint/suspicious/noThenProperty: Drizzle query builders are intentionally thenable.
  query.then = (resolve, reject) => Promise.resolve(result).then(resolve, reject);
  return query;
}

const now = new Date("2026-08-10T00:00:00.000Z");

function makeSite(overrides: Record<string, unknown> = {}) {
  return {
    id: 7,
    siteKey: "example.com",
    probeBaseUrl: "https://example.com/management",
    dashboardPat: "pat-must-not-leak",
    dashboardUserId: 42,
    allowInsecureHttp: false,
    proxyUrl: "http://user:pass@proxy.example.com:8080",
    proxyFallbackToDirect: true,
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
}

describe("upstream site repository", () => {
  beforeEach(() => {
    selectMock = vi.fn();
    insertMock = vi.fn();
    updateMock = vi.fn();
    deleteMock = vi.fn();
    const executor = {
      select: (...args: unknown[]) => selectMock(...args),
      insert: (...args: unknown[]) => insertMock(...args),
      update: (...args: unknown[]) => updateMock(...args),
      delete: (...args: unknown[]) => deleteMock(...args),
    };
    transactionMock = vi.fn(async (callback: (tx: typeof executor) => Promise<unknown>) =>
      callback(executor)
    );
  });

  it("normalizes the domain and reuses an existing site under a row lock", async () => {
    const insertQuery = fluent([]);
    const selectQuery = fluent([{ id: 7 }]);
    insertMock.mockReturnValue(insertQuery);
    selectMock.mockReturnValue(selectQuery);

    const id = await getOrCreateUpstreamSiteIdForUrl("https://WWW.Example.com/v1/messages");

    expect(id).toBe(7);
    expect(insertQuery.values).toHaveBeenCalledWith({ siteKey: "example.com" });
    expect(selectQuery.for).toHaveBeenCalledWith("update");
  });

  it("returns public site data without exposing the PAT", async () => {
    selectMock.mockReturnValueOnce(fluent([makeSite()])).mockReturnValueOnce(
      fluent([
        {
          upstreamSiteId: 7,
          url: "https://example.com/v1/messages",
          isEnabled: true,
          rateFollowUpstream: true,
          rateUpstreamType: "newapi",
        },
      ])
    );

    const sites = await findUpstreamSites();

    expect(sites).toHaveLength(1);
    expect(sites[0]).toMatchObject({
      id: 7,
      patConfigured: true,
      dashboardUserId: 42,
      providerCount: 1,
      newapiProviderCount: 1,
      probeTargetCandidates: ["https://example.com"],
    });
    expect(sites[0]).not.toHaveProperty("dashboardPat");
    expect(JSON.stringify(sites)).not.toContain("pat-must-not-leak");
  });

  it("does not delete a site that still has an active provider", async () => {
    const siteQuery = fluent([{ id: 7 }]);
    selectMock.mockReturnValueOnce(siteQuery).mockReturnValueOnce(fluent([{ id: 12 }]));

    await expect(deleteEmptyUpstreamSite(7)).resolves.toBe("in_use");
    expect(siteQuery.for).toHaveBeenCalledWith("update");
    expect(deleteMock).not.toHaveBeenCalled();
  });

  it("automatically deletes only an empty, unconfigured site", async () => {
    const siteQuery = fluent([
      makeSite({
        probeBaseUrl: null,
        dashboardPat: null,
        dashboardUserId: null,
        allowInsecureHttp: false,
        proxyUrl: null,
        proxyFallbackToDirect: false,
      }),
    ]);
    selectMock.mockReturnValueOnce(siteQuery).mockReturnValueOnce(fluent([]));
    deleteMock.mockReturnValue(fluent(undefined));

    await expect(tryDeleteUnconfiguredUpstreamSiteIfEmpty(7)).resolves.toBe(true);
    expect(siteQuery.for).toHaveBeenCalledWith("update");
    expect(deleteMock).toHaveBeenCalledOnce();
  });
});

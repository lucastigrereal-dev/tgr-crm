import { afterEach, describe, expect, it, vi } from "vitest";
import { fetchWithTimeout } from "./integrationReliability";

describe("integrationReliability", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("propaga a resposta quando o provider conclui antes do limite", async () => {
    const fetchMock = vi.fn(async () => new Response("ok", { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);

    const response = await fetchWithTimeout("https://provider.test/health", {}, 50);

    expect(response.status).toBe(200);
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it("aborta o request quando o provider excede o timeout", async () => {
    const fetchMock = vi.fn((_input: RequestInfo | URL, init?: RequestInit) => new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener("abort", () => reject(init.signal?.reason || new Error("aborted")), { once: true });
    }));
    vi.stubGlobal("fetch", fetchMock);

    await expect(fetchWithTimeout("https://provider.test/hang", {}, 5)).rejects.toThrow("Integração excedeu 5ms.");
    expect(fetchMock).toHaveBeenCalledOnce();
  });
});

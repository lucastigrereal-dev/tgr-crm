import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("./db", () => ({ getDb: vi.fn(), recordAudit: vi.fn(), recordDomainEvent: vi.fn() }));
vi.mock("./_core/llm", () => ({ listLLMModels: vi.fn(), invokeLLM: vi.fn() }));
import { getDb, recordAudit, recordDomainEvent } from "./db";
import { invokeLLM, listLLMModels } from "./_core/llm";
import { appRouter } from "./routers";

const mockedDb = vi.mocked(getDb); const mockedInvoke = vi.mocked(invokeLLM); const mockedModels = vi.mocked(listLLMModels);
function chain<T>(value: T) { const promise = Promise.resolve(value) as Promise<T> & Record<string, unknown>; for (const method of ["from", "where", "orderBy", "limit", "innerJoin"]) promise[method] = () => promise; return promise; }
function caller(role: string) { return appRouter.createCaller({ user: { id: 7, role } } as never); }

describe("ai.analyzeCustomer", () => {
  beforeEach(() => vi.resetAllMocks());
  it("barra perfil externo antes de consultar contexto ou modelo", async () => {
    await expect(caller("user").ai.analyzeCustomer({ customerId: 1, question: "Qual o próximo contato?" })).rejects.toMatchObject({ code: "FORBIDDEN" });
    expect(mockedDb).not.toHaveBeenCalled();
  });

  it("entrega resposta estruturada, com evidência permitida e trilha auditável", async () => {
    const select = vi.fn()
      .mockImplementationOnce(() => chain([{ id: 1, fullName: "Ana", status: "active" }]))
      .mockImplementationOnce(() => chain([{ id: 2, type: "note", subject: "Contato", content: "Preferência registrada", occurredAt: new Date("2026-08-01") }]))
      .mockImplementationOnce(() => chain([{ id: 3, number: "TS-1", status: "active" }]))
      .mockImplementationOnce(() => chain([])).mockImplementationOnce(() => chain([])).mockImplementationOnce(() => chain([])).mockImplementationOnce(() => chain([]));
    mockedDb.mockResolvedValue({ select } as never);
    mockedModels.mockResolvedValue({ object: "list", data: [{ id: "gpt-5-mini", object: "model", created: 0, owned_by: "openai" }] });
    mockedInvoke.mockResolvedValue({ id: "ai-1", created: 0, model: "gpt-5-mini", choices: [{ index: 0, finish_reason: "stop", message: { role: "assistant", content: JSON.stringify({ answer: "Registrar retorno.", confidence: "high", evidenceIds: ["E1", "E2"], recommendedActions: [{ title: "Ligar", rationale: "Há contato pendente.", requiresHumanApproval: true }], limitations: ["Sem nova interação posterior."] }) } }] });
    const result = await caller("admin").ai.analyzeCustomer({ customerId: 1, question: "Qual o próximo contato?" });
    expect(result.evidence.map(item => item.id)).toEqual(["E1", "E2"]);
    expect(result.recommendedActions[0]?.requiresHumanApproval).toBe(true);
    expect(recordAudit).toHaveBeenCalled();
    expect(recordDomainEvent).toHaveBeenCalledWith(expect.objectContaining({ eventName: "ai.assistance.requested", payload: expect.objectContaining({ evidenceCount: 3, model: "gpt-5-mini" }) }));
  });
});

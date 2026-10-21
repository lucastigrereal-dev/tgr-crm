import { describe, expect, it } from "vitest";
import { ageInYears, arrivalOrder, computeNq, isCoupleCode, relationshipDays } from "./captureSheetDomain";

describe("ficha impressa: regras puras", () => {
  it("aceita código do casal curto e seguro e recusa lixo, CPF e telefone", () => {
    expect(isCoupleCode("AB12-cd_34")).toBe(true);
    expect(isCoupleCode("abc")).toBe(false);
    expect(isCoupleCode("a b c d")).toBe(false);
    expect(isCoupleCode("12345678901")).toBe(false);
    expect(isCoupleCode("81-99999-9999")).toBe(false);
    expect(isCoupleCode("999998888")).toBe(false);
    expect(isCoupleCode("CP-0001")).toBe(true);
    expect(isCoupleCode("x".repeat(65))).toBe(false);
    expect(isCoupleCode("../etc/passwd")).toBe(false);
  });

  it("tempo de relacionamento em dias sai de anos e meses, vazio quando não informado", () => {
    expect(relationshipDays(null, null)).toBeNull();
    expect(relationshipDays(2, 3)).toBe(2 * 365 + 90);
    expect(relationshipDays(null, 6)).toBe(180);
  });

  it("ordem de chegada conta os check-ins anteriores do dia e desempata pelo id", () => {
    const at = (h: number) => new Date(Date.UTC(2026, 9, 17, h));
    const rows = [{ id: 3, checkedInAt: at(10) }, { id: 1, checkedInAt: at(9) }, { id: 2, checkedInAt: at(9) }, { id: 4, checkedInAt: null }];
    expect(arrivalOrder(rows[1], rows)).toBe(1);
    expect(arrivalOrder(rows[2], rows)).toBe(2);
    expect(arrivalOrder(rows[0], rows)).toBe(3);
    expect(arrivalOrder(rows[3], rows)).toBeNull();
  });
});

describe("casal qualificado: itens de NQ (regra provisória)", () => {
  const good = { maleSpouse: "titular" as const, primaryAge: 41, partnerAge: 28, relationshipStatus: "Casados", relationshipYears: 5, relationshipMonths: 0, vehicleKind: "carro" as const, vehicleYear: 2020, averageIncome: "9500.00", hasCreditCard: true, ownsHome: true };

  it("casal que atende tudo tem 0 itens e fica qualificado", () => {
    const result = computeNq(good);
    expect(result).toMatchObject({ nqItems: 0, missing: 0, outcome: "qualificado", label: "NQ: 0 itens" });
  });

  it("só a idade do homem conta: mulher mais nova não gera NQ, homem de 30 anos gera", () => {
    expect(computeNq({ ...good, partnerAge: 22 }).nqItems).toBe(0);
    expect(computeNq({ ...good, maleSpouse: "conjuge", partnerAge: 30 }).criteria.find(c => c.key === "idade_homem")?.status).toBe("nq");
    expect(computeNq({ ...good, maleSpouse: "conjuge", partnerAge: 31 }).criteria.find(c => c.key === "idade_homem")?.status).toBe("ok");
    expect(computeNq({ ...good, maleSpouse: null }).criteria.find(c => c.key === "idade_homem")?.status).toBe("missing");
  });

  it("namorada é NQ, casado e união estável passam, texto estranho pede confirmação", () => {
    const status = (value: string) => computeNq({ ...good, relationshipStatus: value }).criteria.find(c => c.key === "relacionamento")?.status;
    expect(status("Namorados")).toBe("nq");
    expect(status("União estável")).toBe("ok");
    expect(status("Uniao Estavel")).toBe("ok");
    expect(status("Casal")).toBe("missing");
    expect(status("Não casados")).toBe("nq");
    expect(status("não tem união estável")).toBe("nq");
    expect(status("Separados")).toBe("missing");
    expect(status("Casados")).toBe("ok");
  });

  it("tempo de relacionamento precisa passar de 12 meses (12 exatos é NQ)", () => {
    const status = (years: number | null, months: number | null) => computeNq({ ...good, relationshipYears: years, relationshipMonths: months }).criteria.find(c => c.key === "tempo_relacionamento")?.status;
    expect(status(1, 0)).toBe("nq");
    expect(status(1, 1)).toBe("ok");
    expect(status(0, 11)).toBe("nq");
    expect(status(2, null)).toBe("ok");
    expect(status(0, null)).toBe("nq");
    // só anos: "1" pode ser 1 ano e 8 meses, então não decide sozinho
    expect(status(1, null)).toBe("missing");
    expect(status(null, null)).toBe("missing");
  });

  it("só carro vale: moto 2027 é NQ, carro 2017 é NQ, carro 2018 passa, e o melhor dos dois veículos vale", () => {
    const status = (extra: object) => computeNq({ ...good, vehicleKind: null, vehicleYear: null, ...extra }).criteria.find(c => c.key === "veiculo")?.status;
    expect(status({ vehicleKind: "moto", vehicleYear: 2027 })).toBe("nq");
    expect(status({ vehicleKind: "carro", vehicleYear: 2017 })).toBe("nq");
    expect(status({ vehicleKind: "carro", vehicleYear: 2018 })).toBe("ok");
    expect(status({ vehicleKind: "carro", vehicleYear: null })).toBe("missing");
    expect(status({})).toBe("missing");
    expect(status({ vehicleKind: "nenhum" })).toBe("nq");
    expect(computeNq({ ...good, vehicleKind: "nenhum", vehicleYear: null, averageIncome: "5000" })).toMatchObject({ nqItems: 2, outcome: "nt_perfil" });
    expect(status({ vehicleKind: "moto", vehicleYear: 2027, secondVehicleKind: "carro", secondVehicleYear: 2019 })).toBe("ok");
    // ano gravado sem o tipo (ficha antiga) pode ser um carro bom: fica faltando, mesmo com o outro veículo sendo moto
    expect(status({ vehicleKind: "moto", vehicleYear: 2010, secondVehicleKind: null, secondVehicleYear: 2021 })).toBe("missing");
    expect(status({ vehicleKind: null, vehicleYear: 2021 })).toBe("missing");
  });

  it("renda de 8 mil conta; cartão e casa própria são obrigatórios; 'da cidade' não é critério", () => {
    expect(computeNq({ ...good, averageIncome: "8000" }).nqItems).toBe(0);
    expect(computeNq({ ...good, averageIncome: "7999.99" }).nqItems).toBe(1);
    expect(computeNq({ ...good, hasCreditCard: false }).nqItems).toBe(1);
    expect(computeNq({ ...good, ownsHome: false }).nqItems).toBe(1);
    expect(computeNq(good).criteria.map(c => c.key)).not.toContain("cidade");
  });

  it("1 item ainda entra, 2 itens caem como NT por perfil; dado faltando não vira NQ", () => {
    expect(computeNq({ ...good, hasCreditCard: false })).toMatchObject({ nqItems: 1, outcome: "nq_aceito", label: "NQ: 1 item" });
    expect(computeNq({ ...good, hasCreditCard: false, ownsHome: false })).toMatchObject({ nqItems: 2, outcome: "nt_perfil" });
    const partial = computeNq({ ...good, hasCreditCard: null, ownsHome: null });
    expect(partial).toMatchObject({ nqItems: 0, missing: 2, outcome: "qualificado", label: "NQ: 0 itens (faltam 2 dados)" });
  });

  it("limites vêm da configuração", () => {
    const result = computeNq({ ...good, averageIncome: "9500" }, { minManAge: 45, minRelationshipMonths: 12, minVehicleYear: 2018, minIncome: 10000, maxItemsAccepted: 2 });
    expect(result).toMatchObject({ nqItems: 2, outcome: "nq_aceito" });
  });

  it("idade em anos completos", () => {
    const today = new Date("2026-10-17T12:00:00Z");
    expect(ageInYears("1985-10-17", today)).toBe(41);
    expect(ageInYears("1985-10-18", today)).toBe(40);
    expect(ageInYears(null, today)).toBeNull();
    expect(ageInYears("lixo", today)).toBeNull();
    expect(ageInYears("2030-01-01", today)).toBeNull();
  });
});

describe("CRM-G1: casal qualificado por versão da política", () => {
  const base = { maleSpouse: "titular" as const, primaryAge: 41, partnerAge: 28, relationshipStatus: "Casados", relationshipYears: 5, relationshipMonths: 0, vehicleKind: "moto" as const, vehicleYear: 2022, averageIncome: "20000", hasCreditCard: true, ownsHome: false };
  const legacy = { minManAge: 30, minRelationshipMonths: 24, minVehicleYear: 2015, minIncome: 8000, maxItemsAccepted: 1 };

  it("sem versão informada nada muda: moto não vale, cartão e casa própria entram, resultado sem policyVersion", () => {
    const result = computeNq(base, legacy);
    expect(result.criteria.find(c => c.key === "veiculo")?.status).toBe("nq");
    expect(result.criteria.map(c => c.key)).toContain("casa_propria");
    expect(result).not.toHaveProperty("policyVersion");
  });

  it("versão que aceita moto e dispensa casa própria muda o resultado e carrega a versão", () => {
    const result = computeNq(base, { ...legacy, vehicleKinds: ["carro", "moto"], requireOwnsHome: false, version: "2026-11" });
    expect(result.criteria.find(c => c.key === "veiculo")?.status).toBe("ok");
    expect(result.criteria.map(c => c.key)).not.toContain("casa_propria");
    expect(result).toMatchObject({ nqItems: 0, outcome: "qualificado", policyVersion: "2026-11" });
  });

  it("versão só com moto recusa carro; limites da versão valem (renda mínima maior)", () => {
    expect(computeNq({ ...base, vehicleKind: "carro" }, { ...legacy, vehicleKinds: ["moto"], version: "v" }).criteria.find(c => c.key === "veiculo")?.status).toBe("nq");
    expect(computeNq(base, { ...legacy, minIncome: 30000, version: "v" }).criteria.find(c => c.key === "renda")?.status).toBe("nq");
  });
});

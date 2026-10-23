import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

// Contrato de código da UI (sem infraestrutura de componente): o comportamento real está em unlinkedCouples.mysql.test.ts.
const panel = readFileSync(join(__dirname, "..", "client/src/components/crm/UnlinkedCouplesPanel.tsx"), "utf8");
const room = readFileSync(join(__dirname, "..", "client/src/pages/SalesRoom.tsx"), "utf8");
const ficha = readFileSync(join(__dirname, "..", "client/src/pages/FichaSala.tsx"), "utf8");

describe("F1.4: alerta de casal sem vínculo no painel da sala", () => {
  it("o painel está montado na sala de vendas e some quando não há nada para ligar", () => {
    expect(room).toMatch(/<UnlinkedCouplesPanel \/>/);
    expect(panel).toMatch(/captureSheet\.unlinked\.useQuery/);
    expect(panel).toMatch(/data\.total === 0\) return null/);
  });
  it("só administração e vendedor ligam; a ligação pede confirmação do casal", () => {
    expect(panel).toMatch(/user\?\.role === "admin" \|\| user\?\.role === "seller"/);
    expect(panel).toMatch(/window\.confirm\("Ligar este código a esta ficha\?/);
    expect(panel).toMatch(/captureSheet\.setCoupleCode\.useMutation/);
  });
  it("/ficha?captura=ID&codigo=CP-… abre a ligação com o código sugerido (sem ligar sozinho)", () => {
    expect(ficha).toMatch(/<LigarCodigo captureId=\{captureId\} suggestedCode=\{code \?\? undefined\} \/>/);
    expect(ficha).toMatch(/useState\(suggestedCode \?\? ""\)/);
  });
});

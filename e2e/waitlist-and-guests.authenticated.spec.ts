import { expect, test } from "@playwright/test";

const admin = { id: 1, openId: "test", name: "Lucas", email: "lucas@example.com", loginMethod: "test", role: "admin", createdAt: "2026-08-01T00:00:00.000Z", updatedAt: "2026-08-01T00:00:00.000Z", lastSignedIn: "2026-08-01T00:00:00.000Z" };
const query = (json: unknown) => ({ result: { data: { json } } });
const unit = { id: 10, resortId: 1, code: "102", category: "Superior", capacity: 4, beds: 2, status: "active" };

test.describe("fila e acompanhantes autenticados", () => {
  test("converte oferta em reserva e registra presença individual", async ({ page }) => {
    let guestPresent = false;
    await page.route("**/api/trpc/operations.resorts,operations.units,contracts.list,ownership.listEntitlements,ownership.listMaintenanceBlocks,customers.list,operations.reservations,operations.waitlist,auth.me**", route => route.fulfill({ contentType: "application/json", body: JSON.stringify([
      query([{ id: 1, name: "Rota Dourada", city: "Olímpia", state: "SP" }]), query([{ unit, resortName: "Rota Dourada" }]), query([]), query([]), query([]), query([]),
      query([{ reservation: { id: 90, customerId: 1, unitId: 10, status: "checked_in", checkIn: "2026-08-20T12:00:00.000Z", checkOut: "2026-08-23T12:00:00.000Z" }, customerName: "Ana da Silva", unitCode: "102", resortName: "Rota Dourada", contractNumber: "TS-90" }]),
      query([{ item: { id: 44, resortId: 1, desiredCheckIn: "2026-08-25T12:00:00.000Z", desiredCheckOut: "2026-08-28T12:00:00.000Z", partySize: 3, priorityScore: 1, status: "offered" }, customerName: "Bruno Costa", resortName: "Rota Dourada" }]), query(admin),
    ]) }));
    await page.route("**/api/trpc/operations.availableUnits?**", route => route.fulfill({ contentType: "application/json", body: JSON.stringify([query([{ unit, resortName: "Rota Dourada" }])]) }));
    await page.route("**/api/trpc/operations.convertWaitlistToReservation?**", route => route.fulfill({ contentType: "application/json", body: JSON.stringify([query({ reservationId: 91, waitlistId: 44 })]) }));
    await page.route("**/api/trpc/operations.reservationGuests?**", route => route.fulfill({ contentType: "application/json", body: JSON.stringify([query([{ id: 7, reservationId: 90, fullName: "Carla da Silva", relationship: "Cônjuge", checkedInAt: guestPresent ? "2026-08-20T13:00:00.000Z" : null, checkedOutAt: null }])]) }));
    await page.route("**/api/trpc/operations.updateGuestPresence?**", route => { guestPresent = true; return route.fulfill({ contentType: "application/json", body: JSON.stringify([query({ id: 7, action: "check_in" })]) }); });

    await page.goto("/reservas");
    await page.getByRole("button", { name: "Acompanhantes" }).click();
    await expect(page.getByText("Carla da Silva")).toBeVisible();
    await page.getByRole("button", { name: "Chegou" }).click();
    await expect(page.getByText("Presença do acompanhante atualizada.")).toBeVisible();
    await expect(page.getByText("Presente")).toBeVisible();
    await page.keyboard.press("Escape");
    await page.getByRole("button", { name: "Confirmar reserva" }).click();
    await page.getByRole("combobox").last().click();
    await page.getByText("Rota Dourada · 102 · até 4 hóspedes").click();
    await page.getByRole("button", { name: "Criar reserva confirmada" }).click();
    await expect(page.getByText("Oferta convertida em reserva confirmada.")).toBeVisible();
  });
});

import assert from "node:assert/strict";
import test from "node:test";
import { addDeposit, advanceChargeDate, buildNextChargeDate, cancelDeposit, MAX_NOTIFICATIONS, addNotification, runDebitForService, seedData } from "./domain";

test("monthly billing advances by exactly one configured interval", () => {
  const service = seedData().services[0];
  Object.assign(service.billing, { period: "month", interval: 1, anchorDay: 31, anchorHour: 12, shiftDays: 0 });
  assert.equal(advanceChargeDate(service, new Date(2026, 0, 31, 12)).toISOString(), new Date(2026, 1, 28, 12).toISOString());
});

test("next monthly charge clamps the anchor day to the destination month", () => {
  const next = buildNextChargeDate(new Date(2026, 0, 31, 13), "month", 1, 31, 12, 0);
  assert.equal(next.toISOString(), new Date(2026, 1, 28, 12).toISOString());
});

test("hourly schedules never return a moment in the past", () => {
  const from = new Date(2026, 4, 10, 15, 30);
  const next = buildNextChargeDate(from, "hour", 1, 1, 12, 0);
  assert.ok(next > from);
  assert.equal(next.toISOString(), new Date(2026, 4, 10, 16, 0).toISOString());
});

test("a day shift that crosses into the next month does not skip a month", () => {
  const service = seedData().services[0];
  // Anchor on the 28th, shifted 5 days: charges land on the 2nd/3rd of the following month.
  Object.assign(service.billing, { period: "month", interval: 1, anchorDay: 28, anchorHour: 12, shiftDays: 5 });
  const january = new Date(2026, 1, 2, 12); // 28 Jan + 5 days
  assert.equal(advanceChargeDate(service, january).toISOString(), new Date(2026, 2, 5, 12).toISOString()); // 28 Feb + 5
  const first = buildNextChargeDate(new Date(2026, 1, 1, 0), "month", 1, 28, 12, 5);
  assert.equal(first.toISOString(), january.toISOString());
});

test("a free service advances its schedule instead of failing every minute", () => {
  const data = seedData();
  const service = data.services[0];
  service.monthlyCost = 0;
  const before = service.billing.nextChargeAt;
  assert.deepEqual(runDebitForService(data, service.id, "auto"), []);
  assert.notEqual(service.billing.nextChargeAt, before);
});

test("cancelling a deposit also cancels the payment that produced it", () => {
  const data = seedData();
  const [user] = data.users;
  const deposit = addDeposit(data, { serviceId: data.services[0].id, userId: user.id, amount: 100, currency: "RUB", source: "manual" });
  data.payments.push({
    id: "pay_1", userId: user.id, serviceId: data.services[0].id, amount: 100, currency: "RUB", method: "manual", provider: "manual",
    status: "succeeded", externalId: "", confirmationUrl: "", description: "", comment: "", depositId: deposit.id, failureReason: "",
    createdAt: deposit.createdAt, updatedAt: deposit.createdAt, paidAt: deposit.createdAt
  });
  cancelDeposit(data, deposit.id, "ошибка ввода");
  assert.equal(user.balance, 0);
  assert.equal(data.payments[0].status, "canceled");
  assert.equal(data.payments[0].failureReason, "ошибка ввода");
});

test("the notification log is capped", () => {
  const data = seedData();
  for (let index = 0; index < MAX_NOTIFICATIONS + 25; index += 1) {
    addNotification(data, { serviceId: "", userId: null, kind: "system", message: String(index), status: "sent" });
  }
  assert.equal(data.notifications.length, MAX_NOTIFICATIONS);
  assert.equal(data.notifications[0].message, String(MAX_NOTIFICATIONS + 24));
});

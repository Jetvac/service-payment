import assert from "node:assert/strict";
import test from "node:test";
import { advanceChargeDate, buildNextChargeDate, seedData } from "./domain";

test("monthly billing advances by exactly one configured interval", () => {
  const service = seedData().services[0];
  service.billing.period = "month";
  service.billing.interval = 1;
  service.billing.anchorDay = 31;
  service.billing.anchorHour = 12;
  service.billing.shiftDays = 0;

  assert.equal(advanceChargeDate(service, new Date(2026, 0, 31, 12)).toISOString(), new Date(2026, 1, 28, 12).toISOString());
});

test("next monthly charge clamps the anchor day to the destination month", () => {
  const next = buildNextChargeDate(new Date(2026, 0, 31, 13), "month", 1, 31, 12, 0);
  assert.equal(next.toISOString(), new Date(2026, 1, 28, 12).toISOString());
});

import assert from "node:assert/strict";
import test from "node:test";
import { mapYooKassaStatus, type YooKassaPayment } from "./payments";

function payment(status: YooKassaPayment["status"], paid = false): YooKassaPayment {
  return { id: "provider-1", status, paid, amount: { value: "600.00", currency: "RUB" } };
}

test("provider status only succeeds when YooKassa marks the payment paid", () => {
  assert.equal(mapYooKassaStatus(payment("succeeded", true)), "succeeded");
  assert.equal(mapYooKassaStatus(payment("succeeded", false)), "pending");
  assert.equal(mapYooKassaStatus(payment("canceled")), "canceled");
  assert.equal(mapYooKassaStatus(payment("pending")), "pending");
});

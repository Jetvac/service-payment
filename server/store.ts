import fs from "node:fs";
import path from "node:path";
import type { AppData } from "./types";
import { BALANCE_CURRENCY, roundMoney, seedData } from "./domain";

const dataDir = path.resolve(process.cwd(), "data");
const dataFile = path.join(dataDir, "db.json");

export class Store {
  private data: AppData;

  constructor() {
    this.data = this.load();
  }

  read() {
    return this.data;
  }

  write(mutator: (data: AppData) => void) {
    mutator(this.data);
    this.persist();
    return this.data;
  }

  persist() {
    fs.mkdirSync(dataDir, { recursive: true });
    fs.writeFileSync(dataFile, JSON.stringify(this.data, null, 2), "utf-8");
  }

  private load(): AppData {
    fs.mkdirSync(dataDir, { recursive: true });

    if (!fs.existsSync(dataFile)) {
      const initial = seedData();
      fs.writeFileSync(dataFile, JSON.stringify(initial, null, 2), "utf-8");
      return initial;
    }

    const parsed = JSON.parse(fs.readFileSync(dataFile, "utf-8")) as AppData;
    return this.migrate(parsed);
  }

  private migrate(data: AppData): AppData {
    const toBalanceCurrency = (amount: number, fromCode: string) => {
      const from = data.currencies.find((currency) => currency.code === fromCode);
      const to = data.currencies.find((currency) => currency.code === BALANCE_CURRENCY);
      if (!from || !to) return roundMoney(amount);
      return roundMoney((amount * from.rateToRub) / to.rateToRub);
    };

    for (const service of data.services) {
      service.notes ??= "";
      service.active ??= true;
      service.monthlyCost = roundMoney(service.monthlyCost);
    }

    for (const user of data.users) {
      user.notes ??= "";
      user.commandDepositsBlocked ??= false;
      user.botAdmin ??= false;
      user.telegramId ??= "";
      user.telegramUsername ??= "";
      const legacyBalances = (data.memberships ?? []).filter(
        (membership) => membership.userId === user.id && typeof membership.balance === "number"
      );
      const legacyBalance = roundMoney(
        legacyBalances.reduce((sum, membership) => {
          const service = data.services.find((item) => item.id === membership.serviceId);
          return sum + toBalanceCurrency(Number(membership.balance ?? 0), service?.currency ?? BALANCE_CURRENCY);
        }, 0)
      );

      if (typeof user.balance !== "number" || (user.balance === 0 && legacyBalances.length > 0)) {
        user.balance = legacyBalance;
      } else {
        user.balance = roundMoney(user.balance);
      }
    }

    data.notifications ??= [];
    data.deposits ??= [];
    data.debits ??= [];
    data.memberships ??= [];
    data.settings.telegram.pollingEnabled ??= false;
    data.settings.telegram.notificationTopicId ??= "";
    data.settings.telegram.updateOffset ??= 0;
    data.settings.telegram.lastUpdateAt ??= null;
    data.settings.telegram.lastError ??= "";

    for (const membership of data.memberships) {
      delete membership.balance;
    }

    for (const deposit of data.deposits) {
      deposit.cancelledAt ??= null;
      deposit.reversalId ??= null;
      deposit.reversesId ??= null;
      deposit.amountOriginal = roundMoney(deposit.amountOriginal);
      deposit.amountServiceCurrency = roundMoney(deposit.amountServiceCurrency);
      deposit.serviceCurrency ??= data.services.find((service) => service.id === deposit.serviceId)?.currency ?? BALANCE_CURRENCY;
      deposit.amountBalanceCurrency ??= toBalanceCurrency(deposit.amountServiceCurrency, deposit.serviceCurrency);
      deposit.amountBalanceCurrency = roundMoney(deposit.amountBalanceCurrency);
      deposit.balanceCurrency ??= BALANCE_CURRENCY;
      if (deposit.balanceCurrency !== BALANCE_CURRENCY) {
        deposit.balanceAfter = toBalanceCurrency(deposit.balanceAfter, deposit.balanceCurrency);
        deposit.balanceCurrency = BALANCE_CURRENCY;
      } else {
        deposit.balanceAfter = roundMoney(deposit.balanceAfter);
      }
    }

    for (const debit of data.debits) {
      debit.cancelledAt ??= null;
      debit.reversalId ??= null;
      debit.reversesId ??= null;
      debit.amount = roundMoney(debit.amount);
      debit.currency ??= data.services.find((service) => service.id === debit.serviceId)?.currency ?? BALANCE_CURRENCY;
      debit.amountBalanceCurrency ??= toBalanceCurrency(debit.amount, debit.currency);
      debit.amountBalanceCurrency = roundMoney(debit.amountBalanceCurrency);
      debit.balanceCurrency ??= BALANCE_CURRENCY;
      debit.rateSnapshot ??= Object.fromEntries(data.currencies.map((currency) => [currency.code, currency.rateToRub]));
      if (debit.balanceCurrency !== BALANCE_CURRENCY) {
        debit.balanceAfter = toBalanceCurrency(debit.balanceAfter, debit.balanceCurrency);
        debit.balanceCurrency = BALANCE_CURRENCY;
      } else {
        debit.balanceAfter = roundMoney(debit.balanceAfter);
      }
    }

    return data;
  }
}

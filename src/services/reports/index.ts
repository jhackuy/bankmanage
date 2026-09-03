/**
 * M2C reports application-service barrel.
 *
 * Re-exports the public surface of the reports slice. The Worker / Hono
 * layer (and any future Mini App API or report consumer) must import
 * from this barrel rather than reaching into internal files.
 */

export { type ReportsRepository } from "./repository.js";

export { D1ReportsRepository } from "./d1-repository.js";

export { ReportsApplicationService, type ReportsServiceDeps } from "./service.js";

export {
  type AccountTotal,
  type BankCurrencyTotal,
  type BankCurrencyTotals,
  type CurrencyAmount,
  type CurrencyAmountList,
  type ExpenseCategoryBreakdown,
  type ExpenseCategoryBreakdownRow,
  type MaturityAllWindowsStats,
  type MaturityWindowStats,
  type MonthlyIncomeExpenseNet,
  type RecentTransaction,
  type ServiceError,
  type ServiceErrorCode,
  type ServiceResult,
  fail,
  ok,
  serviceError,
} from "./types.js";

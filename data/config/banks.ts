/**
 * Bank configuration data.
 *
 * Banks are data, NOT enums — new banks can be added without a code deployment.
 * The slug is the stable machine identifier referenced in queries and adapters.
 *
 * This file is the authoritative source for system-seeded banks; the migration
 * SQL must stay in sync with this list.
 */

export interface BankConfig {
  readonly slug: string;
  readonly name: string;
  readonly shortName: string;
  readonly isSystem: true;
}

export const SYSTEM_BANKS: readonly BankConfig[] = [
  {
    slug: "bdo",
    name: "Banco de Oro Unibank",
    shortName: "BDO",
    isSystem: true,
  },
  {
    slug: "bpi",
    name: "Bank of the Philippine Islands",
    shortName: "BPI",
    isSystem: true,
  },
  {
    slug: "metrobank",
    name: "Metropolitan Bank and Trust Co.",
    shortName: "Metrobank",
    isSystem: true,
  },
  {
    slug: "pnb",
    name: "Philippine National Bank",
    shortName: "PNB",
    isSystem: true,
  },
  {
    slug: "hsbc",
    name: "HSBC Philippines",
    shortName: "HSBC",
    isSystem: true,
  },
  {
    slug: "other",
    name: "Other / Custom Bank",
    shortName: "Other",
    isSystem: true,
  },
] as const;

/** Look up a system bank by slug. Returns undefined for user-created custom banks. */
export function findSystemBank(slug: string): BankConfig | undefined {
  return SYSTEM_BANKS.find((b) => b.slug === slug);
}

/** All slugs that are guaranteed to exist after a fresh migration. */
export const SYSTEM_BANK_SLUGS = SYSTEM_BANKS.map((b) => b.slug);

/**
 * The default chart of accounts, owned by CODE rather than by a table.
 *
 * The design is explicit about the mechanism: *"Loxep seeds a default chart at
 * book creation from a code-owned template, not from a database table of
 * templates. After creation the rows belong to the operator. A template table
 * would invite the question 'what happens when the template changes', and the
 * honest answer — nothing, because the book already has its own rows — is
 * better expressed by not having the table."*
 *
 * So this is a constant, `createBook` copies it once, and nothing ever reads it
 * again for a book that exists.
 *
 * ## What makes an account a SYSTEM account
 *
 * `system_key` is the stable handle Loxep's own posting rules resolve through,
 * and it is what lets a shipped rule work inside a chart the operator has
 * renumbered to taste:
 *
 * ```text
 * may change freely   code, name, description, parent, status(archived)
 * may NEVER change    system_key, account_type
 * may NEVER happen    deletion
 * ```
 *
 * A rule that resolves `marketplace_clearing` finds whichever account carries
 * that key in whichever book the fact routed to. Deleting it would break every
 * rule that resolves through it; changing its type would silently move an
 * account between statements.
 *
 * **Every member of `LEDGER_SYSTEM_KEYS` appears exactly once below, and a test
 * asserts it.** The design's own pre-implementation checklist asks for that by
 * name: *"a rule referencing a `system_key` no seeded account carries is a
 * silent suspense posting, and that failure should be caught by a test rather
 * than by a balance nobody looks at."*
 *
 * ## The fee accounts, and why there are three of them
 *
 * Phase 3 shipped `order_fees.fee_direction`, a distinction its own design
 * draft did not have and the WooCommerce reality finding forced:
 *
 * ```text
 * seller_charge     the platform charges the SELLER; a deduction from proceeds
 *                   -> marketplace_fees / payment_processing_fees (EXPENSE)
 * buyer_surcharge   the seller charges the BUYER (handling, small-order, COD,
 *                   gift wrap); already inside orders.total, and NOT a
 *                   deduction from proceeds
 *                   -> buyer_fee_income (REVENUE)
 * ```
 *
 * `buyer_fee_income` is not in the design's system-key sketch and is required
 * by that shipped reality. Posting a buyer surcharge as a fee expense would
 * understate income by exactly the amount the buyer covered — the same error
 * the Phase 4 contribution read model avoids by filtering on
 * `fee_direction = 'seller_charge'`. Every profitability figure in the product
 * already respects the distinction; the chart has to as well, or the P&L and
 * the item-level contribution number will disagree by a real amount.
 *
 * ## What is deliberately NOT here
 *
 * No per-entity account duplication. ADR-0017 lists chart-of-accounts structure
 * first among separation mechanisms, and this design chooses the entity
 * DIMENSION instead: duplicating a fifty-account chart across three operating
 * identities produces a hundred and fifty accounts and turns consolidated
 * reporting into a string-parsing exercise. One chart per book; the entity
 * lives on the line.
 *
 * No accounts-receivable or accounts-payable detail beyond the single AR
 * subtype placeholder's absence — AR has no source fact until invoices exist
 * (Phase 6), and an AR aging report against an empty concept is worse than no
 * report.
 */
import type {
  LedgerAccountSubtype,
  LedgerAccountType,
  LedgerSystemKey,
} from "@loxep/db/schema";

export interface ChartTemplateAccount {
  code: string;
  name: string;
  accountType: LedgerAccountType;
  accountSubtype?: LedgerAccountSubtype;
  /** Present only on the accounts Loxep's own rules resolve through. */
  systemKey?: LedgerSystemKey;
  /** `code` of the roll-up header this sits under. */
  parentCode?: string;
  /** `false` marks a roll-up header; journal lines may not reference it. */
  isPostable?: boolean;
  isContra?: boolean;
  description?: string;
}

/**
 * A small, opinionated starter chart for a resale/e-commerce book: five
 * headers, every system account, and one ordinary bank account.
 *
 * It is deliberately short. An operator who wants forty expense accounts adds
 * them in a minute; an operator handed forty they did not ask for deletes them
 * for an hour, and the ones they miss become a menu nobody understands.
 */
export const DEFAULT_CHART_TEMPLATE: readonly ChartTemplateAccount[] = [
  /* ------------------------------------------------------------- assets */
  {
    code: "1000",
    name: "Assets",
    accountType: "asset",
    isPostable: false,
    description: "Roll-up header.",
  },
  {
    code: "1100",
    name: "Marketplace Clearing",
    accountType: "asset",
    accountSubtype: "clearing",
    systemKey: "marketplace_clearing",
    parentCode: "1000",
    description:
      "Money the marketplace owes us. A sale debits it, fees and refunds " +
      "credit it, and the payout clears it. A non-zero residual after a " +
      "settlement window is THE finding: an uningested fee, a missing order, " +
      "a refund commerce never saw, or a rule that fired twice.",
  },
  {
    code: "1200",
    name: "Undeposited Funds",
    accountType: "asset",
    accountSubtype: "undeposited_funds",
    systemKey: "undeposited_funds",
    parentCode: "1000",
    description: "Settled by the processor, not yet in the bank.",
  },
  {
    code: "1300",
    name: "Business Checking",
    accountType: "asset",
    accountSubtype: "bank",
    parentCode: "1000",
    description:
      "An ordinary operator-owned account, not a system account: the banking " +
      "milestone maps real financial_accounts onto chart accounts, and which " +
      "one is a bank is the operator's statement, not Loxep's.",
  },
  {
    code: "1400",
    name: "Inventory",
    accountType: "asset",
    accountSubtype: "inventory",
    systemKey: "inventory",
    parentCode: "1000",
    description:
      "Stock at landed cost, as frozen on the item by Phase 4. Depletion " +
      "credits it and debits COGS at that same frozen basis; valuation " +
      "judgements are a later, separate posting.",
  },
  {
    code: "1900",
    name: "Suspense",
    accountType: "asset",
    accountSubtype: "suspense",
    systemKey: "suspense",
    parentCode: "1000",
    description:
      "The plug of last resort, used when a rule matched but an account could " +
      "not be resolved. It earns its place by being permanently visible in a " +
      "named report: a suspense balance nobody looks at is worse than a " +
      "failed posting, and one on the front page is a work queue.",
  },

  /* -------------------------------------------------------- liabilities */
  {
    code: "2000",
    name: "Liabilities",
    accountType: "liability",
    isPostable: false,
    description: "Roll-up header.",
  },
  {
    code: "2100",
    name: "Sales Tax Payable",
    accountType: "liability",
    accountSubtype: "sales_tax_payable",
    systemKey: "sales_tax_payable",
    parentCode: "2000",
    description: "Tax WE collected and must remit. Seller liability only.",
  },
  {
    code: "2200",
    name: "Facilitator Tax Clearing",
    accountType: "liability",
    accountSubtype: "clearing",
    systemKey: "facilitator_tax_clearing",
    parentCode: "2000",
    description:
      "Tax a marketplace collects from the buyer and remits itself. It passes " +
      "through gross sales and is never our liability, so it clears to zero " +
      "once the payout settles and never touches sales tax payable or P&L. " +
      "Crediting it to Sales Tax Payable instead would create a liability " +
      "that will never be paid and grows forever.",
  },

  /* -------------------------------------------------------------- equity */
  {
    code: "3000",
    name: "Equity",
    accountType: "equity",
    isPostable: false,
    description: "Roll-up header.",
  },
  {
    code: "3100",
    name: "Opening Balance Equity",
    accountType: "equity",
    accountSubtype: "opening_balance_equity",
    systemKey: "opening_balance_equity",
    parentCode: "3000",
    description:
      "The other side of an opening-balance entry. Retained earnings is NOT " +
      "an account here: it is computed in the balance-sheet read model from " +
      "prior fiscal years' net income, because stored closing entries double " +
      "a small book's entry count and make the trial balance depend on " +
      "whether a job ran.",
  },

  /* ------------------------------------------------------------- revenue */
  {
    code: "4000",
    name: "Revenue",
    accountType: "revenue",
    isPostable: false,
    description: "Roll-up header.",
  },
  {
    code: "4100",
    name: "Sales Revenue",
    accountType: "revenue",
    systemKey: "sales_revenue",
    parentCode: "4000",
  },
  {
    code: "4200",
    name: "Shipping Income",
    accountType: "revenue",
    systemKey: "shipping_income",
    parentCode: "4000",
    description: "Customer-paid shipping, which is income and not a fee.",
  },
  {
    code: "4300",
    name: "Buyer Fee Income",
    accountType: "revenue",
    systemKey: "buyer_fee_income",
    parentCode: "4000",
    description:
      "Surcharges the SELLER charges the BUYER — handling, small-order, COD, " +
      "gift wrap — which arrive as order_fees with " +
      "fee_direction = 'buyer_surcharge' and are already inside the order " +
      "total. Income, never a fee expense.",
  },
  {
    code: "4900",
    name: "Sales Returns",
    accountType: "revenue",
    isContra: true,
    systemKey: "sales_returns",
    parentCode: "4000",
    description:
      "Contra revenue: a flag on the ordinary type rather than a sixth " +
      "account type, which keeps statement grouping trivial.",
  },

  /* --------------------------------------------------- cost of goods sold */
  {
    code: "5000",
    name: "Cost of Goods Sold",
    accountType: "expense",
    isPostable: false,
    description: "Roll-up header.",
  },
  {
    code: "5100",
    name: "Cost of Goods Sold",
    accountType: "expense",
    accountSubtype: "cogs",
    systemKey: "cogs",
    parentCode: "5000",
    description:
      "Posted from depletion movements at the item's frozen landed cost. This " +
      "is the only way per-item realized contribution and the P&L can agree.",
  },

  /* ------------------------------------------------------------ expenses */
  {
    code: "6000",
    name: "Operating Expenses",
    accountType: "expense",
    isPostable: false,
    description: "Roll-up header.",
  },
  {
    code: "6100",
    name: "Marketplace Fees",
    accountType: "expense",
    accountSubtype: "marketplace_fees",
    systemKey: "marketplace_fees",
    parentCode: "6000",
    description:
      "Seller-charged platform fees only (fee_direction = 'seller_charge'): " +
      "final value, insertion, regulatory operating, promoted listing.",
  },
  {
    code: "6200",
    name: "Payment Processing Fees",
    accountType: "expense",
    accountSubtype: "marketplace_fees",
    systemKey: "payment_processing_fees",
    parentCode: "6000",
  },
  {
    code: "6300",
    name: "Shipping Expense",
    accountType: "expense",
    accountSubtype: "shipping_expense",
    systemKey: "shipping_expense",
    parentCode: "6000",
    description:
      "Actual postage and label cost — the outbound side of the shipping " +
      "pair whose income half is 4200.",
  },
  {
    code: "6900",
    name: "FX Gain / Loss",
    accountType: "expense",
    accountSubtype: "fx_gain_loss",
    systemKey: "fx_gain_loss",
    parentCode: "6000",
    description:
      "Realized conversion difference. Unused while this build is USD-only, " +
      "and seeded anyway: it is the account the posting engine must be able " +
      "to reach the moment a second currency exists, and an entry that cannot " +
      "resolve it silently plugs to suspense instead.",
  },
];

/**
 * The rule set Loxep ships, owned by CODE rather than by a table — the same
 * mechanism, and the same reasoning, as `chart-template.ts`.
 *
 * Seeding is idempotent by `code`: an installation that already has a rule
 * keeps it, because after seeding the rows belong to the operator. A changed
 * template does nothing to an existing installation, which is the honest
 * answer, and it is better expressed by not having a template table.
 *
 * ## The accrual shape, stated once
 *
 * ```text
 * order               revenue at SALE, into marketplace_clearing
 * order_fee           seller_charge -> expense; buyer_surcharge -> INCOME
 * order_refund        contra revenue, out of marketplace_clearing
 * expense             the operator's own cost, by category
 * acquisition_cost    capitalize -> INVENTORY (an asset, not a cost);
 *                     otherwise spend posted where it sits
 * inventory_movement  depletion_sale -> COGS at the frozen basis
 * ```
 *
 * `accounting_books.accounting_basis` may say `cash`, and nothing here branches
 * on it: a cash-basis rule set posts from settlement facts instead of sale
 * facts, and nobody has written one. The label is stored honestly rather than
 * aspirationally.
 *
 * ## fee_direction is load-bearing, and this is where it becomes money
 *
 * Phase 3 shipped `order_fees.fee_direction` because a WooCommerce `fee_line`
 * is a surcharge the merchant adds to the BUYER's cart while an eBay
 * `totalMarketplaceFee` is charged to the SELLER — both polarities, sometimes on
 * one order. The ratified accounting reading:
 *
 * ```text
 * seller_charge     a deduction from proceeds
 *                   DR marketplace_fees (EXPENSE)  CR marketplace_clearing
 * buyer_surcharge   money the buyer paid, already inside orders.total
 *                   DR suspense  CR buyer_fee_income (REVENUE)
 * ```
 *
 * Posting a buyer surcharge as a fee expense would understate income by exactly
 * the amount the buyer covered — the error every Phase 4 contribution read model
 * already avoids by filtering on `seller_charge`.
 *
 * ## PROVISIONAL: why the buyer-surcharge debit is `suspense`
 *
 * The design's worked example does not say, and the arithmetic forces a choice.
 * The sale rule debits `marketplace_clearing` for the provider-asserted
 * `total`, which ALREADY CONTAINS the surcharge, so the surcharge's entry must
 * not debit clearing again — that would count the same money twice and leave a
 * permanent clearing residual, destroying the one number that is supposed to be
 * zero.
 *
 * What the sale rule can recognize is `subtotal + shipping + tax − discount`.
 * The gap between that and `total` is exactly the components Loxep has not
 * ingested yet, and the sale rule's `remainder` plug parks it in `suspense`:
 *
 * ```text
 * order      DR clearing 220 | CR revenue 180, shipping 20, fac_tax 15,
 *                             CR suspense 5      <- the unexplained residue
 * surcharge  DR suspense 5   | CR buyer_fee_income 5
 * suspense   0                                   <- explained
 * ```
 *
 * That makes `suspense` a WORK QUEUE for orders whose components do not add up,
 * which is precisely the role the design gives it ("a suspense balance on the
 * front page is a work queue"), and it makes an uningested surcharge visible
 * instead of quietly inflating revenue. The alternative — plugging the residue
 * into `sales_revenue` and reclassing later — is tidier and hides the gap.
 *
 * ## PROVISIONAL: why an expense credits `opening_balance_equity`
 *
 * An expense's funding side is a real-world account, and `financial_accounts`
 * does not exist until the banking milestone. Every candidate was wrong in some
 * way; this one is wrong in the way an accountant already recognizes: an expense
 * paid from an account the books do not model is owner-funded, which is what
 * `opening_balance_equity` means in practice. Crediting `suspense` instead would
 * make the plug account permanently non-zero for ordinary, correct activity and
 * train an operator to ignore it. The banking milestone reclassifies by posting
 * the real account; the expense rules become one line different.
 *
 * ## The goods half: one dollar, one deduction
 *
 * ```text
 * BUY    acquisition_cost, capitalize = true
 *          DR inventory                 the money becomes an ASSET
 *          CR opening_balance_equity    the same funding side an expense uses
 *
 * HOLD   inventory_movement, receipt    NOTHING. The dollar is already in
 *                                       inventory; posting the intake too would
 *                                       debit the asset twice for one purchase.
 *
 * SELL   inventory_movement, depletion_sale
 *          DR cogs                      the FROZEN basis, never recomputed
 *          CR inventory                 the asset is relieved, to exactly zero
 * ```
 *
 * This is the flipping design's central rule made into arithmetic: *"Money
 * spent on goods is not an expense … Recording it as both would report the same
 * dollar twice — once as an expense at purchase and once as cost of goods at
 * sale."* The capitalized rule debits an ASSET, so it never touches the income
 * statement, and the only path from that asset to the P&L is a depletion.
 *
 * ## PROVISIONAL: the capitalized funding side is `opening_balance_equity`
 *
 * Deliberately the SAME choice, and the same reasoning, as the expense rules
 * above: `financial_accounts` does not exist, so a purchase paid from an
 * account the books do not model is owner-funded. Splitting the two — expenses
 * to equity, purchases to suspense — would make the plug account permanently
 * non-zero for the single largest category of a reseller's ordinary, correct
 * spend, which is exactly the failure the expense decision refused. When the
 * banking milestone lands, both rule families change by one line.
 *
 * ## PROVISIONAL: a NON-capitalized acquisition cost posts to `suspense`
 *
 * Phase 5's answer to Phase 4's open question 10 is that such a row is *"not
 * copied into `expenses`"* and *"a posting rule with `source_fact_type =
 * 'acquisition_cost'` and `match_capitalize = false` posts them directly from
 * where they already are"* — which the rule below does. Where it posts to is a
 * choice the design does not make, and the rule model cannot make it well: the
 * predicate set the design specified for this fact type has no `cost_type`, so
 * a declarative rule genuinely cannot tell mileage from a non-capitalized
 * repair part. Rather than route every one of them into `shipping_expense` and
 * be wrong most of the time, this takes the same answer the unmapped-expense
 * catch-all already ships: `suspense`, which is visible in a named report and
 * is replaced the moment an operator writes a rule naming their own account.
 */
import type { CreatePostingRuleInput } from "./posting-rules.ts";

export interface PostingRuleTemplate
  extends Omit<CreatePostingRuleInput, "createdByUserId" | "requestId"> {
  code: string;
}

export const DEFAULT_POSTING_RULES: readonly PostingRuleTemplate[] = [
  {
    code: "order_sale",
    name: "Marketplace sale",
    sourceFactType: "order",
    priority: 100,
    activate: true,
    description:
      "Revenue at sale. Debits marketplace clearing for the provider-asserted " +
      "total and credits each component Loxep recognizes; the residue parks in " +
      "suspense until a fee fact explains it.",
    lines: [
      {
        lineNumber: 1,
        accountSystemKey: "marketplace_clearing",
        amountSource: "total",
        amountMultiplier: "1",
        descriptionTemplate: "{provider} sale {external_order_number}",
      },
      {
        lineNumber: 2,
        accountSystemKey: "sales_revenue",
        amountSource: "subtotal",
        amountMultiplier: "-1",
      },
      {
        lineNumber: 3,
        accountSystemKey: "shipping_income",
        amountSource: "shipping",
        amountMultiplier: "-1",
      },
      {
        // Facilitator-collected tax, both sides, netting to zero once the
        // payout settles. It never touches sales_tax_payable and never touches
        // P&L: that money was never the seller's, and crediting it to a payable
        // would create a liability that will never be paid and grows forever.
        lineNumber: 4,
        accountSystemKey: "facilitator_tax_clearing",
        amountSource: "tax",
        amountMultiplier: "-1",
      },
      {
        // A discount is a reduction of revenue, posted against the same revenue
        // account rather than inventing a contra-discount account the shipped
        // chart does not carry. Zero on most orders, and a zero line is dropped
        // before it reaches the journal.
        lineNumber: 5,
        accountSystemKey: "sales_revenue",
        amountSource: "discount",
        amountMultiplier: "1",
      },
      { lineNumber: 9, accountSystemKey: "suspense", amountSource: "remainder" },
    ],
  },
  {
    code: "order_fee_seller_charge",
    name: "Marketplace fee charged to the seller",
    sourceFactType: "order_fee",
    priority: 100,
    activate: true,
    matchFeeDirection: "seller_charge",
    description:
      "A deduction from proceeds: an expense, and a reduction of what the " +
      "marketplace owes.",
    lines: [
      {
        lineNumber: 1,
        accountSystemKey: "marketplace_fees",
        amountSource: "fee",
        amountMultiplier: "1",
        descriptionTemplate: "{fee_type} fee on {external_order_number}",
      },
      {
        lineNumber: 2,
        accountSystemKey: "marketplace_clearing",
        amountSource: "fee",
        amountMultiplier: "-1",
      },
    ],
  },
  {
    code: "order_fee_buyer_surcharge",
    name: "Surcharge the seller charged the buyer",
    sourceFactType: "order_fee",
    priority: 100,
    activate: true,
    matchFeeDirection: "buyer_surcharge",
    description:
      "Handling, small-order, COD, and gift-wrap surcharges: income, never a " +
      "fee expense, and already inside the order total — so it clears the " +
      "sale's suspense residue rather than debiting clearing a second time.",
    lines: [
      {
        lineNumber: 1,
        accountSystemKey: "suspense",
        amountSource: "fee",
        amountMultiplier: "1",
        descriptionTemplate: "{fee_type} surcharge on {external_order_number}",
      },
      {
        lineNumber: 2,
        accountSystemKey: "buyer_fee_income",
        amountSource: "fee",
        amountMultiplier: "-1",
      },
    ],
  },
  {
    code: "order_refund",
    name: "Refund to the buyer",
    sourceFactType: "order_refund",
    priority: 100,
    activate: true,
    description:
      "Contra revenue, and a reduction of what the marketplace owes. Sales " +
      "returns is a contra flag on the ordinary revenue type rather than a " +
      "sixth account type, which keeps statement grouping trivial.",
    lines: [
      {
        lineNumber: 1,
        accountSystemKey: "sales_returns",
        amountSource: "refund",
        amountMultiplier: "1",
        descriptionTemplate: "Refund on {external_order_number}",
      },
      {
        lineNumber: 2,
        accountSystemKey: "marketplace_clearing",
        amountSource: "refund",
        amountMultiplier: "-1",
      },
    ],
  },
  /* --------------------------------------------------------------- expenses */
  // Four category rules ahead of one catch-all: `priority` ascending, so the
  // specific ones claim first and the catch-all only sees what nothing else
  // wanted. This is the whole resolution model in miniature — no OR, no
  // negation, just narrower rules at a lower number.
  {
    code: "expense_postage",
    name: "Expense — postage",
    sourceFactType: "expense",
    priority: 50,
    activate: true,
    matchExpenseCategory: "postage",
    lines: [
      {
        lineNumber: 1,
        accountSystemKey: "shipping_expense",
        amountSource: "total",
        amountMultiplier: "1",
        descriptionTemplate: "{category} — {payee_name}",
      },
      {
        lineNumber: 2,
        accountSystemKey: "opening_balance_equity",
        amountSource: "total",
        amountMultiplier: "-1",
      },
    ],
  },
  {
    code: "expense_shipping_supplies",
    name: "Expense — shipping supplies",
    sourceFactType: "expense",
    priority: 50,
    activate: true,
    matchExpenseCategory: "shipping_supplies",
    lines: [
      {
        lineNumber: 1,
        accountSystemKey: "shipping_expense",
        amountSource: "total",
        amountMultiplier: "1",
        descriptionTemplate: "{category} — {payee_name}",
      },
      {
        lineNumber: 2,
        accountSystemKey: "opening_balance_equity",
        amountSource: "total",
        amountMultiplier: "-1",
      },
    ],
  },
  {
    code: "expense_marketplace_subscription",
    name: "Expense — marketplace subscription",
    sourceFactType: "expense",
    priority: 50,
    activate: true,
    matchExpenseCategory: "marketplace_subscription",
    description:
      "A store subscription is a marketplace fee that no single order caused. " +
      "It lands in the same expense account as the per-order fees so the P&L " +
      "line reads as one cost of selling there.",
    lines: [
      {
        lineNumber: 1,
        accountSystemKey: "marketplace_fees",
        amountSource: "total",
        amountMultiplier: "1",
        descriptionTemplate: "{category} — {payee_name}",
      },
      {
        lineNumber: 2,
        accountSystemKey: "opening_balance_equity",
        amountSource: "total",
        amountMultiplier: "-1",
      },
    ],
  },
  {
    code: "expense_bank_fees",
    name: "Expense — bank and processor fees",
    sourceFactType: "expense",
    priority: 50,
    activate: true,
    matchExpenseCategory: "bank_fees",
    lines: [
      {
        lineNumber: 1,
        accountSystemKey: "payment_processing_fees",
        amountSource: "total",
        amountMultiplier: "1",
        descriptionTemplate: "{category} — {payee_name}",
      },
      {
        lineNumber: 2,
        accountSystemKey: "opening_balance_equity",
        amountSource: "total",
        amountMultiplier: "-1",
      },
    ],
  },
  {
    code: "expense_uncategorized",
    name: "Expense — no mapped account",
    sourceFactType: "expense",
    priority: 900,
    activate: true,
    description:
      "The catch-all. The shipped chart carries a handful of expense accounts " +
      "and an operator's categories will outgrow them within a month, so an " +
      "unmapped expense posts to suspense — visible in a named report, and " +
      "replaced the moment the operator writes a rule naming their own " +
      "account. Refusing to post it instead would leave the expense invisible " +
      "in both the ledger AND the backlog.",
    lines: [
      {
        lineNumber: 1,
        accountSystemKey: "suspense",
        amountSource: "total",
        amountMultiplier: "1",
        descriptionTemplate: "{category} — {payee_name}",
      },
      {
        lineNumber: 2,
        accountSystemKey: "opening_balance_equity",
        amountSource: "total",
        amountMultiplier: "-1",
      },
    ],
  },
  /* ------------------------------------------------- goods: buy, hold, sell */
  {
    code: "acquisition_cost_capitalized",
    name: "Purchase of goods — capitalized into inventory",
    sourceFactType: "acquisition_cost",
    priority: 100,
    activate: true,
    matchCapitalize: true,
    description:
      "Money spent on goods is an ASSET, not an expense: it becomes cost " +
      "basis on the item and reaches the income statement only as COGS when " +
      "the item depletes. Posting it as an expense here would deduct the same " +
      "dollar twice.",
    lines: [
      {
        lineNumber: 1,
        accountSystemKey: "inventory",
        amountSource: "total",
        amountMultiplier: "1",
        descriptionTemplate: "{cost_type} on {reference_code}",
      },
      {
        lineNumber: 2,
        accountSystemKey: "opening_balance_equity",
        amountSource: "total",
        amountMultiplier: "-1",
      },
    ],
  },
  {
    code: "acquisition_cost_expensed",
    name: "Acquisition cost the operator chose not to capitalize",
    sourceFactType: "acquisition_cost",
    priority: 100,
    activate: true,
    matchCapitalize: false,
    description:
      "Mileage to the estate sale, a buyer's premium the operator will not " +
      "capitalize: real spend that never became basis. It posts from where it " +
      "sits and is never copied into `expenses`. The account is `suspense` " +
      "because this fact type carries no cost-type predicate to route on — " +
      "the same honest catch-all the unmapped-expense rule uses.",
    lines: [
      {
        lineNumber: 1,
        accountSystemKey: "suspense",
        amountSource: "total",
        amountMultiplier: "1",
        descriptionTemplate: "{cost_type} on {reference_code}",
      },
      {
        lineNumber: 2,
        accountSystemKey: "opening_balance_equity",
        amountSource: "total",
        amountMultiplier: "-1",
      },
    ],
  },
  {
    code: "cogs_on_depletion",
    name: "Cost of goods sold, at depletion",
    sourceFactType: "inventory_movement",
    priority: 100,
    activate: true,
    matchMovementKind: "depletion_sale",
    description:
      "The design's own worked example: DR cogs / CR inventory at the item's " +
      "FROZEN landed cost. This is the only way per-item realized " +
      "contribution and the P&L can agree, because both read the same frozen " +
      "number rather than each recomputing one.",
    lines: [
      {
        lineNumber: 1,
        accountSystemKey: "cogs",
        amountSource: "quantity_times_basis",
        amountMultiplier: "1",
        descriptionTemplate: "Cost of goods sold — {item_code}",
      },
      {
        lineNumber: 2,
        accountSystemKey: "inventory",
        amountSource: "quantity_times_basis",
        amountMultiplier: "-1",
      },
    ],
  },
  {
    code: "cogs_depletion_reversed",
    name: "Reversed depletion — cost of goods sold, returned",
    sourceFactType: "inventory_movement",
    priority: 100,
    activate: true,
    matchMovementKind: "reversal",
    description:
      "A `reversal` movement is how @loxep/inventory corrects an append-only " +
      "ledger, and a depletion that did not happen must not leave COGS " +
      "overstated while the stock comes back. The reader refuses to produce a " +
      "basis for a reversal of anything other than a depletion_sale, so this " +
      "rule can be unconditional on the kind it reverses.",
    lines: [
      {
        lineNumber: 1,
        accountSystemKey: "inventory",
        amountSource: "quantity_times_basis",
        amountMultiplier: "1",
        descriptionTemplate: "Reversed depletion — {item_code}",
      },
      {
        lineNumber: 2,
        accountSystemKey: "cogs",
        amountSource: "quantity_times_basis",
        amountMultiplier: "-1",
      },
    ],
  },
];

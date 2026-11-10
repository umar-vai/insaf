// The land purchase project (the ads landing page /land). Both funds count
// towards it: one off gifts to the land fund and the special land donor
// members. The approved public campaign goal is 2.5 crore taka. Keep the live
// Admin fund goal synchronized with this amount.
export const LAND = {
  fund: 'land-buy',
  memberFund: 'land-giver',
  goalMinor: 2_50_00_000 * 100,
} as const;

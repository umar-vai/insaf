// The land purchase project (the ads landing page /land). Both funds count
// towards it: one off gifts to the land fund and the special land donor
// members. The goal is the land fund's goal_minor (set in Admin, Donations,
// Funds); this is only the fallback the owner gave: 2 crore taka.
export const LAND = {
  fund: 'land-buy',
  memberFund: 'land-giver',
  goalMinor: 2_00_00_000 * 100,
} as const;

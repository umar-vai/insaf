// The land purchase project (the ads landing page /land). Both funds count
// towards it: one off gifts to the land fund and the special land donor
// members. The approved public campaign goal is 2.5 crore taka. Keep the live
// Admin fund goal synchronized with this amount.
export const LAND = {
  fund: 'land-buy',
  memberFund: 'land-giver',
  goalMinor: 2_50_00_000 * 100,
  // Land donor members: 100 members, 2.5 lakh taka each = the 2.5 crore goal.
  memberGoal: 100,
  memberShareTaka: 2_50_000,
} as const;

const MEMBER_SUMMARY = 'বিশেষ ১০০ জন জমিদাতা সদস্যের তালিকায় আপনার নাম অন্তর্ভুক্ত করুন। প্রত্যেক সদস্যের অংশ ২.৫ লক্ষ টাকা।';
const MEMBER_STORY = `> যখন মানুষ মৃত্যুবরণ করে তখন তার সমস্ত আমল বন্ধ হয়ে যায়। শুধু তিন প্রকার আমল অব্যাহত থাকে: সদাকাহ জারিয়াহ; এমন জ্ঞান যার দ্বারা অন্যের উপকার হয়; যে সুসন্তান তার জন্যে দু‘আ করতে থাকে। (সহীহ মুসলিম, হাদীস ১৬৩১)

বিশেষ ১০০ জন জমিদাতা সদস্যের তালিকায় আপনার নাম অন্তর্ভুক্ত করুন। ২ কোটি ৫০ লাখ টাকার জমি ক্রয়ে ১০০ জন সদস্যের প্রত্যেকের অংশ ২.৫ লক্ষ টাকা। স্থায়ী সদস্য পদ লাভ করুন এবং এই দীনি উদ্যোগের ইতিহাসে নিজের নাম লিখে রাখুন।

## ব্যয়ের খাত
তামরিন এডুকেশন নেটওয়ার্ক ফাউন্ডেশনের মসজিদ, মাদরাসা ও ইসলামিক সেন্টারের জমি ক্রয়ের জন্য ব্যয় করা হবে ইন শা আল্লাহ।`;

/**
 * The approved land donor member terms are authoritative, like the land goal:
 * whatever an older database row says, every page shows 100 members at
 * 2.5 lakh taka each. Other funds pass through untouched.
 */
export function withLandMemberTerms<T extends { slug: string; goalMinor: number | null; memberGoal: number | null; presetAmounts: string; summary: string; storyText: string }>(f: T): T {
  if (f.slug !== LAND.memberFund) return f;
  return {
    ...f,
    goalMinor: LAND.memberGoal * LAND.memberShareTaka * 100,
    memberGoal: LAND.memberGoal,
    presetAmounts: String(LAND.memberShareTaka),
    summary: MEMBER_SUMMARY,
    storyText: MEMBER_STORY,
  };
}

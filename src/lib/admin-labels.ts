// Bangla labels used across the admin.
export const ORDER_STATUS_BN = {
  review: 'যাচাই দরকার',
  paid: 'পরিশোধিত',
  pending: 'অপেক্ষমাণ',
  failed: 'ব্যর্থ',
  cancelled: 'বাতিল',
} as const;

export const ENROLL_STATUS_BN: Record<string, string> = { active: 'চালু', pending: 'অপেক্ষমাণ', cancelled: 'বন্ধ' };
export const ENROLL_SOURCE_BN: Record<string, string> = { legacy: 'পুরোনো সাইট', order: 'অনলাইন পেমেন্ট', admin: 'অ্যাডমিন', free: 'ফ্রি' };
export const COURSE_STATUS_BN: Record<string, string> = { published: 'চালু', draft: 'খসড়া', archived: 'আর্কাইভ' };
export const REVIEW_STATUS_BN: Record<string, string> = { pending: 'অপেক্ষমাণ', published: 'প্রকাশিত', hidden: 'লুকানো' };

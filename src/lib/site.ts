// Facts as published on the old madrasatulinsaf.org (home, contact and fund pages).
export const SITE = {
  name: 'Madrasatul Insaf',
  nameBn: 'মাদরাসাতুল ইনসাফ',
  nameAr: 'مدرسة الإنصاف',
  slogan: 'আগামী প্রজন্মের ইলমিযাত্রা',
  tagline: 'কুরআন ও সুন্নাহভিত্তিক ইলমি মারকাজ। নুরানি, নাজেরা ও হিফজুল কুরআন এবং কিতাব বিভাগ (মাদানি নেসাব)।',
  phone: { display: '01615-332482', tel: '+8801615332482' },
  whatsapp: '8801615332482',
  email: 'madrasatulinsaf24@gmail.com',
  address: '২৭/এ/৩ মনেশ্বর ১ম লেন, হাজারীবাগ, ঢাকা-১২০৯',
  officeHours: 'রবি থেকে বৃহস্পতিবার: সকাল ৯টা থেকে দুপুর ৩টা',
  mapUrl: 'https://www.google.com/maps/search/Madrashatul%20Insaf/@23.72929959,90.37232212,17z?hl=en',
  facebook: 'https://www.facebook.com/share/1FUjFiMC9w/',
  youtube: 'https://youtube.com/@isastv7418',
  payments: ['বিকাশ', 'নগদ', 'রকেট', 'কার্ড', 'নেট ব্যাংকিং'],
} as const;

/** For gifts over 10,000 Tk the old site asked donors to use the bank. */
export const BANK = {
  name: 'MADRASATUL INSAF',
  account: '20507830200126602',
  routing: '125263522',
  bank: 'Islami Bank Bangladesh PLC',
  branch: 'Jigatala sub-branch, New Market, Dhaka',
} as const;

export const FOUNDER = {
  name: 'উস্তাদ শাহাদাত হোসেন',
  role: 'প্রতিষ্ঠাতা, নীতিগত অভিভাবক ও দিকনির্দেশক',
  about: 'একজন ভাষাপ্রশিক্ষক ও দীনি সংগঠক।',
} as const;

export function whatsappUrl(message?: string): string {
  return `https://wa.me/${SITE.whatsapp}${message ? `?text=${encodeURIComponent(message)}` : ''}`;
}

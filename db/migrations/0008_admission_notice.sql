-- The notice page is /blog (notices and news, edited in Admin, Website). This
-- adds the admission announcement from the madrasa's poster as a notice. No
-- schema change: scheduling is a published row whose published_at is still in
-- the future, which the public queries hide until then. The poster picture
-- itself is shown at the top of the notice page.

INSERT INTO blog_posts (id, slug, title, excerpt, body_html, category, status, featured, author_name, published_at) VALUES (
  'post_admission_open',
  'admission-open',
  'ভর্তি চলছে: মাদরাসাতুল ইনসাফ',
  'নূরানি কিন্ডারগার্টেন ও আন্তর্জাতিক মানের হিফজ মাদরাসা। আবাসিক, অনাবাসিক ও ডে-কেয়ার। প্লে, নার্সারি, কেজি, ১ম, ২য় ও ৩য় শ্রেণিতে ভর্তি চলছে।',
  '<p>মাদরাসাতুল ইনসাফ, নূরানি কিন্ডারগার্টেন ও আন্তর্জাতিক মানের হিফজ মাদরাসায় ভর্তি চলছে। আবাসিক, অনাবাসিক ও ডে-কেয়ার, তিন ধরনেই ভর্তি নেওয়া হচ্ছে।</p><h2>ভর্তি চলছে যেসব শ্রেণিতে</h2><p>প্লে, নার্সারি, কেজি, ১ম, ২য় ও ৩য় শ্রেণি। জেনারেল শিক্ষায় প্রতিটি ক্লাস মাত্র ৬ মাসে সম্পন্ন।</p><h2>বিভাগসমূহ</h2><ul><li>হিফজুল কুরআন শাখা</li><li>হিফজ রিভিশন শাখা</li><li>আদর্শ নাজেরা শাখা</li><li>সম্পৃক্ত আরবী ও জেনারেল শাখা (নূরানী কিন্ডারগার্টেন)</li><li>পৃথক আরবী ও জেনারেল শাখা</li><li>স্কুলগামী শিক্ষার্থীদের কুরআন শিক্ষার পাশাপাশি দ্বীনি শাখা</li><li>মহিলাদের জন্য বিশেষ দ্বীনি শাখা</li></ul><h2>আমাদের সাফল্য</h2><p>কওমী মাদরাসা শিক্ষাবোর্ড বেফাক পরীক্ষায় সারাদেশের মধ্যে ৩য় স্থান অর্জনসহ গৌরবময় সফলতা।</p><h2>যোগাযোগ</h2><p>মোবাইল: ০১৬১৫-৩৩২৪৮২, ০১৭৫৬-০৫৭৫৭১</p><p>ঠিকানা: ২৭/এ/৩ মনেশ্বর ১ম লেন, হাজারীবাগ, ঢাকা।</p><p>অনলাইনে আবেদন করতে ভর্তির আবেদন পাতায় যান।</p>',
  'নোটিশ', 'published', 1, 'মাদরাসাতুল ইনসাফ', strftime('%Y-%m-%dT%H:%M:%fZ','now')
);

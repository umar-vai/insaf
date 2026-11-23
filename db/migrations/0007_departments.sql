-- Departments (বিভাগ) are the offline courses, now also shown on the public
-- site and open for online applications. Additive only: four nullable or
-- defaulted columns on offline_courses, one on admission_applications, and the
-- seven real departments from the madrasa's admission poster.
-- Fees are left at 0 on purpose: the madrasa sets them in the admin.

ALTER TABLE offline_courses ADD COLUMN slug TEXT;
ALTER TABLE offline_courses ADD COLUMN summary TEXT NOT NULL DEFAULT '';
ALTER TABLE offline_courses ADD COLUMN sort_order INTEGER NOT NULL DEFAULT 0;
ALTER TABLE offline_courses ADD COLUMN is_public INTEGER NOT NULL DEFAULT 0;
CREATE UNIQUE INDEX offline_courses_slug_idx ON offline_courses(slug);

ALTER TABLE admission_applications ADD COLUMN course_id TEXT;
CREATE INDEX admission_applications_course_idx ON admission_applications(course_id);

INSERT INTO offline_courses (id, title, slug, fee_minor, admission_fee_minor, duration_months, note, status, is_public, sort_order) VALUES
  ('dept_hifz',       'হিফজুল কুরআন শাখা', 'hifz', 0, 0, 12, '', 'active', 1, 1),
  ('dept_revision',   'হিফজ রিভিশন শাখা', 'revision', 0, 0, 12, '', 'active', 1, 2),
  ('dept_nazera',     'আদর্শ নাজেরা শাখা', 'nazera', 0, 0, 12, '', 'active', 1, 3),
  ('dept_nurani',     'সম্পৃক্ত আরবী ও জেনারেল শাখা (নূরানী কিন্ডারগার্টেন)', 'nurani', 0, 0, 12, '', 'active', 1, 4),
  ('dept_separate',   'পৃথক আরবী ও জেনারেল শাখা', 'separate', 0, 0, 12, '', 'active', 1, 5),
  ('dept_school',     'স্কুলগামী শিক্ষার্থীদের কুরআন শিক্ষার পাশাপাশি দ্বীনি শাখা', 'school', 0, 0, 12, '', 'active', 1, 6),
  ('dept_women',      'মহিলাদের জন্য বিশেষ দ্বীনি শাখা', 'women', 0, 0, 12, '', 'active', 1, 7);

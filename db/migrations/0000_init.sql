CREATE TABLE `admin_events` (
	`id` text PRIMARY KEY NOT NULL,
	`actor` text NOT NULL,
	`action` text NOT NULL,
	`target` text NOT NULL,
	`detail_json` text DEFAULT '{}' NOT NULL,
	`ip` text DEFAULT '' NOT NULL,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')) NOT NULL
);
--> statement-breakpoint
CREATE INDEX `admin_events_actor_idx` ON `admin_events` (`actor`,`created_at`);--> statement-breakpoint
CREATE INDEX `admin_events_target_idx` ON `admin_events` (`target`,`created_at`);--> statement-breakpoint
CREATE INDEX `admin_events_created_idx` ON `admin_events` (`created_at`);--> statement-breakpoint
CREATE TABLE `batch_materials` (
	`id` text PRIMARY KEY NOT NULL,
	`batch_id` text NOT NULL,
	`title` text NOT NULL,
	`url` text,
	`file_key` text,
	`file_name` text,
	`content_type` text,
	`size_bytes` integer,
	`created_by` text NOT NULL,
	`hidden` integer DEFAULT 0 NOT NULL,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')) NOT NULL,
	FOREIGN KEY (`batch_id`) REFERENCES `offline_batches`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `batch_materials_batch_idx` ON `batch_materials` (`batch_id`,`created_at`);--> statement-breakpoint
CREATE TABLE `batch_teachers` (
	`id` text PRIMARY KEY NOT NULL,
	`batch_id` text NOT NULL,
	`teacher_id` text NOT NULL,
	`subject` text DEFAULT '' NOT NULL,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')) NOT NULL,
	FOREIGN KEY (`batch_id`) REFERENCES `offline_batches`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`teacher_id`) REFERENCES `teachers`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `batch_teachers_one_idx` ON `batch_teachers` (`batch_id`,`teacher_id`);--> statement-breakpoint
CREATE INDEX `batch_teachers_teacher_idx` ON `batch_teachers` (`teacher_id`);--> statement-breakpoint
CREATE TABLE `blog_posts` (
	`id` text PRIMARY KEY NOT NULL,
	`slug` text NOT NULL,
	`title` text NOT NULL,
	`excerpt` text DEFAULT '' NOT NULL,
	`body_html` text DEFAULT '' NOT NULL,
	`cover_key` text,
	`category` text DEFAULT '' NOT NULL,
	`status` text DEFAULT 'draft' NOT NULL,
	`featured` integer DEFAULT false NOT NULL,
	`author_name` text DEFAULT '' NOT NULL,
	`seo_title` text,
	`seo_description` text,
	`legacy_wp_id` integer,
	`published_at` text,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')) NOT NULL,
	`updated_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')) NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `blog_posts_slug_unique` ON `blog_posts` (`slug`);--> statement-breakpoint
CREATE UNIQUE INDEX `blog_posts_legacy_wp_id_unique` ON `blog_posts` (`legacy_wp_id`);--> statement-breakpoint
CREATE INDEX `blog_posts_status_idx` ON `blog_posts` (`status`,`published_at`);--> statement-breakpoint
CREATE TABLE `donation_events` (
	`id` text PRIMARY KEY NOT NULL,
	`donation_id` text,
	`kind` text NOT NULL,
	`detail_json` text NOT NULL,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')) NOT NULL,
	FOREIGN KEY (`donation_id`) REFERENCES `donations`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `donation_events_donation_idx` ON `donation_events` (`donation_id`,`created_at`);--> statement-breakpoint
CREATE TABLE `donations` (
	`id` text PRIMARY KEY NOT NULL,
	`reference` text NOT NULL,
	`fund_id` text NOT NULL,
	`amount_minor` integer NOT NULL,
	`donor_name` text NOT NULL,
	`donor_phone` text DEFAULT '' NOT NULL,
	`donor_email` text DEFAULT '' NOT NULL,
	`on_behalf` text DEFAULT '' NOT NULL,
	`anonymous` integer DEFAULT false NOT NULL,
	`status` text DEFAULT 'pending' NOT NULL,
	`gateway` text DEFAULT 'sslcommerz' NOT NULL,
	`method` text DEFAULT '' NOT NULL,
	`val_id` text,
	`bank_tran_id` text,
	`review_reason` text,
	`utm_source` text DEFAULT '' NOT NULL,
	`utm_campaign` text DEFAULT '' NOT NULL,
	`note` text DEFAULT '' NOT NULL,
	`recorded_by` text,
	`nonce` text,
	`voided_at` text,
	`voided_by` text,
	`void_reason` text,
	`paid_at` text,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')) NOT NULL,
	`updated_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')) NOT NULL,
	FOREIGN KEY (`fund_id`) REFERENCES `funds`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "donations_amount_check" CHECK("donations"."amount_minor" > 0)
);
--> statement-breakpoint
CREATE UNIQUE INDEX `donations_reference_unique` ON `donations` (`reference`);--> statement-breakpoint
CREATE INDEX `donations_fund_idx` ON `donations` (`fund_id`,`status`,`paid_at`);--> statement-breakpoint
CREATE INDEX `donations_status_idx` ON `donations` (`status`,`created_at`);--> statement-breakpoint
CREATE INDEX `donations_phone_idx` ON `donations` (`donor_phone`);--> statement-breakpoint
CREATE INDEX `donations_paid_idx` ON `donations` (`paid_at`);--> statement-breakpoint
CREATE UNIQUE INDEX `donations_nonce_idx` ON `donations` (`nonce`);--> statement-breakpoint
CREATE TABLE `expenses` (
	`id` text PRIMARY KEY NOT NULL,
	`spent_on` text NOT NULL,
	`category` text NOT NULL,
	`amount_minor` integer NOT NULL,
	`description` text DEFAULT '' NOT NULL,
	`method` text DEFAULT 'cash' NOT NULL,
	`voucher_key` text,
	`recorded_by` text NOT NULL,
	`status` text DEFAULT 'approved' NOT NULL,
	`decided_by` text,
	`decided_at` text,
	`nonce` text,
	`voided_at` text,
	`voided_by` text,
	`void_reason` text,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')) NOT NULL,
	CONSTRAINT "expenses_amount_check" CHECK("expenses"."amount_minor" > 0)
);
--> statement-breakpoint
CREATE INDEX `expenses_spent_idx` ON `expenses` (`spent_on`);--> statement-breakpoint
CREATE INDEX `expenses_status_idx` ON `expenses` (`status`);--> statement-breakpoint
CREATE UNIQUE INDEX `expenses_nonce_idx` ON `expenses` (`nonce`);--> statement-breakpoint
CREATE TABLE `fund_updates` (
	`id` text PRIMARY KEY NOT NULL,
	`fund_id` text NOT NULL,
	`title` text NOT NULL,
	`body` text DEFAULT '' NOT NULL,
	`image_key` text,
	`happened_on` text NOT NULL,
	`status` text DEFAULT 'published' NOT NULL,
	`created_by` text NOT NULL,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')) NOT NULL,
	FOREIGN KEY (`fund_id`) REFERENCES `funds`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `fund_updates_fund_idx` ON `fund_updates` (`fund_id`,`status`,`happened_on`);--> statement-breakpoint
CREATE TABLE `funds` (
	`id` text PRIMARY KEY NOT NULL,
	`slug` text NOT NULL,
	`title` text NOT NULL,
	`summary` text DEFAULT '' NOT NULL,
	`story_text` text DEFAULT '' NOT NULL,
	`cover_key` text,
	`goal_minor` integer,
	`member_goal` integer,
	`preset_amounts` text DEFAULT '500,1000,2000,5000,10000' NOT NULL,
	`status` text DEFAULT 'active' NOT NULL,
	`position` integer DEFAULT 0 NOT NULL,
	`legacy_wp_id` integer,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')) NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `funds_slug_unique` ON `funds` (`slug`);--> statement-breakpoint
CREATE UNIQUE INDEX `funds_legacy_wp_id_unique` ON `funds` (`legacy_wp_id`);--> statement-breakpoint
CREATE TABLE `leave_requests` (
	`id` text PRIMARY KEY NOT NULL,
	`teacher_id` text NOT NULL,
	`from_day` text NOT NULL,
	`to_day` text NOT NULL,
	`reason` text DEFAULT '' NOT NULL,
	`kind` text DEFAULT 'normal' NOT NULL,
	`status` text DEFAULT 'pending' NOT NULL,
	`decided_by` text,
	`decided_at` text,
	`decision_note` text DEFAULT '' NOT NULL,
	`created_by` text NOT NULL,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')) NOT NULL,
	FOREIGN KEY (`teacher_id`) REFERENCES `teachers`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `leave_teacher_idx` ON `leave_requests` (`teacher_id`,`from_day`);--> statement-breakpoint
CREATE INDEX `leave_status_idx` ON `leave_requests` (`status`);--> statement-breakpoint
CREATE TABLE `login_codes` (
	`id` text PRIMARY KEY NOT NULL,
	`email` text NOT NULL,
	`code_hash` text NOT NULL,
	`attempts` integer DEFAULT 0 NOT NULL,
	`expires_at` text NOT NULL,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')) NOT NULL
);
--> statement-breakpoint
CREATE INDEX `login_codes_email_idx` ON `login_codes` (`email`,`created_at`);--> statement-breakpoint
CREATE TABLE `notices` (
	`id` text PRIMARY KEY NOT NULL,
	`title` text NOT NULL,
	`body` text DEFAULT '' NOT NULL,
	`audience` text NOT NULL,
	`target_id` text DEFAULT '' NOT NULL,
	`pinned` integer DEFAULT 0 NOT NULL,
	`file_key` text,
	`file_name` text,
	`content_type` text,
	`status` text DEFAULT 'published' NOT NULL,
	`created_by` text NOT NULL,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')) NOT NULL
);
--> statement-breakpoint
CREATE INDEX `notices_audience_idx` ON `notices` (`audience`,`status`,`created_at`);--> statement-breakpoint
CREATE TABLE `offline_attendance` (
	`id` text PRIMARY KEY NOT NULL,
	`batch_id` text NOT NULL,
	`enrollment_id` text NOT NULL,
	`day` text NOT NULL,
	`status` text NOT NULL,
	`marked_by` text NOT NULL,
	`updated_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')) NOT NULL,
	FOREIGN KEY (`batch_id`) REFERENCES `offline_batches`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`enrollment_id`) REFERENCES `offline_enrollments`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `offline_attendance_one_idx` ON `offline_attendance` (`enrollment_id`,`day`);--> statement-breakpoint
CREATE INDEX `offline_attendance_batch_idx` ON `offline_attendance` (`batch_id`,`day`);--> statement-breakpoint
CREATE TABLE `offline_batches` (
	`id` text PRIMARY KEY NOT NULL,
	`course_id` text NOT NULL,
	`name` text NOT NULL,
	`kind` text DEFAULT '' NOT NULL,
	`days` text DEFAULT '' NOT NULL,
	`start_time` text DEFAULT '' NOT NULL,
	`end_time` text DEFAULT '' NOT NULL,
	`teacher_id` text,
	`room` text DEFAULT '' NOT NULL,
	`start_date` text DEFAULT '' NOT NULL,
	`status` text DEFAULT 'active' NOT NULL,
	`note` text DEFAULT '' NOT NULL,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')) NOT NULL,
	FOREIGN KEY (`course_id`) REFERENCES `offline_courses`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`teacher_id`) REFERENCES `teachers`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `offline_batches_course_idx` ON `offline_batches` (`course_id`);--> statement-breakpoint
CREATE INDEX `offline_batches_teacher_idx` ON `offline_batches` (`teacher_id`);--> statement-breakpoint
CREATE TABLE `offline_charges` (
	`id` text PRIMARY KEY NOT NULL,
	`enrollment_id` text NOT NULL,
	`kind` text NOT NULL,
	`label` text NOT NULL,
	`amount_minor` integer NOT NULL,
	`due_date` text NOT NULL,
	`source_key` text NOT NULL,
	`created_by` text NOT NULL,
	`voided_at` text,
	`voided_by` text,
	`void_reason` text,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')) NOT NULL,
	FOREIGN KEY (`enrollment_id`) REFERENCES `offline_enrollments`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "offline_charges_amount_check" CHECK("offline_charges"."amount_minor" > 0)
);
--> statement-breakpoint
CREATE UNIQUE INDEX `offline_charges_source_idx` ON `offline_charges` (`enrollment_id`,`source_key`);--> statement-breakpoint
CREATE INDEX `offline_charges_due_idx` ON `offline_charges` (`due_date`);--> statement-breakpoint
CREATE TABLE `offline_courses` (
	`id` text PRIMARY KEY NOT NULL,
	`title` text NOT NULL,
	`fee_minor` integer NOT NULL,
	`admission_fee_minor` integer DEFAULT 0 NOT NULL,
	`duration_months` integer NOT NULL,
	`note` text DEFAULT '' NOT NULL,
	`status` text DEFAULT 'active' NOT NULL,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')) NOT NULL
);
--> statement-breakpoint
CREATE TABLE `offline_enrollments` (
	`id` text PRIMARY KEY NOT NULL,
	`student_id` text NOT NULL,
	`course_id` text NOT NULL,
	`batch` text DEFAULT '' NOT NULL,
	`batch_id` text,
	`roll` text DEFAULT '' NOT NULL,
	`start_date` text NOT NULL,
	`fee_minor` integer NOT NULL,
	`admission_fee_minor` integer DEFAULT 0 NOT NULL,
	`discount_minor` integer DEFAULT 0 NOT NULL,
	`duration_months` integer NOT NULL,
	`plan_months` integer NOT NULL,
	`status` text DEFAULT 'active' NOT NULL,
	`note` text DEFAULT '' NOT NULL,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')) NOT NULL,
	FOREIGN KEY (`student_id`) REFERENCES `offline_students`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`course_id`) REFERENCES `offline_courses`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`batch_id`) REFERENCES `offline_batches`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `offline_enrollments_student_idx` ON `offline_enrollments` (`student_id`);--> statement-breakpoint
CREATE INDEX `offline_enrollments_course_idx` ON `offline_enrollments` (`course_id`);--> statement-breakpoint
CREATE INDEX `offline_enrollments_batch_idx` ON `offline_enrollments` (`batch_id`);--> statement-breakpoint
CREATE TABLE `offline_exams` (
	`id` text PRIMARY KEY NOT NULL,
	`batch_id` text NOT NULL,
	`title` text NOT NULL,
	`subject` text DEFAULT '' NOT NULL,
	`exam_date` text NOT NULL,
	`start_time` text DEFAULT '' NOT NULL,
	`fee_minor` integer DEFAULT 0 NOT NULL,
	`note` text DEFAULT '' NOT NULL,
	`status` text DEFAULT 'scheduled' NOT NULL,
	`created_by` text NOT NULL,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')) NOT NULL,
	FOREIGN KEY (`batch_id`) REFERENCES `offline_batches`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `offline_exams_batch_idx` ON `offline_exams` (`batch_id`,`exam_date`);--> statement-breakpoint
CREATE INDEX `offline_exams_date_idx` ON `offline_exams` (`exam_date`);--> statement-breakpoint
CREATE TABLE `offline_online_payments` (
	`id` text PRIMARY KEY NOT NULL,
	`reference` text NOT NULL,
	`enrollment_id` text NOT NULL,
	`student_id` text NOT NULL,
	`amount_minor` integer NOT NULL,
	`status` text DEFAULT 'pending' NOT NULL,
	`val_id` text,
	`bank_tran_id` text,
	`card_type` text,
	`payment_id` text,
	`review_reason` text,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')) NOT NULL,
	`updated_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')) NOT NULL,
	FOREIGN KEY (`enrollment_id`) REFERENCES `offline_enrollments`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`student_id`) REFERENCES `students`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "ofop_amount_check" CHECK("offline_online_payments"."amount_minor" > 0)
);
--> statement-breakpoint
CREATE UNIQUE INDEX `offline_online_payments_reference_unique` ON `offline_online_payments` (`reference`);--> statement-breakpoint
CREATE INDEX `ofop_enrollment_idx` ON `offline_online_payments` (`enrollment_id`);--> statement-breakpoint
CREATE INDEX `ofop_status_idx` ON `offline_online_payments` (`status`);--> statement-breakpoint
CREATE TABLE `offline_payments` (
	`id` text PRIMARY KEY NOT NULL,
	`receipt_no` integer NOT NULL,
	`enrollment_id` text NOT NULL,
	`amount_minor` integer NOT NULL,
	`paid_on` text NOT NULL,
	`method` text NOT NULL,
	`reference` text DEFAULT '' NOT NULL,
	`note` text DEFAULT '' NOT NULL,
	`recorded_by` text NOT NULL,
	`nonce` text,
	`voided_at` text,
	`voided_by` text,
	`void_reason` text,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')) NOT NULL,
	FOREIGN KEY (`enrollment_id`) REFERENCES `offline_enrollments`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `offline_payments_receipt_idx` ON `offline_payments` (`receipt_no`);--> statement-breakpoint
CREATE UNIQUE INDEX `offline_payments_nonce_idx` ON `offline_payments` (`nonce`);--> statement-breakpoint
CREATE INDEX `offline_payments_enrollment_idx` ON `offline_payments` (`enrollment_id`);--> statement-breakpoint
CREATE INDEX `offline_payments_paid_idx` ON `offline_payments` (`paid_on`);--> statement-breakpoint
CREATE INDEX `offline_payments_created_idx` ON `offline_payments` (`created_at`);--> statement-breakpoint
CREATE TABLE `offline_students` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`phone` text NOT NULL,
	`guardian_phone` text DEFAULT '' NOT NULL,
	`address` text DEFAULT '' NOT NULL,
	`note` text DEFAULT '' NOT NULL,
	`email` text DEFAULT '' NOT NULL,
	`student_no` integer,
	`status` text DEFAULT 'active' NOT NULL,
	`blocked_reason` text DEFAULT '' NOT NULL,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')) NOT NULL
);
--> statement-breakpoint
CREATE INDEX `offline_students_phone_idx` ON `offline_students` (`phone`);--> statement-breakpoint
CREATE UNIQUE INDEX `offline_students_no_idx` ON `offline_students` (`student_no`);--> statement-breakpoint
CREATE TABLE `payroll` (
	`id` text PRIMARY KEY NOT NULL,
	`teacher_id` text NOT NULL,
	`month` text NOT NULL,
	`basic_minor` integer NOT NULL,
	`work_days` integer NOT NULL,
	`leave_days` integer DEFAULT 0 NOT NULL,
	`paid_leave_days` integer DEFAULT 0 NOT NULL,
	`unpaid_days` integer DEFAULT 0 NOT NULL,
	`deduction_minor` integer DEFAULT 0 NOT NULL,
	`bonus_minor` integer DEFAULT 0 NOT NULL,
	`other_deduction_minor` integer DEFAULT 0 NOT NULL,
	`net_minor` integer NOT NULL,
	`basis` text NOT NULL,
	`note` text DEFAULT '' NOT NULL,
	`status` text DEFAULT 'draft' NOT NULL,
	`approved_by` text,
	`approved_at` text,
	`paid_on` text,
	`paid_method` text,
	`expense_id` text,
	`created_by` text NOT NULL,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')) NOT NULL,
	`updated_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')) NOT NULL,
	FOREIGN KEY (`teacher_id`) REFERENCES `teachers`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `payroll_one_idx` ON `payroll` (`teacher_id`,`month`);--> statement-breakpoint
CREATE INDEX `payroll_month_idx` ON `payroll` (`month`);--> statement-breakpoint
CREATE TABLE `settings` (
	`key` text PRIMARY KEY NOT NULL,
	`value` text NOT NULL,
	`updated_by` text NOT NULL,
	`updated_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')) NOT NULL
);
--> statement-breakpoint
CREATE TABLE `site_activity` (
	`id` text PRIMARY KEY NOT NULL,
	`day` text NOT NULL,
	`visitor` text NOT NULL,
	`student_id` text,
	`kind` text NOT NULL,
	`path` text DEFAULT '' NOT NULL,
	`course_id` text,
	`lesson_id` text,
	`detail` text DEFAULT '' NOT NULL,
	`device` text DEFAULT '' NOT NULL,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')) NOT NULL
);
--> statement-breakpoint
CREATE INDEX `site_activity_day_idx` ON `site_activity` (`day`,`student_id`);--> statement-breakpoint
CREATE TABLE `staff` (
	`email` text PRIMARY KEY NOT NULL,
	`added_by` text NOT NULL,
	`scope` text DEFAULT 'all' NOT NULL,
	`modules` text DEFAULT '' NOT NULL,
	`name` text DEFAULT '' NOT NULL,
	`role` text DEFAULT 'custom' NOT NULL,
	`area` text DEFAULT 'both' NOT NULL,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')) NOT NULL
);
--> statement-breakpoint
CREATE TABLE `students` (
	`id` text PRIMARY KEY NOT NULL,
	`email` text NOT NULL,
	`name` text DEFAULT '' NOT NULL,
	`phone` text,
	`google_sub` text,
	`legacy_wp_user_id` integer,
	`password_hash` text,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')) NOT NULL,
	`last_login_at` text
);
--> statement-breakpoint
CREATE UNIQUE INDEX `students_google_sub_unique` ON `students` (`google_sub`);--> statement-breakpoint
CREATE UNIQUE INDEX `students_legacy_wp_user_id_unique` ON `students` (`legacy_wp_user_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `students_email_idx` ON `students` (lower("email"));--> statement-breakpoint
CREATE INDEX `students_created_idx` ON `students` (`created_at`);--> statement-breakpoint
CREATE TABLE `teacher_ratings` (
	`id` text PRIMARY KEY NOT NULL,
	`offline_student_id` text NOT NULL,
	`teacher_id` text NOT NULL,
	`batch_id` text NOT NULL,
	`month` text NOT NULL,
	`teaching` integer NOT NULL,
	`punctuality` integer NOT NULL,
	`behaviour` integer NOT NULL,
	`overall` integer NOT NULL,
	`comment` text DEFAULT '' NOT NULL,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')) NOT NULL,
	FOREIGN KEY (`offline_student_id`) REFERENCES `offline_students`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`teacher_id`) REFERENCES `teachers`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`batch_id`) REFERENCES `offline_batches`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "teacher_ratings_range" CHECK("teacher_ratings"."teaching" BETWEEN 1 AND 5 AND "teacher_ratings"."punctuality" BETWEEN 1 AND 5 AND "teacher_ratings"."behaviour" BETWEEN 1 AND 5 AND "teacher_ratings"."overall" BETWEEN 1 AND 5)
);
--> statement-breakpoint
CREATE UNIQUE INDEX `teacher_ratings_once_idx` ON `teacher_ratings` (`offline_student_id`,`teacher_id`,`month`);--> statement-breakpoint
CREATE INDEX `teacher_ratings_teacher_idx` ON `teacher_ratings` (`teacher_id`,`month`);--> statement-breakpoint
CREATE TABLE `teachers` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`phone` text NOT NULL,
	`email` text DEFAULT '' NOT NULL,
	`subject` text DEFAULT '' NOT NULL,
	`basic_pay_minor` integer DEFAULT 0 NOT NULL,
	`joined_on` text DEFAULT '' NOT NULL,
	`role` text DEFAULT 'teacher' NOT NULL,
	`status` text DEFAULT 'active' NOT NULL,
	`note` text DEFAULT '' NOT NULL,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')) NOT NULL
);
--> statement-breakpoint
CREATE TABLE `ticket_messages` (
	`id` text PRIMARY KEY NOT NULL,
	`ticket_id` text NOT NULL,
	`author_kind` text NOT NULL,
	`author` text NOT NULL,
	`body` text NOT NULL,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')) NOT NULL,
	FOREIGN KEY (`ticket_id`) REFERENCES `tickets`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `ticket_messages_ticket_idx` ON `ticket_messages` (`ticket_id`,`created_at`);--> statement-breakpoint
CREATE TABLE `tickets` (
	`id` text PRIMARY KEY NOT NULL,
	`ticket_no` integer NOT NULL,
	`from_kind` text NOT NULL,
	`offline_student_id` text,
	`teacher_id` text,
	`subject` text NOT NULL,
	`category` text DEFAULT 'other' NOT NULL,
	`status` text DEFAULT 'open' NOT NULL,
	`closed_by` text,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')) NOT NULL,
	`updated_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')) NOT NULL,
	FOREIGN KEY (`offline_student_id`) REFERENCES `offline_students`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`teacher_id`) REFERENCES `teachers`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `tickets_no_idx` ON `tickets` (`ticket_no`);--> statement-breakpoint
CREATE INDEX `tickets_status_idx` ON `tickets` (`status`,`updated_at`);--> statement-breakpoint
CREATE INDEX `tickets_student_idx` ON `tickets` (`offline_student_id`);--> statement-breakpoint
CREATE INDEX `tickets_teacher_idx` ON `tickets` (`teacher_id`);
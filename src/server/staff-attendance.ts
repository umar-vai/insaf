import { log } from './admin';
import { newId, type Result } from './ops-util';
import { isTime, isYmd } from '../lib/offline';

// Daily attendance of teachers and office staff: present, late, absent or
// on leave, with arrival and leaving times. The office marks the whole staff
// for a day on one sheet. When the owner switches it on (office rules), a
// teacher can also tap "I have arrived" and "I am leaving" in the teacher
// panel; the time is the server's Dhaka time, never the phone's. Approved
// leave (leave_requests) shows on the sheet so the office does not mark
// someone absent who is on leave. Payroll keeps counting leave as before.

export const STAFF_STATUSES = ['present', 'late', 'absent', 'leave'] as const;
export type StaffStatus = (typeof STAFF_STATUSES)[number];
export const STAFF_STATUS_BN: Record<StaffStatus, string> = { present: 'উপস্থিত', late: 'দেরিতে', absent: 'অনুপস্থিত', leave: 'ছুটি' };

export type StaffDayRow = {
  teacherId: string;
  name: string;
  role: 'teacher' | 'staff';
  status: StaffStatus | null;
  inTime: string;
  outTime: string;
  note: string;
  source: 'office' | 'self' | null;
  onLeave: number;
};

/** Every active teacher and staff member with what is recorded for the day. */
export async function staffDay(db: D1Database, day: string): Promise<StaffDayRow[]> {
  const { results } = await db
    .prepare(
      `SELECT t.id AS teacherId, t.name, t.role, a.status, coalesce(a.in_time, '') AS inTime, coalesce(a.out_time, '') AS outTime,
         coalesce(a.note, '') AS note, a.source,
         EXISTS (SELECT 1 FROM leave_requests l WHERE l.teacher_id = t.id AND l.status = 'approved' AND l.from_day <= ?1 AND l.to_day >= ?1) AS onLeave
       FROM teachers t LEFT JOIN staff_attendance a ON a.teacher_id = t.id AND a.day = ?1
       WHERE t.status = 'active' OR a.id IS NOT NULL ORDER BY t.role DESC, t.name`,
    )
    .bind(day)
    .all<StaffDayRow>();
  return results;
}

export type StaffMark = { status: StaffStatus; inTime: string; outTime: string; note: string };

/** Reads the sheet ("status_<id>", "in_<id>", "out_<id>", "note_<id>"). Rows left blank are skipped. */
export function staffMarksFromForm(form: FormData, ids: string[]): Record<string, StaffMark> {
  const out: Record<string, StaffMark> = {};
  for (const id of ids) {
    const status = String(form.get(`status_${id}`) ?? '');
    if (!(STAFF_STATUSES as readonly string[]).includes(status)) continue;
    const inTime = String(form.get(`in_${id}`) ?? '').trim();
    const outTime = String(form.get(`out_${id}`) ?? '').trim();
    out[id] = {
      status: status as StaffStatus,
      inTime: isTime(inTime) ? inTime : '',
      outTime: isTime(outTime) ? outTime : '',
      note: String(form.get(`note_${id}`) ?? '').trim().slice(0, 200),
    };
  }
  return out;
}

/** Saves the office's sheet for a day (not a future day). Only known staff rows are written. */
export async function saveStaffDay(db: D1Database, actor: string, day: string, rows: Record<string, StaffMark>, today: string): Promise<number> {
  if (!isYmd(day) || day > today) return 0;
  const known = new Set((await staffDay(db, day)).map((r) => r.teacherId));
  const entries = Object.entries(rows).filter(([id]) => known.has(id));
  if (!entries.length) return 0;
  await db.batch(
    entries.map(([teacherId, m]) =>
      db
        .prepare(
          `INSERT INTO staff_attendance (id, teacher_id, day, status, in_time, out_time, note, source, marked_by) VALUES (?, ?, ?, ?, ?, ?, ?, 'office', ?)
           ON CONFLICT (teacher_id, day) DO UPDATE SET status = excluded.status, in_time = excluded.in_time, out_time = excluded.out_time,
             note = excluded.note, source = 'office', marked_by = excluded.marked_by, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')`,
        )
        .bind(newId('sat'), teacherId, day, m.status, m.inTime, m.outTime, m.note, actor),
    ),
  );
  await log(db, actor, 'staff_attendance.save', `staff_attendance:${day}`, { marked: entries.length, absent: entries.filter(([, m]) => m.status === 'absent').length });
  return entries.length;
}

/** Dhaka date and time now ("YYYY-MM-DD", "HH:MM"). */
export function dhakaNow(now = new Date()): { day: string; time: string } {
  const d = new Date(now.getTime() + 6 * 3600_000).toISOString();
  return { day: d.slice(0, 10), time: d.slice(11, 16) };
}

/**
 * A teacher's own arrival or leaving, at the server's time. Arrival is
 * recorded once a day (late after the office start time); leaving needs an
 * arrival first and can be updated. The office's own marks are not changed.
 */
export async function selfAttendance(
  db: D1Database,
  actor: string,
  teacherId: string,
  action: 'in' | 'out',
  startTime: string,
  now = dhakaNow(),
): Promise<Result<StaffStatus>> {
  const current = await db.prepare('SELECT status, in_time AS inTime, source FROM staff_attendance WHERE teacher_id = ? AND day = ?').bind(teacherId, now.day).first<{ status: StaffStatus; inTime: string; source: string }>();
  if (action === 'in') {
    if (current) return { ok: false, error: 'already' };
    const status: StaffStatus = startTime && isTime(startTime) && now.time > startTime ? 'late' : 'present';
    try {
      await db
        .prepare(`INSERT INTO staff_attendance (id, teacher_id, day, status, in_time, source, marked_by) VALUES (?, ?, ?, ?, ?, 'self', ?)`)
        .bind(newId('sat'), teacherId, now.day, status, now.time, actor)
        .run();
    } catch {
      return { ok: false, error: 'already' };
    }
    await log(db, actor, 'staff_attendance.self_in', `teacher:${teacherId}`, { day: now.day, time: now.time, status });
    return { ok: true, value: status };
  }
  if (!current || !current.inTime || current.status === 'absent' || current.status === 'leave') return { ok: false, error: 'not_in' };
  await db.prepare('UPDATE staff_attendance SET out_time = ?, updated_at = strftime(\'%Y-%m-%dT%H:%M:%fZ\',\'now\') WHERE teacher_id = ? AND day = ?').bind(now.time, teacherId, now.day).run();
  await log(db, actor, 'staff_attendance.self_out', `teacher:${teacherId}`, { day: now.day, time: now.time });
  return { ok: true, value: current.status };
}

export type StaffMonthRow = { teacherId: string; name: string; role: string; present: number; late: number; absent: number; leave: number; leaveApproved: number };

/** Counts per person for a month ("YYYY-MM"), with approved leave days from leave requests. */
export async function staffMonth(db: D1Database, month: string): Promise<StaffMonthRow[]> {
  const { results } = await db
    .prepare(
      `SELECT t.id AS teacherId, t.name, t.role,
         coalesce(sum(a.status = 'present'), 0) AS present, coalesce(sum(a.status = 'late'), 0) AS late,
         coalesce(sum(a.status = 'absent'), 0) AS absent, coalesce(sum(a.status = 'leave'), 0) AS leave,
         (SELECT coalesce(sum(julianday(min(l.to_day, ?2)) - julianday(max(l.from_day, ?1)) + 1), 0) FROM leave_requests l
            WHERE l.teacher_id = t.id AND l.status = 'approved' AND l.from_day <= ?2 AND l.to_day >= ?1) AS leaveApproved
       FROM teachers t LEFT JOIN staff_attendance a ON a.teacher_id = t.id AND a.day BETWEEN ?1 AND ?2
       WHERE t.status = 'active' OR a.id IS NOT NULL GROUP BY t.id ORDER BY t.role DESC, t.name`,
    )
    .bind(`${month}-01`, `${month}-31`)
    .all<StaffMonthRow>();
  return results;
}

export type MyStaffDay = { day: string; status: StaffStatus; inTime: string; outTime: string; note: string };

export async function myStaffAttendance(db: D1Database, teacherId: string, month: string): Promise<MyStaffDay[]> {
  const { results } = await db
    .prepare(`SELECT day, status, in_time AS inTime, out_time AS outTime, note FROM staff_attendance WHERE teacher_id = ? AND day LIKE ? ORDER BY day DESC`)
    .bind(teacherId, `${month}-%`)
    .all<MyStaffDay>();
  return results;
}

export async function myStaffToday(db: D1Database, teacherId: string, day: string) {
  return db.prepare('SELECT status, in_time AS inTime, out_time AS outTime, source FROM staff_attendance WHERE teacher_id = ? AND day = ?').bind(teacherId, day).first<{ status: StaffStatus; inTime: string; outTime: string; source: string }>();
}

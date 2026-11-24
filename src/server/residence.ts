import { log } from './admin';
import { isYmd, parseTaka } from '../lib/offline';
import { parseStudentNo } from './offline';
import { newId, text, wholeNumber, type Result } from './ops-util';

type Room = { id: string; name: string; capacity: number; occupied: number };
type Stay = { id: string; studentId: string; name: string; studentNo: number; roomName: string; startsOn: string; endsOn: string | null };
export async function residenceView(db: D1Database) {
  const [rooms, stays] = await db.batch([
    db.prepare(`SELECT r.id, r.name, r.capacity,
      (SELECT count(*) FROM residential_stays s WHERE s.room_id = r.id AND s.ends_on IS NULL) AS occupied FROM residential_rooms r ORDER BY r.name`),
    db.prepare(`SELECT t.id, s.id AS studentId, s.name, s.student_no AS studentNo, r.name AS roomName, t.starts_on AS startsOn, t.ends_on AS endsOn
      FROM residential_stays t JOIN offline_students s ON s.id = t.student_id JOIN residential_rooms r ON r.id = t.room_id
      WHERE t.ends_on IS NULL UNION ALL
      SELECT * FROM (SELECT t.id, s.id, s.name, s.student_no, r.name, t.starts_on, t.ends_on
        FROM residential_stays t JOIN offline_students s ON s.id = t.student_id JOIN residential_rooms r ON r.id = t.room_id
        WHERE t.ends_on IS NOT NULL ORDER BY t.ends_on DESC, t.id LIMIT 40)
      ORDER BY endsOn, roomName, studentNo`),
  ]);
  return { rooms: rooms!.results as Room[], stays: stays!.results as Stay[] };
}

export async function saveRoom(db: D1Database, actor: string, form: FormData): Promise<Result<string>> {
  const id = text(form, 'roomId', 40);
  const name = text(form, 'name', 80);
  const capacity = wholeNumber(form.get('capacity'));
  if (name.length < 2 || capacity === null || capacity < 1 || capacity > 200) return { ok: false, error: 'room' };
  const roomId = id || newId('room');
  const result = id ? await db.prepare(`UPDATE residential_rooms SET name = ?1, capacity = ?2 WHERE id = ?3
    AND ?2 >= (SELECT count(*) FROM residential_stays WHERE room_id = ?3 AND ends_on IS NULL)
    AND NOT EXISTS (SELECT 1 FROM residential_rooms WHERE id <> ?3 AND name = ?1)`).bind(name, capacity, id).run()
    : await db.prepare('INSERT INTO residential_rooms (id, name, capacity, created_by) VALUES (?, ?, ?, ?) ON CONFLICT (name) DO NOTHING').bind(roomId, name, capacity, actor).run();
  if (!result.meta.changes) return { ok: false, error: 'room' };
  await log(db, actor, 'school.residence.room', `residential_room:${roomId}`, { name, capacity });
  return { ok: true, value: roomId };
}

export async function placeResident(db: D1Database, actor: string, form: FormData, today: string): Promise<Result<string>> {
  const roomId = text(form, 'roomId', 40);
  const studentNo = parseStudentNo(text(form, 'studentNo', 24));
  const id = newId('stay');
  if (!studentNo || !roomId) return { ok: false, error: 'stay' };
  const result = await db.prepare(`INSERT INTO residential_stays (id, student_id, room_id, starts_on, placed_by)
    SELECT ?1, s.id, r.id, ?2, ?3 FROM offline_students s JOIN residential_rooms r ON r.id = ?4
    WHERE s.student_no = ?5 AND s.status = 'active'
    AND EXISTS (SELECT 1 FROM offline_enrollments e WHERE e.student_id = s.id AND e.status = 'active')
    AND NOT EXISTS (SELECT 1 FROM residential_stays WHERE student_id = s.id AND (ends_on IS NULL OR ends_on > ?2))
    AND r.capacity > (SELECT count(*) FROM residential_stays WHERE room_id = r.id AND ends_on IS NULL)
    ON CONFLICT DO NOTHING RETURNING student_id AS studentId`).bind(id, today, actor, roomId, studentNo).first<{ studentId: string }>();
  if (!result) return { ok: false, error: 'stay' };
  await log(db, actor, 'school.residence.place', `offline_student:${result.studentId}`, { id, roomId });
  return { ok: true, value: id };
}

export async function releaseResident(db: D1Database, actor: string, id: string, today: string): Promise<Result<string>> {
  const result = await db.prepare('UPDATE residential_stays SET ends_on = ?, released_by = ? WHERE id = ? AND ends_on IS NULL AND starts_on <= ? RETURNING student_id AS studentId')
    .bind(today, actor, id, today).first<{ studentId: string }>();
  if (!result) return { ok: false, error: 'stay' };
  await log(db, actor, 'school.residence.release', `offline_student:${result.studentId}`, { id });
  return { ok: true, value: id };
}

export async function billResidence(db: D1Database, actor: string, form: FormData, today: string): Promise<Result<string>> {
  const stayId = text(form, 'stayId', 40);
  const enrollmentId = text(form, 'enrollmentId', 40);
  const period = text(form, 'period', 7);
  const due = text(form, 'dueDate', 10);
  const amount = parseTaka(form.get('amount'));
  if (form.get('confirm') !== 'yes' || amount === null || amount < 1 || amount > 10_000_000 || !isYmd(due) || due < today ||
      !/^\d{4}-(0[1-9]|1[0-2])$/.test(period)) return { ok: false, error: 'bill' };
  const id = newId('chg');
  const row = await db.prepare(`INSERT INTO offline_charges (id, enrollment_id, kind, label, amount_minor, due_date, source_key, created_by)
    SELECT ?1, e.id, 'other', 'আবাসিক ফি · ' || ?2, ?3, ?4, 'residence:' || s.student_id || ':' || ?2, ?5
    FROM residential_stays s JOIN offline_enrollments e ON e.student_id = s.student_id AND e.id = ?6 AND e.status = 'active'
    WHERE s.id = ?7 AND substr(s.starts_on, 1, 7) <= ?2 AND (s.ends_on IS NULL OR substr(s.ends_on, 1, 7) >= ?2)
    AND NOT EXISTS (SELECT 1 FROM enrollment_assistance a WHERE a.enrollment_id = e.id AND a.kind = 'zakat' AND a.revoked_at IS NULL)
    AND NOT EXISTS (SELECT 1 FROM offline_charges x WHERE x.source_key = 'residence:' || s.student_id || ':' || ?2 AND x.voided_at IS NULL)
    ON CONFLICT DO NOTHING RETURNING id`).bind(id, period, amount * 100, due, actor, enrollmentId, stayId).first<{ id: string }>();
  if (!row) return { ok: false, error: 'bill' };
  await log(db, actor, 'school.residence.bill', `offline_enrollment:${enrollmentId}`, { stayId, chargeId: id, period, amount });
  return { ok: true, value: id };
}

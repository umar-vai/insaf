import { env } from 'cloudflare:workers';
import { beforeEach, describe, expect, it } from 'vitest';
import { changePassword, grantPasswordLogin, hashPassword, phoneEmail, signInWithPassword, verifyPassword } from '../src/server/password';
import { offlineIdsForEmail, teacherForEmail } from '../src/server/panels';

const db = env.DB;
const ACTOR = 'office@example.org';

beforeEach(async () => {
  await db.batch([
    db.prepare('DELETE FROM admin_events'),
    db.prepare('DELETE FROM students'),
    db.prepare('DELETE FROM offline_students'),
    db.prepare('DELETE FROM teachers'),
    db.prepare(
      `INSERT INTO offline_students (id, name, phone, guardian_phone, email, student_no) VALUES
         ('os_1', 'Abdullah', '01711111111', '', '', 1),
         ('os_2', 'Abdur Rahman', '01711111111', '', '', 2),
         ('os_3', 'Kid', 'none', '01811111111', '', 3),
         ('os_4', 'Gmail kid', '01911111111', '', 'kid@gmail.com', 4)`,
    ),
    db.prepare(`INSERT INTO teachers (id, name, phone, email) VALUES ('t_1', 'Ustaz', '01611111111', '')`),
  ]);
});

describe('passwords', () => {
  it('hashes with a salt and checks without leaking', async () => {
    const h = await hashPassword('secret12');
    expect(h).toMatch(/^pbkdf2\$100000\$/);
    expect(h).not.toBe(await hashPassword('secret12'));
    expect(await verifyPassword('secret12', h)).toBe(true);
    expect(await verifyPassword('secret13', h)).toBe(false);
    expect(await verifyPassword('secret12', 'garbage')).toBe(false);
    expect(await verifyPassword('secret12', null)).toBe(false);
  });
});

describe('mobile number login', () => {
  it('lets the office switch it on for a student; brothers share the guardian number', async () => {
    const one = await grantPasswordLogin(db, ACTOR, 'student', 'os_1');
    if (!one.ok) throw new Error(one.reason);
    expect(one.login).toBe('01711111111');
    // The brother's record gets the same sign-in identity, so one login shows both.
    const two = await grantPasswordLogin(db, ACTOR, 'student', 'os_2');
    if (!two.ok) throw new Error(two.reason);
    expect(await offlineIdsForEmail(db, phoneEmail('01711111111'))).toEqual(['os_1', 'os_2']);
    // The newer password replaced the older one.
    expect(await signInWithPassword(db, '01711111111', one.password)).toBeNull();
    const id = await signInWithPassword(db, '০১৭১১-১১১১১১', two.password);
    expect(id).toBeTruthy();
    expect(await signInWithPassword(db, '+8801711111111', two.password)).toBe(id);
    expect(await signInWithPassword(db, '01711111111', 'wrong')).toBeNull();
    expect(await signInWithPassword(db, '01799999999', two.password)).toBeNull();
  });

  it('uses the guardian number when the student has none, and refuses without any', async () => {
    const r = await grantPasswordLogin(db, ACTOR, 'student', 'os_3');
    expect(r.ok && r.login).toBe('01811111111');
    await db.prepare(`UPDATE offline_students SET phone = 'x', guardian_phone = '', email = '' WHERE id = 'os_3'`).run();
    expect(await grantPasswordLogin(db, ACTOR, 'student', 'os_3')).toEqual({ ok: false, reason: 'phone' });
    expect(await grantPasswordLogin(db, ACTOR, 'student', 'missing')).toEqual({ ok: false, reason: 'not_found' });
  });

  it('keeps a Gmail record on its Gmail and still allows a password', async () => {
    const r = await grantPasswordLogin(db, ACTOR, 'student', 'os_4');
    if (!r.ok) throw new Error(r.reason);
    expect(r.login).toBe('kid@gmail.com');
    expect(await signInWithPassword(db, 'KID@gmail.com', r.password)).toBeTruthy();
  });

  it('opens the teacher panel for a teacher', async () => {
    const r = await grantPasswordLogin(db, ACTOR, 'teacher', 't_1');
    if (!r.ok) throw new Error(r.reason);
    expect((await teacherForEmail(db, phoneEmail('01611111111')))?.id).toBe('t_1');
    expect(await signInWithPassword(db, '01611111111', r.password)).toBeTruthy();
  });

  it('changes a password only with the current one', async () => {
    const r = await grantPasswordLogin(db, ACTOR, 'teacher', 't_1');
    if (!r.ok) throw new Error(r.reason);
    const id = (await signInWithPassword(db, '01611111111', r.password))!;
    expect(await changePassword(db, id, 'nope', 'newpass1')).toBe('wrong');
    expect(await changePassword(db, id, r.password, '123')).toBe('weak');
    expect(await changePassword(db, id, r.password, 'newpass1')).toBe('ok');
    expect(await signInWithPassword(db, '01611111111', 'newpass1')).toBe(id);
  });
});

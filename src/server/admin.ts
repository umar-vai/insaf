import { requestIp } from './request-context';
import { grantsText, isEmail, ownerEmails, parseGrants, parseModules, ROLES, scopeModules, scopeOf, STAFF_SCOPES, type AreaChoice, type Grants, type Module, type Role, type StaffEnv, type StaffScope } from './staff';

// Admin reads and changes. Every change is written to admin_events with the
// staff email that made it.

export async function log(db: D1Database, actor: string, action: string, target: string, detail: Record<string, unknown> = {}) {
  await db
    .prepare('INSERT INTO admin_events (id, actor, action, target, detail_json, ip) VALUES (?, ?, ?, ?, ?, ?)')
    .bind(`ae_${crypto.randomUUID()}`, actor, action, target, JSON.stringify(detail).slice(0, 2000), requestIp())
    .run();
}

/** A web address part from a title; Bangla titles get a short random one. */
export function slugify(title: string, prefix = 'post'): string {
  const s = title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80)
    .replace(/-+$/, '');
  return s.length >= 3 ? s : `${prefix}-${crypto.randomUUID().slice(0, 6)}`;
}

// ---- Team -----------------------------------------------------------------

export async function listTeam(db: D1Database, env: StaffEnv) {
  const { results } = await db
    .prepare('SELECT email, added_by AS addedBy, scope, modules, name, role, area, created_at AS createdAt FROM staff ORDER BY created_at')
    .all<{ email: string; addedBy: string; scope: StaffScope; modules: string; name: string; role: Role; area: AreaChoice; createdAt: string }>();
  return {
    owners: ownerEmails(env),
    staff: results.map((r) => {
      const grants: Grants = r.modules || (r.role && r.role !== 'custom') ? parseGrants(r.modules) : Object.fromEntries(scopeModules(isScope(r.scope) ? r.scope : 'online').map((m) => [m, 'edit']));
      return { ...r, grants, moduleList: Object.keys(grants) as Module[] };
    }),
  };
}

const isScope = (v: string): v is StaffScope => (STAFF_SCOPES as readonly string[]).includes(v);

export async function addStaff(
  db: D1Database,
  env: StaffEnv,
  actor: string,
  raw: string,
  scope: string = 'all',
): Promise<'added' | 'exists' | 'invalid'> {
  const email = raw.trim().toLowerCase();
  if (!isEmail(email) || !isScope(scope)) return 'invalid';
  if (ownerEmails(env).includes(email)) return 'exists';
  const r = await db.prepare('INSERT OR IGNORE INTO staff (email, added_by, scope) VALUES (?, ?, ?)').bind(email, actor, scope).run();
  if (r.meta.changes) await log(db, actor, 'staff.add', `staff:${email}`, { scope });
  return r.meta.changes ? 'added' : 'exists';
}

/** Changes which part of the admin a team member may use. Owners always have all of it. */
export async function setStaffScope(db: D1Database, env: StaffEnv, actor: string, raw: string, scope: string): Promise<boolean> {
  const email = raw.trim().toLowerCase();
  if (!isScope(scope) || ownerEmails(env).includes(email)) return false;
  const before = await db.prepare('SELECT scope FROM staff WHERE email = ?').bind(email).first<{ scope: string }>();
  if (!before) return false;
  if (before.scope === scope) return true;
  await db.prepare(`UPDATE staff SET scope = ?, modules = '' WHERE email = ?`).bind(scope, email).run();
  await log(db, actor, 'staff.scope', `staff:${email}`, { from: before.scope, to: scope });
  return true;
}

/** Gives a team member exactly these modules (at least one). Owners always have all of them. */
export async function setStaffModules(db: D1Database, env: StaffEnv, actor: string, raw: string, modules: readonly string[]): Promise<boolean> {
  const email = raw.trim().toLowerCase();
  const list = parseModules(modules.join(','));
  if (!list.length || ownerEmails(env).includes(email)) return false;
  const before = await db.prepare('SELECT scope, modules FROM staff WHERE email = ?').bind(email).first<{ scope: string; modules: string }>();
  if (!before) return false;
  const value = list.join(',');
  if (before.modules === value) return true;
  await db.prepare('UPDATE staff SET modules = ?, scope = ? WHERE email = ?').bind(value, scopeOf(list), email).run();
  await log(db, actor, 'staff.modules', `staff:${email}`, { from: before.modules || `scope:${before.scope}`, to: value });
  return true;
}

/** Adds a team member with chosen modules. */
export async function addStaffWithModules(db: D1Database, env: StaffEnv, actor: string, raw: string, modules: readonly string[]): Promise<'added' | 'exists' | 'invalid'> {
  const list: Module[] = parseModules(modules.join(','));
  if (!list.length) return 'invalid';
  const r = await addStaff(db, env, actor, raw, scopeOf(list));
  if (r === 'added') await db.prepare('UPDATE staff SET modules = ? WHERE email = ?').bind(list.join(','), raw.trim().toLowerCase()).run();
  return r;
}

/** Owners and the person doing it cannot be removed here. */
export async function removeStaff(db: D1Database, env: StaffEnv, actor: string, raw: string): Promise<boolean> {
  const email = raw.trim().toLowerCase();
  if (email === actor.toLowerCase() || ownerEmails(env).includes(email)) return false;
  const r = await db.prepare('DELETE FROM staff WHERE email = ?').bind(email).run();
  if (r.meta.changes) await log(db, actor, 'staff.remove', `staff:${email}`);
  return r.meta.changes > 0;
}

export async function recentActivity(db: D1Database, limit = 20) {
  const { results } = await db
    .prepare('SELECT actor, action, target, created_at AS createdAt FROM admin_events ORDER BY created_at DESC LIMIT ?')
    .bind(limit)
    .all<{ actor: string; action: string; target: string; createdAt: string }>();
  return results;
}

// ---- Team member access: role, part, level per module ---------------------------

export type AccessInput = { name: string; role: Role; area: AreaChoice; grants: Grants; phone?: string };

export function parseAccessForm(form: FormData, grants: Grants): AccessInput {
  const role = String(form.get('role') ?? 'custom') as Role;
  const area = String(form.get('area') ?? 'both') as AreaChoice;
  return {
    name: String(form.get('name') ?? '').trim().slice(0, 120),
    role: ROLES.includes(role) ? role : 'custom',
    area: area === 'online' || area === 'offline' ? area : 'both',
    grants,
    phone: String(form.get('phone') ?? '').trim().slice(0, 30),
  };
}

/**
 * A teacher on the team also gets a row in the teachers list (by Gmail), so
 * the teacher panel opens for them. An existing teacher with that email is
 * left as it is.
 */
async function ensureTeacher(db: D1Database, actor: string, email: string, name: string, phone: string) {
  const found = await db.prepare('SELECT id FROM teachers WHERE lower(email) = lower(?)').bind(email).first<{ id: string }>();
  if (found) return found.id;
  const id = `tch_${crypto.randomUUID().replace(/-/g, '').slice(0, 16)}`;
  await db
    .prepare(`INSERT INTO teachers (id, name, phone, email, role) VALUES (?, ?, ?, ?, 'teacher')`)
    .bind(id, name || email.split('@')[0], phone.replace(/[^0-9+]/g, ''), email)
    .run();
  await log(db, actor, 'teacher.create', `teacher:${id}`, { name: name || email, from: 'team' });
  return id;
}

/**
 * Adds a team member with a role, a part and a level per module. A teacher
 * may have no admin module at all (teacher panel only); anyone else needs
 * at least one.
 */
export async function addTeamMember(db: D1Database, env: StaffEnv, actor: string, raw: string, v: AccessInput): Promise<'added' | 'exists' | 'invalid'> {
  const email = raw.trim().toLowerCase();
  const text = grantsText(v.grants);
  if (!isEmail(email) || (!text && v.role !== 'teacher')) return 'invalid';
  if (ownerEmails(env).includes(email)) return 'exists';
  const modules = Object.keys(v.grants) as Module[];
  const r = await db
    .prepare('INSERT OR IGNORE INTO staff (email, added_by, scope, modules, name, role, area) VALUES (?, ?, ?, ?, ?, ?, ?)')
    .bind(email, actor, scopeOf(modules), text, v.name, v.role, v.area)
    .run();
  if (!r.meta.changes) return 'exists';
  await log(db, actor, 'staff.add', `staff:${email}`, { role: v.role, area: v.area, modules: text });
  if (v.role === 'teacher') await ensureTeacher(db, actor, email, v.name, v.phone ?? '');
  return 'added';
}

/** Changes a member's role, part and levels. Owners cannot be changed here. */
export async function setTeamAccess(db: D1Database, env: StaffEnv, actor: string, raw: string, v: AccessInput): Promise<boolean> {
  const email = raw.trim().toLowerCase();
  const text = grantsText(v.grants);
  if (ownerEmails(env).includes(email) || (!text && v.role !== 'teacher')) return false;
  const before = await db.prepare('SELECT modules, role, area, name FROM staff WHERE email = ?').bind(email).first<{ modules: string; role: string; area: string; name: string }>();
  if (!before) return false;
  const modules = Object.keys(v.grants) as Module[];
  await db
    .prepare('UPDATE staff SET modules = ?, scope = ?, role = ?, area = ?, name = ? WHERE email = ?')
    .bind(text, scopeOf(modules), v.role, v.area, v.name || before.name, email)
    .run();
  await log(db, actor, 'staff.access', `staff:${email}`, { from: { role: before.role, area: before.area, modules: before.modules }, to: { role: v.role, area: v.area, modules: text } });
  if (v.role === 'teacher') await ensureTeacher(db, actor, email, v.name || before.name, v.phone ?? '');
  return true;
}

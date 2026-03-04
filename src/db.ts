import Database from "better-sqlite3";

const db = new Database("sborbot.db");
db.pragma("journal_mode = WAL");

// Schema versioning
const SCHEMA_VERSION = 2;
db.exec(`CREATE TABLE IF NOT EXISTS _schema (version INTEGER NOT NULL DEFAULT 0)`);
const schemaRow = db.prepare("SELECT version FROM _schema").get() as { version: number } | undefined;
if (!schemaRow) {
  db.prepare("INSERT INTO _schema (version) VALUES (?)").run(SCHEMA_VERSION);
} else if (schemaRow.version < SCHEMA_VERSION) {
  db.exec(`DROP TABLE IF EXISTS payments; DROP TABLE IF EXISTS collections;`);
  db.prepare("UPDATE _schema SET version = ?").run(SCHEMA_VERSION);
}

db.exec(`
  CREATE TABLE IF NOT EXISTS groups (
    group_id INTEGER PRIMARY KEY,
    title TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS collections (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    group_id INTEGER NOT NULL,
    admin_id INTEGER NOT NULL,
    title TEXT NOT NULL,
    message TEXT NOT NULL DEFAULT '',
    total_amount REAL NOT NULL DEFAULT 0,
    member_count INTEGER NOT NULL DEFAULT 0,
    per_person REAL NOT NULL DEFAULT 0,
    details TEXT NOT NULL DEFAULT '',
    deadline TEXT,
    status TEXT DEFAULT 'active',
    created_at TEXT DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS members (
    user_id INTEGER NOT NULL,
    group_id INTEGER NOT NULL,
    first_name TEXT,
    username TEXT,
    active INTEGER DEFAULT 1,
    PRIMARY KEY (user_id, group_id)
  );

  CREATE TABLE IF NOT EXISTS payments (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    collection_id INTEGER NOT NULL REFERENCES collections(id),
    user_id INTEGER NOT NULL,
    file_id TEXT,
    status TEXT DEFAULT 'pending',
    reject_reason TEXT,
    created_at TEXT DEFAULT (datetime('now'))
  );
`);

// --- Types ---

export type Collection = {
  id: number; group_id: number; admin_id: number;
  title: string; message: string; total_amount: number;
  member_count: number; per_person: number; details: string;
  deadline: string | null; status: string; created_at: string;
};

export type Member = {
  user_id: number; group_id: number;
  first_name: string; username: string | null; active: number;
};

export type Payment = {
  id: number; collection_id: number; user_id: number;
  file_id: string | null; status: string;
  reject_reason: string | null; created_at: string;
};

// --- Groups ---

const _upsertGroup = db.prepare(`
  INSERT INTO groups (group_id, title) VALUES (?, ?)
  ON CONFLICT(group_id) DO UPDATE SET title = excluded.title
`);
export function upsertGroup(groupId: number, title: string) {
  _upsertGroup.run(groupId, title);
}

const _getGroups = db.prepare(`SELECT * FROM groups`);
export function getGroups() {
  return _getGroups.all() as { group_id: number; title: string }[];
}

// --- Collections ---

const _createCollection = db.prepare(`
  INSERT INTO collections (group_id, admin_id, title, message, total_amount, member_count, per_person, details, deadline)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
`);
export function createCollection(
  groupId: number, adminId: number, title: string, message: string,
  totalAmount: number, memberCount: number, perPerson: number,
  details: string, deadline?: string,
) {
  return _createCollection.run(groupId, adminId, title, message, totalAmount, memberCount, perPerson, details, deadline ?? null);
}

const _getActiveCollection = db.prepare(
  `SELECT * FROM collections WHERE group_id = ? AND status = 'active' ORDER BY id DESC LIMIT 1`
);
export function getActiveCollection(groupId: number) {
  return _getActiveCollection.get(groupId) as Collection | undefined;
}

const _getCollectionById = db.prepare(`SELECT * FROM collections WHERE id = ?`);
export function getCollectionById(id: number) {
  return _getCollectionById.get(id) as Collection | undefined;
}

const _getActiveCollections = db.prepare(`SELECT * FROM collections WHERE status = 'active'`);
export function getActiveCollections() {
  return _getActiveCollections.all() as Collection[];
}

const _getActiveCollectionsWithDeadline = db.prepare(
  `SELECT * FROM collections WHERE status = 'active' AND deadline IS NOT NULL`
);
export function getActiveCollectionsWithDeadline() {
  return _getActiveCollectionsWithDeadline.all() as Collection[];
}

const _closeCollection = db.prepare(`UPDATE collections SET status = 'closed' WHERE id = ?`);
export function closeCollection(id: number) {
  _closeCollection.run(id);
}

// --- Members ---

const _upsertMember = db.prepare(`
  INSERT INTO members (user_id, group_id, first_name, username, active)
  VALUES (?, ?, ?, ?, 1)
  ON CONFLICT(user_id, group_id) DO UPDATE SET
    first_name = excluded.first_name,
    username = COALESCE(excluded.username, members.username),
    active = 1
`);
export function upsertMember(userId: number, groupId: number, firstName: string, username?: string) {
  _upsertMember.run(userId, groupId, firstName, username ?? null);
}

const _deactivateMember = db.prepare(`UPDATE members SET active = 0 WHERE user_id = ? AND group_id = ?`);
export function deactivateMember(userId: number, groupId: number) {
  _deactivateMember.run(userId, groupId);
}

const _getActiveMembers = db.prepare(`SELECT * FROM members WHERE group_id = ? AND active = 1`);
export function getActiveMembers(groupId: number) {
  return _getActiveMembers.all(groupId) as Member[];
}

const _getMemberByUsername = db.prepare(`SELECT * FROM members WHERE username = ? AND group_id = ? AND active = 1`);
export function getMemberByUsername(username: string, groupId: number) {
  return _getMemberByUsername.get(username, groupId) as Member | undefined;
}

const _getMemberByUserId = db.prepare(`SELECT * FROM members WHERE user_id = ? AND group_id = ? AND active = 1`);
export function getMemberByUserId(userId: number, groupId: number) {
  return _getMemberByUserId.get(userId, groupId) as Member | undefined;
}

// --- Payments ---

const _addPayment = db.prepare(`INSERT INTO payments (collection_id, user_id, file_id) VALUES (?, ?, ?)`);
export function addPayment(collectionId: number, userId: number, fileId: string) {
  return _addPayment.run(collectionId, userId, fileId);
}

const _getPayment = db.prepare(
  `SELECT * FROM payments WHERE collection_id = ? AND user_id = ? ORDER BY id DESC LIMIT 1`
);
export function getPayment(collectionId: number, userId: number) {
  return _getPayment.get(collectionId, userId) as Payment | undefined;
}

const _updatePaymentStatus = db.prepare(`
  UPDATE payments SET status = ?, reject_reason = ?
  WHERE collection_id = ? AND user_id = ? AND id = (
    SELECT id FROM payments WHERE collection_id = ? AND user_id = ? ORDER BY id DESC LIMIT 1
  )
`);
export function updatePaymentStatus(collectionId: number, userId: number, status: string, rejectReason?: string) {
  _updatePaymentStatus.run(status, rejectReason ?? null, collectionId, userId, collectionId, userId);
}

// --- Collection Status (3 categories) ---

export function getCollectionStatus(collectionId: number) {
  const collection = getCollectionById(collectionId);
  if (!collection) return { paid: [] as Member[], pending: [] as Member[], unpaid: [] as Member[] };

  const members = getActiveMembers(collection.group_id);
  const nonAdmin = members.filter((m) => m.user_id !== collection.admin_id);

  const paid: Member[] = [];
  const pending: Member[] = [];
  const unpaid: Member[] = [];

  for (const m of nonAdmin) {
    const p = getPayment(collectionId, m.user_id);
    if (p?.status === "confirmed") paid.push(m);
    else if (p?.status === "pending") pending.push(m);
    else unpaid.push(m);
  }

  return { paid, pending, unpaid };
}

// --- Find active collections for a user ---

const _getActiveCollectionsForUser = db.prepare(`
  SELECT c.* FROM collections c
  JOIN members m ON m.group_id = c.group_id AND m.user_id = ? AND m.active = 1
  WHERE c.status = 'active'
`);
export function getActiveCollectionsForUser(userId: number) {
  return _getActiveCollectionsForUser.all(userId) as Collection[];
}

export { db };

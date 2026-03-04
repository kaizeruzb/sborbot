import Database from "better-sqlite3";

const db = new Database("sborbot.db");
db.pragma("journal_mode = WAL");

db.exec(`
  CREATE TABLE IF NOT EXISTS collections (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    group_id INTEGER NOT NULL,
    admin_id INTEGER NOT NULL,
    title TEXT NOT NULL,
    amount TEXT NOT NULL,
    details TEXT NOT NULL,
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

// --- Collections ---

const _createCollection = db.prepare(`
  INSERT INTO collections (group_id, admin_id, title, amount, details, deadline)
  VALUES (?, ?, ?, ?, ?, ?)
`);

export function createCollection(
  groupId: number,
  adminId: number,
  title: string,
  amount: string,
  details: string,
  deadline?: string,
) {
  return _createCollection.run(groupId, adminId, title, amount, details, deadline ?? null);
}

const _getActiveCollection = db.prepare(`
  SELECT * FROM collections WHERE group_id = ? AND status = 'active' ORDER BY id DESC LIMIT 1
`);

export function getActiveCollection(groupId: number) {
  return _getActiveCollection.get(groupId) as
    | { id: number; group_id: number; admin_id: number; title: string; amount: string; details: string; deadline: string | null; status: string; created_at: string }
    | undefined;
}

const _getCollectionById = db.prepare(`SELECT * FROM collections WHERE id = ?`);

export function getCollectionById(collectionId: number) {
  return _getCollectionById.get(collectionId) as ReturnType<typeof getActiveCollection>;
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

const _deactivateMember = db.prepare(`
  UPDATE members SET active = 0 WHERE user_id = ? AND group_id = ?
`);

export function deactivateMember(userId: number, groupId: number) {
  _deactivateMember.run(userId, groupId);
}

const _getActiveMembers = db.prepare(`
  SELECT * FROM members WHERE group_id = ? AND active = 1
`);

export function getActiveMembers(groupId: number) {
  return _getActiveMembers.all(groupId) as { user_id: number; group_id: number; first_name: string; username: string | null; active: number }[];
}

// --- Payments ---

const _addPayment = db.prepare(`
  INSERT INTO payments (collection_id, user_id, file_id) VALUES (?, ?, ?)
`);

export function addPayment(collectionId: number, userId: number, fileId: string) {
  return _addPayment.run(collectionId, userId, fileId);
}

const _getPayment = db.prepare(`
  SELECT * FROM payments WHERE collection_id = ? AND user_id = ? ORDER BY id DESC LIMIT 1
`);

export function getPayment(collectionId: number, userId: number) {
  return _getPayment.get(collectionId, userId) as
    | { id: number; collection_id: number; user_id: number; file_id: string | null; status: string; reject_reason: string | null; created_at: string }
    | undefined;
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

// --- Collection Status ---

export function getCollectionStatus(collectionId: number) {
  const collection = getCollectionById(collectionId);
  if (!collection) return { paid: [], unpaid: [] };

  const members = getActiveMembers(collection.group_id);
  // Exclude the admin from the collection status
  const nonAdminMembers = members.filter((m) => m.user_id !== collection.admin_id);

  const paid: typeof nonAdminMembers = [];
  const unpaid: typeof nonAdminMembers = [];

  for (const member of nonAdminMembers) {
    const payment = getPayment(collectionId, member.user_id);
    if (payment && payment.status === "confirmed") {
      paid.push(member);
    } else {
      unpaid.push(member);
    }
  }

  return { paid, unpaid };
}

const _closeCollection = db.prepare(`
  UPDATE collections SET status = 'closed' WHERE id = ?
`);

export function closeCollection(collectionId: number) {
  _closeCollection.run(collectionId);
}

// --- Deadline queries ---

const _getActiveCollectionsWithDeadline = db.prepare(`
  SELECT * FROM collections WHERE status = 'active' AND deadline IS NOT NULL
`);

export function getActiveCollectionsWithDeadline() {
  return _getActiveCollectionsWithDeadline.all() as NonNullable<ReturnType<typeof getActiveCollection>>[];
}

const _getMemberByUsername = db.prepare(`
  SELECT * FROM members WHERE username = ? AND group_id = ? AND active = 1
`);

export function getMemberByUsername(username: string, groupId: number) {
  return _getMemberByUsername.get(username, groupId) as ReturnType<typeof getActiveMembers>[number] | undefined;
}

const _getMemberByUserId = db.prepare(`
  SELECT * FROM members WHERE user_id = ? AND group_id = ? AND active = 1
`);

export function getMemberByUserId(userId: number, groupId: number) {
  return _getMemberByUserId.get(userId, groupId) as ReturnType<typeof getActiveMembers>[number] | undefined;
}

export { db };

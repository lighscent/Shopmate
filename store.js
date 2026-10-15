const bcrypt = require('bcryptjs');
const { db } = require('./db');

// Invites (famille + listes) : 30 min max, usage unique
const INVITE_TTL = `datetime('now', '-30 minutes')`;

// ---- tiny query helpers ----
const get = (sql, ...params) => db.prepare(sql).get(...params);
const all = (sql, ...params) => db.prepare(sql).all(...params);
const run = (sql, ...params) => db.prepare(sql).run(...params);
const normEmail = (email) => (email || '').trim().toLowerCase();

// ---- ids ----
const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 9);
const ID_CHARS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
const shortId = (length = 6) => Array.from({ length }, () => ID_CHARS.charAt(Math.floor(Math.random() * ID_CHARS.length))).join('');

// ---- users ----
function createUser(email, password) {
  if (get('SELECT email FROM users WHERE email = ?', email)) return null;
  run('INSERT INTO users (email, password) VALUES (?, ?)', email, bcrypt.hashSync(password, 10));
  return { email, pseudo: '' };
}

function getUserByEmail(email) {
  return get('SELECT email, pseudo FROM users WHERE email = ?', email) || null;
}

function verifyUser(email, password) {
  const user = get('SELECT * FROM users WHERE email = ?', email);
  return !!user && bcrypt.compareSync(password, user.password);
}

function setPseudo(email, pseudo) {
  if (!get('SELECT email FROM users WHERE email = ?', email)) return null;
  run('UPDATE users SET pseudo = ? WHERE email = ?', pseudo, email);
  return { email, pseudo };
}

function updatePassword(email, newPassword) {
  run('UPDATE users SET password = ? WHERE email = ?', bcrypt.hashSync(newPassword, 10), email);
  return true;
}

function deleteUser(email) {
  for (const l of all('SELECT id FROM lists WHERE created_by = ?', email)) {
    run('DELETE FROM items WHERE list_id = ?', l.id);
    run('DELETE FROM list_members WHERE list_id = ?', l.id);
    run('DELETE FROM lists WHERE id = ?', l.id);
  }
  run('DELETE FROM list_members WHERE user_email = ?', email);
  run('DELETE FROM article_info WHERE user_email = ?', email);
  run('DELETE FROM pseudo_changes WHERE user_email = ?', email);
  run('DELETE FROM family_members WHERE owner_email = ? OR member_email = ?', email, email);
  run('DELETE FROM family_invites WHERE owner_email = ?', email);
  run('DELETE FROM users WHERE email = ?', email);
  try {
    for (const r of all('SELECT sid, data FROM sessions')) {
      try { if (JSON.parse(r.data).userEmail === email) run('DELETE FROM sessions WHERE sid = ?', r.sid); } catch {}
    }
  } catch {}
  return true;
}

// ---- pseudo quotas ----
const PSEUDO_MAX_PER_WEEK = 2;
const PSEUDO_MIN_GAP_MIN = 15;

function getPseudoChangeStatus(email) {
  const row = get(`SELECT COUNT(*) AS count7d, MAX(changed_at) AS last, (strftime('%s','now') - strftime('%s', MAX(changed_at))) / 60.0 AS minsSinceLast FROM pseudo_changes WHERE user_email = ? AND changed_at > datetime('now', '-7 days')`, email);
  const count7d = row ? row.count7d : 0;
  return { count7d, remaining: Math.max(0, PSEUDO_MAX_PER_WEEK - count7d), minsSinceLast: row && row.minsSinceLast != null ? row.minsSinceLast : null };
}

function recordPseudoChange(email) {
  run(`DELETE FROM pseudo_changes WHERE user_email = ? AND changed_at <= datetime('now', '-7 days')`, email);
  run('INSERT INTO pseudo_changes (user_email) VALUES (?)', email);
}

// ---- lists ----
function touchList(listId) {
  run('UPDATE lists SET updated_at = CURRENT_TIMESTAMP WHERE id = ?', listId);
}

function hydrateItems(list, sort) {
  if (!list) return null;
  const order = sort === 'updated' ? 'updated_at DESC' : 'created_at ASC';
  list.items = all(`SELECT id, name, quantity, checked, added_by AS addedBy FROM items WHERE list_id = ? ORDER BY ${order}`, list.id);
  list.items.forEach((item) => { item.checked = !!item.checked; });
  return list;
}

function createList(name, createdBy, shareWith) {
  const id = shortId();
  run('INSERT INTO lists (id, name, created_by, updated_at) VALUES (?, ?, ?, CURRENT_TIMESTAMP)', id, name, createdBy || null);
  if (createdBy) {
    addMember(id, createdBy);
    if (shareWith === undefined) {
      // legacy (vieux clients sans champ share) : auto-partage avec ma famille
      for (const m of getFamilyMembers(createdBy)) addMember(id, m.email, m.canEdit);
    } else if (shareWith === 'self') {
      for (const m of getFamilyMembers(createdBy)) addMember(id, m.email, m.canEdit);
    } else if (shareWith) {
      // partage avec la famille d'un autre : owner + membres (droits de chacun conservés)
      addMember(id, shareWith, 1);
      for (const m of getFamilyMembers(shareWith)) { if (m.email !== createdBy) addMember(id, m.email, m.canEdit); }
    }
    // shareWith '' ou falsy : liste perso, créateur seul
  }
  return getList(id);
}

function getListsByUser(email, sort, dir) {
  const col = sort === 'created' ? 'l.created_at' : 'l.updated_at';
  const d = dir === 'asc' ? 'ASC' : 'DESC';
  return all(`SELECT l.id, l.name, l.updated_at, l.created_by, COALESCE(MAX(lm.can_edit), 1) AS can_edit, (SELECT COUNT(*) FROM items WHERE list_id = l.id) AS item_count, (SELECT COUNT(*) FROM items WHERE list_id = l.id AND checked = 1) AS checked_count FROM lists l LEFT JOIN list_members lm ON lm.list_id = l.id WHERE l.created_by = ? OR lm.user_email = ? GROUP BY l.id ORDER BY ${col} ${d}`, email, email);
}

function getList(id, sort) {
  return hydrateItems(get('SELECT * FROM lists WHERE id = ?', id), sort);
}

function getListByShareToken(token) {
  return hydrateItems(get('SELECT * FROM lists WHERE share_token = ?', token));
}

function isListMember(listId, email) {
  const list = get('SELECT created_by FROM lists WHERE id = ?', listId);
  if (!list) return false;
  if (list.created_by === email) return true;
  return !!get('SELECT 1 AS ok FROM list_members WHERE list_id = ? AND user_email = ?', listId, email);
}

// Droit d'écriture : créateur toujours, sinon colonne can_edit (NULL legacy = 1)
function canEditList(listId, email) {
  const list = get('SELECT created_by FROM lists WHERE id = ?', listId);
  if (!list) return false;
  if (list.created_by === email) return true;
  const row = get('SELECT can_edit FROM list_members WHERE list_id = ? AND user_email = ?', listId, email);
  if (!row) return false;
  return row.can_edit == null || row.can_edit === 1;
}

function deleteList(listId, email) {
  const list = get('SELECT created_by FROM lists WHERE id = ?', listId);
  if (!list || list.created_by !== email) return false;
  run('DELETE FROM items WHERE list_id = ?', listId);
  run('DELETE FROM list_members WHERE list_id = ?', listId);
  run('DELETE FROM lists WHERE id = ?', listId);
  return true;
}

// ---- list invites : 30 min, usage unique, créées à la demande ----
function createListInvite(listId) {
  const token = shortId(12);
  run('UPDATE lists SET share_token = ?, share_token_created_at = CURRENT_TIMESTAMP WHERE id = ?', token, listId);
  return token;
}

function getValidListInvite(listId) {
  const row = get(`SELECT share_token AS token FROM lists WHERE id = ? AND share_token IS NOT NULL AND share_token_created_at > ${INVITE_TTL}`, listId);
  return row ? row.token : null;
}

function peekListInvite(token) {
  return hydrateItems(get(`SELECT * FROM lists WHERE share_token = ? AND share_token_created_at > ${INVITE_TTL}`, token));
}

function consumeListInvite(token) {
  const list = peekListInvite(token);
  if (list) run('UPDATE lists SET share_token = NULL, share_token_created_at = NULL WHERE id = ?', list.id);
  return list;
}

// ---- items ----
const findItem = (listId, itemId) => get('SELECT * FROM items WHERE id = ? AND list_id = ?', itemId, listId);
const toClientItem = (i) => ({ id: i.id, name: i.name, quantity: i.quantity, checked: !!i.checked, addedBy: i.added_by });

function addItem(listId, { name, quantity = 1, addedBy = 'Anonyme' }) {
  if (!get('SELECT id FROM lists WHERE id = ?', listId)) return null;
  const existing = get('SELECT id, quantity FROM items WHERE list_id = ? AND LOWER(name) = LOWER(?)', listId, name);
  if (existing) {
    run('UPDATE items SET quantity = quantity + ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?', quantity, existing.id);
    touchList(listId);
    return { id: existing.id, name, quantity: existing.quantity + quantity, checked: false, addedBy };
  }
  const id = uid();
  run('INSERT INTO items (id, list_id, name, quantity, added_by, updated_at) VALUES (?, ?, ?, ?, ?, CURRENT_TIMESTAMP)', id, listId, name, quantity, addedBy);
  touchList(listId);
  return { id, name, quantity, checked: false, addedBy };
}

function changeItemQuantity(listId, itemId, delta) {
  const item = findItem(listId, itemId);
  if (!item) return null;
  if (item.quantity + delta <= 0) {
    run('DELETE FROM items WHERE id = ?', itemId);
    touchList(listId);
    return { deleted: true };
  }
  run('UPDATE items SET quantity = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?', item.quantity + delta, itemId);
  touchList(listId);
  return toClientItem({ ...item, quantity: item.quantity + delta });
}

function toggleItem(listId, itemId) {
  const item = findItem(listId, itemId);
  if (!item) return null;
  run('UPDATE items SET checked = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?', item.checked ? 0 : 1, itemId);
  touchList(listId);
  return { id: item.id, name: item.name, checked: !item.checked, addedBy: item.added_by };
}

function removeItem(listId, itemId) {
  const changed = run('DELETE FROM items WHERE id = ? AND list_id = ?', itemId, listId).changes > 0;
  if (changed) touchList(listId);
  return changed;
}

function clearCheckedItems(listId) {
  const removed = run('DELETE FROM items WHERE list_id = ? AND checked = 1', listId).changes;
  if (removed > 0) touchList(listId);
  return removed;
}

// ---- list members ----
function addMember(listId, email, canEdit = 1) {
  run('INSERT OR IGNORE INTO list_members (list_id, user_email, can_edit) VALUES (?, ?, ?)', listId, email, canEdit ? 1 : 0);
}

function removeMember(listId, email) {
  const list = get('SELECT created_by FROM lists WHERE id = ?', listId);
  if (!list || list.created_by === email) return false;
  run('DELETE FROM list_members WHERE list_id = ? AND user_email = ?', listId, email);
  return true;
}

function getMembers(listId) {
  return all(`SELECT u.email, u.pseudo, lm.joined_at, COALESCE(lm.can_edit, 1) AS canEdit FROM list_members lm JOIN users u ON u.email = lm.user_email WHERE lm.list_id = ? ORDER BY lm.joined_at ASC`, listId);
}

function getRecentItems(email, limit = 15) {
  return all(`SELECT i.id, i.name, i.quantity, i.added_by, i.created_at, l.name AS list_name, l.id AS list_id FROM items i JOIN lists l ON l.id = i.list_id LEFT JOIN list_members lm ON lm.list_id = l.id WHERE l.created_by = ? OR lm.user_email = ? ORDER BY i.created_at DESC LIMIT ?`, email, email, limit);
}

// ---- catalogue articles (100% manuel ; rien n'est alimenté depuis les listes) ----
function getCatalog(email) {
  return all('SELECT display AS name, price FROM article_info WHERE user_email = ? ORDER BY created_at DESC', email);
}
function searchCatalog(email, q) {
  const query = (q || '').trim().toLowerCase();
  if (query.length < 2) return [];
  const esc = query.replace(/\\/g, '\\\\').replace(/%/g, '\\%').replace(/_/g, '\\_');
  return all(`SELECT display AS name, price FROM article_info WHERE user_email = ? AND name LIKE '%' || ? || '%' ESCAPE '\\' ORDER BY updated_at DESC LIMIT 8`, email, esc);
}
function parsePrice(price) {
  const p = price === '' || price == null ? null : Number(price);
  return (p != null && (!isFinite(p) || p < 0)) ? undefined : p;
}
// Ajout manuel : false si invalide, sinon { name, price, isNew }
function addArticle(email, rawName, price) {
  const display = (rawName || '').trim();
  if (!display) return false;
  const p = parsePrice(price);
  if (p === undefined) return false;
  const key = display.toLowerCase();
  const existed = !!get('SELECT 1 AS ok FROM article_info WHERE user_email = ? AND name = ?', email, key);
  run(`INSERT INTO article_info (user_email, name, display, price, manual, updated_at, created_at) VALUES (?, ?, ?, ?, 1, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP) ON CONFLICT(user_email, name) DO UPDATE SET price = excluded.price, manual = 1, updated_at = CURRENT_TIMESTAMP`, email, key, display, p);
  return { name: display, price: p, isNew: !existed };
}
function setArticleInfo(email, rawName, price) {
  const display = (rawName || '').trim();
  if (!display) return false;
  const p = parsePrice(price);
  if (p === undefined) return false;
  run('UPDATE article_info SET price = ?, manual = 1, updated_at = CURRENT_TIMESTAMP WHERE user_email = ? AND name = ?', p, email, display.toLowerCase());
  return true;
}
// Renomme : 'empty' | 'exists' | { name } (nouvel affichage)
function renameArticle(email, oldRaw, newRaw) {
  const oldKey = (oldRaw || '').trim().toLowerCase();
  const display = (newRaw || '').trim();
  if (!oldKey || !display) return 'empty';
  const newKey = display.toLowerCase();
  if (newKey !== oldKey && get('SELECT 1 AS ok FROM article_info WHERE user_email = ? AND name = ?', email, newKey)) return 'exists';
  run('UPDATE article_info SET name = ?, display = ?, manual = 1, updated_at = CURRENT_TIMESTAMP WHERE user_email = ? AND name = ?', newKey, display, email, oldKey);
  return { name: display };
}
function deleteArticle(email, rawName) {
  return run('DELETE FROM article_info WHERE user_email = ? AND name = ?', email, (rawName || '').trim().toLowerCase()).changes > 0;
}

// ---- family ----
function getFamilyMembers(ownerEmail) {
  return all(`SELECT u.email, u.pseudo, COALESCE(fm.can_edit, 1) AS canEdit FROM family_members fm JOIN users u ON u.email = fm.member_email WHERE fm.owner_email = ? ORDER BY fm.added_at ASC`, ownerEmail);
}

function addFamilyMember(ownerEmail, memberEmail) {
  const member = normEmail(memberEmail);
  if (!member) return 'empty';
  if (member === ownerEmail) return 'self';
  if (!getUserByEmail(member)) return 'nouser';
  return run('INSERT OR IGNORE INTO family_members (owner_email, member_email, can_edit) VALUES (?, ?, 1)', ownerEmail, member).changes
    ? 'added' : 'exists';
}

function removeFamilyMember(ownerEmail, memberEmail) {
  run('DELETE FROM family_members WHERE owner_email = ? AND member_email = ?', ownerEmail, memberEmail);
}

// Familles dont cet utilisateur fait partie (il n'est pas le propriétaire)
function getFamiliesOf(memberEmail) {
  const m = normEmail(memberEmail);
  return all(`SELECT u.email AS ownerEmail, u.pseudo AS ownerPseudo, COALESCE(fm.can_edit, 1) AS canEdit FROM family_members fm JOIN users u ON u.email = fm.owner_email WHERE fm.member_email = ? ORDER BY fm.added_at ASC`, m);
}

// Quitter la famille de quelqu'un + perdre l'accès à ses listes (sauf celles qu'on a créées)
function leaveFamily(ownerEmail, memberEmail) {
  const o = normEmail(ownerEmail), m = normEmail(memberEmail);
  if (!o || !m || o === m) return false;
  run('DELETE FROM family_members WHERE owner_email = ? AND member_email = ?', o, m);
  run('DELETE FROM list_members WHERE user_email = ? AND list_id IN (SELECT id FROM lists WHERE created_by = ?)', m, o);
  return true;
}

// Change le droit d'un membre + propage aux listes du propriétaire
function setFamilyCanEdit(ownerEmail, memberEmail, canEdit) {
  const v = canEdit ? 1 : 0;
  run('UPDATE family_members SET can_edit = ? WHERE owner_email = ? AND member_email = ?', v, ownerEmail, memberEmail);
  run('UPDATE list_members SET can_edit = ? WHERE user_email = ? AND list_id IN (SELECT id FROM lists WHERE created_by = ?)', v, memberEmail, ownerEmail);
  return true;
}

// ---- family invites : 30 min, usage unique, créées à la demande ----
function createFamilyInvite(ownerEmail) {
  const token = shortId(12);
  run(`INSERT INTO family_invites (owner_email, token, created_at) VALUES (?, ?, CURRENT_TIMESTAMP) ON CONFLICT(owner_email) DO UPDATE SET token = excluded.token, created_at = CURRENT_TIMESTAMP`, ownerEmail, token);
  return token;
}

function getValidFamilyInvite(ownerEmail) {
  const row = get(`SELECT token FROM family_invites WHERE owner_email = ? AND created_at > ${INVITE_TTL}`, ownerEmail);
  return row ? row.token : null;
}

function peekFamilyInvite(token) {
  const row = get(`SELECT owner_email FROM family_invites WHERE token = ? AND created_at > ${INVITE_TTL}`, token);
  return row ? row.owner_email : null;
}

function consumeFamilyInvite(token) {
  const owner = peekFamilyInvite(token);
  if (owner) run('DELETE FROM family_invites WHERE token = ?', token);
  return owner;
}

function hasFamilyInvite(token) {
  return !!get('SELECT 1 AS ok FROM family_invites WHERE token = ?', token);
}

module.exports = { createList, getList, getListByShareToken, addItem, toggleItem, changeItemQuantity, removeItem, createUser, getUserByEmail, verifyUser, setPseudo, getListsByUser, deleteList, addMember, removeMember, getMembers, getRecentItems, getCatalog, searchCatalog, addArticle, setArticleInfo, renameArticle, deleteArticle, deleteUser, updatePassword, getPseudoChangeStatus, recordPseudoChange, clearCheckedItems, isListMember, canEditList, createListInvite, getValidListInvite, peekListInvite, consumeListInvite, getFamilyMembers, addFamilyMember, removeFamilyMember, setFamilyCanEdit, getFamiliesOf, leaveFamily, createFamilyInvite, getValidFamilyInvite, peekFamilyInvite, consumeFamilyInvite, hasFamilyInvite, PSEUDO_MAX_PER_WEEK, PSEUDO_MIN_GAP_MIN };

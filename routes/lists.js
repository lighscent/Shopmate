const { Router } = require('express');
const store = require('../store');
const ws = require('../ws');
const { baseUrl } = require('../lib/urls');
const { requireAuth, requirePseudo } = require('../middleware/auth');

const router = Router();

function shareTargets(email) {
  const targets = [];
  if (store.getFamilyMembers(email).length) targets.push({ value: 'self', label: 'Ma famille' });
  for (const f of store.getFamiliesOf(email)) {
    if (f.canEdit) targets.push({ value: f.ownerEmail, label: 'Famille de ' + (f.ownerPseudo || f.ownerEmail) });
  }
  return targets;
}

router.get('/', requireAuth, requirePseudo, (req, res) => {
  const sort = req.query.sort === 'created' ? 'created' : 'updated';
  const dir = req.query.dir === 'asc' ? 'asc' : 'desc';
  const lists = store.getListsByUser(req.session.userEmail, sort, dir);
  const recentItems = store.getRecentItems(req.session.userEmail);
  res.render('index', { lists, recentItems, shareTargets: shareTargets(req.session.userEmail), sort, dir });
});

router.post('/lists', requireAuth, requirePseudo, (req, res) => {
  const { name } = req.body;
  if (!name || !name.trim()) return res.redirect('/');
  const wantsJson = req.get('X-Requested-With') === 'XMLHttpRequest' || (req.get('Accept') || '').includes('application/json');
  const trimmed = name.trim();
  const me = req.session.userEmail;
  const duplicate = store.getListsByUser(me)
    .find((l) => l.created_by === me && l.name.trim().toLowerCase() === trimmed.toLowerCase());
  if (duplicate) {
    if (wantsJson) return res.status(409).json({ error: 'duplicate', name: trimmed, existingId: duplicate.id });
    const lists = store.getListsByUser(me);
    const recentItems = store.getRecentItems(me);
    return res.render('index', { lists, recentItems, shareTargets: shareTargets(me), sort: 'updated', dir: 'desc', warningName: trimmed, existingList: duplicate });
  }
  // cible de partage validée : 'self' ou un owner dont je suis éditeur, sinon perso.
  // champ absent (vieux clients en cache) : undefined = ancien comportement auto-partage
  const rawShare = req.body.share;
  let shareWith;
  if (rawShare === undefined) shareWith = undefined;
  else {
    const share = String(rawShare).trim();
    if (share === 'self' && store.getFamilyMembers(me).length) shareWith = 'self';
    else if (share) {
      const f = store.getFamiliesOf(me).find((x) => x.ownerEmail === share && x.canEdit);
      shareWith = f ? share : '';
    } else shareWith = '';
  }
  const list = store.createList(trimmed, me, shareWith);
  // La liste apparaît en direct chez le créateur + tous les membres ajoutés
  const emails = [me, ...store.getMembers(list.id).map((m) => m.email)];
  ws.notifyUsers([...new Set(emails)], { type: 'lists-changed', action: 'added', id: list.id });
  if (wantsJson) return res.json({ id: list.id });
  res.redirect('/list/' + list.id);
});

router.get('/join/:token', (req, res) => {
  const list = store.peekListInvite(req.params.token);
  if (!list) {
    const stale = store.getListByShareToken(req.params.token);
    return res.status(stale ? 410 : 404).render('404', stale
      ? { code: 410, msg: 'Ce lien d\u2019invitation a expir\u00e9 (30 min, usage unique). Demande un nouveau lien.' }
      : {});
  }
  if (!res.locals.user) {
    req.session.afterLogin = req.originalUrl;
    return res.redirect('/login');
  }
  if (!res.locals.user.pseudo) {
    req.session.afterLogin = req.originalUrl;
    return res.redirect('/choose-pseudo');
  }
  store.consumeListInvite(req.params.token);
  store.addMember(list.id, req.session.userEmail);
  ws.notifyUsers([req.session.userEmail], { type: 'lists-changed', action: 'added', id: list.id });
  res.redirect('/list/' + list.id);
});

router.get('/list', (req, res) => {
  const { id } = req.query;
  if (!id) return res.redirect('/');
  res.redirect('/list/' + id);
});

router.get('/list/:id', requireAuth, (req, res) => {
  const sort = req.query.sort === 'updated' ? 'updated' : 'created';
  const list = store.getList(req.params.id, sort);
  if (!list) return res.status(404).render('404');
  res.render('list', { list, user: res.locals.user, canEdit: store.canEditList(req.params.id, req.session.userEmail), sort });
});

router.get('/list/:id/members', requireAuth, (req, res) => {
  const list = store.getList(req.params.id);
  if (!list) return res.status(404).render('404');
  const members = store.getMembers(req.params.id);
  const canInvite = store.canEditList(req.params.id, req.session.userEmail);
  const token = store.getValidListInvite(req.params.id);
  res.render('members', { list, user: res.locals.user, members, canInvite, inviteUrl: token ? baseUrl(req) + '/join/' + token : null });
});

module.exports = router;

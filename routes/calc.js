const { Router } = require('express');
const store = require('../store');
const { requireAuth, requirePseudo } = require('../middleware/auth');

const router = Router();

function wantsJson(req) {
  return req.get('X-Requested-With') === 'XMLHttpRequest' || (req.get('Accept') || '').includes('application/json');
}

function editableLists(email) {
  return store.getListsByUser(email).filter(l => l.created_by === email || l.can_edit);
}

router.get('/calculatrice', requireAuth, requirePseudo, (req, res) => {
  res.render('calculatrice', {
    lists: editableLists(req.session.userEmail),
    sessions: store.getCalcSessions(req.session.userEmail),
    presetList: req.query.list || '',
    user: res.locals.user
  });
});

router.post('/calculatrice/finish', requireAuth, requirePseudo, (req, res) => {
  const { listId, lines } = req.body;
  if (listId && !editableLists(req.session.userEmail).some(l => l.id === listId)) {
    if (wantsJson(req)) return res.status(403).json({ error: 'Liste non modifiable' });
    return res.redirect('/calculatrice');
  }
  const saved = store.saveCalcSession(req.session.userEmail, listId || null, lines);
  if (!saved) {
    if (wantsJson(req)) return res.status(400).json({ error: 'Ticket vide ou prix manquants' });
    return res.redirect('/calculatrice');
  }
  if (wantsJson(req)) return res.json({ ok: true, id: saved.id, total: saved.total });
  res.redirect('/calculatrice');
});

router.post('/calculatrice/delete', requireAuth, requirePseudo, (req, res) => {
  store.deleteCalcSession(req.session.userEmail, req.body.id || '');
  if (wantsJson(req)) return res.json({ ok: true });
  res.redirect('/calculatrice');
});

module.exports = router;

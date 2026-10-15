const { Router } = require('express');
const store = require('../store');
const ws = require('../ws');
const { baseUrl } = require('../lib/urls');
const { requireAuth, requirePseudo } = require('../middleware/auth');

const router = Router();

function wantsJson(req) {
  return req.get('X-Requested-With') === 'XMLHttpRequest' || (req.get('Accept') || '').includes('application/json');
}

function inviteUrl(req) {
  const token = store.getValidFamilyInvite(req.session.userEmail);
  return token ? baseUrl(req) + '/famille/rejoindre/' + token : null;
}

function renderFamille(req, res, extra = {}) {
  res.render('famille', {
    members: store.getFamilyMembers(req.session.userEmail),
    familiesOf: store.getFamiliesOf(req.session.userEmail),
    inviteUrl: inviteUrl(req),
    user: res.locals.user,
    ...extra
  });
}

router.get('/famille', requireAuth, requirePseudo, (req, res) => {
  renderFamille(req, res);
});

router.post('/famille/add', requireAuth, requirePseudo, (req, res) => {
  const email = (req.body.email || '').trim();
  const inFam = store.getFamiliesOf(req.session.userEmail);
  if (inFam.length) {
    const msg = 'Tu fais partie de la famille de ' + (inFam[0].ownerPseudo || inFam[0].ownerEmail) + ' — quitte-la pour créer la tienne';
    if (wantsJson(req)) return res.status(400).json({ error: msg });
    return renderFamille(req, res, { error: msg });
  }
  const r = store.addFamilyMember(req.session.userEmail, email);
  const errors = {
    empty: 'Entre un email',
    self: 'Tu ne peux pas t\u2019ajouter toi-m\u00eame',
    nouser: 'Aucun compte avec cet email — la personne doit d\u2019abord s\u2019inscrire',
    exists: 'D\u00e9j\u00e0 dans ta famille'
  };
  if (r !== 'added') {
    if (wantsJson(req)) return res.status(400).json({ error: errors[r] || 'Erreur' });
    return renderFamille(req, res, { error: errors[r] || 'Erreur' });
  }
  const member = store.getUserByEmail(email.toLowerCase());
  if (wantsJson(req)) return res.json({ ok: true, member: { email: member.email, pseudo: member.pseudo, canEdit: 1 } });
  return renderFamille(req, res, { success: email + ' ajout\u00e9 à ta famille' });
});

router.post('/famille/remove', requireAuth, requirePseudo, (req, res) => {
  store.removeFamilyMember(req.session.userEmail, (req.body.email || '').trim());
  if (wantsJson(req)) return res.json({ ok: true });
  res.redirect('/famille');
});

// Quitter une famille dont on fait partie (on perd aussi l'accès à ses listes)
router.post('/famille/leave', requireAuth, requirePseudo, (req, res) => {
  store.leaveFamily((req.body.owner || '').trim(), req.session.userEmail);
  ws.notifyUsers([req.session.userEmail], { type: 'lists-changed', action: 'removed' });
  if (wantsJson(req)) return res.json({ ok: true });
  res.redirect('/famille');
});

// Bascule éditeur <-> lecteur pour un membre (+ propage aux listes du propriétaire)
router.post('/famille/rights', requireAuth, requirePseudo, (req, res) => {
  const email = (req.body.email || '').trim().toLowerCase();
  const canEdit = req.body.can_edit === '1' || req.body.can_edit === 1 || req.body.can_edit === true;
  store.setFamilyCanEdit(req.session.userEmail, email, canEdit);
  if (wantsJson(req)) return res.json({ ok: true, canEdit: canEdit ? 1 : 0 });
  res.redirect('/famille');
});

// Génère un lien à usage unique (30 min) — rien n'est pré-généré avant cet appel
router.post('/famille/invite', requireAuth, requirePseudo, (req, res) => {
  const inFam = store.getFamiliesOf(req.session.userEmail);
  if (inFam.length) {
    const msg = 'Tu fais partie de la famille de ' + (inFam[0].ownerPseudo || inFam[0].ownerEmail) + ' — quitte-la pour inviter dans ta propre famille';
    if (wantsJson(req)) return res.status(400).json({ error: msg });
    return renderFamille(req, res, { error: msg });
  }
  const token = store.createFamilyInvite(req.session.userEmail);
  const url = baseUrl(req) + '/famille/rejoindre/' + token;
  if (wantsJson(req)) return res.json({ ok: true, url });
  res.redirect('/famille');
});

router.get('/famille/rejoindre/:token', (req, res) => {
  const owner = store.peekFamilyInvite(req.params.token);
  if (!owner) {
    const stale = store.hasFamilyInvite(req.params.token);
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
  if (owner !== req.session.userEmail) {
    // Famille exclusive : soit on a la sienne (avec des membres), soit on est dans une seule famille
    const mine = store.getFamilyMembers(req.session.userEmail);
    if (mine.length) {
      return renderFamille(req, res, { error: 'Tu as déjà ta propre famille — retire tes membres avant d’en rejoindre une autre' });
    }
    const inFam = store.getFamiliesOf(req.session.userEmail);
    if (!inFam.some(f => f.ownerEmail === owner)) {
      if (inFam.length) {
        return renderFamille(req, res, { error: 'Tu fais déjà partie de la famille de ' + (inFam[0].ownerPseudo || inFam[0].ownerEmail) + ' — quitte-la avant d’en rejoindre une autre' });
      }
      store.consumeFamilyInvite(req.params.token);
      store.addFamilyMember(owner, req.session.userEmail);
    }
  }
  res.redirect('/famille');
});

module.exports = router;

(() => {
  if (window.__appVersionInit) return;
  window.__appVersionInit = true;
  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('/sw.js').catch(() => {});
  }
  const KEY = 'shoplist-version';
  var popupShown = false;
  function cmp(a, b) {
    const pa = String(a).split('.').map(Number), pb = String(b).split('.').map(Number);
    for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
      const d = (pa[i] || 0) - (pb[i] || 0);
      if (d) return d > 0 ? 1 : -1;
    }
    return 0;
  }
  function showPopup(entries) {
    if (popupShown || document.getElementById('newsPopup') || !entries.length) return;
    popupShown = true;
    var overlay = document.createElement('div');
    overlay.id = 'newsPopup';
    overlay.setAttribute('style', 'position:fixed;inset:0;z-index:70;background:rgba(0,0,0,.45);display:flex;align-items:center;justify-content:center;padding:20px;');
    var card = document.createElement('div');
    card.setAttribute('style', 'background:#fff;border-radius:20px;max-width:24rem;width:100%;max-height:80vh;display:flex;flex-direction:column;box-shadow:0 20px 50px rgba(0,0,0,.3);');
    var head = document.createElement('p');
    head.textContent = 'Nouveautés';
    head.setAttribute('style', 'margin:0;padding:16px 20px 0;font-size:17px;font-weight:700;color:#1f2937;');
    var list = document.createElement('div');
    list.setAttribute('style', 'padding:8px 20px 0;overflow-y:auto;');
    entries.forEach(function(e) {
      var title = document.createElement('p');
      title.setAttribute('style', 'margin:12px 0 4px;font-size:13px;font-weight:700;color:#1d4ed8;');
      title.textContent = 'v' + e.version + (e.date ? ' — ' + e.date : '');
      var ul = document.createElement('ul');
      ul.setAttribute('style', 'margin:0;padding-left:18px;list-style:disc;font-size:13px;color:#4b5563;line-height:1.55;');
      (e.items || []).forEach(function(it) {
        var li = document.createElement('li');
        li.textContent = it;
        ul.appendChild(li);
      });
      list.appendChild(title);
      list.appendChild(ul);
    });
    var foot = document.createElement('div');
    foot.setAttribute('style', 'padding:14px 20px 18px;');
    var btn = document.createElement('button');
    btn.type = 'button';
    btn.textContent = 'Super !';
    btn.setAttribute('style', 'width:100%;background:#3b82f6;color:#fff;font-weight:600;font-size:14px;padding:12px;border:none;border-radius:14px;min-height:48px;');
    btn.onclick = function() { overlay.remove(); };
    foot.appendChild(btn);
    card.appendChild(head);
    card.appendChild(list);
    card.appendChild(foot);
    overlay.appendChild(card);
    overlay.addEventListener('click', function(e) { if (e.target === overlay) overlay.remove(); });
    document.body.appendChild(overlay);
  }
  async function check() {
    try {
      const [vr, cr] = await Promise.all([
        fetch('/api/version', { cache: 'no-store' }),
        fetch('/api/changelog', { cache: 'no-store' })
      ]);
      if (!vr.ok || !cr.ok) return;
      const { version } = await vr.json();
      const log = await cr.json();
      if (!version || !Array.isArray(log)) return;
      const prev = localStorage.getItem(KEY);
      if (prev && cmp(version, prev) <= 0) return;
      const fresh = prev ? log.filter((e) => e.version && cmp(e.version, prev) > 0) : log.slice(0, 1);
      try { localStorage.setItem(KEY, version); } catch {}
      showPopup(fresh);
    } catch {}
  }
  check();
  document.addEventListener('visibilitychange', () => { if (!document.hidden) check(); });
  // Simulation : ajouter ?simulmaj à l'URL pour voir la popup sans vraie release
  (async () => {
    try {
      if (new URLSearchParams(location.search).get('simulmaj') === null) return;
      const cr = await fetch('/api/changelog', { cache: 'no-store' });
      if (!cr.ok) return;
      const log = await cr.json();
      showPopup(Array.isArray(log) ? log.slice(0, 2) : []);
    } catch {}
  })();
})();

# ShopList — AGENTS.md

Express 5 + EJS + SQLite (`better-sqlite3`) + `ws`. Mobile-first PWA (`max-w-sm`, viewport no-zoom, main actions ≥ 48px).

## Commands

- `npm install` then `npm start` (`node index.js`, port `PORT` or 3000)
- `npm run dev` — nodemon + tailwind watch (needs `concurrently`, `nodemon`)
- `npm run build:css` — rebuild `public/css/main.css` (Tailwind v4 CLI)
- No tests (`npm test` is an `echo` placeholder). Verify with `node --check <file>`.

## Wiring

- `index.js` — entrypoint: dynamic `/api/version`, `/manifest.json`, `/sw.js` (all no-cache), static `public/`, session (SQLiteStore), `res.locals.user` + `res.locals.version`, then routers.
- `routes/auth.js` (`/login`, `/register`, `/choose-pseudo`, `/profile`, `/changelog` (journal alimenté par `changelog.json`), `/account/delete`), `routes/articles.js` (`/articles`, `/articles/add|update|delete` — catalogue perso manuel nom+prix, vide par défaut, rename via `update(newName)` + conflit `exists`, table `article_info` + flag `manual`), `routes/calc.js` (`/calculatrice` — calculette classique tactile + historique, `/calculatrice/finish|delete` legacy ticket, tables `calc_sessions` + `calc_lines`), `routes/lists.js` (`/`, `/listes` (page des listes : composer + tri + recherche + temps réel), `/lists` perso ou partagée via `share` → `store.createList(name, by, shareWith)`, `/join/:token`, `/list/:id` (?sort=created|updated sur les items via `items.updated_at` ; `/` + `GET /api/lists` trient les listes via `getListsByUser(email, sort, dir)`)), `routes/family.js` (`/famille`, `/famille/add|remove|leave|rights|invite`, `/famille/rejoindre/:token`), `routes/api.js` (`/api/...`, dont `GET /api/lists` + `GET /api/catalog` (autocomplete, min 2 lettres) + `POST /list/:id/invite`, auth required except `/api/version`).
- `ws.js` — rooms par liste (`join`/`leave`) + rooms par user (`join-user`, auth via cookie de session, jamais l'email client). `notifyUsers(emails, data)` pour les events hors liste (`lists-changed`). Heartbeat 30 s + reconnect client avec backoff (`list.ejs`, `index.ejs`).
 - Nav SPA : `public/js/spa-nav.js` intercepte les liens internes (fetch + swap du body + pushState, fallback reload). Scripts inline ré-exécutés à chaque nav : pas de `const`/`let` top-level (utiliser `var`), sockets/intervalles dans `window.__pageCleanup`, `window.goPage(url)` pour les redirections JS. Cache HTML stale-while-revalidate (max 20, jamais si redirection), invalidation via `window.__spaForget(url)` appelée par les refresh temps réel.
- Invites famille + listes : 30 min, usage unique, générées à la demande uniquement (`store.create*Invite` / `peek*` / `consume*`). `lib/urls.js` `baseUrl(req)` (`SITE_URL` env, sinon hôte de la requête, proxy-aware).
- Droits : `can_edit` sur `family_members` + `list_members` (`store.canEditList`, créateur toujours éditeur). Toggle via `POST /famille/rights`, propagé aux listes du propriétaire. Mutations API → 403 si lecture seule.
- `middleware/auth.js` — `requireAuth`, `requirePseudo` (no pseudo → `/choose-pseudo`).
- `store.js` — all SQL. `db.js` — creates `db/data.db` + tables (`users`, `lists`, `items`, `sessions`, `list_members`, `pseudo_changes`, `family_members`, `family_invites`).

## Version system (PWA update)

Single source: `package.json` `version`. Bumping it updates `/api/version`, manifest (`start_url: /?v=<v>`), SW cache name, and footer — Chrome then refreshes installed WebAPKs. Client check: `public/js/app-version.js` (purge `shoplist-*` caches + reload on mismatch). Views reference it via `<%= locals.version %>` (`?v=` on manifest/script URLs).

## Gotchas

- `public/css/main.css` is compiled. If you can't run `build:css`, reuse classes already present in it (grep first) + inline `style=` for anything new.
- Views: logged-in pages use `partials/bottom-nav` (fixed bottom bar Accueil/Listes/Articles/Famille/Calculatrice/Compte, `active` param, no version) instead of the old fixed footer; containers need `padding-bottom:110px` inline so content isn't hidden. Auth pages keep the old fixed footer + `pb-10`. Version number lives only on `/profile` (link to `/changelog`, fed by `changelog.json` — add user-facing items to the top (unreleased) entry as features land, set its date on release).
- `getListsByUser` uses `GROUP BY l.id` (join fan-out) — keep it.
- Rules enforced in code: pseudo changes max 2 / rolling 7 days + 15 min gap (`pseudo_changes`, initial choice free, resubmitting same pseudo is free); password min 4 chars; `deleteUser` deletes owned lists + items + memberships + sessions.
- No `node_modules` committed; `db/` sqlite file is runtime-created, don't delete it in prod.

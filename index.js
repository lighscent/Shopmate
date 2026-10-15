require('dotenv').config();
const express = require('express');
const path = require('path');
const http = require('http');
const session = require('express-session');
const { SQLiteStore } = require('./db');
const store = require('./store');
const ws = require('./ws');
const log = require('./lib/logger');

const app = express();
const server = http.createServer(app);
const port = process.env.PORT || 3000;

const APP_VERSION = require('./package.json').version;
app.locals.version = APP_VERSION;

ws.init(server);

app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));

// Version API (sans cache, sans auth : utilise pour detecter les mises a jour PWA)
app.get('/api/version', (req, res) => {
  res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
  res.json({ version: APP_VERSION });
});

// Journal des nouveautés (sans cache, sans auth : lu par la popup de mise à jour)
app.get('/api/changelog', (req, res) => {
  res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
  res.json(require('./changelog.json'));
});

// Manifest dynamique : la version change a chaque release => Chrome met a jour le WebAPK installe
app.get('/manifest.json', (req, res) => {
  res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
  res.json({
    name: 'ShopList',
    short_name: 'ShopList',
    description: 'Liste de courses collaborative',
    version: APP_VERSION,
    id: '/',
    scope: '/',
    start_url: '/?v=' + APP_VERSION,
    display: 'standalone',
    display_override: ['standalone', 'minimal-ui'],
    background_color: '#f9fafb',
    theme_color: '#3b82f6',
    icons: [
      {
        src: '/icon-192.png',
        sizes: '192x192',
        type: 'image/png',
        purpose: 'any'
      },
      {
        src: '/icon-512.png',
        sizes: '512x512',
        type: 'image/png',
        purpose: 'any maskable'
      },
      {
        src: '/icon.svg',
        sizes: '512x512',
        type: 'image/svg+xml',
        purpose: 'any maskable'
      }
    ]
  });
});

// Service worker versionne : purge les anciens caches (dont l'ancienne redirection Cloudflare)
app.get('/sw.js', (req, res) => {
  res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
  res.type('application/javascript');
  res.send(
`const APP_VERSION = ${JSON.stringify(APP_VERSION)};
const CACHE_NAME = 'shoplist-' + APP_VERSION;
self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k.startsWith('shoplist-') && k !== CACHE_NAME).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});
// Navigations en network-first : ne rejoue jamais une vieille redirection mise en cache
self.addEventListener('fetch', (e) => {
  if (e.request.method !== 'GET') return;
  if (e.request.mode === 'navigate') {
    e.respondWith(fetch(e.request).catch(() => caches.match('/')));
  }
});
self.addEventListener('message', (e) => { if (e.data === 'SKIP_WAITING') self.skipWaiting(); });
`);
});
app.use((req, res, next) => {
  if (/^\/(icon|manifest|sw\.js)/.test(req.path)) res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
  next();
});
app.use(express.static(path.join(__dirname, 'public'), { maxAge: 0 }));
app.use(express.urlencoded({ extended: true }));
app.use(express.json());
app.use(session({
  store: new SQLiteStore(),
  secret: process.env.SESSION_SECRET || 'shoplist-dev-secret',
  resave: false,
  saveUninitialized: false,
  cookie: { maxAge: 365 * 24 * 60 * 60 * 1000 }
}));

app.use((req, res, next) => {
  res.locals.user = null;
  res.locals.version = APP_VERSION;
  if (req.method === 'GET') res.setHeader('Cache-Control', 'no-store');
  if (req.session.userEmail) {
    const user = store.getUserByEmail(req.session.userEmail);
    if (user) res.locals.user = user;
  }
  next();
});

app.use('/', require('./routes/auth'));
app.use('/', require('./routes/lists'));
app.use('/', require('./routes/family'));
app.use('/', require('./routes/articles'));
app.use('/', require('./routes/calc'));
app.use('/api', require('./routes/api'));

app.use((req, res) => {
  res.status(404).render('404');
});

app.use((err, req, res, next) => {
  log.error(err);
  res.status(500).render('500');
});

process.on('uncaughtException', (err) => {
  log.error('uncaughtException', err);
  process.exit(1);
});
process.on('unhandledRejection', (reason) => {
  log.error('unhandledRejection', reason);
});

server.listen(port, () => {
  log.info('Server running at http://localhost:' + port);
});

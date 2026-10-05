#!/usr/bin/env node
// Garde de sécurité : analyse statique d'un diff git, sans rien exécuter.
//
// Lit uniquement ce que git renvoie (diff, contenu des fichiers aux deux
// révisions) : aucun `npm install`, aucun script du code analysé n'est lancé.
// C'est ce qui permet de passer sur du code venu d'un dépôt tiers.
//
// Usage :
//   node garde-securite.mjs --base <rev> --head <rev> [--ours <rev>]
//                           [--mode pr|amont] [--out rapport.md]
//
//   --base   révision de départ (merge-base pour une synchro amont)
//   --head   révision analysée (tête de l'amont, ou tête de la PR)
//   --ours   notre branche principale : en mode amont, signale les fichiers
//            que nous avons personnalisés ET que l'amont modifie
//   --mode   pr (défaut) : code de sortie 2 s'il y a un point critique
//            amont : code de sortie 0, le nombre de critiques part dans
//            $GITHUB_OUTPUT (critiques=N) ; les changements de .github/
//            deviennent critiques
//
// Les règles sont volontairement lisibles plutôt qu'exhaustives : la garde
// trie ce qu'un humain doit regarder en premier, elle ne remplace pas la
// relecture.

import { execFileSync } from 'node:child_process';
import { appendFileSync, writeFileSync } from 'node:fs';

// --- Arguments ---------------------------------------------------------------

function parseArgs(argv) {
  const args = { mode: 'pr' };
  for (let i = 0; i < argv.length; i += 1) {
    const key = argv[i];
    if (!key.startsWith('--')) throw new Error(`Argument inattendu : ${key}`);
    const value = argv[i + 1];
    if (value === undefined || value.startsWith('--')) throw new Error(`Valeur manquante pour ${key}`);
    args[key.slice(2)] = value;
    i += 1;
  }
  if (!args.base || !args.head) throw new Error('--base et --head sont obligatoires');
  if (!['pr', 'amont'].includes(args.mode)) throw new Error(`--mode inconnu : ${args.mode}`);
  return args;
}

// --- Git ---------------------------------------------------------------------

const GIT_MAX_BUFFER = 512 * 1024 * 1024;

function git(...args) {
  return execFileSync('git', args, { encoding: 'utf8', maxBuffer: GIT_MAX_BUFFER });
}

function gitOrNull(...args) {
  try {
    return execFileSync('git', args, { encoding: 'utf8', maxBuffer: GIT_MAX_BUFFER, stdio: ['ignore', 'pipe', 'ignore'] });
  } catch {
    return null;
  }
}

function resolveRev(rev) {
  const sha = gitOrNull('rev-parse', '--verify', '--quiet', `${rev}^{commit}`);
  if (!sha) throw new Error(`Révision introuvable : ${rev}`);
  return sha.trim();
}

// Statut par fichier (A/M/D/R…), renommages détectés.
function changedFiles(base, head) {
  const out = git('diff', '--name-status', '-z', '-M', base, head);
  const parts = out.split('\0').filter(Boolean);
  const files = [];
  for (let i = 0; i < parts.length; ) {
    const status = parts[i];
    if (status.startsWith('R') || status.startsWith('C')) {
      files.push({ status: status[0], oldPath: parts[i + 1], path: parts[i + 2] });
      i += 3;
    } else {
      files.push({ status: status[0], path: parts[i + 1] });
      i += 2;
    }
  }
  return files;
}

// Lignes ajoutées par fichier, avec leur numéro dans la version `head`.
function addedLines(base, head) {
  const out = git('diff', '--no-color', '--no-ext-diff', '-M', '--unified=0', base, head);
  const byFile = new Map();
  let current = null;
  let lineNo = 0;
  for (const line of out.split('\n')) {
    if (line.startsWith('diff --git ')) {
      current = null;
      continue;
    }
    if (line.startsWith('+++ ')) {
      const target = line.slice(4);
      current = target === '/dev/null' ? null : target.replace(/^b\//, '');
      if (current && !byFile.has(current)) byFile.set(current, []);
      continue;
    }
    if (line.startsWith('@@')) {
      const match = /\+(\d+)/.exec(line);
      lineNo = match ? Number(match[1]) : 0;
      continue;
    }
    if (!current) continue;
    if (line.startsWith('+')) {
      byFile.get(current).push({ line: lineNo, text: line.slice(1) });
      lineNo += 1;
    }
  }
  return byFile;
}

function fileAt(rev, path) {
  return gitOrNull('show', `${rev}:${path}`);
}

// --- Classement des fichiers -------------------------------------------------

const BINARY_EXT = /\.(apk|ipa|aab|exe|dll|so|dylib|jar|wasm|bin|node)$/i;
const SKIP_CONTENT = [
  /(^|\/)package-lock\.json$/,
  /(^|\/)yarn\.lock$/,
  /(^|\/)pnpm-lock\.yaml$/,
  /(^|\/)Cargo\.lock$/,
  /\.min\.(js|css)$/,
  /\.map$/,
  /\.(svg|png|jpe?g|gif|webp|ico|mp4|webm|woff2?|ttf|otf|pdf|zip|gz)$/i,
  /^public\/sitemap\.xml$/,
  /^src\/i18n\/.*\.json$/,
  // Les listes de domaines et de motifs de la garde se déclencheraient sur
  // elles-mêmes. Un changement de ce fichier reste signalé comme sensible
  // (et critique en mode amont, comme tout .github/).
  /^\.github\/scripts\/garde-securite\.mjs$/,
];

// Tests : leurs domaines sont fictifs et leurs eval volontaires. Seuls les
// secrets et le minage y sont encore cherchés.
const TEST_PATH = /(^|\/)(tests?|__tests__|spec)\/|\.(test|spec)\.[cm]?[jt]sx?$|(^|\/)test_[^/]*\.py$|Test\.kt$/;

const CODE_EXT = /\.(m?[jt]sx?|cjs|py|rs|html?|vue|svelte|sh|ya?ml|json|toml|kt|java|swift|m|mm)$/i;

function scansContent(path) {
  if (BINARY_EXT.test(path)) return false;
  return !SKIP_CONTENT.some((re) => re.test(path));
}

// Fichiers dont un changement mérite toujours un coup d'œil : ils portent les
// protections ajoutées sur ce dépôt (CSP, confinement des iframes, mesure
// d'audience, VIP auto-hébergé) ou exécutent du code avec des droits.
const SENSITIVE_PATHS = [
  [/^\.github\//, 'automatisation GitHub (s\'exécute avec les droits du dépôt)'],
  [/^public\/sw\.js$/, 'service worker (redirections vers des miroirs, cache)'],
  [/^server\/securityHeaders\.js$/, 'en-têtes de sécurité / CSP'],
  [/^src\/utils\/embedSandbox\.ts$/, 'confinement des iframes d\'hébergeurs'],
  [/^src\/utils\/analytics\.ts$/, 'mesure d\'audience'],
  [/^src\/utils\/selfhostVip\.ts$/, 'clé VIP auto-hébergée'],
  [/^src\/context\/AdFreePopupContext/, 'popups publicitaires'],
  [/^src\/utils\/adScriptMode\.ts$/, 'script de régie publicitaire'],
  [/^src\/components\/SwiftfluxGate\.tsx$/, 'porte publicitaire SwiftFlux'],
  [/^src\/services\/blockDetection\.ts$/, 'bascule automatique vers un miroir'],
  [/^index\.html$/, 'page racine (scripts chargés partout)'],
  [/^vite\.config\.ts$/, 'configuration de build (PWA, miroirs)'],
  [/^\.env\.example$/, 'valeurs par défaut de configuration'],
  [/^API\/Mainapi\/middleware\//, 'middleware de l\'API (auth, CORS, sécurité)'],
  [/^API\/Mainapi\/routes\/(authRoutes|oauth|sessions|admin[^/]*|sync|profiles)\.js$/, 'comptes, sessions, administration'],
  [/^API\/Mainapi\/(app|server)\.js$/, 'point d\'entrée de l\'API'],
  [/^API\/Mainapi\/config\//, 'configuration de l\'API (domaines des sources)'],
  [/^API\/Mainapi\/db\//, 'schéma et amorçage de la base'],
  [/^API\/proxiesembed\/server\.py$/, 'proxy d\'extraction'],
  [/(^|\/)Dockerfile[^/]*$|^docker-compose\.ya?ml$|^deploy\//, 'déploiement'],
  [/^functions\//, 'fonctions edge Cloudflare'],
  [/^(extension|userscript)\//, 'extension / userscript (non installés)'],
  [/^app\//, 'application mobile (mise à jour automatique)'],
];

function sensitivity(path) {
  const hit = SENSITIVE_PATHS.find(([re]) => re.test(path));
  return hit ? hit[1] : null;
}

// --- Règles de contenu -------------------------------------------------------

// Domaines de traqueurs et de régies : un ajout est critique, c'est exactement
// ce que ce dépôt a retiré.
const TRACKER_DOMAINS = [
  'googletagmanager.com', 'google-analytics.com', 'analytics.google.com',
  'doubleclick.net', 'googlesyndication.com', 'googleadservices.com', 'adservice.google',
  'connect.facebook.net', 'facebook.com/tr', 'hotjar.com', 'clarity.ms',
  'mc.yandex.ru', 'mc.yandex.com', 'metrika.yandex', 'mixpanel.com', 'cdn.segment.com',
  'api.segment.io', 'amplitude.com', 'fullstory.com', 'smartlook.com', 'mouseflow.com',
  'tiktok.com/i18n/pixel', 'analytics.tiktok.com', 'snap.licdn.com', 'static.ads-twitter.com',
  'popads.net', 'popcash.net', 'propellerads.com', 'adsterra.com', 'monetag.com',
  'hilltopads', 'exoclick.com', 'exosrv.com', 'juicyads.com', 'a-ads.com', 'adcash.com',
  'clickadu.com', 'trafficstars.com', 'tsyndicate.com', 'onclicka', 'highperformanceformat.com',
  'profitablecpmrate.com', 'profitablegatecpm.com', 'effectivegatecpm.com', 'effectiveratecpm.com',
  'admaven', 'ad-maven', 'hotsoz.com', 'adskeeper', 'mgid.com', 'taboola.com', 'outbrain.com',
  'pushails', 'richads', 'rollerads', 'galaksion', 'evadav', 'zeroredirect', 'dtscout.com',
];

const MINER_RE = /\b(coinhive|coin-hive|cryptonight|crypto-?loot|webminepool|webmine\.|deepminer|coinimp|jsecoin|xmrig|minero\.cc|monero[-_ ]?miner)\b/i;

const SECRET_RULES = [
  [/-----BEGIN (RSA |EC |OPENSSH |DSA |PGP )?PRIVATE KEY-----/, 'clé privée'],
  [/\bAKIA[0-9A-Z]{16}\b/, 'clé d\'accès AWS'],
  [/\bgh[pousr]_[A-Za-z0-9]{36,}\b/, 'jeton GitHub'],
  [/\bgithub_pat_[A-Za-z0-9_]{50,}\b/, 'jeton GitHub'],
  [/\bsk_live_[A-Za-z0-9]{20,}\b/, 'clé Stripe'],
  [/\bxox[abprs]-[A-Za-z0-9-]{10,}\b/, 'jeton Slack'],
  [/\bsb_secret_[A-Za-z0-9_-]{20,}\b/, 'clé secrète Supabase'],
  [/\beyJhbGciOi[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]*cm9sZSI6InNlcnZpY2Vfcm9sZS[A-Za-z0-9_-]*\.[A-Za-z0-9_-]+/, 'clé service_role Supabase'],
  [/https:\/\/(discord(app)?\.com)\/api\/webhooks\/\d+\/[A-Za-z0-9_-]{30,}/, 'webhook Discord'],
];

const OBFUSCATION_RULES = [
  [/\beval\s*\(\s*(atob|unescape|decodeURIComponent|String\.fromCharCode|Buffer\.from)\b/, 'eval d\'une chaîne décodée'],
  [/\bnew\s+Function\s*\(\s*(atob|unescape|decodeURIComponent|String\.fromCharCode)\b/, 'Function() sur une chaîne décodée'],
  [/(\\x[0-9a-fA-F]{2}){24,}/, 'longue suite d\'échappements hexadécimaux'],
  [/(\b_0x[0-9a-f]{4,6}\b.*){4,}/, 'identifiants de type javascript-obfuscator (_0x…)'],
  [/["'`][A-Za-z0-9+/]{600,}={0,2}["'`]/, 'longue chaîne base64 dans le code'],
];

const DOM_SINK_RULES = [
  [/dangerouslySetInnerHTML/, 'dangerouslySetInnerHTML'],
  [/\.(inner|outer)HTML\s*\+?=(?!=)/, 'affectation innerHTML/outerHTML'],
  [/\bdocument\.write(ln)?\s*\(/, 'document.write'],
  [/(^|[^.\w])eval\s*\(/, 'eval'],
  [/\bnew\s+Function\s*\(/, 'new Function'],
  [/postMessage\s*\([^)]*,\s*['"]\*['"]/, 'postMessage vers n\'importe quelle origine'],
  [/\bimportScripts\s*\(\s*['"`]https?:/, 'importScripts distant'],
];

const SANDBOX_RULES = [
  [/allow-top-navigation(?!-by-user-activation|-to-custom-protocols)/, 'iframe autorisée à rediriger la page'],
  [/allow-popups-to-escape-sandbox/, 'popups d\'iframe sortant du confinement'],
];

const PASTE_RE = /\b(rentry\.(co|org)|pastebin\.com|hastebin|paste\.ee|ghostbin|gist\.githubusercontent\.com|dpaste)\b/i;
const PASTE_SCOPE = /^(public\/sw\.js|vite\.config\.ts|\.env\.example|src\/services\/blockDetection\.ts|app\/)/;

const LIFECYCLE_SCRIPTS = ['preinstall', 'install', 'postinstall', 'prepare', 'prepublish', 'preprepare', 'postprepare'];

const URL_HOST_RE = /\bhttps?:\/\/([a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)+)(?::\d+)?/gi;
// Domaines réservés aux exemples et adresses IP littérales.
const FICTIONAL_HOST = /\.(test|example|invalid|localhost|local|exemple|internal)$|^\d{1,3}(\.\d{1,3}){3}$/i;
const IGNORED_HOSTS = /(^|\.)(localhost|example\.(com|org|net|tld)|w3\.org|schema\.org|github\.com|githubusercontent\.com|npmjs\.(com|org)|mozilla\.org|reactjs\.org|react\.dev|wikipedia\.org|themoviedb\.org|tmdb\.org|apple\.com|android\.com|googleapis\.com|gstatic\.com|cloudflare\.com|jsdelivr\.net|unpkg\.com)$/i;

// --- Analyse -----------------------------------------------------------------

// Ligne entièrement commentée (JS/TS/CSS, shell/Python/YAML/.env, HTML).
// Une ligne de code suivie d'un commentaire reste du code.
function isCommentLine(text) {
  return /^\s*(\/\/|\/\*|\*|#|<!--)/.test(text);
}

function snippet(text) {
  const clean = text.replace(/\s+/g, ' ').trim();
  return clean.length > 140 ? `${clean.slice(0, 137)}…` : clean;
}

function analyse({ base, head, ours, mode }) {
  const findings = { critique: [], attention: [] };
  const add = (level, rule, path, line, detail) => {
    findings[level].push({ rule, path, line, detail });
  };

  const files = changedFiles(base, head);
  const lines = addedLines(base, head);
  const touched = new Set(files.map((f) => f.path));

  // 1. Fichiers sensibles et binaires.
  const sensitiveTouched = [];
  for (const file of files) {
    const why = sensitivity(file.path);
    if (why) sensitiveTouched.push({ ...file, why });

    if (/^\.github\//.test(file.path) && mode === 'amont') {
      add('critique', 'automatisation', file.path, null,
        'l\'amont modifie .github/ : ces fichiers s\'exécuteraient dans TON dépôt, avec ses droits et ses secrets');
    }
    if (/(^|\/)\.env(\.[^/]*)?$/.test(file.path) && !/\.env\.example$/.test(file.path) && file.status !== 'D') {
      add('critique', 'secret', file.path, null, 'fichier .env versionné : il contient normalement des secrets');
    }
    if (file.path === 'API/Mainapi/routes/proxy.js' && file.status !== 'D') {
      add('critique', 'proxy-ouvert', file.path, null,
        'proxy générique retiré de ce dépôt (relais ouvert vers le réseau interne) : en cas de conflit, garder la suppression');
    }
    if (BINARY_EXT.test(file.path) && file.status !== 'D') {
      const wasmSource = /\.wasm$/.test(file.path) && /^public\/wasm\//.test(file.path)
        && ![...touched].some((p) => p.startsWith('wasm/'));
      if (wasmSource) {
        add('critique', 'binaire', file.path, null,
          'module WebAssembly modifié sans changement de ses sources Rust (wasm/) : impossible à relire');
      } else {
        add('attention', 'binaire', file.path, null, 'binaire modifié : son contenu ne peut pas être relu');
      }
    }
  }

  // 2. Règles ligne à ligne sur les ajouts.
  const newHosts = new Map();
  for (const [path, added] of lines) {
    if (!scansContent(path)) continue;
    const isCode = CODE_EXT.test(path);
    const isTest = TEST_PATH.test(path);
    for (const { line, text } of added) {
      if (text.length > 5000) {
        if (isCode && /\.(m?[jt]sx?|cjs|html?)$/i.test(path)) {
          add('attention', 'ligne-geante', path, line, `ligne de ${text.length} caractères (code minifié ou embarqué ?)`);
        }
        continue;
      }
      const lower = text.toLowerCase();

      // Les secrets comptent même en commentaire : ils sont publiés pareil.
      for (const [re, label] of SECRET_RULES) {
        if (re.test(text)) add('critique', 'secret', path, line, `${label} (valeur masquée)`);
      }
      // Le reste ne vise que du code actif : un commentaire qui cite un
      // domaine ou un attribut n'exécute rien.
      if (isCommentLine(text)) continue;
      if (isTest) {
        if (MINER_RE.test(text)) add('critique', 'minage', path, line, snippet(text));
        continue;
      }

      for (const domain of TRACKER_DOMAINS) {
        if (lower.includes(domain)) {
          add('critique', 'traqueur-regie', path, line, `${domain} — ${snippet(text)}`);
          break;
        }
      }
      if (MINER_RE.test(text)) add('critique', 'minage', path, line, snippet(text));
      if (isCode) {
        for (const [re, label] of OBFUSCATION_RULES) {
          if (re.test(text)) add('critique', 'obfuscation', path, line, `${label} — ${snippet(text)}`);
        }
        for (const [re, label] of DOM_SINK_RULES) {
          if (re.test(text)) add('attention', 'injection', path, line, `${label} — ${snippet(text)}`);
        }
        for (const [re, label] of SANDBOX_RULES) {
          if (re.test(text)) add('attention', 'iframe', path, line, `${label} — ${snippet(text)}`);
        }
      }
      if (PASTE_SCOPE.test(path) && PASTE_RE.test(text)) {
        add('critique', 'miroir-distant', path, line,
          `liste de miroirs lue sur un service de paste public : quiconque le contrôle choisit où sont redirigés les utilisateurs — ${snippet(text)}`);
      }
      if (/^index\.html$|^public\/.*\.html$/.test(path) && /<script[^>]+src=["']?(https?:)?\/\//i.test(text)) {
        add('attention', 'script-externe', path, line, snippet(text));
      }

      if (isCode) {
        for (const match of text.matchAll(URL_HOST_RE)) {
          const host = match[1].toLowerCase();
          if (IGNORED_HOSTS.test(host) || FICTIONAL_HOST.test(host)) continue;
          if (!newHosts.has(host)) newHosts.set(host, { path, line });
        }
      }
    }
  }

  // 3. Dépendances et scripts d'installation.
  const depChanges = [];
  for (const file of files) {
    if (!/(^|\/)package\.json$/.test(file.path) || file.status === 'D') continue;
    const before = safeJson(fileAt(base, file.oldPath || file.path));
    const after = safeJson(fileAt(head, file.path));
    if (!after) continue;
    for (const hook of LIFECYCLE_SCRIPTS) {
      const was = before?.scripts?.[hook];
      const now = after.scripts?.[hook];
      if (now && now !== was) {
        add('critique', 'script-installation', file.path, null,
          `script « ${hook} » ${was ? 'modifié' : 'ajouté'} : il s'exécute à chaque npm install — ${snippet(now)}`);
      }
    }
    for (const section of ['dependencies', 'devDependencies', 'optionalDependencies']) {
      const a = before?.[section] || {};
      const b = after[section] || {};
      for (const name of new Set([...Object.keys(a), ...Object.keys(b)])) {
        if (a[name] === b[name]) continue;
        depChanges.push({ manifest: file.path, name, from: a[name] || null, to: b[name] || null });
        if (b[name] && /^(git\+|git:|github:|https?:|file:|link:)/.test(b[name]) && b[name] !== a[name]) {
          add('critique', 'dependance-hors-registre', file.path, null,
            `${name} récupéré hors du registre npm : ${snippet(b[name])}`);
        }
      }
    }
  }
  for (const file of files) {
    if (!/requirements[^/]*\.txt$|Cargo\.toml$/.test(file.path) || file.status === 'D') continue;
    for (const { text } of lines.get(file.path) || []) {
      const t = text.trim();
      if (!t || t.startsWith('#')) continue;
      depChanges.push({ manifest: file.path, name: snippet(t), from: null, to: '(ligne ajoutée)' });
      if (/(git\+|https?:\/\/)/.test(t) && /requirements/.test(file.path)) {
        add('critique', 'dependance-hors-registre', file.path, null, `paquet Python hors PyPI : ${snippet(t)}`);
      }
    }
  }

  // 4. Domaines jamais vus dans la révision de départ.
  // Un seul passage de git grep pour tous les domaines : un appel par
  // domaine coûtait une minute sur un diff d'un mois.
  const unknownHosts = [];
  if (newHosts.size) {
    const patterns = [...newHosts.keys()].flatMap((h) => ['-e', h]);
    const found = gitOrNull('grep', '-h', '-o', '-i', '-F', ...patterns, base, '--', '.') || '';
    const known = new Set(found.split('\n').map((h) => h.trim().toLowerCase()).filter(Boolean));
    for (const [host, where] of newHosts) {
      if (!known.has(host)) unknownHosts.push({ host, ...where });
    }
  }

  // 5. Nos personnalisations que l'amont modifie aussi.
  // Nos changements se mesurent depuis l'ancêtre commun avec la révision
  // analysée, pas depuis --base : sinon les changements de l'amont antérieurs
  // à notre fork passeraient pour les nôtres.
  let overlap = [];
  if (ours) {
    const common = (gitOrNull('merge-base', ours, head) || '').trim();
    if (common) {
      const mine = new Map(changedFiles(common, ours).map((f) => [f.path, f.status]));
      overlap = files
        .filter((f) => mine.has(f.path))
        .map((f) => ({ path: f.path, removedHere: mine.get(f.path) === 'D' }));
    }
  }

  return { files, findings, sensitiveTouched, depChanges, unknownHosts, overlap };
}

function safeJson(text) {
  if (text === null) return null;
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

// --- Rapport -----------------------------------------------------------------

// Le rapport finit dans une PR : tout ce qui vient du code analysé passe dans
// un span de code, sans accent grave possible, pour qu'aucun texte de l'amont
// ne puisse injecter de lien, de mention ou de mise en forme.
function code(text) {
  return `\`${String(text).replace(/`/g, 'ʼ').replace(/\r?\n/g, ' ')}\``;
}

function where(f) {
  return f.line ? `${code(`${f.path}:${f.line}`)}` : code(f.path);
}

const MAX_ROWS = 60;

function list(rows, render) {
  const shown = rows.slice(0, MAX_ROWS).map(render);
  if (rows.length > MAX_ROWS) shown.push(`- … et ${rows.length - MAX_ROWS} de plus`);
  return shown.join('\n');
}

function render(result, { base, head, mode }) {
  const { files, findings, sensitiveTouched, depChanges, unknownHosts, overlap } = result;
  const out = [];
  const nCrit = findings.critique.length;
  const nAtt = findings.attention.length;

  out.push('## Garde de sécurité');
  out.push('');
  out.push(nCrit
    ? `**🔴 ${nCrit} point(s) critique(s)** — à comprendre avant toute fusion.`
    : '**🟢 Aucun point critique détecté.** La relecture reste nécessaire : la garde trie, elle ne garantit rien.');
  out.push('');
  out.push(`Analyse de ${code(base.slice(0, 12))} → ${code(head.slice(0, 12))} : ${files.length} fichier(s) modifié(s), `
    + `${nAtt} point(s) d'attention, ${sensitiveTouched.length} fichier(s) sensible(s) touché(s).`);
  out.push('');

  if (mode === 'amont') {
    const log = gitOrNull('log', '--no-merges', '--format=%h %ad %s', '--date=short', `${base}..${head}`) || '';
    const commits = log.split('\n').filter(Boolean);
    out.push(`### Commits de l'amont (${commits.length})`);
    out.push('');
    out.push(list(commits, (c) => `- ${code(c.length > 120 ? `${c.slice(0, 117)}…` : c)}`));
    out.push('');
  }

  if (nCrit) {
    out.push('### 🔴 Critique');
    out.push('');
    out.push(list(findings.critique, (f) => `- **${f.rule}** ${where(f)} — ${code(f.detail)}`));
    out.push('');
  }

  if (overlap.length) {
    out.push(`### Fichiers personnalisés sur ce dépôt et modifiés par l'amont (${overlap.length})`);
    out.push('');
    out.push('Ce sont les endroits où une fusion peut annuler une protection ajoutée ici : relire chaque conflit, '
      + 'et garder notre version en cas de doute.');
    out.push('');
    out.push(list(overlap, (o) => `- ${code(o.path)}${o.removedHere ? ' — **supprimé ici** : garder la suppression' : ''}`));
    out.push('');
  }

  if (sensitiveTouched.length) {
    out.push(`### Fichiers sensibles touchés (${sensitiveTouched.length})`);
    out.push('');
    out.push(list(sensitiveTouched, (f) => `- ${code(f.path)} (${f.status}) — ${f.why}`));
    out.push('');
  }

  if (depChanges.length) {
    out.push(`### Dépendances (${depChanges.length})`);
    out.push('');
    out.push(list(depChanges, (d) => {
      const change = d.from && d.to ? `${d.from} → ${d.to}` : d.to ? `ajout ${d.to}` : `retrait ${d.from}`;
      return `- ${code(d.manifest)} ${code(d.name)} : ${code(change)}`;
    }));
    out.push('');
  }

  if (unknownHosts.length) {
    out.push(`### Domaines nouveaux dans le code (${unknownHosts.length})`);
    out.push('');
    out.push('Jamais vus dans la révision de départ. Normal pour un nouvel hébergeur ; à vérifier s\'il s\'agit '
      + 'd\'un script, d\'une régie ou d\'un service de mesure.');
    out.push('');
    out.push(list(unknownHosts, (h) => `- ${code(h.host)} — ${where(h)}`));
    out.push('');
  }

  if (nAtt) {
    out.push('### Points d\'attention');
    out.push('');
    out.push(list(findings.attention, (f) => `- **${f.rule}** ${where(f)} — ${code(f.detail)}`));
    out.push('');
  }

  out.push('<sub>Analyse statique uniquement : aucun code du diff n\'a été exécuté. '
    + 'Script : <code>.github/scripts/garde-securite.mjs</code>.</sub>');
  return out.join('\n');
}

// --- Point d'entrée ----------------------------------------------------------

const MAX_REPORT = 60000; // corps de PR GitHub : 65 536 caractères

function main() {
  const args = parseArgs(process.argv.slice(2));
  const base = resolveRev(args.base);
  const head = resolveRev(args.head);
  const ours = args.ours ? resolveRev(args.ours) : null;

  const result = analyse({ base, head, ours, mode: args.mode });
  let report = render(result, { base, head, mode: args.mode });
  if (report.length > MAX_REPORT) {
    report = `${report.slice(0, MAX_REPORT)}\n\n… rapport tronqué (voir le résumé du workflow).`;
  }

  if (args.out) writeFileSync(args.out, `${report}\n`);
  else process.stdout.write(`${report}\n`);

  const nCrit = result.findings.critique.length;
  if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, `${report}\n`);
  if (process.env.GITHUB_OUTPUT) {
    appendFileSync(process.env.GITHUB_OUTPUT, `critiques=${nCrit}\nattention=${result.findings.attention.length}\n`);
  }
  // Annotations visibles dans l'onglet « Files changed » de la PR. Elles
  // passent par stdout, que le rapport n'occupe pas quand --out est fourni.
  if (args.out && process.env.GITHUB_ACTIONS) {
    const prop = (v) => String(v).replace(/%/g, '%25').replace(/\r/g, '%0D').replace(/\n/g, '%0A')
      .replace(/:/g, '%3A').replace(/,/g, '%2C');
    const data = (v) => String(v).replace(/%/g, '%25').replace(/\r/g, '%0D').replace(/\n/g, '%0A');
    for (const f of result.findings.critique.slice(0, 20)) {
      const loc = f.line ? `file=${prop(f.path)},line=${f.line}` : `file=${prop(f.path)}`;
      process.stdout.write(`::error ${loc}::${data(`${f.rule} : ${f.detail}`)}\n`);
    }
  }

  if (args.mode === 'pr' && nCrit > 0) process.exit(2);
}

try {
  main();
} catch (error) {
  process.stderr.write(`garde-securite : ${error.message}\n`);
  process.exit(1);
}

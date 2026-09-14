// En-têtes de sécurité du frontend.
//
// Ils sont posés ici, dans le serveur Hono qui sert `dist/`, et non dans un
// fichier `public/_headers` : celui-ci n'est lu que par Cloudflare Pages, et
// ne s'applique donc pas à un déploiement Docker. Un `<meta>` CSP dans
// `index.html` ne conviendrait pas non plus — il ne peut pas porter
// `frame-ancestors`, qui est précisément la directive qui interdit qu'on
// encadre le site.
//
// ## Ce que cette CSP protège vraiment
//
// La menace n°1 de ce projet est un script tiers exécuté DANS notre origine :
// une régie publicitaire injectée dans `document.head` a accès au
// `localStorage`, donc au jeton d'authentification. `script-src` avec une
// liste blanche d'hôtes ferme cette porte : même si quelqu'un remet une URL
// de régie dans le `.env`, le navigateur refusera de la charger.
//
// ## Pourquoi `'unsafe-inline'` sur script-src
//
// `index.html` contient trois scripts inline indispensables au démarrage
// (polyfill `Object.hasOwn`, récupération de cache sur changement de build,
// chargeur Cast). Un nonce imposerait de réécrire le HTML à chaque requête.
// Le compromis est acceptable parce que `'unsafe-inline'` n'affaiblit PAS la
// liste blanche d'hôtes : aucun script externe non listé ne se charge, ce qui
// est la protection recherchée. Il n'existe par ailleurs aucun point
// d'injection HTML connu dans l'app (cf. audit, § 5).
//
// ## Pourquoi `frame-src https:` est large
//
// Les embeds viennent d'hébergeurs dont les domaines tournent en permanence
// (cf. `src/utils/hosterRegistry.ts` : 150+ alias pour Voe seul). Une liste
// blanche serait cassée en permanence. Ce qui confine réellement ces iframes,
// c'est leur attribut `sandbox` (`src/utils/embedSandbox.ts`), pas la CSP.
//
// ## Pourquoi `connect-src` est large
//
// L'extraction côté client contacte directement les hébergeurs pour résoudre
// les flux. Restreindre `connect-src` casserait la lecture. C'est le choix
// assumé le plus faible de cette politique — resserrable via
// `CSP_CONNECT_SRC` si l'extraction passe entièrement côté serveur.
//
// Toutes les directives sont surchargeables par variable d'environnement, et
// `CSP_DISABLED=true` coupe la CSP le temps d'un diagnostic.

const env = (name, fallback) => {
  const raw = (process.env[name] ?? '').trim();
  return raw.length > 0 ? raw : fallback;
};

/** Origines des services Movix, à autoriser en `connect-src`. */
const serviceOrigins = () =>
  [
    process.env.VITE_MAIN_API,
    process.env.VITE_WATCHPARTY_API,
    process.env.VITE_PROXIES_EMBED_API,
  ]
    .map((value) => (value ?? '').trim())
    .filter(Boolean)
    .map((value) => {
      try {
        return new URL(value).origin;
      } catch {
        return '';
      }
    })
    .filter(Boolean);

const buildCsp = () => {
  const services = serviceOrigins().join(' ');

  const directives = {
    'default-src': env('CSP_DEFAULT_SRC', "'self'"),

    // Aucun script externe hors Turnstile (anti-bot) et gstatic (SDK Cast).
    // C'est la directive qui bloquerait une régie publicitaire.
    'script-src': env(
      'CSP_SCRIPT_SRC',
      "'self' 'unsafe-inline' https://challenges.cloudflare.com https://www.gstatic.com"
    ),

    'style-src': env('CSP_STYLE_SRC', "'self' 'unsafe-inline' https://fonts.googleapis.com"),
    'font-src': env('CSP_FONT_SRC', "'self' https://fonts.gstatic.com data:"),

    // Affiches TMDB + avatars + images d'hébergeurs.
    'img-src': env('CSP_IMG_SRC', "'self' data: blob: https:"),

    // Flux vidéo : blob (MSE/HLS.js), plus les CDN des hébergeurs.
    'media-src': env('CSP_MEDIA_SRC', "'self' blob: data: https:"),

    'connect-src': env(
      'CSP_CONNECT_SRC',
      `'self' blob: data: https: wss: ${services}`.trim()
    ),

    // Les embeds sont confinés par leur attribut `sandbox`, pas par la CSP.
    'frame-src': env('CSP_FRAME_SRC', 'https:'),

    'worker-src': env('CSP_WORKER_SRC', "'self' blob:"),
    'manifest-src': env('CSP_MANIFEST_SRC', "'self'"),

    // Durcissements sans contrepartie fonctionnelle.
    'object-src': "'none'",   // pas de <object>/<embed>/Flash
    'base-uri': "'none'",     // interdit de réécrire la base des URLs relatives
    'form-action': "'self'",  // un formulaire ne peut pas poster ailleurs
    'frame-ancestors': "'none'", // personne ne peut encadrer le site (clickjacking)
  };

  return Object.entries(directives)
    .filter(([, value]) => value && value.length > 0)
    .map(([name, value]) => `${name} ${value}`)
    .join('; ');
};

const CSP = buildCsp();
const CSP_ENABLED = (process.env.CSP_DISABLED ?? '').trim().toLowerCase() !== 'true';

/**
 * Middleware Hono. À monter avant tout ce qui répond, pour que les en-têtes
 * couvrent aussi les réponses statiques et la page d'index.
 */
export const securityHeaders = async (c, next) => {
  await next();

  if (CSP_ENABLED) {
    c.header('Content-Security-Policy', CSP);
  }

  // Empêche le navigateur de deviner un type MIME (un .json servi par erreur
  // comme du HTML deviendrait exécutable).
  c.header('X-Content-Type-Options', 'nosniff');

  // Doublon volontaire de `frame-ancestors` pour les navigateurs anciens.
  c.header('X-Frame-Options', 'DENY');

  // Ne fuite que l'origine vers les tiers, jamais le chemin (donc jamais le
  // titre regardé) — les hébergeurs reçoivent le Referer de nos iframes.
  c.header('Referrer-Policy', 'strict-origin-when-cross-origin');

  // Aucune de ces API n'est utilisée par l'app.
  c.header(
    'Permissions-Policy',
    'camera=(), microphone=(), geolocation=(), interest-cohort=(), payment=()'
  );

  // Isole l'onglet : une fenêtre ouverte par un embed ne garde pas de
  // référence exploitable vers le nôtre.
  c.header('Cross-Origin-Opener-Policy', 'same-origin-allow-popups');
};

export const cspReport = () => ({ enabled: CSP_ENABLED, policy: CSP });

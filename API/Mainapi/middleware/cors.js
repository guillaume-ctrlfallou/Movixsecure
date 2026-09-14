/**
 * CORS middleware configuration.
 * Extracted from server.js -- restricted origin policy.
 */

const cors = require("cors");
const { getOAuthAllowedCorsOrigins } = require('../utils/oauthClients');

// Domaines autorises, pilotes par l'environnement.
//
// La liste etait codee en dur et contenait des domaines tiers
// (nakios.site, cinezo.site, cinezo.online, filmib.cc) : des origines
// exterieures au projet, autorisees a appeler l'API avec `credentials: true`.
// Sur un deploiement personnel elles n'ont rien a y faire, et il ne devrait
// pas falloir modifier le code pour s'en debarrasser.
//
// ALLOWED_ORIGINS (liste separee par des virgules, hostnames sans protocole)
// remplace entierement la liste par defaut quand elle est renseignee.
// Les sous-domaines de chaque entree sont acceptes.
const DEFAULT_ALLOWED_DOMAINS = [
    'localhost:3000',
    'movix.blog',
    'movix.rodeo',
    'movix.club',
    'movix.site',
    'movix11.pages.dev',
    'nakios.site',
    'cinezo.site',
    'cinezo.online',
    'filmib.cc',
    'movix.llc',
    'movix.cash',
    'movix.tax',
    'movix.cloud',
    'movix.golf',
    'movix.chat',
    'movix.date',
    'movix.show',
    'movix.fun'
];

function resolveAllowedDomains() {
    const raw = (process.env.ALLOWED_ORIGINS || '').trim();
    if (!raw) return DEFAULT_ALLOWED_DOMAINS;
    const parsed = raw
        .split(',')
        .map((entry) => entry.trim().replace(/^https?:\/\//i, '').replace(/\/+$/, ''))
        .filter(Boolean);
    return parsed.length > 0 ? parsed : DEFAULT_ALLOWED_DOMAINS;
}

const STATIC_ALLOWED_DOMAINS = resolveAllowedDomains();

function isAllowedStaticOrigin(origin) {
  try {
    const parsedOrigin = new URL(origin);
    const hostname = parsedOrigin.hostname;

    return STATIC_ALLOWED_DOMAINS.some((domain) => (
      hostname === domain || hostname.endsWith(`.${domain}`)
    ));
  } catch {
    return false;
  }
}

function isAllowedOAuthOrigin(origin) {
  return getOAuthAllowedCorsOrigins().includes(origin);
}

const corsMiddleware = cors({
  origin: (origin, callback) => {
    // Allow requests with no origin (like mobile apps or curl requests)
    if (!origin) return callback(null, true);

    // Allow all localhost requests in development only
    if (process.env.NODE_ENV !== 'production' && origin.match(/^https?:\/\/localhost(:[0-9]+)?$/)) {
      return callback(null, true);
    }

    if (isAllowedStaticOrigin(origin) || isAllowedOAuthOrigin(origin)) {
      callback(null, true);
    } else {
      callback(new Error("Not allowed by CORS"));
    }
  },
  methods: ["GET", "POST", "OPTIONS", "PUT", "DELETE", "PATCH", "HEAD"],
  allowedHeaders: [
    "Content-Type",
    "Authorization",
    "X-Requested-With",
    "Accept",
    "Origin",
    "X-No-Compression",
    "Access-Control-Request-Headers",
    "baggage",
    "sentry-trace",
    "x-profile-id",
    "x-access-key",
    "x-movix-client-id",
  ],
  credentials: true,
  optionsSuccessStatus: 204,
});

module.exports = corsMiddleware;

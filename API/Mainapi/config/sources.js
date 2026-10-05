/**
 * Domaines des sites sources — point unique de configuration.
 *
 * ## Pourquoi
 *
 * Les sites sources changent de domaine regulierement. Quand l'un d'eux
 * demenage, tous les films qu'il servait perdent leurs lecteurs, alors que le
 * catalogue (TMDB) continue de les afficher.
 *
 * Avant ce module, les domaines etaient eparpilles :
 *   - six etaient codes en dur (FStream, FrenchStream, PurStream, VoirDrama,
 *     Anime-Sama, et Coflix cote requetes) : un demenagement demandait une
 *     modification de code ;
 *   - Coflix avait TROIS valeurs par defaut differentes selon le fichier
 *     (`coflix.date` dans app.js, `coflix.esq` dans proxyManager.js,
 *     `coflix.boston` dans routes/coflix.js). Pire, app.js transmettait aux
 *     routes sa valeur en dur : renseigner COFLIX_BASE_URL ne changeait que
 *     l'en-tete Referer, pas le domaine interroge.
 *
 * Desormais chaque source a UNE variable d'environnement et UNE valeur par
 * defaut, ici. Un demenagement = une ligne de `.env` puis
 * `docker compose up -d mainapi`, sans rebuild.
 *
 * Une variable presente mais vide (cas de `${X:-}` dans docker-compose) est
 * traitee comme absente : la valeur par defaut s'applique.
 *
 * ## Supabase (optionnel)
 *
 * Avec SUPABASE_URL et SUPABASE_SECRET_KEY, la table `source_domains` du
 * projet peut aussi fournir un domaine — modifiable depuis le tableau de bord
 * Supabase, donc depuis un telephone. Ordre de priorite :
 *
 *   1. la variable du `.env` si elle est renseignee ;
 *   2. sinon l'URL de `source_domains` ;
 *   3. sinon la valeur par defaut ci-dessous.
 *
 * C'est le processus maitre (server.js) qui lit la table et place les valeurs
 * dans l'environnement des workers : le reste du code ne voit que des
 * variables d'environnement, comme avant. MOVIX_SOURCES_SUPABASE liste les
 * sources ainsi fournies, pour le journal de demarrage.
 */

const SOURCES = Object.freeze({
  wiflix:          { env: 'WIFLIX_BASE_URL',       fallback: 'https://flemmix.fast' },
  coflix:          { env: 'COFLIX_BASE_URL',       fallback: 'https://coflix.date' },
  cinestream:      { env: 'CINESTREAM_BASE_URL',   fallback: 'https://cinestream.info' },
  darkiworld:      { env: 'DARKIWORLD_BASE_URL',   fallback: 'https://darkiworld2026.com' },
  fstream:         { env: 'FSTREAM_BASE_URL',      fallback: 'https://french-stream.one' },
  frenchstream:    { env: 'FRENCHSTREAM_BASE_URL', fallback: 'https://frenchstream.food' },
  voirdrama:       { env: 'VOIRDRAMA_BASE_URL',    fallback: 'https://voirdrama.to' },
  animeSama:       { env: 'ANIME_SAMA_BASE_URL',   fallback: 'https://anime-sama.to' },
  // PurStream decouvre son domaine d'API tout seul via cette page de statut ;
  // la base n'est qu'un repli si la page est injoignable.
  purstreamStatus: { env: 'PURSTREAM_STATUS_URL',  fallback: 'https://purstream.wiki/api/status', path: true },
  purstreamApi:    { env: 'PURSTREAM_API_BASE',    fallback: 'https://api.purstream.id/api/v1', path: true },
});

/**
 * Normalise une URL de base : http(s) obligatoire, sans slash final. Une
 * valeur invalide est ignoree avec un avertissement plutot que de faire
 * tomber le serveur au demarrage — la source retombe sur son defaut.
 */
const warned = new Set();

function normalize(id, raw, keepPath) {
  const value = String(raw ?? '').trim().replace(/\/+$/, '');
  if (!value) return null;
  try {
    const url = new URL(value);
    if (url.protocol !== 'https:' && url.protocol !== 'http:') throw new Error('protocole');
    return keepPath ? value : url.origin;
  } catch {
    if (!warned.has(id)) {
      warned.add(id);
      console.warn(`[sources] ${SOURCES[id].env}="${value}" invalide, defaut utilise : ${SOURCES[id].fallback}`);
    }
    return null;
  }
}

/** URL de base d'une source, sans slash final. */
function sourceUrl(id) {
  const def = SOURCES[id];
  if (!def) throw new Error(`Source inconnue : ${id}`);
  return normalize(id, process.env[def.env], def.path) || def.fallback;
}

/** Nom d'hote d'une source (sans protocole). */
function sourceHost(id) {
  return new URL(sourceUrl(id)).host;
}

/**
 * Tableau recapitulatif, journalise au demarrage. `origin` vaut 'env',
 * 'supabase', ou null pour la valeur par defaut.
 */
function describeSources() {
  const fromSupabase = new Set(String(process.env.MOVIX_SOURCES_SUPABASE || '').split(',').filter(Boolean));
  return Object.keys(SOURCES).map((id) => {
    const def = SOURCES[id];
    const overridden = Boolean(normalize(id, process.env[def.env], def.path));
    const origin = !overridden ? null : fromSupabase.has(id) ? 'supabase' : 'env';
    return { id, env: def.env, url: sourceUrl(id), overridden, origin };
  });
}

/**
 * Calcule l'environnement a donner aux workers a partir des lignes de
 * `source_domains` ({ id, url }). Fonction pure : n'ecrit rien.
 *
 * `bootEnv` est l'environnement d'origine du maitre : une variable qui y est
 * renseignee garde la priorite, Supabase ne la remplace jamais. Une URL
 * invalide est ecartee (avec avertissement), la source garde son defaut.
 *
 * Renvoie { env, fromSupabase } : `env` associe chaque variable concernee a
 * sa valeur (ou a undefined pour revenir a l'etat d'origine).
 */
function resolveRemoteSources(rows, bootEnv) {
  const byId = new Map();
  for (const row of Array.isArray(rows) ? rows : []) {
    if (row && typeof row.id === 'string' && Object.hasOwn(SOURCES, row.id)) byId.set(row.id, row.url);
  }

  const env = {};
  const fromSupabase = [];
  for (const [id, def] of Object.entries(SOURCES)) {
    const local = String(bootEnv[def.env] ?? '').trim();
    if (local) continue; // le .env garde la main
    const remote = normalize(id, byId.get(id), def.path);
    if (remote) {
      env[def.env] = remote;
      fromSupabase.push(id);
    } else {
      env[def.env] = bootEnv[def.env]; // undefined ou vide : defaut du code
    }
  }
  env.MOVIX_SOURCES_SUPABASE = fromSupabase.join(',');
  return { env, fromSupabase };
}

module.exports = { SOURCES, sourceUrl, sourceHost, describeSources, resolveRemoteSources };

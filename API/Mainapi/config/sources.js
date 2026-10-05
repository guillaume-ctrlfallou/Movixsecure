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

/** Tableau recapitulatif, journalise au demarrage. */
function describeSources() {
  return Object.keys(SOURCES).map((id) => {
    const def = SOURCES[id];
    const overridden = Boolean(normalize(id, process.env[def.env], def.path));
    return { id, env: def.env, url: sourceUrl(id), overridden };
  });
}

module.exports = { SOURCES, sourceUrl, sourceHost, describeSources };

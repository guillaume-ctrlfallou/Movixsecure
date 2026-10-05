/**
 * Supabase dans le processus maitre du cluster : domaines des sources et
 * miroir de data/users/. Charge par server.js AVANT le lancement des workers.
 *
 * Volontairement leger (fs, fetch, write-file-atomic) : le maitre ne charge
 * ni Express, ni MySQL, ni Redis.
 *
 * Variables :
 *   SUPABASE_URL                 https://<ref>.supabase.co
 *   SUPABASE_SECRET_KEY          cle secrete (sb_secret_…), jamais la publique
 *   SUPABASE_MIRROR              « off » coupe le miroir, garde les domaines
 *   SUPABASE_SYNC_INTERVAL_MS    periode du miroir (defaut 2 min)
 *
 * Sans SUPABASE_URL ni cle : rien ne change, tout reste local.
 */

const path = require('path');
const { SOURCES, resolveRemoteSources } = require('../config/sources');
const { createSupabaseRest, readSupabaseConfig } = require('./supabaseRest');
const { createUserFilesMirror } = require('./supabaseMirror');

const DATA_DIR = path.join(__dirname, '..', 'data');
const USERS_DIR = path.join(DATA_DIR, 'users');
const CONFLICT_DIR = path.join(DATA_DIR, 'users-conflits');

const DEFAULT_SYNC_INTERVAL_MS = 2 * 60 * 1000;
// Les domaines sont relus tous les N cycles (10 min par defaut). Cette
// lecture suffit aussi a garder le projet gratuit eveille : Supabase met en
// pause un projet sans activite pendant 7 jours.
const SOURCES_EVERY_N_TICKS = 5;
const BOOT_TIMEOUT_MS = 30 * 1000;

function createSupabaseMaster({ log = console } = {}) {
  let config;
  try {
    config = readSupabaseConfig();
  } catch (error) {
    log.error(`[supabase] configuration ignoree : ${error.message}`);
    return null;
  }
  if (!config) return null;

  const rest = createSupabaseRest(config);
  const mirror = String(process.env.SUPABASE_MIRROR || '').trim().toLowerCase() === 'off'
    ? null
    : createUserFilesMirror({ rest, root: USERS_DIR, conflictDir: CONFLICT_DIR, log });

  const intervalMs = (() => {
    const parsed = parseInt(process.env.SUPABASE_SYNC_INTERVAL_MS, 10);
    return Number.isFinite(parsed) && parsed >= 10000 ? parsed : DEFAULT_SYNC_INTERVAL_MS;
  })();

  // Environnement d'origine : une variable renseignee ici garde la priorite
  // sur Supabase, meme apres que le maitre a modifie process.env.
  const bootEnv = {};
  for (const def of Object.values(SOURCES)) bootEnv[def.env] = process.env[def.env];
  let appliedKey = JSON.stringify(resolveRemoteSources([], bootEnv).env);
  let lastSourcesError = null;

  /** Relit source_domains ; renvoie true si l'environnement a change. */
  async function refreshSources() {
    let rows;
    try {
      rows = await rest.select('source_domains', 'select=id,url');
      lastSourcesError = null;
    } catch (error) {
      if (error.message !== lastSourcesError) {
        log.warn(`[supabase] domaines des sources non lus : ${error.message}`);
        lastSourcesError = error.message;
      }
      return false;
    }
    const { env, fromSupabase } = resolveRemoteSources(rows, bootEnv);
    const key = JSON.stringify(env);
    if (key === appliedKey) return false;

    for (const [name, value] of Object.entries(env)) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
    appliedKey = key;
    log.log(`[supabase] domaines des sources : ${fromSupabase.length ? fromSupabase.join(', ') : 'aucun'} fourni(s) par Supabase`);
    return true;
  }

  /**
   * A attendre avant de lancer les workers : domaines a jour et comptes
   * restaures. Borne a 30 s : un Supabase injoignable ne bloque pas le site,
   * il sera rattrape au cycle suivant.
   */
  async function boot() {
    log.log(`[supabase] active (${new URL(config.url).host}) — miroir ${mirror ? 'actif' : 'coupe (SUPABASE_MIRROR=off)'}`);
    // Releve local hors delai : il doit preceder tout worker.
    if (mirror) await mirror.snapshotBoot();
    let timer;
    const timeout = new Promise((resolve) => {
      timer = setTimeout(() => {
        log.warn('[supabase] demarrage sans attendre Supabase (30 s ecoulees) : synchronisation au prochain cycle');
        resolve();
      }, BOOT_TIMEOUT_MS);
    });
    const work = (async () => {
      await refreshSources();
      if (mirror) await mirror.tick();
    })();
    await Promise.race([work, timeout]);
    clearTimeout(timer);
  }

  /** Cycle periodique ; onSourcesChanged est appele si un domaine change. */
  function start({ onSourcesChanged }) {
    let ticks = 0;
    let running = false;
    const timer = setInterval(async () => {
      if (running) return; // un cycle lent ne se chevauche pas avec le suivant
      running = true;
      try {
        ticks += 1;
        if (mirror) await mirror.tick();
        if (ticks % SOURCES_EVERY_N_TICKS === 0 && await refreshSources()) onSourcesChanged();
      } finally {
        running = false;
      }
    }, intervalMs);
    timer.unref();
    return () => clearInterval(timer);
  }

  return { boot, start };
}

module.exports = { createSupabaseMaster };

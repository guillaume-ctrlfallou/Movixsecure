/**
 * Miroir de data/users/ (comptes, profils, historique, progression, favoris)
 * dans la table Supabase `user_files`.
 *
 * ## Principe
 *
 * Le disque reste la source de verite : les routes lisent et ecrivent leurs
 * fichiers JSON comme avant, aucune n'est modifiee. Le processus maitre du
 * cluster recopie ces fichiers dans Supabase :
 *
 *   - au demarrage, AVANT de lancer les workers, une reconciliation dans les
 *     deux sens : un fichier present seulement dans Supabase est restaure sur
 *     le disque. Un serveur reinstalle avec les memes cles Supabase retrouve
 *     donc ses comptes et ses historiques tout seul ;
 *   - ensuite, toutes les deux minutes, les fichiers modifies sont envoyes et
 *     les fichiers supprimes (profil supprime…) sont marques comme tels.
 *
 * La date de modification du fichier, en millisecondes, sert de version :
 * Supabase refuse une ecriture plus ancienne que celle qu'il a deja
 * (fonction SQL mirror_put).
 *
 * ## Le cas dangereux : un serveur neuf alors que Supabase dort
 *
 * Un projet gratuit se met en pause apres 7 jours sans activite — typiquement
 * pendant qu'un serveur en panne attend d'etre reinstalle. Si le serveur neuf
 * demarre sans joindre Supabase, une connexion recree un compte VIDE, plus
 * recent que la copie complete de Supabase. L'envoyer ecraserait l'historique.
 *
 * D'ou la regle : un fichier plus recent que Supabase n'est envoye que s'il
 * existait deja au demarrage du serveur. S'il est apparu depuis alors que
 * Supabase en a une copie, c'est Supabase qui gagne ; le fichier local est
 * mis de cote dans data/users-conflits/, rien n'est perdu.
 *
 * Un seul serveur par projet Supabase : le miroir n'est pas concu pour que
 * deux instances ecrivent les memes comptes.
 */

const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const writeFileAtomic = require('write-file-atomic');

// Meme forme que la contrainte SQL de user_files.path.
const PATH_RE = /^[A-Za-z0-9_][A-Za-z0-9._/-]*\.json$/;
const MAX_PATH_LENGTH = 512;
// Le plus gros fichier legitime est un profil, plafonne a 5 Mo par
// utils/syncPolicy.js. Au-dela, ce n'est pas un fichier de l'application.
const MAX_FILE_BYTES = 6 * 1024 * 1024;
const PUSH_CONCURRENCY = 4;

function isMirrorablePath(rel) {
  return rel.length <= MAX_PATH_LENGTH && PATH_RE.test(rel) && !rel.includes('..') && !rel.includes('//');
}

// Version d'un fichier : sa date de modification en millisecondes, ARRONDIE.
// Une date reposee par utimes() relit 703,9999 au lieu de 704 (precision des
// flottants) : tronquer ferait paraitre chaque fichier restaure plus ancien
// que Supabase, et tout serait retelecharge a chaque demarrage.
function versionOf(stat) {
  return Math.round(stat.mtimeMs);
}

async function scanLocal(root) {
  const files = new Map();
  async function walk(dir, prefix) {
    let entries;
    try {
      entries = await fsp.readdir(dir, { withFileTypes: true });
    } catch (error) {
      if (error.code === 'ENOENT') return;
      throw error;
    }
    for (const entry of entries) {
      const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
      const abs = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        await walk(abs, rel);
      } else if (entry.isFile() && isMirrorablePath(rel)) {
        // Les fichiers temporaires de write-file-atomic (« x.json.123 ») ne
        // finissent pas par .json : ils sont ignores ici.
        try {
          const stat = await fsp.stat(abs);
          if (stat.size <= MAX_FILE_BYTES) files.set(rel, versionOf(stat));
        } catch { /* supprime entre readdir et stat */ }
      }
    }
  }
  await walk(root, '');
  return files;
}

async function runPool(items, worker, concurrency = PUSH_CONCURRENCY) {
  const queue = items.slice();
  const runners = Array.from({ length: Math.min(concurrency, queue.length) }, async () => {
    while (queue.length) await worker(queue.shift());
  });
  await Promise.all(runners);
}

function createUserFilesMirror({ rest, root, conflictDir, log = console }) {
  const state = {
    ready: false,
    bootFiles: null,  // Set des fichiers presents au demarrage
    remote: new Map(), // path -> { version, deleted }
    seen: new Map(),   // path -> version locale deja alignee avec Supabase
    lastError: null,
  };

  function reportError(context, error) {
    const message = `${context} : ${error.message}`;
    if (message !== state.lastError) {
      log.warn(`[supabase] ${message}`);
      state.lastError = message;
    }
  }

  function clearError() {
    if (state.lastError) {
      log.log('[supabase] connexion retablie');
      state.lastError = null;
    }
  }

  function absolute(rel) {
    const abs = path.resolve(root, rel);
    if (!abs.startsWith(path.resolve(root) + path.sep)) throw new Error(`chemin hors de data/users : ${rel}`);
    return abs;
  }

  async function push(rel, version) {
    const raw = await fsp.readFile(absolute(rel), 'utf8');
    let content;
    try {
      content = JSON.parse(raw);
    } catch {
      log.warn(`[supabase] ${rel} n'est pas du JSON valide : non recopie`);
      state.seen.set(rel, version);
      return false;
    }
    const written = await rest.rpc('mirror_put', { p_path: rel, p_content: content, p_version: version });
    if (!written) {
      // Supabase a deja une version egale ou plus recente : rien a faire.
      const known = state.remote.get(rel);
      if (known && known.version > version) {
        log.warn(`[supabase] ${rel} : Supabase a une version plus recente que le disque, non ecrasee`);
      }
    }
    state.remote.set(rel, { version: Math.max(version, state.remote.get(rel)?.version || 0), deleted: false });
    state.seen.set(rel, version);
    return true;
  }

  async function pull(rel) {
    const rows = await rest.select('user_files', `select=content,version,deleted&path=eq.${encodeURIComponent(rel)}`);
    const row = rows[0];
    if (!row || row.deleted || row.content === null) return false;
    const abs = absolute(rel);
    await fsp.mkdir(path.dirname(abs), { recursive: true });
    await writeFileAtomic(abs, JSON.stringify(row.content), { mode: 0o644 });
    const when = new Date(Number(row.version));
    await fsp.utimes(abs, when, when);
    state.remote.set(rel, { version: Number(row.version), deleted: false });
    state.seen.set(rel, versionOf(await fsp.stat(abs)));
    return true;
  }

  async function setAside(rel) {
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    const target = path.join(conflictDir, `${rel}.${stamp}`);
    await fsp.mkdir(path.dirname(target), { recursive: true });
    await fsp.copyFile(absolute(rel), target);
    return target;
  }

  /** Releve des fichiers presents avant le lancement des workers. */
  async function snapshotBoot() {
    state.bootFiles = new Set((await scanLocal(root)).keys());
    return state.bootFiles.size;
  }

  /**
   * Premiere reconciliation, dans les deux sens. Peut echouer (Supabase
   * injoignable) : elle sera retentee au cycle suivant, et rien n'est envoye
   * tant qu'elle n'a pas abouti.
   */
  async function reconcile() {
    if (!state.bootFiles) await snapshotBoot();
    const rows = await rest.selectAll('user_files', 'select=path,version,deleted&order=path.asc');
    state.remote = new Map();
    for (const row of rows) {
      // La contrainte SQL interdit deja ces chemins ; on ne s'y fie pas pour
      // ecrire sur le disque.
      if (typeof row.path !== 'string' || !isMirrorablePath(row.path)) {
        log.warn(`[supabase] ligne ignoree, chemin inattendu : ${JSON.stringify(String(row.path)).slice(0, 120)}`);
        continue;
      }
      state.remote.set(row.path, { version: Number(row.version), deleted: Boolean(row.deleted) });
    }
    const local = await scanLocal(root);
    const stats = { restored: 0, pushed: 0, conflicts: 0, deletedRemote: 0 };

    const toPull = [];
    const toPush = [];
    const conflicts = [];

    for (const [rel, remote] of state.remote) {
      const localVersion = local.get(rel);
      if (remote.deleted) {
        if (localVersion !== undefined && localVersion > remote.version) toPush.push(rel);
        else if (localVersion !== undefined) stats.deletedRemote += 1;
        continue;
      }
      if (localVersion === undefined || localVersion < remote.version) toPull.push(rel);
      else if (localVersion > remote.version) {
        if (state.bootFiles.has(rel)) toPush.push(rel);
        else conflicts.push(rel);
      } else {
        state.seen.set(rel, localVersion);
      }
    }
    for (const rel of local.keys()) {
      if (!state.remote.has(rel)) toPush.push(rel);
    }

    for (const rel of conflicts) {
      const saved = await setAside(rel);
      log.warn(`[supabase] ${rel} recree depuis le demarrage alors que Supabase en a une copie : copie Supabase restauree, version locale mise de cote dans ${saved}`);
      toPull.push(rel);
      stats.conflicts += 1;
    }

    await runPool(toPull, async (rel) => {
      if (await pull(rel)) stats.restored += 1;
    });
    await runPool(toPush, async (rel) => {
      const version = local.get(rel);
      if (version === undefined) return;
      if (await push(rel, version)) stats.pushed += 1;
    });

    // Les fichiers deja alignes, ou plus anciens qu'une suppression enregistree
    // dans Supabase, sont consideres comme vus : seule une modification
    // ulterieure les renverra.
    for (const [rel, version] of local) {
      if (!state.seen.has(rel)) state.seen.set(rel, version);
    }

    state.ready = true;
    clearError();
    return { ...stats, local: local.size, remote: rows.length };
  }

  /** Cycle periodique : envoie les modifications et les suppressions. */
  async function sync() {
    const local = await scanLocal(root);
    const changed = [];
    for (const [rel, version] of local) {
      if (state.seen.get(rel) !== version) changed.push(rel);
    }
    const removed = [...state.seen.keys()].filter((rel) => !local.has(rel));

    let pushed = 0;
    let deleted = 0;
    await runPool(changed, async (rel) => {
      const version = local.get(rel);
      try {
        if (await push(rel, version)) pushed += 1;
      } catch (error) {
        if (error.code === 'ENOENT') return; // supprime entre-temps
        throw error;
      }
    });
    for (const rel of removed) {
      await rest.rpc('mirror_delete', { p_path: rel, p_version: Date.now() });
      state.seen.delete(rel);
      state.remote.set(rel, { version: Date.now(), deleted: true });
      deleted += 1;
    }
    clearError();
    return { pushed, deleted };
  }

  /**
   * Un tour : reconciliation tant qu'elle n'a pas abouti, puis cycles
   * normaux. Ne leve jamais : une erreur est journalisee une fois et le tour
   * suivant reessaie.
   */
  async function tick() {
    try {
      if (!state.ready) {
        const stats = await reconcile();
        log.log(
          `[supabase] miroir pret : ${stats.local} fichier(s) sur le disque, ${stats.remote} dans Supabase, `
          + `${stats.restored} restaure(s), ${stats.pushed} envoye(s)`
          + (stats.conflicts ? `, ${stats.conflicts} conflit(s) mis de cote` : '')
          + (stats.deletedRemote ? `, ${stats.deletedRemote} supprime(s) dans Supabase mais present(s) sur le disque` : ''),
        );
        return stats;
      }
      const result = await sync();
      if (result.pushed || result.deleted) {
        log.log(`[supabase] miroir : ${result.pushed} envoye(s), ${result.deleted} suppression(s)`);
      }
      return result;
    } catch (error) {
      reportError(state.ready ? 'miroir' : 'reconciliation initiale', error);
      return null;
    }
  }

  return { snapshotBoot, reconcile, sync, tick, isReady: () => state.ready };
}

module.exports = { createUserFilesMirror, scanLocal, isMirrorablePath };

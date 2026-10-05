/**
 * Client REST minimal pour Supabase (PostgREST), sans dependance.
 *
 * Utilise la cle SECRETE du projet : il ne tourne que cote serveur, et
 * seulement dans le processus maitre du cluster (server.js). Rien ici ne doit
 * finir dans le bundle du frontend.
 *
 * Deux formats de cle acceptes :
 *   - sb_secret_…  (nouvelles cles) : en-tete apikey seul ;
 *   - eyJ…         (ancienne cle service_role, JWT) : apikey + Authorization.
 */

const DEFAULT_TIMEOUT_MS = 15000;

class SupabaseError extends Error {
  constructor(message, { status = 0, code = null } = {}) {
    super(message);
    this.name = 'SupabaseError';
    this.status = status;
    this.code = code;
  }
}

/**
 * Lit la configuration dans l'environnement. Renvoie null si Supabase n'est
 * pas configure (fonctionnalite desactivee), et leve une erreur explicite si
 * elle est configuree a moitie ou mal : mieux vaut un message clair au
 * demarrage qu'un miroir silencieusement inactif.
 */
function readSupabaseConfig(env = process.env) {
  const rawUrl = String(env.SUPABASE_URL || '').trim().replace(/\/+$/, '');
  const key = String(env.SUPABASE_SECRET_KEY || '').trim();

  if (!rawUrl && !key) return null;
  if (!rawUrl || !key) {
    throw new SupabaseError('SUPABASE_URL et SUPABASE_SECRET_KEY doivent etre renseignees ensemble');
  }

  let url;
  try {
    url = new URL(rawUrl);
  } catch {
    throw new SupabaseError(`SUPABASE_URL invalide : ${rawUrl}`);
  }
  if (url.protocol !== 'https:') {
    throw new SupabaseError('SUPABASE_URL doit etre en https');
  }
  if (key.startsWith('sb_publishable_')) {
    throw new SupabaseError(
      'SUPABASE_SECRET_KEY contient la cle PUBLIQUE (sb_publishable_…) : il faut la cle secrete (sb_secret_…)',
    );
  }
  if (!key.startsWith('sb_secret_') && !key.startsWith('eyJ')) {
    throw new SupabaseError('SUPABASE_SECRET_KEY ne ressemble pas a une cle secrete Supabase (sb_secret_…)');
  }

  return { url: url.origin, key };
}

function createSupabaseRest({ url, key, timeoutMs = DEFAULT_TIMEOUT_MS }) {
  const headers = {
    apikey: key,
    'Content-Type': 'application/json',
    Accept: 'application/json',
  };
  if (key.startsWith('eyJ')) headers.Authorization = `Bearer ${key}`;

  async function request(method, path, { body, extraHeaders } = {}) {
    let response;
    try {
      response = await fetch(`${url}/rest/v1/${path}`, {
        method,
        headers: { ...headers, ...extraHeaders },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (error) {
      const reason = error?.name === 'TimeoutError' ? `delai de ${timeoutMs} ms depasse` : (error?.cause?.code || error?.message);
      throw new SupabaseError(`Supabase injoignable (${reason})`);
    }

    const text = await response.text();
    if (!response.ok) {
      let detail = text.slice(0, 200);
      let code = null;
      try {
        const parsed = JSON.parse(text);
        detail = parsed.message || parsed.error || detail;
        code = parsed.code || null;
      } catch { /* corps non JSON (projet en pause, passerelle…) */ }
      throw new SupabaseError(`Supabase ${response.status} : ${detail}`, { status: response.status, code });
    }
    return text ? JSON.parse(text) : null;
  }

  return {
    /** Appel d'une fonction SQL exposee (POST /rpc/<nom>). */
    rpc(name, args) {
      return request('POST', `rpc/${encodeURIComponent(name)}`, { body: args });
    },

    /**
     * Lecture paginee d'une table. `query` est la partie apres le « ? »
     * (select=…, filtres) ; toutes les pages sont concatenees.
     */
    async selectAll(table, query, { pageSize = 1000 } = {}) {
      const rows = [];
      for (let offset = 0; ; offset += pageSize) {
        const page = await request('GET', `${encodeURIComponent(table)}?${query}&limit=${pageSize}&offset=${offset}`);
        rows.push(...page);
        if (page.length < pageSize) return rows;
      }
    },

    select(table, query) {
      return request('GET', `${encodeURIComponent(table)}?${query}`);
    },
  };
}

module.exports = { SupabaseError, createSupabaseRest, readSupabaseConfig };

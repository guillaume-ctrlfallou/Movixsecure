/**
 * Creation du schema complet au demarrage.
 *
 * ## Pourquoi ce module existe
 *
 * `db/schema/` decrit 35 tables, mais rien ne les creait toutes :
 *
 *   - `app.js` en creait 3 en dur (`user_sessions`, `link_submissions`,
 *     `download_links_history`) ;
 *   - une douzaine d'autres etaient creees paresseusement, chacune par la
 *     route qui s'en sert (commentaires, listes partagees, wrapped, VIP...) ;
 *   - `ensureTableGroup` ne couvrait que le groupe `oauth` ;
 *   - `runDatabaseInitialization` (db/initDatabase.js) sait le faire, mais
 *     n'est appele nulle part.
 *
 * Resultat sur une base neuve : 17 tables manquaient, dont `access_keys`
 * (les cles VIP), `admins`, `comments`, `likes` et toute la famille
 * `wishboard_*`. Les routes concernees echouaient au premier appel, avec une
 * erreur SQL qui ne dit pas qu'il s'agit d'un probleme d'installation.
 *
 * Ce module ferme le trou : il rejoue `CREATE TABLE IF NOT EXISTS` pour
 * l'integralite du schema declare, a chaque demarrage.
 *
 * ## Proprietes
 *
 * **Idempotent.** `renderCreateTable` emet toujours `IF NOT EXISTS`
 * (db/schema/helpers.js) : sur une base deja peuplee, chaque instruction est
 * un non-evenement. Ce module ne fait que creer — il ne modifie ni ne
 * supprime jamais une table existante. Faire evoluer une table deja creee
 * reste du ressort de `db/initDatabase.js`.
 *
 * **Ordonne.** Les tables sont creees dans l'ordre de declaration du schema,
 * qui place les references avant leurs dependantes (`comments` avant
 * `comment_replies`). Une cle etrangere vers une table absente ferait
 * echouer la creation : l'echec est journalise et la boucle continue, pour
 * qu'une seule table en defaut n'empeche pas les 34 autres d'exister.
 *
 * **Appele sous verrou.** L'exclusion entre workers du cluster n'est PAS
 * geree ici : `app.js` appelle cette fonction a l'interieur de
 * `withMysqlAdvisoryLock`, le verrou d'avis MySQL que le projet utilise deja
 * pour son bootstrap. Ne pas appeler ce module hors de ce verrou — plusieurs
 * workers emettant le meme DDL simultanement se disputent les verrous de
 * metadonnees de MySQL.
 */

const { schema, renderCreateTable } = require('./schema');

/**
 * Cree toutes les tables declarees dans `db/schema/`.
 *
 * @param {import('mysql2/promise').Pool} pool  Pool MySQL initialise.
 * @param {{ log: Function, error: Function }} [logger]
 * @returns {Promise<{ created: number, failures: Array<{table: string, message: string}> }>}
 */
async function bootstrapSchema(pool, logger = console) {
  if (!pool || typeof pool.query !== 'function') {
    throw new Error('Pool MySQL invalide pour le bootstrap du schema');
  }

  let created = 0;
  const failures = [];

  for (const table of schema) {
    try {
      // `query` et non `execute` : les instructions DDL n'ont pas de
      // parametres, et le protocole de requetes preparees refuse certaines
      // d'entre elles.
      await pool.query(renderCreateTable(table));
      created += 1;
    } catch (error) {
      failures.push({ table: table.name, message: error?.message || String(error) });
    }
  }

  if (failures.length > 0) {
    logger.error(
      `[Bootstrap] Schema : ${failures.length}/${schema.length} table(s) en echec — ` +
        failures.map((f) => `${f.table} (${f.message})`).join(' | '),
    );
  } else {
    logger.log(`[Bootstrap] Schema : ${created} tables verifiees.`);
  }

  return { created, failures };
}

module.exports = { bootstrapSchema };

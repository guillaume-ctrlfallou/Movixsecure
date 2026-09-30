/**
 * Inscription en base de la cle VIP d'une instance auto-hebergee.
 *
 * ## Pourquoi
 *
 * Sur le projet d'origine, le VIP est un produit : une cle achetee, delivree
 * par `utils/vipDonations.js`, saisie a la main. Sur une instance personnelle
 * il n'a plus rien d'un produit. Il conditionne l'extraction cote serveur —
 * c'est-a-dire le mode de lecture le plus sur, ou la page de l'hebergeur n'est
 * jamais chargee — et l'acces a la source IPTV.
 *
 * L'obtenir demandait jusqu'ici une requete SQL a la main, puis une saisie
 * dans les reglages. Avec un piege au milieu : `expires_at` est en
 * millisecondes, et une valeur en secondes est acceptee par MySQL puis
 * refusee a l'usage comme « cle expiree ». Sans ces gestes, l'instance
 * restait dans le mode le moins sur.
 *
 * `SELFHOST_VIP_KEY` (generee par `deploy/setup.sh`) est desormais inscrite ici
 * a chaque demarrage. Le frontend recoit la meme valeur au build et la pose
 * dans le navigateur (`src/utils/selfhostVip.ts`).
 *
 * ## Proprietes
 *
 * **Sans expiration.** `expires_at = NULL`, que les deux verificateurs
 * (`checkVip.js` et `proxiesembed/server.py`) traitent comme « n'expire
 * jamais ». Le piege secondes/millisecondes ne peut donc pas se presenter.
 *
 * **Idempotent.** `ON DUPLICATE KEY UPDATE` sur l'index unique
 * `uq_access_keys_key_value` : redemarrer ne cree pas de doublon, et une cle
 * desactivee a la main est reactivee — c'est la configuration qui fait foi.
 *
 * **Rotation.** Les cles inscrites par ce module portent un libelle fixe dans
 * `duree_validite`. Changer `SELFHOST_VIP_KEY` desactive donc l'ancienne au
 * demarrage suivant. Les cles creees a la main ou achetees portent un autre
 * libelle et ne sont jamais touchees.
 *
 * **Ne fait jamais tomber le serveur.** Il est appele dans le bloc de
 * bootstrap d'`app.js`, dont toute exception est relancee et tue le worker.
 * Un echec est donc journalise et absorbe : sans cle, l'instance demarre
 * quand meme, en mode iframe.
 */

/** Libelle distinctif des cles inscrites par ce module. */
const SELFHOST_LABEL = 'auto-hebergement';

/** Une cle courte serait devinable : elle est figee dans le bundle public. */
const MIN_KEY_LENGTH = 16;
const MAX_KEY_LENGTH = 255; // VARCHAR(255) de access_keys.key_value

/**
 * @param {import('mysql2/promise').Pool} pool
 * @param {{ log: Function, error: Function }} [logger]
 * @param {string} [key] Par defaut `process.env.SELFHOST_VIP_KEY`.
 * @returns {Promise<{ provisioned: boolean, reason?: string, deactivated?: number }>}
 */
async function provisionSelfhostVip(pool, logger = console, key = process.env.SELFHOST_VIP_KEY) {
  const value = String(key ?? '').trim();

  if (!value) {
    return { provisioned: false, reason: 'not_configured' };
  }

  if (value.length < MIN_KEY_LENGTH || value.length > MAX_KEY_LENGTH) {
    logger.error(
      `[Bootstrap] SELFHOST_VIP_KEY ignoree : ${value.length} caracteres, ` +
        `attendu entre ${MIN_KEY_LENGTH} et ${MAX_KEY_LENGTH}. ` +
        `Relancer ./deploy/setup.sh pour en generer une.`,
    );
    return { provisioned: false, reason: 'invalid_length' };
  }

  try {
    await pool.query(
      `INSERT INTO access_keys (key_value, active, used, duree_validite, expires_at)
       VALUES (?, 1, 0, ?, NULL)
       ON DUPLICATE KEY UPDATE active = 1, expires_at = NULL, duree_validite = ?`,
      [value, SELFHOST_LABEL, SELFHOST_LABEL],
    );

    const [result] = await pool.query(
      `UPDATE access_keys SET active = 0
       WHERE duree_validite = ? AND key_value <> ? AND active = 1`,
      [SELFHOST_LABEL, value],
    );
    const deactivated = Number(result?.affectedRows) || 0;

    logger.log(
      `[Bootstrap] Cle VIP auto-hebergee active` +
        (deactivated ? ` (${deactivated} ancienne(s) desactivee(s)).` : '.'),
    );
    return { provisioned: true, deactivated };
  } catch (error) {
    logger.error('[Bootstrap] Cle VIP auto-hebergee non inscrite :', error?.message || error);
    return { provisioned: false, reason: 'error' };
  }
}

module.exports = { provisionSelfhostVip, SELFHOST_LABEL };

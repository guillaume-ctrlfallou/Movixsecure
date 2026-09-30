// Clé VIP d'une instance auto-hébergée, appliquée sans intervention.
//
// Sur le projet d'origine, le VIP est un produit : une clé achetée, saisie à
// la main dans les réglages. Sur une instance personnelle il n'a plus rien
// d'un produit — il conditionne l'extraction côté serveur, c'est-à-dire le
// mode de lecture le plus sûr : le flux arrive en direct et la page de
// l'hébergeur n'est jamais chargée, donc ses publicités non plus. Exiger une
// requête SQL puis une saisie manuelle pour l'obtenir laissait par défaut le
// mode le moins sûr.
//
// `deploy/setup.sh` génère une clé et la transmet des deux côtés :
//   - au serveur (`SELFHOST_VIP_KEY`), qui l'inscrit en base à chaque
//     démarrage — voir `API/Mainapi/db/selfhostVip.js` ;
//   - au build du frontend (`VITE_SELFHOST_VIP_KEY`), lue ici.
// Au chargement, si le navigateur n'a aucune clé, celle-ci est posée
// exactement comme le ferait une activation manuelle réussie
// (`AuthContext.verifyAccessCode`) : `access_code`, `access_code_expires`,
// `is_vip`. Les composants qui vérifient la clé au montage (en-tête, menu
// profil, contextes) la confirment ensuite auprès du serveur, et la révoquent
// s'il la refuse.
//
// ## Pourquoi ce module est importé en premier
//
// `main.tsx` l'importe avant tout le reste. Les imports ES s'évaluent dans
// l'ordre : la clé est donc en place avant qu'un seul module de l'application
// ne s'exécute. C'est nécessaire parce que `usesServerExtraction()` lit
// `is_vip` dès le premier chargement des sources — posée plus tard, la clé ne
// servirait qu'à partir du film suivant.
//
// ## Portée
//
// La valeur est figée dans le bundle, donc lisible par quiconque charge le
// site. C'est acceptable derrière Tailscale, où seuls tes appareils
// l'atteignent. Sur une instance exposée publiquement, laisser la variable
// vide : chaque visiteur serait VIP et pourrait se servir du serveur comme
// relais d'extraction. La clé n'ouvre rien d'autre — ni administration, ni
// secret du serveur.
//
// ## Quand on NE pose PAS la clé
//
//   - le navigateur en a déjà une (activée à la main, ou achetée ailleurs) ;
//   - l'utilisateur a retiré CETTE clé depuis les réglages : on respecte son
//     choix (marqueur posé par `markSelfhostVipDismissed`).
//
// Un refus du serveur, lui, ne pose pas de marqueur : la clé est reposée au
// chargement suivant. C'est ce qui rattrape un premier démarrage où le
// frontend aurait été servi avant que le serveur ait inscrit la clé.

const CONFIGURED_KEY = (import.meta.env.VITE_SELFHOST_VIP_KEY ?? '').trim();

/** Marqueur : l'utilisateur a volontairement retiré cette clé. */
export const SELFHOST_VIP_DISMISSED_KEY = 'movix_selfhost_vip_dismissed';

/**
 * Pose la clé auto-hébergée dans le navigateur si rien ne s'y oppose.
 * @returns vrai si la clé vient d'être posée.
 */
export function applySelfhostVipKey(
  key: string = CONFIGURED_KEY,
  storage: Storage = localStorage,
): boolean {
  if (!key) return false;
  try {
    if (storage.getItem('access_code')) return false;
    if (storage.getItem(SELFHOST_VIP_DISMISSED_KEY) === key) return false;

    storage.setItem('access_code', key);
    // La clé est inscrite sans date d'expiration côté serveur.
    storage.setItem('access_code_expires', 'never');
    // Posé d'emblée, comme lors d'une activation manuelle : la vérification
    // serveur lancée au montage des composants le confirme ou le révoque.
    storage.setItem('is_vip', 'true');
    return true;
  } catch {
    // Stockage indisponible (navigation privée stricte) : l'instance reste
    // utilisable, en mode iframe.
    return false;
  }
}

/**
 * À appeler juste avant qu'une clé soit retirée par l'utilisateur. Sans
 * effet si la clé retirée n'est pas la clé auto-hébergée.
 */
export function markSelfhostVipDismissed(
  removedKey: string | null,
  key: string = CONFIGURED_KEY,
  storage: Storage = localStorage,
): void {
  if (!key || removedKey !== key) return;
  try {
    storage.setItem(SELFHOST_VIP_DISMISSED_KEY, key);
  } catch {
    /* stockage indisponible : rien à retenir */
  }
}

if (typeof window !== 'undefined') {
  applySelfhostVipKey();
}

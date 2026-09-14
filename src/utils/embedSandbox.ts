// Politique de confinement des iframes d'hébergeurs tiers.
//
// Un embed d'hébergeur est servi depuis un autre domaine : la same-origin
// policy lui interdit déjà de lire notre DOM, notre localStorage ou notre
// session. Ce n'est donc PAS contre l'exfiltration que ce sandbox protège —
// c'est contre ce que l'iframe peut *faire subir* à l'utilisateur.
//
// Sans attribut `sandbox`, une iframe garde toutes ses capacités natives :
//
//   - naviguer la fenêtre du dessus       -> l'hébergeur détourne l'onglet
//                                            entier vers une page d'arnaque
//   - ouvrir des fenêtres                 -> popunders
//   - déclencher un téléchargement        -> fichier poussé sans clic
//   - ouvrir des modales                  -> faux « votre appareil est infecté »
//
// Ce sont les quatre vecteurs de nuisance réels des hébergeurs de streaming.
// La liste ci-dessous les retire et ne garde que ce qu'il faut pour lire une
// vidéo.
//
// `allow-scripts` + `allow-same-origin` ensemble sont un anti-pattern connu
// UNIQUEMENT quand l'iframe est de même origine que la page porteuse : elle
// pourrait alors retirer son propre attribut sandbox. Nos embeds sont tous
// cross-origin, la combinaison est donc sûre ici — et les deux sont requis
// (le lecteur est en JS et fait ses propres requêtes vers son domaine).
//
// Si un hébergeur casse avec cette politique, la bonne réaction est de
// changer d'hébergeur, pas d'ajouter `allow-popups` ou
// `allow-top-navigation` : ce sont exactement les deux capacités dont ils se
// servent pour monétiser.

/**
 * Attribut `sandbox` appliqué à toutes les iframes d'hébergeurs.
 *
 * Volontairement absents — ne pas rajouter :
 *   allow-top-navigation, allow-top-navigation-by-user-activation,
 *   allow-popups, allow-popups-to-escape-sandbox,
 *   allow-downloads, allow-modals, allow-pointer-lock.
 */
export const EMBED_SANDBOX =
  'allow-scripts allow-same-origin allow-forms allow-presentation';

/**
 * Attribut `allow` (Permissions Policy) des mêmes iframes.
 *
 * `clipboard-write` a été retiré : il laissait l'hébergeur écrire dans le
 * presse-papier de l'utilisateur, ce qui est le support classique de la
 * substitution d'adresse de portefeuille crypto. Aucun lecteur vidéo n'en a
 * besoin pour lire un flux.
 */
export const EMBED_ALLOW =
  'accelerometer; autoplay; encrypted-media; gyroscope; picture-in-picture';

/**
 * `referrerPolicy` des embeds. `ezplayer` exige de ne recevoir aucun Referer ;
 * pour tout le reste on envoie l'origine seule en cross-origin.
 */
export const embedReferrerPolicy = (
  embedUrl: string | null | undefined
): 'no-referrer' | 'strict-origin-when-cross-origin' =>
  (embedUrl || '').toLowerCase().includes('ezplayer')
    ? 'no-referrer'
    : 'strict-origin-when-cross-origin';

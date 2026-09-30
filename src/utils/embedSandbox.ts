// Politique de confinement des iframes d'hébergeurs tiers.
//
// Un embed d'hébergeur est servi depuis un autre domaine : la same-origin
// policy lui interdit déjà de lire notre DOM, notre localStorage ou notre
// session. Ce n'est donc PAS contre l'exfiltration que ce sandbox protège —
// c'est contre ce que l'iframe peut *faire subir* à l'utilisateur.
//
// Sans attribut `sandbox`, une iframe garde toutes ses capacités natives :
//
//   allow-top-navigation  -> l'hébergeur détourne l'onglet entier vers une
//                            page d'arnaque ou un kit d'exploitation
//   allow-popups          -> popunders publicitaires
//   allow-downloads       -> fichier poussé sans clic
//   allow-modals          -> faux « votre appareil est infecté »
//
// ## Pourquoi un réglage, et pas une valeur unique
//
// Plusieurs hébergeurs DÉTECTENT le sandbox et refusent de servir la vidéo.
// Ce n'est pas un bug : ils sont rémunérés au popunder, et un `window.open()`
// qui échoue leur signale qu'ils ne seront pas payés. Le confinement le plus
// strict coûte donc une partie du catalogue — celle qui n'existe que chez ces
// hébergeurs-là.
//
// L'arbitrage dépend du déploiement, pas du code. Il se règle donc par
// `VITE_EMBED_SANDBOX`, et la valeur par défaut reste la plus stricte.

type SandboxPreset = 'strict' | 'balanced' | 'off';

const PRESETS: Record<Exclude<SandboxPreset, 'off'>, string> = {
  /**
   * Défaut. Aucune des quatre capacités de nuisance.
   *
   * `allow-scripts` + `allow-same-origin` ensemble sont un anti-pattern connu
   * UNIQUEMENT quand l'iframe est de même origine que la page porteuse : elle
   * pourrait alors retirer son propre attribut sandbox. Nos embeds sont tous
   * cross-origin, la combinaison est donc sûre ici — et les deux sont requis
   * (le lecteur est en JS et fait ses propres requêtes vers son domaine).
   */
  strict: 'allow-scripts allow-same-origin allow-forms allow-presentation',

  /**
   * Compromis : `allow-popups` en plus, rien d'autre.
   *
   * Suffit à satisfaire les hébergeurs qui testent `window.open()`, donc à
   * récupérer le catalogue qu'ils sont seuls à servir. En échange, leurs
   * popunders s'ouvrent : c'est de la publicité, assumée comme telle.
   *
   * Ce que ça n'ouvre PAS, et c'est l'essentiel : `allow-popups-to-escape-sandbox`
   * reste absent, donc la fenêtre ouverte **hérite de ce même sandbox**. Le
   * popunder est lui-même confiné — il ne peut ni naviguer notre onglet, ni
   * déclencher de téléchargement, ni ouvrir à son tour d'autres fenêtres.
   *
   * Les trois vecteurs les plus dangereux (détournement d'onglet,
   * téléchargement forcé, fausses modales) restent donc fermés. On échange
   * une nuisance contre de la disponibilité, pas une protection contre un
   * risque d'infection.
   */
  balanced: 'allow-scripts allow-same-origin allow-forms allow-presentation allow-popups',
};

const resolvePreset = (): SandboxPreset => {
  const raw = (import.meta.env.VITE_EMBED_SANDBOX ?? '').trim().toLowerCase();
  if (raw === 'balanced') return 'balanced';
  if (raw === 'off') return 'off';
  return 'strict';
};

const PRESET = resolvePreset();

/**
 * Attribut `sandbox` des iframes d'hébergeurs.
 *
 * `undefined` en mode `off` : React omet alors l'attribut, et l'iframe
 * retrouve TOUTES ses capacités, détournement d'onglet compris. C'est le
 * comportement d'origine du projet, conservé pour qui l'assume — mais il n'y
 * a aucune raison de le choisir plutôt que `balanced`, qui satisfait les
 * mêmes hébergeurs en gardant les protections qui comptent.
 */
export const EMBED_SANDBOX: string | undefined =
  PRESET === 'off' ? undefined : PRESETS[PRESET];

/** Préréglage actif, pour l'afficher dans les réglages ou un diagnostic. */
export const EMBED_SANDBOX_PRESET: SandboxPreset = PRESET;

/**
 * Attribut `allow` (Permissions Policy) des mêmes iframes.
 *
 * `clipboard-write` a été retiré : il laissait l'hébergeur écrire dans le
 * presse-papier de l'utilisateur, ce qui est le support classique de la
 * substitution d'adresse de portefeuille crypto. Aucun lecteur vidéo n'en a
 * besoin pour lire un flux, et aucun ne le détecte.
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

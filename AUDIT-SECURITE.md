# Audit de sécurité — Movix

> Cartographie, surface d'attaque et pipeline de contenu.
> Objectif : usage personnel auto-hébergé, sans pub, sans tracker, sans exposer l'appareil.

**Périmètre auditté** : `src/`, `API/Mainapi/`, `API/proxiesembed/`, `extension/`, `userscript/`, `public/sw.js`, `app/`.
**Méthode** : lecture de code statique. Pas de test dynamique, pas d'exploitation.

---

## 1. Résumé exécutif

La crainte de départ — « des pubs, donc sûrement des trackers cachés » — **n'est pas confirmée**.
La télémétrie est propre : désactivée par défaut, pilotée par `.env`, respecte Do Not Track.
La publicité est intégralement pilotée par 4 variables d'environnement : vides, il n'y a **aucune pub**.

Le vrai risque est ailleurs, et il est plus grave que de la pub.

| # | Composant | Gravité | Nature |
|---|---|---|---|
| 1 | Extension navigateur | **Critique** | Proxy HTTP universel exposé à n'importe quel site |
| 2 | Iframes d'hébergeurs | **Élevé** | `sandbox` explicitement désactivé |
| 3 | Frontend | **Élevé** | Aucune CSP |
| 4 | Auth API | **Élevé** | JWT sans expiration, en `localStorage` |
| 5 | Pont page ↔ extension | Moyen | Token diffusé en `postMessage(*)` |
| 6 | Service Worker | Moyen | Redirection pilotée par un paste public tiers |
| 7 | Soumission de liens | Moyen | Pas de whitelist de protocole |
| 8 | `domainRestriction` | Moyen | Contournable sans `Origin`/`Referer` |
| 9 | App mobile | Moyen | `mixedContentMode="always"` |
| 10 | `routes/proxy.js` | Faible | SSRF complète — mais **code mort** |

**Verdict** : le cœur du projet est correctement écrit. Le danger vient de la périphérie —
l'extension, et les iframes tierces. Les deux se neutralisent, et la section 6 dit comment.

---

## 2. Cartographie

### 2.1 Composants réels

Le `CLAUDE.md` du dépôt est incomplet : il ne mentionne ni l'app Android/Kotlin ni l'app iOS/Swift.

```
Movixsecure/  (535 Mo)
├── src/                  Frontend React 18 + TypeScript + Vite 8
│   ├── pages/            58 routes  (WatchMovie, WatchTv, WatchAnime, LiveTV…)
│   ├── components/       118+       (HLSPlayer.tsx = 568 Ko à lui seul)
│   ├── context/          12 providers React
│   ├── services/         22 services Axios
│   └── utils/            80+ modules
├── API/
│   ├── Mainapi/          Express 4 + MySQL + Redis     — port 25565
│   │   └── routes/       33 modules (dont 12 scrapers de sources)
│   ├── watchpartyAPI/    Socket.IO                     — port 25566
│   └── proxiesembed/     Python aiohttp                — port 25569
│       ├── server.py     6 716 lignes
│       └── drmproxy/     70 extracteurs DRM (Netflix, Canal+, M6, TF1…)
├── extension/            Chrome MV3 (1.4.4) + Firefox MV3 (1.6.4)
├── userscript/           Tampermonkey — équivalent de l'extension
├── app/                  React Native + Android (Kotlin) + iOS (Swift)
├── wasm/                 Moteur de sync watchparty (Rust → WASM)
├── cloudflareproxy/      Worker relais CORS
└── public/sw.js          Service worker + bascule de domaine miroir
```

### 2.2 Scripts tiers chargés par le frontend

Inventaire exhaustif de ce qui part vers un serveur tiers, hors `.env` :

| Source | Chargé depuis | Rôle | Évitable ? |
|---|---|---|---|
| Cloudflare Turnstile | `challenges.cloudflare.com` | Anti-bot (`index.html`) | Non — verrou serveur réel |
| Google Cast SDK | `www.gstatic.com` | Chromecast (`index.html`, body) | Oui — supprimable si pas de Cast |
| TMDB | `api.themoviedb.org` + `image.tmdb.org` | Métadonnées + affiches | Non — c'est le catalogue |
| Analytics | selon `.env` | GA4 ou Plausible | **Oui — `none` par défaut** |
| Régie pub | selon `.env` | Popunder / smartlink | **Oui — vide par défaut** |

Aucun script de tracking n'est codé en dur. `index.html` porte même un commentaire
documentant le retrait de l'ancien snippet `gtag` hardcodé.

---

## 3. Pubs et trackers — ce qui a été trouvé

### 3.1 Télémétrie : propre

`src/utils/analytics.ts` est un module bien tenu :

- `VITE_ANALYTICS_PROVIDER` vaut **`none` par défaut** → aucun script injecté ;
- un seul fournisseur à la fois, GA4 ou Plausible ;
- **Do Not Track respecté** (`navigator.doNotTrack === '1'`) ;
- opt-out local : `localStorage.movix_analytics_opt_out = '1'` ;
- si l'identifiant de mesure manque, la fonction sort sans rien charger.

C'est au-dessus de la moyenne de ce qu'on trouve dans ce type de projet.

> **Nuance à connaître** : `VITE_PLAUSIBLE_SCRIPT_PATH` / `VITE_PLAUSIBLE_API_PATH` existent
> pour servir Plausible derrière des chemins déguisés, explicitement afin d'échapper aux
> listes de blocage type EasyPrivacy. C'est du contournement de bloqueur assumé.
> Sans effet pour toi tant que le provider reste `none`.

### 3.2 Publicité : 100 % pilotée par `.env`

Aucune URL de régie n'est dans le code. Quatre variables, toutes optionnelles :

| Variable | Effet si vide |
|---|---|
| `VITE_AD_DIRECT_URLS_ADULT` | Aucune fenêtre ouverte (mode +18) |
| `VITE_AD_DIRECT_URL_SFW` | Aucune fenêtre ouverte (mode SFW) |
| `VITE_AD_SCRIPT_SRC` | Mode script coupé, retour au lien direct |
| `VITE_SWIFTFLUX_AD_URL` | Étape pub sautée dans `SwiftfluxGate` |

**Vides, le site tourne sans aucune publicité.** Le popup « Voir une pub » reste affiché
mais valide sans rien ouvrir (`AdFreePopupContext.handlePopupAccept`).

Deux points à connaître quand même :

- **Les pubs +18 sont activées par défaut.** `src/utils/adAdultMode.ts` : `isAdultAdsEnabled()`
  retourne `true` tant que `localStorage.settings_ad_popup_adult` ne vaut pas explicitement
  `'false'`. Clé absente = +18 actif. Sans effet si les URLs sont vides.
- **Le popup est purement client.** Le déverrouillage repose sur `isUserVip()`, qui lit
  `localStorage.is_vip`. La vérification serveur est **non bloquante** et lancée en arrière-plan.
  Sur ton propre déploiement, c'est une ligne à changer (§ 6).

### 3.3 ⚠️ Le vrai problème de la pub : `VITE_AD_SCRIPT_SRC`

`src/utils/adScriptMode.ts` injecte le script de régie dans `document.head` de **l'origine principale** :

```js
const s = document.createElement('script');
s.src = AD_SCRIPT_SRC;            // URL tierce
s.setAttribute('data-cfasync', 'false');
(document.head || document.body).appendChild(s);
```

Ce script s'exécute avec **tous les droits de la page** : lecture complète de `localStorage`
(donc `access_code`, `auth_token`, `is_vip`), écoute de tous les `postMessage`, modification
du DOM, accès au lecteur. Sans CSP (§ 4.3) pour le contenir.

C'est la plus grosse délégation de confiance du projet. **Pour un usage personnel : laisser vide.**

---

## 4. Points faibles — par gravité

### 4.1 🔴 CRITIQUE — L'extension navigateur est un proxy HTTP ouvert à tout le web

C'est le point le plus grave de l'audit, et de loin.

**Privilèges demandés** (`extension/Chrome/manifest.json`, identique côté Firefox) :

```json
"host_permissions": ["<all_urls>", "http://*/*", "https://*/*"],
"content_scripts": [{ "matches": ["<all_urls>"], "js": ["content.js"], "run_at": "document_start" }],
"web_accessible_resources": [{ "resources": [...], "matches": ["<all_urls>"] }]
```

C'est le maximum absolu qu'une extension puisse demander. Le content script tourne sur
**tous les sites que tu visites**, pas seulement sur Movix.

**Le défaut.** `extension/Chrome/content.js` ne vérifie jamais l'origine de l'expéditeur :

```js
window.addEventListener("message", async (event) => {
    if (event.source !== window || !event.data || event.data.source !== "MOVIX_WEB") {
        return;                          // ← seul contrôle : une constante publique
    }
    const { type, action, payload, messageId } = event.data;
    if (type === "EXTENSION_REQUEST") {
        const response = await chrome.runtime.sendMessage({ action, payload });
        // …renvoyé à la page
    }
});
```

`event.source !== window` signifie seulement « le message vient de cette fenêtre ».
N'importe quel script de n'importe quelle page satisfait cette condition.
`event.data.source === "MOVIX_WEB"` est une chaîne en clair, trivialement reproductible.

Côté background, `handleMessage()` (ligne 599) ne regarde pas non plus `sender` —
sauf `maybeUseLocalApi()`, qui ne sert qu'à choisir l'URL de l'API.

**L'impact.** L'action `PROXY_HTTP` est donc atteignable depuis n'importe quel site :

```js
async function proxyHttpRequest(url, headers = {}) {
    if (headers && Object.keys(headers).length > 0) {
        const parsedUrl = new URL(url);
        const rulePattern = `*://${parsedUrl.host}${parsedUrl.pathname}*`;
        await addHeadersRule(rulePattern, headers);      // (b)
    }
    const response = await fetch(url, { headers });       // (a)
    const buffer = await response.arrayBuffer();
    const base64 = proxyBytesToBase64(new Uint8Array(buffer));
    return { data: base64, contentType: …, status: …, finalUrl: response.url };
}
```

**(a) Contournement universel de la same-origin policy.**
Le fetch part du background, qui détient `<all_urls>` — donc sans CORS. Le corps complet
de la réponse est renvoyé en base64 à la page appelante. Un site malveillant obtient :

- un **scanner de ton réseau local** : `http://192.168.1.1/`, `http://127.0.0.1:<port>/`,
  tes NAS, tes imprimantes, tes services de dev — et il en lit les réponses ;
- l'accès aux **endpoints de métadonnées cloud** (`169.254.169.254`) si tu l'exécutes sur un VPS ;
- une sortie réseau qui porte **ton adresse IP**.

*Atténuation présente* : `fetch()` utilise `credentials: 'same-origin'` par défaut, donc tes
cookies ne partent **pas** sur les requêtes cross-origin. Le vol de session authentifiée
n'est donc pas direct. Le reste de la primitive tient.

**(b) Injection d'en-têtes persistante, à l'échelle du navigateur.**
Avant le fetch, `addHeadersRule()` pose une règle `declarativeNetRequest` **dynamique** —
elle survit aux redémarrages du navigateur. `createHeadersRule()` :

```js
condition: {
  urlFilter: urlPattern,                 // ← dérivé de l'URL fournie par l'appelant
  resourceTypes: ["xmlhttprequest","media","websocket","other","sub_frame","main_frame"],
}
```

Aucun `initiatorDomains`. La règle s'applique donc à **toute ta navigation réelle**,
`main_frame` compris. Un site tiers peut réécrire des en-têtes de requête sur un domaine
de son choix, pour tes propres visites, durablement.

À comparer avec la règle CORS globale (`setupRules`, id 1), qui est elle **correctement
bornée** par `initiatorDomains` aux seuls domaines Movix. La protection existe dans le
fichier — elle n'a simplement pas été appliquée à `addHeadersRule`.

**(c) Balise de fingerprinting universelle.**
`injected.js` est injecté dans **chaque page visitée** et y pose :

```js
window.hasMovixExtension = true;
window.hasMovixNexusExtractor = true;
window.dispatchEvent(new CustomEvent('movix-extension-loaded'));
```

Tout site peut donc te reconnaître comme utilisateur de Movix, et surtout détecter
qu'il a en face de lui une extension exploitable.

**Le userscript Tampermonkey présente le même profil** (`@connect *`, `@grant unsafeWindow`,
`@run-at document-start`), avec une atténuation notable : ses `@match` sont limités aux
domaines Movix, là où l'extension s'installe partout.

---

### 4.2 🟠 ÉLEVÉ — Les iframes d'hébergeurs sont explicitement dé-sandboxées

C'est le vecteur d'infection classique de ce type d'app, et il est ouvert ici volontairement.

`src/pages/Watch/WatchTv.tsx:4227` (même logique dans `WatchMovie.tsx`, `WatchAnime.tsx`) :

```jsx
sandbox={(() => {
  const urlLower = embedUrl ? embedUrl.toLowerCase() : '';
  // Jamais de sandbox pour Mixdrop, Doodstream, ou les lecteurs multi
  if (urlLower.includes("mixdrop") || urlLower.includes("dood")
   || urlLower.includes("emmmmbed") || urlLower.includes("lecteur6")) return undefined;
  // Jamais de sandbox pour supervideo ou dropload
  if (urlLower.includes("supervideo") || urlLower.includes("dropload")) return undefined;
  // Jamais de sandbox pour les liens Firebase Upload
  if (urlLower.includes('uqload') || urlLower.includes('luluvdoo')) return undefined;
  …
})()}
```

Et `WatchMovie.tsx:2985`, encore plus direct : `sandbox={undefined}`.

Ces hébergeurs sont précisément ceux réputés pour le malvertising agressif.
Sans attribut `sandbox`, l'iframe conserve **toutes** ses capacités :

| Capacité | Conséquence concrète |
|---|---|
| `allow-top-navigation` implicite | L'hébergeur **redirige ton onglet entier** vers une page d'arnaque ou un kit d'exploitation |
| `allow-popups` implicite | Popunders, faux « votre appareil est infecté » |
| `allow-downloads` implicite | Téléchargement déclenché sans action de ta part |
| `allow-scripts` implicite | Mineur de crypto, exploitation de faille navigateur |
| `allow="clipboard-write"` (explicite) | L'iframe **écrit dans ton presse-papier** — attaque classique de substitution d'adresse crypto |

La same-origin policy empêche l'iframe de lire ta session Movix. Elle n'empêche
**rien** de ce qui précède. C'est exactement le scénario « je regarde un film et mon
onglet part sur une page vérolée ».

Un contre-exemple existe dans le dépôt : `src/components/VideoPlayer.tsx:38` utilise
`sandbox="allow-scripts allow-same-origin"`. Le mécanisme est connu, il n'a pas été appliqué ici.

---

### 4.3 🟠 ÉLEVÉ — Aucune Content-Security-Policy

Recherche exhaustive : pas de `public/_headers`, pas de `<meta http-equiv="Content-Security-Policy">`,
rien dans `vite.config.ts`, rien dans `functions/`, rien dans `cloudflareproxy/`.

Côté API, `middleware/security.js` pose un jeu minimal :

```js
res.setHeader('X-Content-Type-Options', 'nosniff');
res.setHeader('X-Frame-Options', 'DENY');
res.setHeader('X-XSS-Protection', '0');   // désactivé volontairement, OWASP : « utilisez CSP »
res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
```

Correct — mais ces en-têtes ne couvrent que les réponses de l'API, pas le frontend servi
par Cloudflare Pages. Et le commentaire renvoie à une CSP qui n'existe nulle part.

Conséquence : aucun filet sous le script de régie (§ 3.3), aucune limite sur les origines
que la page peut contacter, aucun `frame-src` pour restreindre les hébergeurs embarqués.

---

### 4.4 🟠 ÉLEVÉ — JWT sans expiration, stocké en `localStorage`

`API/Mainapi/middleware/auth.js:31` :

```js
function issueJwt(userType, userId, sessionId, authMethod = null) {
  // Issue a token without expiration (no exp claim)
  const payload = { sub: userId, userType, sessionId };
  …
  return jwt.sign(payload, JWT_SECRET, { algorithm: 'HS256' });
}
```

Pas de claim `exp` : le jeton est **valide indéfiniment**. Côté client il atterrit dans
`localStorage` (`access_code`, `auth_token`, `discord_token`, `google_token`), donc lisible
par tout script exécuté dans la page — à commencer par le script de régie du § 3.3.

Un jeton exfiltré une seule fois reste utilisable pour toujours, sauf révocation explicite
par la table des sessions.

---

### 4.5 🟡 MOYEN — Le pont page ↔ extension diffuse le jeton d'accès

`src/utils/extensionProxy.ts:33` :

```js
const accessKey = window.localStorage.getItem("access_code");
const enrichedPayload = { ...payload, ...(accessKey ? { accessKey } : {}) };
…
window.postMessage({ source: "MOVIX_WEB", type: "EXTENSION_REQUEST",
                     action, payload: enrichedPayload, messageId }, "*");
```

`window.postMessage(..., "*")` est reçu par **tout écouteur `message` de la page**.
Le jeton d'accès transite donc en clair à portée de n'importe quel script tiers présent
dans la page — le script de régie, typiquement.

---

### 4.6 🟡 MOYEN — Le Service Worker redirige selon un paste public tiers

`.env.example` : `VITE_MIRRORS_CONFIG_URL=https://rentry.co/movix`

`public/sw.js` : quand une navigation échoue (timeout 3 s), le SW va chercher cette page,
en extrait des hostnames via `parseConfig()`, et redirige :

```js
setTimeout(function () { window.location.replace(${JSON.stringify(url)}); }, 100);
```

Le filtrage porte uniquement sur la **forme** du hostname, et exclut `rentry.co` lui-même.
Rien ne vérifie **qui** a écrit la liste.

Quiconque prend le contrôle de cette paste rentry contrôle la destination de tous les
utilisateurs dont le SW est installé, dès que le site paraît injoignable. C'est un point de
supply-chain hors de ton contrôle. Il est aussi lu **sans cache** à chaque appel — donc une
modification hostile est effective immédiatement.

---

### 4.7 🟡 MOYEN — Soumission de liens : pas de whitelist de protocole

`API/Mainapi/linkSubmissionsRoutes.js:231` :

```js
try { new URL(url); }
catch { return res.status(400).json({ error: 'URL invalide' }); }
const cleanUrl = url.trim();
if (cleanUrl.length > 2048) { … }
```

`new URL()` accepte `javascript:`, `data:`, `vbscript:`, `file:`. Aucun contrôle de
protocole ailleurs dans le fichier. Une URL `javascript:` soumise est stockée telle quelle
et attend d'être rendue dans un `href` ou un `src`.

*Atténuation* : approbation obligatoire par un compte `admin` ou `uploader` avant publication,
et les requêtes SQL sont correctement paramétrées. Le risque est donc conditionné à une
erreur de modération — mais la validation, elle, est absente.

---

### 4.8 🟡 MOYEN — `domainRestriction` n'est pas un contrôle d'accès

`API/Mainapi/middleware/security.js` :

```js
// Comportement CORS standard : une requête sans Origin ni Referer n'est pas
// une requête cross-origin navigateur (curl, app mobile, serveur-a-serveur,
// navigation directe). On la laisse passer
if (!origin && !referer) { return next(); }
```

Le choix est délibéré et documenté, et il est juste du point de vue CORS. Mais il faut en
tirer la conséquence : **`curl` passe toujours**. La liste de domaines filtre les navigateurs,
pas les scripts. Toute route qui compte dessus pour son autorisation est ouverte.

À noter aussi, dans `middleware/cors.js` comme dans `domainRestriction`, la présence de
domaines tiers en dur — `nakios.site`, `cinezo.site`, `cinezo.online`, `filmib.cc` — autorisés
avec `credentials: true`. Ce sont des origines extérieures au projet qui peuvent appeler
l'API avec cookies. À supprimer sur un déploiement personnel.

---

### 4.9 🟡 MOYEN — App mobile : contenu mixte autorisé

`app/src/components/WebViewBrowser.tsx:292` : `mixedContentMode="always"`

La WebView Android charge des ressources HTTP dans une page HTTPS. Sur un réseau non
maîtrisé (wifi public, partage de connexion), un attaquant en position intermédiaire peut
injecter du contenu dans la page. À passer à `"never"`, ou `"compatibility"` au minimum.

---

### 4.10 🔵 FAIBLE — SSRF complète dans du code mort

`API/Mainapi/routes/proxy.js` (313 lignes) accepte une URL arbitraire, la décode
récursivement, la préfixe en `https://` si besoin, la récupère et renvoie le corps avec
`Access-Control-Allow-Origin: *`. Aucune validation d'hôte, aucun blocage d'IP privée,
aucune authentification.

**Vérifié : ce routeur n'est monté nulle part dans `app.js`.** Il n'est donc pas exploitable
en l'état. C'est une mine posée : un `app.use('/proxy', …)` ajouté un jour ouvre la boîte.
À supprimer.

---

## 5. Ce qui est bien fait

Un audit qui ne liste que les défauts donne une image fausse. Ces points sont solides :

**Le proxy Python est la partie la mieux sécurisée du projet.**
`API/proxiesembed/media_signing.py` impose une signature HMAC-SHA256 sur
`route \n cible \n expiration`, avec un secret partagé `MEDIA_SIGNING_SECRET` :

- **fail-closed** : sans secret, tout le trafic média est refusé, pas ouvert ;
- la **route fait partie du message signé** — une URL signée pour `/fsvid-proxy` ne peut pas
  être rejouée sur `/vidmoly-proxy` pour emprunter sa sortie SOCKS ;
- **garde anti-SSRF en défense en profondeur** : blocage des IP privées et des hostnames de
  métadonnées cloud (`metadata.google.internal`, `169.254.x.x`), même pour une URL signée —
  « protège contre un secret fuité et contre nos propres bugs » ;
- `PublicOnlyResolver` contre le **DNS rebinding** ;
- les réponses d'erreur ne distinguent pas `bad_signature` d'`expired`, pour ne pas offrir
  d'oracle de forge.

C'est du travail sérieux, nettement au-dessus du reste du dépôt.

**Les extracteurs d'hébergeurs tournent dans un bac à sable.**
Plutôt que d'`eval()` le JavaScript obfusqué récupéré chez les hébergeurs, le projet embarque
un interpréteur **QuickJS compilé en WASM** (`fsvid-vidzy-quickjs.wasm`, côté extension comme
côté Python via `fsvid_vidzy_sandbox.py`). C'est exactement la bonne décision, et rare.

**Zéro `eval()` / `new Function()` dans `src/`.** Vérifié exhaustivement.

**Le bypass Turnstile est honnête.** `src/utils/turnstileBypass.ts` est du confort d'affichage :
la décision est prise côté serveur dans `verifyTurnstileFromRequest`, à partir du JWT vérifié
et de la table `admins`. Le fichier le documente explicitement — « quiconque bricole son
navigateur pour se déclarer admin n'obtient rien ».

**Règle CORS de l'extension correctement bornée.** `setupRules()` règle 1 restreint
`Access-Control-Allow-Origin: *` aux seuls `initiatorDomains` Movix.

**SQL systématiquement paramétré** dans toutes les routes inspectées.

**Aucun secret commité.** Seuls des `.env.example`. Les deux clés d'API trouvées en dur
(`m6_fr.py`, `joyn_de.py`) sont des clés publiques de lecteurs de chaînes, pas des secrets du projet.

**Dépendances à jour** : React 18.3, Vite 8, axios 1.13, hls.js 1.6, jsonwebtoken 9.
Aucune version notoirement vulnérable. (`API/Mainapi` est en Express **4**, alors que le
`CLAUDE.md` annonce Express 5 — sans conséquence de sécurité, mais la doc est fausse.)

**Les `dangerouslySetInnerHTML`** (12 occurrences) portent sur du CSS statique, des clés i18n
du dépôt, et des sous-titres passés par `formatSubtitleTextToSafeHtml()`. Pas de donnée
utilisateur brute. Pas d'exploitation trouvée.

---

## 6. Pipeline de contenu — comment les vidéos arrivent

C'est la question la plus importante pour maintenir le flux. La réponse tient en une phrase :

> **Il n'y a pas de base de contenus. Rien n'est stocké, rien n'est « ingéré ».
> Tout est résolu à la demande, au moment où tu cliques.**

### 6.1 La chaîne, étape par étape

```
┌─ 1. CATALOGUE ────────── « quels films/séries existent »
│   TMDB — api.themoviedb.org
│   Affiches, synopsis, casting, notes, nouveautés.
│   → Aucune maintenance. TMDB indexe, ton app suit.
│
├─ 2. RÉSOLUTION ───────── « où se trouve ce titre »
│   API/Mainapi/routes/{wiflix,coflix,fstream,cinestream,j1f,
│                        darkiworld,cpasmal,purstream,voirdrama,
│                        animeSama,kisskh,francetv}.js
│   Scraping HTML (axios + cheerio) d'un agrégateur, par tmdb_id.
│   Renvoie des URLs de pages d'hébergeurs (« embeds »).
│   Résultat mis en cache (Redis + JSON sur disque).
│
├─ 3. EXTRACTION ───────── « l'URL réelle du fichier »
│   extension/Chrome/extractors.js   (2 116 lignes, côté client)
│   API/proxiesembed/hoster_decoders.py + seekstreaming/uqload utils
│   src/utils/hosterRegistry.ts      (détection de l'hébergeur)
│   Désobfusque la page de l'hébergeur → .m3u8 ou .mp4 direct.
│
└─ 4. LECTURE ─────────── proxy signé HMAC → HLSPlayer.tsx / Shaka / Video.js
```

Le flux de nouveautés ne dépend donc d'**aucun cron chez toi**. Un film sorti hier apparaît
dans ton catalogue dès que TMDB l'indexe. Ce qui casse n'est jamais « le catalogue » —
c'est toujours l'étape 2 ou l'étape 3.

### 6.2 Les trois choses qui cassent le flux

**a) Les sites sources changent de domaine** — c'est le cas le plus fréquent.
Le projet a anticipé : chaque source lit son URL de base dans l'environnement, avec un
défaut en dur. **Aucune modification de code n'est nécessaire.**

| Variable | Défaut dans le code | Fichier |
|---|---|---|
| `WIFLIX_BASE_URL` | `https://flemmix.fast` | `routes/wiflix.js:45` |
| `COFLIX_BASE_URL` | `https://coflix.boston` | `routes/coflix.js:26` |
| `CINESTREAM_BASE_URL` | `https://cinestream.info` | `routes/cinestream.js:32` |
| `J1F_BASE_URL` | — | `routes/j1f.js:62` |
| `DARKIWORLD_BASE_URL` | (constante) | `app.js:63` |
| `SWIFTFLOW_BASE_URL` | — | `routes/swiftflow.js:45` |
| `VAVOO_BASE_URL` | `https://kool.to` | `liveTvRoutes.js:523` |

Le commentaire du code est explicite : *« Source rotates domains (flemmix.fast → …).
Override via env, no code change. »*
**C'est ton levier de maintenance numéro un.** Une source morte = une ligne de `.env`.

**b) Les hébergeurs changent de domaine.**
`src/utils/hosterRegistry.ts` tient un registre de regex par hébergeur. L'ampleur du
problème se lit dans le fichier : **plus de 150 alias en dur pour le seul Voe**, qui fait
tourner ses domaines de sortie environ tous les mois, avec des noms aléatoires
(`19turanosephantasia`, `chuckle-tube`, `goofy-banana`…).

Le projet expose une soupape : **Réglages → Priorité → Hosters custom & regex** permet
d'ajouter un domaine sans rebuilder.

**c) Les hébergeurs changent leur obfuscation.**
C'est le seul point qui demande du vrai travail de développement : `extractors.js` et les
décodeurs Python doivent suivre. Rien d'automatisable.

### 6.3 La voie communautaire

Deux mécanismes complètent le scraping :

- `API/Mainapi/linkSubmissionsRoutes.js` — les utilisateurs soumettent des liens
  (quotas : 15 films / 10 séries par 24 h), un compte `admin` ou `uploader` approuve
  avant publication. C'est la faiblesse du § 4.7 ;
- **Greenlight / Wishboard** (`src/pages/Greenlight/`, `wishboardRoutes.js`) — demandes de
  contenu, avec priorité VIP.

Sur un déploiement personnel, les deux sont inutiles : autant les désactiver (moins de
surface, moins de base de données).

### 6.4 Live TV

Chaîne distincte : `liveTvRoutes.js` agrège Vavoo (`kool.to`), Northlive et des flux de
matchs. Passe par un proxy signé, comme le reste. Mêmes règles : le domaine de base tourne,
la variable d'environnement suit.

---

## 7. Plan d'action pour un usage personnel

### Priorité 1 — avant la première utilisation

**1. Ne pas installer l'extension navigateur.**
Le § 4.1 en fait une porte ouverte sur ton réseau local pour n'importe quel site visité.
Elle ne sert qu'à l'extraction locale et au Live TV. Sans elle, l'extraction passe côté
serveur, ce qui suffit largement pour un usage perso.

Si tu la veux malgré tout, deux correctifs suffisent — je peux les écrire :
- gater `content.js` sur `window.location.origin` (liste blanche de tes propres domaines) ;
- ajouter `initiatorDomains` dans `createHeadersRule()`, comme le fait déjà `setupRules()` règle 1.

**2. Remettre le `sandbox` sur les iframes d'hébergeurs.**
Dans `WatchTv.tsx`, `WatchMovie.tsx`, `WatchAnime.tsx`, remplacer les `return undefined`
par une valeur commune :

```jsx
sandbox="allow-scripts allow-same-origin allow-forms allow-presentation"
```

Sans `allow-top-navigation`, sans `allow-popups`, sans `allow-downloads`.
Et retirer `clipboard-write` de l'attribut `allow`.
Certains hébergeurs casseront — c'est le compromis, et c'est le bon sens du choix.

**3. Ajouter une CSP.** Créer `public/_headers` (Cloudflare Pages le lit automatiquement) :

```
/*
  Content-Security-Policy: default-src 'self'; img-src 'self' https://image.tmdb.org data:; connect-src 'self' https://api.themoviedb.org <TON_API>; frame-src https:; script-src 'self' https://challenges.cloudflare.com; style-src 'self' 'unsafe-inline'; object-src 'none'; base-uri 'none'
```

À ajuster selon les hébergeurs que tu gardes. Commence permissif sur `frame-src`, resserre ensuite.

**4. Nettoyer le `.env`.**

```bash
VITE_ANALYTICS_PROVIDER=none
VITE_AD_DIRECT_URLS_ADULT=
VITE_AD_DIRECT_URL_SFW=
VITE_AD_SCRIPT_SRC=
VITE_SWIFTFLUX_AD_URL=
VITE_MIRRORS_CONFIG_URL=          # ← surtout : ne pas laisser rentry.co
VITE_DEFAULT_MIRRORS=
```

**5. Supprimer le popup de pub.** Il ne sert plus à rien une fois les URLs vides.
Dans `src/context/AdFreePopupContext.tsx`, en tête de `showPopupForPlayer` :

```js
const showPopupForPlayer = useCallback((playerType: string, additionalInfo?: any) => {
  setShouldLoadIframe(true);
  return;                    // usage personnel : pas de porte publicitaire
  …
```

### Priorité 2 — dans la foulée

6. **Expiration des JWT** — ajouter `{ expiresIn: '30d' }` dans `issueJwt()` (`middleware/auth.js:31`).
7. **Supprimer `API/Mainapi/routes/proxy.js`** (§ 4.10).
8. **Whitelist de protocole** sur les soumissions de liens :
   `if (!['http:','https:'].includes(new URL(url).protocol)) return res.status(400)…`
9. **`mixedContentMode="never"`** dans `app/src/components/WebViewBrowser.tsx:292`.
10. **Élaguer les listes de domaines** dans `middleware/cors.js` et `middleware/security.js` :
    ne garder que le tien. `nakios.site`, `cinezo.site`, `cinezo.online`, `filmib.cc` n'ont rien
    à y faire.
11. **Retirer le SDK Google Cast** de `index.html` si tu ne castes pas — une connexion tierce en moins.
12. **Désactiver Greenlight / Wishboard / soumissions de liens** — inutiles en solo.

### Priorité 3 — réduction de surface

13. **Supprimer `API/proxiesembed/drmproxy/`** si tu n'en as pas l'usage.
    C'est 70 extracteurs DRM, le plus gros bloc de code du service, et tu n'y toucheras jamais
    pour du streaming classique. Moins de code = moins de surface.

---

## 8. Note légale

Deux choses de nature juridique différente cohabitent dans ce dépôt.

Le scraping d'agrégateurs (§ 6) est ce à quoi on s'attend d'un projet de ce type.

`API/proxiesembed/drmproxy/` est autre chose : 70 modules qui ciblent les protections DRM
Widevine de services commerciaux — Netflix, Canal+, M6, TF1, RTL, Rakuten, Zee5, Viki.
Le contournement de mesure technique de protection relève en France de l'article L.335-3-1
du Code de la propriété intellectuelle, indépendamment de l'usage qui en est fait ensuite.
C'est un régime distinct de celui du visionnage.

Ce n'est pas un conseil juridique, et c'est ta décision. C'est aussi, accessoirement,
le sous-arbre que la recommandation 13 propose de supprimer pour des raisons purement
techniques.

---

## Annexe — Récapitulatif des fichiers cités

| Constat | Fichier | Ligne |
|---|---|---|
| Extension : pas de contrôle d'origine | `extension/Chrome/content.js` | 9-15 |
| Extension : pas de contrôle d'expéditeur | `extension/Chrome/background.js` | 569, 599 |
| Extension : proxy HTTP arbitraire | `extension/Chrome/background.js` | 772 |
| Extension : règle DNR non bornée | `extension/Chrome/background.js` | 1468-1513 |
| Extension : balise de fingerprinting | `extension/Chrome/injected.js` | 1-3 |
| Extension : règle CORS bien bornée ✅ | `extension/Chrome/background.js` | 528-543 |
| Iframes non sandboxées | `src/pages/Watch/WatchTv.tsx` | 4227 |
| Iframes non sandboxées | `src/pages/Watch/WatchMovie.tsx` | 2985, 3833 |
| Injection du script de régie | `src/utils/adScriptMode.ts` | 63-88 |
| JWT sans expiration | `API/Mainapi/middleware/auth.js` | 31 |
| Token diffusé en postMessage | `src/utils/extensionProxy.ts` | 33, 62 |
| SW : redirection sur paste tiers | `public/sw.js` | 202, 269 |
| Liens : pas de contrôle de protocole | `API/Mainapi/linkSubmissionsRoutes.js` | 231 |
| `domainRestriction` contournable | `API/Mainapi/middleware/security.js` | ~70 |
| Contenu mixte mobile | `app/src/components/WebViewBrowser.tsx` | 292 |
| SSRF (code mort) | `API/Mainapi/routes/proxy.js` | 20 |
| Signature HMAC ✅ | `API/proxiesembed/media_signing.py` | 1-60, 218-250 |
| Analytics opt-in ✅ | `src/utils/analytics.ts` | — |
| Bypass Turnstile côté serveur ✅ | `src/utils/turnstileBypass.ts` | — |

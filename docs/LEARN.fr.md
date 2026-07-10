# Comprendre : comment fonctionne une blockchain — avec chainmap

[← Retour au README](../README.fr.md) · [English](LEARN.md) · **Français**

Un **programme pratique**. Chaque concept ci-dessous correspond à quelque chose que vous
pouvez *voir et faire* dans l'outil. Ouvrez **Mode démo** (aucune clé API requise) et suivez
le fil.

---

## Sommaire

1. [Comptes et adresses](#1-comptes-et-adresses)
2. [Transactions — trois familles](#2-transactions--trois-familles)
3. [Valeur, unités de base et décimales](#3-valeur-unités-de-base-et-décimales)
4. [Calldata et sélecteurs de méthode](#4-calldata-et-sélecteurs-de-méthode)
5. [Jetons — ERC-20 / 721 / 1155](#5-jetons--erc-20--721--1155)
6. [Graphe de transactions et expansion BFS](#6-graphe-de-transactions-et-expansion-bfs)
7. [Échantillonnage ≠ historique complet](#7-échantillonnage--historique-complet)
8. [Transactions échouées et annulées](#8-transactions-échouées-et-annulées)
9. [EVM et multichaîne](#9-evm-et-multichaîne)
10. [Heuristiques pour enquêter](#10-heuristiques-pour-enquêter)
11. [Travaux pratiques](#travaux-pratiques)

---

## 1. Comptes et adresses

Un compte sur une chaîne EVM est identifié par une **adresse** de 20 octets — `0x` + 40
caractères hexadécimaux (ex. `0x742d…B78a`). Deux types :

- **EOA** (compte détenu en externe) — contrôlé par une clé privée (une personne / un
  portefeuille).
- **Compte de contrat** — du code qui s'exécute lorsqu'il est appelé.

> **Dans chainmap :** chaque nœud est une adresse. Collez-en une dans *Adresse à analyser* —
> le **détecteur de chaîne** sous le champ vous dit aussitôt s'il s'agit d'une adresse EVM
> (scannable ici) ou d'autre chose (Bitcoin, Solana, Tron…) et vous renvoie vers le bon
> explorateur. Les adresses sont **mises en minuscules** en interne comme identifiant
> canonique ; le libellé affiché (forme courte, votre alias, ou un nom d'adresse connue) ne
> change jamais cet identifiant.

## 2. Transactions — trois familles

chainmap récupère trois types d'activité (les trois cases à cocher) :

- **Normales** — une EOA envoie une tx (transfert de valeur et/ou appel de contrat).
- **Internes** — valeur déplacée *par le code d'un contrat* pendant l'exécution (pas des tx
  signées séparément ; reconstruites par le traceur du nœud).
- **Transferts de jetons** — mouvements ERC-20 / ERC-721 / ERC-1155 (émis comme événements de
  journal).

> **Dans chainmap :** chaque transfert devient une **arête** orientée de l'émetteur vers le
> destinataire, colorée par famille (voir la Légende). C'est le modèle mental central : **une
> blockchain est un registre de mouvements de valeur orientés**, et un graphe en est la forme
> naturelle.

## 3. Valeur, unités de base et décimales

Les blockchains stockent les montants comme des **entiers dans la plus petite unité** (le wei
pour l'ETH : 1 ETH = 10¹⁸ wei). Un jeton déclare ses propres `decimals` (l'USDC en utilise 6).
Pour afficher un montant lisible, on divise par `10^decimals` — avec de l'**arithmétique sur
grands entiers**, jamais de virgule flottante, sous peine de perdre en précision sur de
grandes valeurs.

> **Dans chainmap :** `formatUnits` le fait avec `BigInt`. Si un jeton renvoie des décimales
> erronées/absentes, l'app signale le montant **« décimales inconnues »** au lieu d'afficher
> silencieusement un nombre faux — une règle d'honnêteté qui compte en forensique. La largeur
> des arêtes est **pondérée par le montant**, si bien que les gros flux sont littéralement plus
> épais.

## 4. Calldata et sélecteurs de méthode

*Ce que* fait une transaction. Une tx peut porter des **données d'entrée** (calldata). Un
simple transfert d'ETH a un calldata vide (`0x`). Un appel de contrat encode un **sélecteur de
méthode de 4 octets** (les 4 premiers octets de `keccak256("transfer(address,uint256)")` =
`0xa9059cbb`) suivi des arguments encodés en ABI.

> **Dans chainmap :** les arêtes dont la tx portait du calldata sont dessinées **en pointillés
> avec un `✱`** — on repère les interactions de contrat d'un coup d'œil. Cliquez-en une : le
> panneau de détails **décode le sélecteur** vers sa signature lisible et **décode les
> arguments de tête**. C'est crucial pour l'enquêteur : une tx *normale* appelant `transfer()`
> a son `to` fixé sur le **contrat du jeton**, tandis que le **vrai destinataire** est caché
> dans le calldata — chainmap le révèle.

## 5. Jetons — ERC-20 / 721 / 1155

- **ERC-20** — jetons fongibles (USDC, DAI). `transfer(to, amount)`.
- **ERC-721** — NFT ; chacun a un `tokenId` unique.
- **ERC-1155** — multi-jetons ; identifiants fongibles et non fongibles dans un même contrat.

> **Dans chainmap :** les arêtes de jetons sont dédupliquées sur une **clé précise**
> (`action | hash | from | to | contractAddress | tokenID | logIndex`). Le symbole ne fait
> *pas* partie de la clé — deux contrats différents peuvent tous deux s'appeler « USDC », et
> une seule tx ERC-1155 peut déplacer plusieurs identifiants de jetons. Fusionner sur le
> symbole confondrait des mouvements distincts ; chainmap les garde séparés.

## 6. Graphe de transactions et expansion BFS

En partant de votre adresse (la **racine**, en rouge), chainmap examine ses contreparties,
puis *leurs* contreparties, et ainsi de suite — un **parcours en largeur (BFS)** sur le graphe
d'adresses. La *profondeur de récursion* contrôle le nombre de sauts. La couleur des nœuds
encode la profondeur.

> **Dans chainmap :** augmentez la *profondeur de récursion* pour élargir l'enquête. Des
> garde-fous la maintiennent bornée et peu coûteuse : une taille d'échantillon par adresse, un
> **plafond de sécurité** strict sur le nombre total d'adresses, et un bouton **Arrêter** qui
> interrompt réellement les requêtes en cours. Utilisez d'abord **Estimer le scan** pour prévoir le nombre
> d'appels API et la durée avant un gros parcours.

## 7. Échantillonnage ≠ historique complet

La mise en garde forensique. chainmap récupère les **N dernières** transactions par adresse et
par type — **pas** l'historique complet. Cela garde les scans rapides et bon marché, mais le
graphe est donc un **échantillon**.

> **Dans chainmap :** une bannière persistante et l'export CSV le signalent tous deux.
> **Règle :** ne présentez jamais un graphe échantillonné comme complet ou forensique.
> Augmentez la limite par adresse si nécessaire, et mentionnez toujours l'échantillonnage dans
> vos conclusions.

## 8. Transactions échouées et annulées

Une transaction peut être *incluse dans un bloc tout en échouant* (manque de gaz, un
`revert`). Elle coûte du gaz mais **ne déplace aucune valeur**. Etherscan les marque
(`isError = "1"`, `txreceipt_status = "0"`).

> **Dans chainmap :** les tx échouées sont **écartées avant le tracé des arêtes** — un
> transfert annulé ne doit jamais apparaître comme un mouvement d'argent réel.

## 9. EVM et multichaîne

Ethereum, BSC, Polygon, Arbitrum, Optimism, Base, Avalanche, Fantom… sont toutes
**compatibles EVM** : même format d'adresse, même modèle de tx. Elles diffèrent par leur
**chain id**. Etherscan v2 les expose via **un seul point d'accès**, sélectionné par un
paramètre `chainid`.

> **Dans chainmap :** le sélecteur *Chaîne* ne fait que changer le `chainid`. Comme toutes les
> chaînes EVM partagent le format `0x`-40-hex, une adresse seule **ne peut pas** vous dire à
> quelle chaîne (ni mainnet vs testnet) elle appartient — il faut le contexte des
> transactions. Le détecteur de chaîne rend cette limite explicite.

## 10. Heuristiques pour enquêter

Transformer des données en pistes. Les vraies blockchains sont bruitées. chainmap encode les
motifs que recherchent les enquêteurs :

- **Filtres montant / date / valeur-nulle / spam** — couper le bruit pour voir le signal.
- **Regroupement d'arêtes** — fusionner de nombreux transferts A→B en une seule flèche
  pondérée (« N tx, total X »).
- **Hubs puits / source** — adresses qui surtout *reçoivent* (puits) ou surtout *envoient*
  (source), souvent des exchanges / mixeurs / airdrops ; atténuées pour ne pas dominer.
- **Allers-retours (cycles)** — une valeur qui revient à son point de départ (A→B→A, ou des
  boucles plus longues) est un signal classique de **layering / wash trading**. L'algorithme
  SCC de Tarjan cercle chaque adresse d'un cycle.
- **Coloration par ancienneté** — flux anciens froids/ternes → flux récents chauds/vifs, pour
  lire le tempo.
- **Libellés d'adresses connues** — une liste locale intégrée nomme les contrats bien connus
  (WETH, USDC, routeurs) **sans aucune requête réseau**.
- **Score de risque par nœud** — un chiffre de triage *explicable* combinant ce qui précède
  (sur un cycle, hub, degré élevé, appels de contrat, entité connue). Cliquez un nœud pour
  voir le score **et toutes les raisons** — aucune boîte noire.

![superpositions d'enquête : anneaux de cycle + arêtes pondérées + légende](img/overlays.png)

---

## Travaux pratiques

Chargez **Mode démo**, puis déroulez ces exercices. Chacun nomme le(s) concept(s) qu'il
travaille.

1. **Lire le graphe.** Repérez la racine (rouge). Suivez les flèches — qui a envoyé à qui, et
   combien ? Quelle arête est la plus épaisse, et pourquoi ?
   *(→ Transactions, Valeur et décimales)*
2. **Trouver l'appel de contrat.** Une arête est en pointillés avec un `✱`. Cliquez-la : quelle
   méthode a été appelée ? Quels sont les arguments décodés ? Pourquoi un *transfert de valeur*
   est-il aussi un appel de contrat ? *(→ Calldata et sélecteurs)*
3. **Repérer le layering.** Activez **Surligner les allers-retours**. Quelles adresses reçoivent un
   anneau ambre ? Tracez le cycle à la main. Pourquoi un flux qui revient est-il suspect ?
   *(→ Heuristiques pour enquêter)*
4. **Couper le bruit.** Réglez un *Montant min.*, activez *Masquer valeur nulle*, puis
   **Regrouper les arêtes**. Comment le signal lisible change-t-il ? *(→ Heuristiques pour enquêter)*
5. **Trier par risque.** Cliquez chaque nœud et lisez sa ligne **Risque**. Classez les adresses.
   Laquelle enquêteriez-vous en premier, et quelles preuves motivent ce choix ?
   *(→ Heuristiques pour enquêter)*
6. **Respecter l'échantillon.** Notez la bannière d'échantillonnage. Si c'était réel, que
   faudrait-il faire avant de qualifier une conclusion de complète ? *(→ Échantillonnage)*
7. **Détecter la chaîne.** Collez une adresse Bitcoin (`1A1zP1eP5QGefi2DMPTfTL5SLmv7DivfNa`)
   dans le champ d'adresse. Que vous dit chainmap, et pourquoi ne peut-il pas la scanner ?
   *(→ Comptes, Multichaîne)*
8. **Produire des preuves.** Ajoutez une note, exportez en **PNG** et **CSV**. Que préserve le
   CSV que l'image ne montre pas ? *(→ Panneau Export)*

*Conseil pour l'enseignant :* construisez un petit `data/demo-workspace.json` d'un incident
connu et faites reconstruire l'histoire par les étudiants à partir du seul graphe.

![détecteur de chaîne + mobile](img/detector.png)

---

[← Retour au README](../README.fr.md) · [English](LEARN.md)

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
11. [Preuves et provenance](#11-preuves-et-provenance)
12. [Travaux pratiques](#travaux-pratiques)

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

> **Dans chainmap :** **Charger les plus anciennes** étend l'échantillon d'un nœud page par page, mais
> l'historique n'est complet que lorsque Etherscan renvoie un lot incomplet pour ce nœud. Une bannière
> persistante et l'export CSV le signalent tous deux.
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

Ethereum, BSC, Polygon, Arbitrum, Optimism, Base, Avalanche, Sonic… sont toutes
**compatibles EVM** : même format d'adresse, même modèle de tx. Elles diffèrent par leur
**chain id**. Etherscan v2 les expose via **un seul point d'accès**, sélectionné par un
paramètre `chainid`.

> **Dans chainmap :** le sélecteur *Chaîne* ne fait que changer le `chainid`. Comme toutes les
> chaînes EVM partagent le format `0x`-40-hex, une adresse seule **ne peut pas** vous dire à
> quelle chaîne (ni mainnet vs testnet) elle appartient — il faut le contexte des
> transactions. Le détecteur de chaîne rend cette limite explicite.

### Même clé vs même adresse

La signature d'un EOA prouve qu'**une seule clé** contrôle cette adresse sur toutes les
chaînes EVM : la même adresse EOA sur deux chaînes est donc un indice de clé unique (le même
*propriétaire* reste une inférence). Un **contrat** à la même adresse est en général sans
rapport : Multicall3 et Permit2 sont à la même adresse partout, et n'importe qui peut
déployer un autre contrat à une adresse que vous contrôlez sur une autre chaîne. Exemple : en
juin 2022, Wintermute a envoyé 20 M d'OP sur Optimism à l'adresse de son Safe L1 ; ce Safe
n'existait pas sur Optimism, et un attaquant y a déployé un Safe et pris les jetons.

> **Dans chainmap :** la même adresse sur deux chaînes donne deux nœuds. Un lien pointillé
> **même clé** n'est tracé que si l'adresse a signé une transaction normale (`txlist`) sur une
> chaîne qui n'est pas nativement en abstraction de compte. Les paires sans cet indice
> apparaissent comme « même adresse seulement — probablement sans lien » dans la ligne
> *Autres chaînes* du nœud, et ne sont jamais tracées.
>
> **Limite connue :** sur les chaînes OP-stack/Arbitrum, le `txlist` d'Etherscan peut inclure
> des transactions de dépôt/système L1→L2 dont l'émetteur est un contrat L1 aliasé ; cela
> pourrait passer pour « même clé » entre deux telles chaînes. Le lien est un indice, pas une
> preuve de propriété commune. Colorer les nœuds par chaîne et tracer les liens « même adresse
> seulement » ne sont pas dans cette version.

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
- **Libellés d'adresses connues et risk-flags** — une liste locale intégrée nomme des entités
  bien connues — pas seulement des contrats (WETH, USDC, routeurs) mais aussi des
  **exchanges, ponts, mixeurs et adresses sanctionnées par l'OFAC**, sur plusieurs chaînes —
  **sans aucune requête réseau**. Les catégories à fort signal alimentent les **risk-flags** :
  une arête dont le destinataire est un mixeur, un pont ou une entité sanctionnée est escaladée
  sur le graphe, et le panneau de détails d'un nœud affiche le libellé plus une ligne
  **Source** donnant la provenance (ex. une action OFAC, ou un libellé public d'explorateur).
  La liste est un **instantané daté, pas un flux de sanctions en direct** — vérifiez contre la
  liste OFAC SDN officielle avant d'agir sur un résultat `sanctioned`.
- **Score de risque par nœud** — un chiffre de triage *explicable* combinant ce qui précède
  (sur un cycle, hub, degré élevé, appels de contrat, entité connue). Cliquez un nœud pour
  voir le score **et toutes les raisons** — aucune boîte noire.
- **Adresses de dépôt d'une plateforme d'échange** — voir la sous-section ci-dessous.

![superpositions d'enquête : anneaux de cycle + arêtes pondérées + légende](img/overlays.png)

### Adresses de dépôt d'une plateforme d'échange

Les plateformes d'échange centralisées donnent à chaque client une **adresse de dépôt
unique**. Ce que le client y envoie est ensuite **balayé** (transféré, en général vite et
presque en totalité) vers l'un des portefeuilles chauds de la plateforme. Une adresse dont les
sorties vont presque toutes vers **un seul portefeuille connu** d'une plateforme est donc
probablement une adresse de dépôt de celle-ci : c'est la piste à porter auprès de la
plateforme dans une demande de conformité.

chainmap marque une telle adresse « dépôt probable → `<portefeuille>` » quand tout ceci est vrai :

- **Ses propres transactions ont été récupérées**, natives comme jetons. Sinon ses sorties
  dans le graphe ne sont que ce que les requêtes d'autres nœuds ont laissé voir, et elle n'est
  jamais jugée.
- Elle n'est pas elle-même une entité connue, et elle a envoyé de la valeur à **un seul**
  portefeuille connu de plateforme.
- **La règle 90/90 :** au moins 90 % de ses transferts sortants (en nombre) sont allés à ce
  portefeuille et, pour chaque actif balayé, au moins 90 % de la valeur (BigInt sur les unités
  de base, pourcentage arrondi à l'inférieur : 99,9 % n'apparaît jamais comme 100 %). Les
  faux transferts de jetons imitation ou listés comme spam sont ignorés.
- **Au moins un balayage se fait dans la monnaie native de la chaîne ou dans un jeton connu**
  (listé dans `data/`). N'importe qui peut déployer un jeton dont le contrat émet un faux
  `Transfer` depuis n'importe quelle adresse : un transfert de jeton forgé ne peut donc pas, à
  lui seul, créer une marque.

Le panneau de détails montre les indices : « N transferts sortants sur M », la part par actif
et une **ligne de délai** (« balayé moins de 10 minutes après la dernière entrée »). Le délai
utilise le même filtre que les sorties (action récupérée, valeur > 0, ni imitation ni spam) et
il est affiché, pas exigé : les politiques de balayage vont de quelques minutes à plusieurs
semaines, et l'entrée est souvent hors de l'échantillon.

Limites, à lire avant de se fier à une marque :

- Tout repose sur des **données échantillonnées** ; l'indice vaut ce que vaut la récupération
  des N dernières transactions.
- **1 sur 1 suffit.** Une adresse de dépôt ne sert souvent qu'une fois ; le compte est affiché
  pour que vous le pesiez.
- Seuls les portefeuilles de `data/` sont reconnus ; les autres plateformes restent invisibles.
- Un flux réparti entre deux portefeuilles de plateforme reste non marqué (cela pourrait être
  deux plateformes).
- **Des transferts falsifiés peuvent encore masquer un dépôt.** Les faux transferts d'un jeton
  inconnu comptent comme des transferts sortants : ils peuvent faire passer une vraie adresse
  de dépôt sous le seuil de 90 %.
- **Les actifs jamais balayés vers le portefeuille ne sont pas jugés en valeur.** Un gros
  transfert d'un autre actif ailleurs ne compte que pour un transfert dans la part de 90 % en
  nombre.
- Le jugement se fait **par chaîne** ; la même adresse sur deux chaînes est jugée deux fois,
  indépendamment.
- C'est une **piste, pas une preuve de propriété** : vérifiez auprès de la plateforme.

Exemple : dans la démo, `0xdec0…0001` est alimentée par la racine puis balayée vers Binance 14
dix minutes plus tard ; elle est donc marquée (données illustratives).

### Ponts : liens déduits, pas des preuves

Un **pont** fait passer de la valeur d'une chaîne à l'autre. Deux conceptions comptent ici. Un
pont **lock-mint** verrouille l'actif dans un contrat sur la chaîne A et crée (mint) une copie
enveloppée sur la chaîne B. Un pont à **liquidité** prend votre dépôt sur A et un relayeur vous
paie sur B avec son propre stock, moins des frais. Sur la chaîne de destination, la « libération »
peut ressembler à un **mint depuis `0x0…0`** (un transfert de jeton dont l'expéditeur est l'adresse
zéro), à une **transaction interne du contrat de pont L2** ou à un **remplissage par un relayeur**
(un transfert ordinaire). Aucun ne porte l'identifiant du dépôt dans les données que lit chainmap :
le lien entre les deux chaînes ne peut qu'être **déduit**.

chainmap étiquette 271 contrats de pont. Un transfert de valeur vers l'un d'eux est un **dépôt de
pont**. Il propose ensuite des **libérations candidates** à partir des transactions déjà chargées
et trace chacune en **lien pointillé, « déduit — à vérifier »**. C'est une piste à vérifier sur les
deux explorateurs, jamais une preuve.

Ce qu'il lui faut, et comment il le lit :

- **La base du destinataire.** Le destinataire attendu de l'autre côté est soit **décodé depuis
  l'appel de dépôt** (une fonction de pont connue comme `depositEtherFor(address)` le nomme), soit,
  faute de décodage, **supposé être l'adresse du déposant**. Ce repli est une base plus faible et
  **n'augmente jamais la confiance à lui seul**. Il n'est supposé que si le déposant n'est pas un
  exchange, routeur, pont, mixeur ou jeton connu sur cette chaîne, car ceux-là agissent pour
  d'autres. Tout autre déposant, y compris un acteur sanctionné connu, est supposé recevoir à sa
  propre adresse. Pour les autres, les détails disent « Destinataire inconnu » et aucun candidat
  n'est cherché.
- **Les facteurs observés.** Une libération doit être sur une autre chaîne, vers ce destinataire,
  après le dépôt et dans les **14 jours**, pour le même actif (ETH et WETH comptent comme
  identiques), et de montant égal ou **inférieur d'au plus 3 %** (lu comme « compatible avec des
  frais de pont, ou un transfert sans rapport »). Les échanges (dépôt d'USDC, réception d'ETH) ne
  sont pas proposés. Les montants sont comparés exactement (BigInt). L'**expéditeur** de la
  libération est aussi noté : un pont connu, un mint de jeton, ou ni l'un ni l'autre. L'actif est
  *de confiance* s'il est natif ou un jeton connu sur sa chaîne.
- **Les niveaux** (le premier qui s'applique) :

  | Niveau | Exige |
  |---|---|
  | `high` | unique, actif de confiance, montant **égal**, destinataire **décodé**, expéditeur = pont connu ou mint |
  | `medium` | unique, actif de confiance, et (destinataire décodé **ou** expéditeur = pont connu ou mint) ; un montant réduit par des frais est plafonné ici |
  | `low` | tout le reste : destinataire de repli seul, un second candidat d'un côté ou de l'autre, échantillon non couvrant, actif non fiable |

  Même `high` s'affiche avec « déduit — à vérifier ». Aucun résultat calculé n'est dit confirmé.
- **La couverture.** *Unique* exige que les transactions chargées **du destinataire lui-même**
  remontent jusqu'à l'heure du dépôt, pour qu'une meilleure correspondance ne se cache pas dans un
  historique non chargé. Sinon, les détails le disent et proposent **Charger plus ancien**. (Une
  arête apparue seulement sur la page d'une contrepartie ne prouve jamais la couverture.)
- **Un candidat par transaction de libération.** Plusieurs arêtes d'une même transaction de
  libération (par exemple listée deux fois, en transfert interne et en transfert de jeton) ne
  forment qu'un candidat.
- **Chercher la sortie sur {chaîne}.** Un clic charge les transactions natives, internes et de
  jetons du destinataire là-bas (une page chacune, journalisées dans le journal des requêtes ;
  chainmap n'explore jamais seul une chaîne de destination). Si le destinataire est déjà chargé sur
  cette chaîne, il charge plutôt une page plus ancienne.
- **Votre décision est une affirmation.** Confirmez, rejetez ou effacez chaque candidat. Elle est
  consignée comme *confirmé par l'enquêteur*, avec son heure, partout où elle apparaît (détails,
  CSV `bridge_inferred`, PNG/PDF, MANIFEST, espace de travail). Ce n'est **jamais une preuve
  on-chain** et elle **ne change jamais un niveau calculé** : rejeter un candidat ne fait pas
  passer un autre en `high`.

Limites, à lire avant de s'appuyer sur un lien :

- **Les candidats viennent uniquement des données chargées**, qui sont échantillonnées (voir la
  section 7). Une libération non chargée ne peut pas être proposée, et l'absence de candidat ne
  prouve rien.
- **Routeurs et agrégateurs.** Quand un contrat fait le dépôt (y compris par transaction interne),
  c'est lui le déposant, pas la personne derrière. Un routeur connu n'a pas de destinataire ; un
  contrat inconnu est supposé recevoir à sa propre adresse (`low`, au plus `medium`). Il n'y a pas
  de remontée jusqu'au portefeuille d'origine, car un routeur peut payer n'importe où.
- Les **échanges à travers un pont**, les chaînes de ponts **multi-sauts** et les destinations non
  EVM ne sont pas suivis.
- **Alias Arbitrum :** l'adresse d'un contrat déposant peut apparaître sous un alias sur L2 ; le
  destinataire supposé est alors faux et aucun candidat n'apparaît.
- **Chaînes `plan_required` :** une clé gratuite peut être refusée sur certaines chaînes ; la
  requête Chercher échoue alors et aucun candidat n'apparaît.
- **L'identifiant d'une décision suit l'arête de plus petite clé de la transaction de
  libération.** Si une arête de plus petite clé de la même transaction se charge plus tard,
  l'identifiant change : l'ancienne décision est conservée et sauvegardée dans l'espace de
  travail, mais n'est plus affichée.
- **Libellé français de la ligne « destinataire inconnu » :** le mot `{category}` est le mot brut
  de la catégorie (par exemple « exchange »), non traduit.
- **Limite de couverture :** la fenêtre propre du destinataire est jugée remonter assez loin quand
  une arête datée au plus tard du dépôt se situe à partir du bloc le plus ancien de l'historique.
  Une libération dans exactement ce bloc limite, à la même seconde que le dépôt, pourrait être
  manquée.

Exemple : la démo contient un dépôt illustratif de 20 ETH d'un exploiteur vers le
`RootChainManager` de Polygon (pont connu), dont l'appel `depositEtherFor` nomme le destinataire.
Sur la chaîne 137, ce destinataire a reçu 20 WETH créés depuis `0x0…0` trente minutes plus tard.
Destinataire décodé, montant égal, expéditeur = mint, actif de confiance, historique du
destinataire complet : le candidat est `high`, toujours « déduit — à vérifier ». L'autre dépôt de
la démo n'a pas de candidat et affiche donc la ligne **Chercher la sortie** (données
illustratives).

---

## 11. Preuves et provenance

Une image de graphe se conteste facilement : quand a-t-elle été faite, à partir de quelles
données, a-t-elle été retouchée ? chainmap tient un **journal des requêtes** et peut tout
réunir dans un **dossier de preuves** pour que vous, ou un lecteur, puissiez vérifier que les
fichiers n'ont pas changé depuis l'export.

**Ce que le journal enregistre.** Une entrée par tentative de requête Etherscan (une nouvelle
tentative est une entrée à part ; une tentative annulée avec **Arrêter** n'est pas consignée) : l'heure (UTC), la chaîne, l'action, les paramètres de la
requête **sans votre clé d'API**, le statut HTTP, le nombre de lignes reçues, le **SHA-256 du
corps brut de la réponse** et une issue (ok, nouvelle tentative, erreur, sans réponse). Seule
l'empreinte est conservée, jamais la réponse : le journal reste léger et ne contient aucune
donnée de réponse, mais quiconque détient la même réponse brute peut vérifier qu'elle
correspond. La clé d'API est retirée avant tout stockage. Ouvrez le panneau **Journal des
requêtes** pour le lire, ou utilisez **Exporter le journal des requêtes (.json)**. Il est
aussi enregistré dans les espaces de travail.

**Ce que contient le dossier.** **Dossier de preuves (.zip)** télécharge
`chainmap-evidence-<heure UTC>.zip` :

- `graph.csv` et `graph.png` (le PNG est omis s'il dépasserait le plafond de pixels, et le
  manifeste l'indique dans `omitted`), qui montrent tous deux le graphe complet, quels que soient
  les filtres à l'écran, avec leur provenance (pied de page du PNG, ligne 1 du CSV) ;
- `workspace.json`, qui permet de recharger le graphe ;
- `query-log.json` ;
- `MANIFEST.json` : version de l'appli, heure d'export, chaînes, racines, taille du graphe,
  réglages d'échantillonnage, fenêtre de récupération, instantané des adresses connues,
  mises en garde et SHA-256 de chaque fichier ;
- `SHA256SUMS` : les mêmes empreintes que `MANIFEST.json`, plus celle de `MANIFEST.json`
  lui-même, dans un format que les outils standards savent contrôler.

**Comment le vérifier.**

```bash
unzip chainmap-evidence-*.zip -d case && cd case && sha256sum -c SHA256SUMS
```

Chaque ligne doit afficher `OK`. Sous macOS, utilisez `shasum -a 256 -c SHA256SUMS`. Sous
Windows, utilisez `Get-FileHash` (PowerShell) et comparez les valeurs à la main. Ensuite,
**notez le SHA-256 du zip lui-même** (affiché dans le journal de l'appli juste après
l'export) dans vos notes de dossier, ou confiez-le à un tiers : plus tard, recalculer
l'empreinte du zip doit redonner la même valeur.

**Limites. À lire avant de vous appuyer sur un dossier.**

- **Détection d'altération, pas une signature.** Les empreintes montrent que des fichiers ont
  changé après l'export. Elles ne prouvent ni *quand* le dossier a été produit ni *par qui* :
  qui peut reconstruire le zip peut reconstruire les empreintes. C'est un horodatage ou une
  signature d'un tiers qui apporte cela.
- **Données échantillonnées.** Les scans récupèrent les dernières transactions de chaque
  adresse (voir la section 7). Le dossier le dit ; ce n'est jamais l'historique complet de la chaîne.
- **Le journal enregistre des requêtes ; il ne prouve pas qu'il explique chaque enregistrement.**
  Il contient aussi des sondes qui n'ont ajouté aucune donnée au graphe (estimation du scan,
  détection de chaîne, « vérifier les autres chaînes »), et supprimer des nœuds ne supprime
  pas les entrées du journal.
- **« Partiel ».** Si une partie du graphe vient de la démo, d'un espace de travail enregistré
  sans journal (ou avec des entrées de journal invalides), ou si d'anciennes entrées ont été
  écartées à la limite du journal, le pied de page et le manifeste signalent qu'une partie du
  graphe n'a aucune récupération consignée au journal. Sinon, `retrieval.fullyLogged` vaut
  `true` dans le manifeste. Cela signifie seulement que rien n'a été écarté ni laissé hors
  journal ; cela ne veut pas dire que les données sont complètes : des requêtes ont pu
  échouer, des scans ont pu être arrêtés, et les données sont échantillonnées.
- **Libellés et heuristiques : des signaux, pas des faits.** Libellés connus, signaux de
  risque, jetons imités, marques de dépôt probable (aussi dessinées dans les PNG/PDF) et liens
  de même clé sont des pistes à corroborer. Les libellés connus viennent d'un instantané
  daté, consigné dans le manifeste.

### Estimations en USD

« Combien cela valait-il ? » n'est pas la même question que « combien était-ce ? ». chainmap peut
y répondre par une **estimation**, mais seulement si vous le demandez : cochez **Afficher les
valeurs en USD** dans le panneau Enquête. La case est **décochée à chaque chargement de la
page** et n'est jamais enregistrée (ni dans le navigateur, ni dans les espaces de travail).
Tant qu'elle est décochée, chainmap ne fait **aucune** requête au fournisseur de prix : ni au
chargement, ni lors d'un scan, de la démo, du chargement d'un espace de travail, du panneau de
détails ou d'un export.

**Ce qui est envoyé, et ce qui ne l'est jamais.** Une fois la case cochée, chainmap interroge
l'API gratuite de prix de DefiLlama (`coins.llama.fi`, sans clé) pour obtenir des prix
historiques, par lots, dans une file à part (1 requête par seconde, indépendante de votre quota
Etherscan). Une requête ne contient que :

- des **identifiants de monnaie** : `<nom de la chaîne>:<contrat du jeton>` (par exemple
  `ethereum:0xa0b8…`) ou un identifiant de monnaie native (`coingecko:ethereum`), en minuscules ;
- des **heures Unix arrondies à l'heure** ;
- `searchWidth=30m`.

Elle ne contient jamais une adresse examinée (expéditeur, destinataire ou racine), un hash de
transaction, votre clé Etherscan ni du texte libre, et elle n'envoie ni cookie ni référent. Comme
toute requête web, elle montre tout de même votre adresse IP à DefiLlama, et les contrats de
jetons lui indiquent quels actifs vous regardez. Un contrat de jeton qui est une **racine sur
n'importe quelle chaîne** de votre graphe n'est jamais envoyé (vérifié à la construction de la
requête, puis juste avant son envoi). La requête est aussi consignée dans votre journal des
requêtes (voir plus bas).

**Le créneau à l'heure la plus proche.** L'heure de chaque transaction est arrondie à
**l'heure la plus proche** (son créneau) et l'API est interrogée pour le prix à **±30 minutes**
de cette heure. Les deux écarts s'additionnent : le prix retenu est à **moins d'1 heure** de la
transaction. Le panneau de détails affiche l'heure propre du point de données (UTC), pour voir
à quel point il est réellement proche. Pour un actif stable, c'est sans importance ; pour un
jeton volatil, cela peut compter.

**La règle de confiance.** DefiLlama associe une `confidence` à la plupart des points de données
mais ne documente aucun seuil. Le seuil de 0,9 est **la règle propre à chainmap** : un point dont
la confiance est présente et inférieure à 0,9 est traité comme inconnu. Un point **sans**
confiance (les points anciens en manquent souvent) est accepté, et le panneau de détails
affiche la confiance « — ».

**Ce qui n'est jamais valorisé.** Ces transferts n'ont aucun prix, et le panneau de détails en
donne la raison (« non valorisé (...) ») :

- les **NFT** (ERC-721 / ERC-1155) ;
- les transferts de **valeur nulle** ;
- les **faux jetons** et les jetons de la **liste de spam** : un faux « USDT » ne reçoit jamais
  le prix du vrai USDT, car la valorisation passe par le contrat, jamais par le symbole ;
- les jetons dont le contrat est une **racine** de votre graphe (une adresse examinée) ;
- les chaînes que DefiLlama ne couvre pas, les **testnets**, et quelques lacunes : la **monnaie
  native de Fraxtal** (son jeton de gaz a changé à une date contestée, et les deux prix diffèrent
  d'environ 1000 fois) et les **jetons de MemeCore** (aucun nom de chaîne chez DefiLlama ;
  seule sa monnaie native est valorisée) ;
- les transferts dont le montant, les décimales ou l'heure sont inconnus ;
- les **arêtes regroupées** (un total A→B n'est pas une transaction) : dégroupez pour voir les
  valeurs par transfert.

Un prix inconnu, en attente, en échec ou de confiance insuffisante est affiché comme tel et
laissé **vide dans le CSV, jamais `0`**. Un montant positif valant moins d'un centime s'affiche
« < 0.01 ».

**Échec fermé.** Les contrôles faux jeton et spam reposent sur les données intégrées
d'adresses connues et sur la liste de spam. Si l'une des deux n'a pas pu être chargée, chainmap
ne demande **aucun** prix pendant toute la session et écrit une seule ligne d'erreur dans le
journal de l'appli. Une requête qui échoue est traitée sobrement : un 429 ou un 5xx est retenté
jusqu'à 3 fois (en respectant `Retry-After`, 60 s au plus) ; un délai dépassé, une erreur réseau ou tout autre
4xx n'est pas retenté et le transfert affiche « échec de la requête de prix ». Il est redemandé
au prochain changement du graphe ou quand la case est recochée. Un échec de prix ne ralentit ni n'arrête jamais un scan.

**Preuves.** Chaque requête de prix est une entrée du **journal des requêtes** (source DefiLlama,
action `batchHistorical`, paramètres `coins` et `searchWidth`, statut, lignes, SHA-256 du
corps), consignée **avant** que sa valeur puisse apparaître à l'écran. Dans le panneau, la
colonne d'adresse indique le nombre de monnaies de la requête. Les entrées restent après
décochage de la case, et sont effacées avec le reste du journal lors d'une réinitialisation, du
chargement d'un espace de travail ou de la démo. Dans le CSV, `usd_value` est après les
colonnes de dépôt (`bridge_inferred` le suit), et la ligne 1 indique que les valeurs sont des estimations et combien de
transferts valorisables ont reçu un prix. Dans le dossier de preuves, `MANIFEST.json` reçoit un
bloc `prices` (source, `estimate: true`, USD affiché ou non, nombre de requêtes, transferts
valorisés et valorisables), et la mise en garde USD s'ajoute à ses mises en garde. Les
PNG/PDF n'affichent aucun USD.

**Limites. C'est une estimation, pas un fait.**

- Le prix est celui de DefiLlama, à moins d'1 heure de la transaction. Ce n'est pas le prix
  obtenu par l'expéditeur ou le destinataire, et une valeur n'est rien d'autre qu'un montant
  multiplié par un prix.
- Les **jetons de longue traîne** ont peu de données de prix : beaucoup de transferts resteront
  vides. Les **chaînes et jetons récents** n'ont rien avant leur référencement, donc leurs
  premiers transferts sont vides, ce qui est la bonne réponse.
- La **monnaie native de Polygon** est passée de MATIC à POL le 2024-09-10 (Unix 1725926400) ;
  chainmap utilise la monnaie correspondante de chaque côté de cette date.
- DefiLlama est un tiers : ses données peuvent être révisées, et chainmap ne peut pas s'en
  porter garant. Recoupez avec une seconde source tout ce qui compte (pièce de procédure,
  rapport).

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

# ScoutPad

Petit site local en JavaScript pour piloter un Moorebot Scout depuis un navigateur avec la Gamepad API, des boutons clavier/souris et un panneau video central.

## Applications 1.1.3

Les binaires sont disponibles dans les [releases GitHub](https://github.com/neoteknic/scoutpad/releases).

- Android : installer `ScoutPad-Android-1.1.3.apk`. Le pont ROS est inclus.
- Windows x64 : extraire `ScoutPad-Windows-x64.zip`, puis ouvrir `ScoutPad.exe`. Le pont ROS est inclus ; aucun Node ou Go a installer. L'icone de notification permet d'arreter le serveur.
- Windows utilise .NET Framework 4.8 et ouvre l'interface dans le navigateur par defaut, a `http://127.0.0.1:18114/`.
- Si Windows bloque ROS, lancer `Setup-Firewall.ps1` en administrateur sur un reseau prive. La regle autorise uniquement le programme et l'IP du robot (192.168.0.142 par defaut ; parametre `-RobotIp` pour la changer), y compris le port XML-RPC dynamique et TCPROS.

Les applications Android et Windows partagent le meme backend dans `bridge/mobilebridge`. La version Node ci-dessous reste disponible pour les endpoints HTTP personnalises et le proxy RTSP.

### Changements 1.1.3

- Soundboard : importer un fichier audio, renommer, preecouter localement, jouer sur le haut-parleur du Scout et arreter.
- Six affectations de sons memorisees : croix haut/bas/gauche/droite, X et Y. Choisir un son ou `Aucun` dans la section Sons. Un appui declenche une seule lecture, sans armement ; la croix ne deplace plus le robot. Les sticks et les fleches du clavier restent disponibles pour piloter.
- Sons conserves sur l'appareil de controle dans IndexedDB, pas sur le robot. Limites : 24 sons, 30 secondes par son, 10 Mo par fichier, 30 Mo par bibliotheque.
- Conversion mono AAC-LC 16 kHz : MediaCodec natif sur Android, encodeur FFmpeg audio minimal inclus sur Windows, FFmpeg existant avec Node. MP3/WAV et les autres formats decodables par le navigateur sont acceptes.
- Lecture sans armer ni deplacer le robot. Simulation n'envoie pas de son ; une suspension de l'application arrete la lecture.
- Le haut-parleur du Scout prend environ 2 secondes a se preparer. L'etat indique l'envoi des trames ROS, pas une confirmation acoustique du robot.
- Les nouveaux imports gardent 100 % du niveau du fichier, sans attenuation ni amplification au-dela du maximum numerique. Le firmware ROS ne fournit pas de reglage du volume de l'amplificateur. Reimporter les sons encodes precedemment a 80 % pour beneficier du niveau plein.
- Les sons restent propres a l'origine de l'interface : navigateur Node 5173 et application Windows 18114 ont des bibliotheques distinctes. Effacer les donnees de l'app/navigateur supprime les sons.

### Changements 1.1.2

- Annulation complete du retour : signal `/AppNode/cancel_detect` puis annulation NavPathNode et CoreNode. Les deux services doivent repondre sans erreur.
- A / Espace interrompt le retour en attente ou en cours, sans faire avancer le robot. Hors retour, A conserve la sortie de base.
- Deux sons distincts apres acquittement : retour demande et retour annule. Son natif Android sur le volume multimedia ; navigateur, cliquer une fois dans la page pour autoriser l'audio.
- Etat du retour suivi via `/CoreNode/going_home_status`. Les commandes manuelles attendent l'annulation du retour.

### Changements 1.1.1

- Menu de selection de manette ; choix Android memorise par descripteur.
- Detection automatique Android basee sur une vraie entree, sans verrouillage du premier controleur annonce.
- Connexion ROS avant l'armement, et armement automatique sur une nouvelle entree de la manette choisie.
- Start reste un interrupteur armer/desarmer ; un stick maintenu ne rearme pas apres desarmement.
- Menu contextuel et selection de texte hors champs desactives dans la WebView Android.

### Changements 1.1.0

- Arret prioritaire au relachement d'un stick ; rejet des requetes perimees.
- Actions A/B preservees, appuis Android courts transmis directement et requetes bornees dans le temps.
- Detection reelle de la manette ; axes remis a zero lors d'une suspension. Recentrer les sticks avant de reprendre.
- Surveillance du reseau et du flux video, avec reconnexion progressive et diagnostic de l'age des images.
- Sortie de base de 1,8 seconde geree independamment du watchdog de pilotage de 260 ms.
- Fermeture des boucles Go et recuperation apres perte du processus WebView.
- Reglages distincts pour avance/recul, translation et rotation.
- Photo, enregistrement, HTTP personnalise et proxy RTSP masques dans les applications natives, ou ils ne sont pas disponibles.

### Verification et Builds

```powershell
npm test
cd bridge/mobilebridge
go test ./...
go vet ./...
cd ../..
npm run build:android
npm run build:windows
```

La commande Windows produit `dist/ScoutPad-Windows-x64.zip`. Le build Android produit `Moorebot-Scout-Android.apk`. Les binaires ne sont pas suivis par Git ; ils sont joints aux releases.

Les tests de l'interface utilisent des API simulees et ne font pas bouger le robot. `scripts/check-ui.cjs` peut etre lance avec Playwright installe ; `PLAYWRIGHT_MODULE` et `PLAYWRIGHT_CHANNEL` permettent de choisir le module et le navigateur disponibles.

## APK Android autonome

L'APK [Moorebot-Scout-Android.apk](Moorebot-Scout-Android.apk) embarque directement le bridge Go/ROS et n'a pas besoin du serveur Node sur le PC. Le telephone ou la console Android doit etre connecte au meme reseau Wi-Fi que le robot `192.168.0.142`.

La manette integree est lue par Android puis transmise a l'interface :

Depuis l'APK 1.1.1, le menu `Manette > Peripherique` permet de choisir un controleur Android, y compris les controleurs integres declares avec seulement des boutons ou un D-pad. Le choix est conserve par descripteur Android, et non par identifiant temporaire. En mode automatique, l'app attend une vraie entree au lieu de verrouiller le premier peripherique de la liste. Le changement de manette arrete et desarme le robot ; une manette choisie mais absente n'est pas remplacee automatiquement.

Le bouton `Armer` et Start connectent ROS avant d'armer. Une nouvelle entree analogique de la manette choisie arme aussi automatiquement ; Start permet toujours de desarmer. Les boutons de sons n'arment pas le robot. Recentrer les sticks avant de piloter apres l'armement ou une suspension. Les menus contextuels et la selection de texte hors champs de saisie sont desactives dans la WebView Android.

- Stick gauche vertical : avancer/reculer.
- Stick gauche horizontal : rotation.
- Stick droit horizontal : translation gauche/droite.
- Croix directionnelle : quatre sons personnalisables, sans mouvement.
- X et Y : deux sons personnalisables.
- A : sortir de la base ou annuler le retour base.
- B : retour a la base.
- Start/Menu : armer/desarmer.
- L1/LB : video on/off.
- R1/RB : video plein ecran.

Pour reconstruire l'APK apres une modification :

```powershell
npm run build:android
```

Le build necessite Android Studio/JDK, le SDK Android 35, le NDK `27.2.12479018`, Go Mobile et Gradle 8.9 dans `.tools`.

## Demarrage

```powershell
npm install
npm start
```

Ouvre ensuite `http://127.0.0.1:5173`.

Le binaire local `.runtime/scout-bridge.exe` relaie les commandes ROS avec `goroslib`, comme `go-scout`. Si tu dois le reconstruire :

```powershell
npm run build:bridge
```

## Commandes ROS inspirees de go-scout

Le mode par defaut utilise le protocole repere dans `Shell-Company/go-scout` :

- ROS Master : `{ip}:11311`
- mouvement : topic `/cmd_vel` en `geometry_msgs/Twist`, via le bridge goroslib local
- camera : topic `/CoreNode/jpg`, expose localement en MJPEG via `/api/ros/camera.mjpg`
- retour base : service `/nav_low_bat`
- lumiere : service `/CoreNode/adjust_light`

Dans l'interface :

1. Laisse `Mode commande` sur `ROS Scout`.
2. Verifie `Endpoint ROS` : `192.168.0.142:11311`.
3. Clique `Connecter ROS`.
4. Decoche `Simulation`, clique `Armer`, puis teste une commande.

Si la video ROS fonctionne mais que le robot ne bouge pas, regarde `/api/ros/status`.

- `bridge.running: true` : le bridge goroslib est lance et tient `/cmd_vel`.
- `bridge.lastError` non vide : erreur du bridge a corriger en premier.
- `ros.framePublishers: 1` : la camera ROS est connectee.

Le port TCPROS local de commande est fixe : `18112`. Il est utilise par `scout-bridge.exe`, pas par le serveur Node.

PowerShell en administrateur :

```powershell
New-NetFirewallRule -DisplayName "Moorebot Scout ROS TCPROS 18112" -Direction Inbound -LocalPort 18112 -Protocol TCP -Action Allow -Profile Any
```

## Commandes HTTP custom

L'interface envoie les commandes au serveur Node local, puis le serveur les relaie vers l'endpoint configure dans les reglages. Par defaut, le robot est `192.168.0.142` et l'endpoint est :

```text
http://{ip}/api/drive
```

Le corps JSON par defaut est :

```json
{"x":{x},"y":{y},"turn":{turn},"speed":{speed},"angle":{angle},"magnitude":{magnitude},"action":"{action}"}
```

Variables disponibles dans les templates : `{ip}`, `{x}`, `{y}`, `{turn}`, `{speed}`, `{angle}`, `{magnitude}`, `{direction}`, `{left}`, `{right}`, `{action}`.

Important : le mode HTTP est conserve comme secours configurable. La valeur par defaut `http://{ip}/api/drive` est un placeholder testable, pas une API Moorebot garantie.

Si `Sortir de la base` ne bouge pas :

1. Le mode `Simulation` doit etre decoche.
2. Le controle doit etre arme avec `Armer`, Start, ou une entree de la manette choisie.
3. En mode ROS, `/api/ros/status` doit afficher `bridge.running: true`.

## Manette

- Stick gauche vertical : avancer/reculer.
- Stick gauche horizontal : rotation.
- Stick droit horizontal : translation gauche/droite.
- A : sortir de la base ou annuler un retour base en cours.
- B : retour a la base.
- Start/Menu : armer/desarmer.
- L1/LB : video on/off.
- R1/RB : video plein ecran.
- Autres touches : inactives pour l'instant.

## Clavier

- Fleche haut/bas : avancer/reculer.
- Fleche gauche/droite : translation gauche/droite.
- Q/S : rotation gauche/droite.
- Espace : sortir de la base ou annuler un retour base en cours.
- B : retour a la base.

Le controle doit etre arme pour envoyer de vraies commandes. `Armer` ou Start connectent ROS automatiquement ; une nouvelle entree de la manette choisie arme aussi le controle. En mode simulation, rien n'est envoye au robot.

## Video

Le Scout expose surtout du RTSP selon la documentation publique. Les navigateurs ne lisent pas RTSP directement.

Options :

- Renseigner une URL MJPEG HTTP dans `URL video`.
- Renseigner une URL HLS `.m3u8`.
- Laisser une URL `rtsp://...`, puis cliquer sur `Proxy RTSP`. Le projet installe un binaire ffmpeg local via npm et le serveur Node convertit alors le flux RTSP en HLS local.

Exemple :

```text
rtsp://192.168.0.142:554/live
```

Si le chemin RTSP exact du Scout differe, remplace-le dans les reglages.

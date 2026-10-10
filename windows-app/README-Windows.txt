ScoutPad 1.1.3 - Windows x64 portable

Extraire toute l'archive puis ouvrir ScoutPad.exe.
L'interface s'ouvre dans le navigateur par defaut. Le serveur et le pont ROS sont inclus.
Une icone ScoutPad dans la zone de notification permet d'ouvrir ou d'arreter l'application.
Le PC et le robot doivent etre sur le meme reseau. IP par defaut : 192.168.0.142.
Si les commandes ROS ne passent pas, executer Setup-Firewall.ps1 dans PowerShell administrateur.

A : sortie / annulation retour base. B : retour base. Start : armer / desarmer.
A pendant le retour l'annule sans lancer la sortie de base.
Deux sons confirment le retour et son annulation. Cliquer une fois dans l'interface pour autoriser le son du navigateur.
LB : video on/off. RB : plein ecran.
Stick gauche : avance/recul et rotation. Stick droit horizontal : translation.
Clavier : fleches pour le mouvement, Q/S pour la rotation, Espace pour sortir, B pour rentrer.

Le controle demarre desarme. Apres une suspension, remettre les sticks au centre.
Armer ou Start connectent ROS automatiquement. Une nouvelle entree de la manette choisie arme aussi le controle.
Choisir le peripherique dans le menu Manette. Changer de manette arrete et desarme le robot.
Windows 10/11 x64 avec .NET Framework 4.8. Aucun Node, Go ou ffmpeg a installer.

Sons : importer, renommer, ecouter ici, jouer sur le robot, arreter.
24 sons maximum, 30 secondes par son, fichiers de 10 Mo maximum.
Les sons sont conserves dans le navigateur utilise, pas dans le robot.
Le haut-parleur prend environ 2 secondes a se preparer. Aucun armement necessaire.
La suspension de l'interface arrete le son. Aucune nouvelle touche manette n'est assignee.
Sources et licences de l'encodeur audio : third-party/ffmpeg.

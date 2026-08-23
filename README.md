# Utilisation
- Ouvrir l’[URL de l'application](https://gcatrans.github.io/test-ocr-onnx-develop/).
- Sélectionner « Manual » (rognage manuel, recommandé pour Android) ou « Auto » (rognage automatique).
- Cliquer sur « New » pour prendre une photo ou « Existing » pour sélectionner une photo existante.
- Rognage
  - Manual : Tracer un rectangle autour de la zone de marquages sans couper les caractères.
  - Auto :
    - Attendre que le statut indique « Container ID located… ».
    - Vérifier que l'application a bien entouré la zone de marquages et la redimensionner manuellement si elle inclut des caractères qui ne sont pas des marquages.
- Cliquer sur « Scan selected crop region ».
- Attendre l'affichage des résultats.
- /!\ En cas d’erreur, relancer l’application et recommencer la procédure.

# Installation en mode hors connection
- Ouvrir l’[URL de l'application](https://gcatrans.github.io/test-ocr-onnx-develop/).
- Type de terminal (iOS recommandé)
  - iOS
    - Appuyer sur le bouton « Partager » de Safari (carré avec une flèche vers le haut).
    - Sélectionner "Ajouter à l'écran d'accueil".
    - Valider le nom de l'application.
    - Appuyer sur "Ajouter".
  - Android
    - Cliquer sur les trois points du menu du navigateur en haut à droite -> Installer et créer un raccourci -> Ajouter -> Ajouter.
- Télécharger les [images de test](./images) (optionnel).
- Effectuer au moins une analyse avec les images de test ([Utilisation](#Utilisation)) pour télécharger tous les fichiers de l’application et les stocker sur l'appareil mobile.
- Passer en mode avion.
- Vérifier que l'analyse des images de test fonctionne toujours.

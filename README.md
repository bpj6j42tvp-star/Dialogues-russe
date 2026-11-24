# Studio Dialogues

Générateur de courtes vidéos de dialogues (russe → français) pour TikTok et YouTube Shorts.
Tout se passe dans le navigateur (Safari sur iPad), sans serveur. Les voix viennent d'Azure AI Speech (niveau gratuit F0).

## Mettre la page en ligne (GitHub Pages, gratuit)

1. Sur l'iPad, ouvre le dépôt GitHub dans Safari (version « site pour ordinateur » si les menus manquent : bouton **aA** → *Demander le site pour ordinateur*).
2. **Settings** → **Pages** (menu de gauche).
3. *Source* : **Deploy from a branch**. *Branch* : choisis la branche qui contient `index.html`, dossier **/ (root)**, puis **Save**.
4. Attends 1 ou 2 minutes, puis recharge : l'adresse s'affiche en haut (`https://<ton-pseudo>.github.io/<nom-du-depot>/`).
5. Ouvre cette adresse dans Safari → bouton Partager → **Sur l'écran d'accueil** : tu as une icône comme une app.

> GitHub Pages gratuit exige un dépôt **public**. Ce n'est pas un problème : la clé Azure n'est jamais dans le code.

## Utilisation

1. **Clé Azure** : portail Azure → ta ressource Speech → *Clés et point de terminaison*. Copie **KEY 1** et la **Région** (ex. `westeurope`). Clique *Tester la clé*.
2. **Dialogue** : choisis un exemple ou colle le tien, une réplique par ligne : `M: русский текст | traduction`.
3. **Générer l'audio**, puis **▶ Aperçu**.
4. **● Créer la vidéo** : l'enregistrement se fait en temps réel. Garde l'écran allumé et la page visible.
5. **Partager / Enregistrer dans Photos** (pour publier sur TikTok), ou télécharge la vidéo, le MP3 et le `.srt`.

## Choix techniques

- **Voix** : API REST `https://<région>.tts.speech.microsoft.com/cognitiveservices/v1`, SSML, format `riff-24khz-16bit-mono-pcm`. Si le navigateur bloque l'appel REST, la page bascule sur le SDK Speech officiel (WebSocket).
- **Vidéo** : `MediaRecorder` natif (Safari produit du MP4 H.264/AAC). ffmpeg.wasm n'est pas utilisé : environ 30 Mo à télécharger, trop gourmand pour la mémoire de l'iPad, et la version rapide demande des en-têtes que GitHub Pages ne permet pas.
- **Cache** : l'audio déjà généré est gardé sur l'appareil (IndexedDB), donc pas de quota consommé si tu régénères le même texte.
- **MP3** : encodé sur l'appareil avec lamejs. Si la bibliothèque ne se charge pas, l'audio est fourni en WAV.
- Code découpé en modules (`DialogueParser`, `AzureTTS`, `Timeline`, `VideoRenderer`, `Recorder`, `Exports`, `UI`). Les langues se règlent dans `LANGS` (géorgien et serbe déjà prévus, en test).

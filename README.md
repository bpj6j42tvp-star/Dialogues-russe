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
4. **● Créer la vidéo** : la vidéo est encodée image par image (30 i/s fixes). Reste sur la page jusqu'à la fin.
5. Lis le **contrôle automatique** (durées, nombre d'images, codecs) et regarde les 3 images de contrôle (5 s, milieu, fin − 2 s).
6. **Partager / Enregistrer dans Photos** (pour publier sur TikTok), ou télécharge la vidéo, le MP3 et le `.srt`.

### Accent tonique

Écris un accent aigu (U+0301) juste après la voyelle accentuée : `Ко́фе, пожа́луйста`. À l'écran, le signe disparaît et la voyelle s'affiche en rouge. Le texte envoyé à Azure est toujours sans accent. Ajouter ou corriger des accents ne relance pas la synthèse et ne consomme pas de quota.

## Choix techniques

- **Voix** : API REST `https://<région>.tts.speech.microsoft.com/cognitiveservices/v1`, SSML, format `riff-24khz-16bit-mono-pcm`. Si le navigateur bloque l'appel REST, la page bascule sur le SDK Speech officiel (WebSocket).
- **Vidéo** : rendu image par image. L'image n°i est dessinée à l'instant i/30 s, convertie en YUV 4:2:0 BT.709 plage vidéo (yuv420p), puis encodée en H.264 par l'encodeur matériel du navigateur (WebCodecs, Safari 16.4 et plus). Le son est en AAC (encodeur natif, sinon encodeur WebAssembly de secours). Le MP4 est assemblé par [mediabunny](https://mediabunny.dev) 1.65.2 avec l'index au début (équivalent de `-movflags +faststart`). Nombre d'images = durée audio × 30, par construction.
- **Pourquoi pas `MediaRecorder`** (version précédente) : c'était un enregistrement en temps réel. Safari n'écrit une image que lorsque le canvas est redessiné et affiché, à fréquence variable. Si le dessin s'interrompait (écran en veille, page masquée, etc.), l'image restait figée pendant que le son continuait.
- **Pourquoi pas ffmpeg.wasm** : environ 30 Mo à télécharger, trop gourmand pour la mémoire de l'iPad, et la version rapide demande des en-têtes que GitHub Pages ne permet pas.
- **Vérification** : après chaque export, la page relit le fichier (durées, nombre d'images, régularité à 30 i/s, codecs, étiquette couleur) et affiche 3 images de contrôle. Sur un ordinateur, `outils/verifier-video.sh video.mp4` refait les mêmes contrôles avec ffprobe.
- **Charte « L'Est en 60 secondes »** : fond #F3ECE1, texte #1C1A18, rouge #A01D22, texte secondaire #5F5A52, filets #1C1A1840. Polices : Playfair Display 800, Source Serif 4 500, IBM Plex Mono 500. Marges de sécurité : 200 px en haut, 90 px sur les côtés, 300 px en bas.
- **Cache** : l'audio déjà généré est gardé sur l'appareil (IndexedDB), donc pas de quota consommé si tu régénères le même texte.
- **MP3** : encodé sur l'appareil avec lamejs. Si la bibliothèque ne se charge pas, l'audio est fourni en WAV.
- Code découpé en modules (`Stress`, `DialogueParser`, `AzureTTS`, `Timeline`, `VideoRenderer`, `VideoExporter`, `Exports`, `UI`). Les langues se règlent dans `LANGS` (géorgien et serbe déjà prévus, en test).

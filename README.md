# Tiro – télécharger des vidéos (MP4 / MP3)

## Lancer chez toi (PC / Mac / Linux)
1. Installer Node 18+, ffmpeg et yt-dlp (`pip install yt-dlp` ou binaire officiel).
2. `node server.js` puis ouvrir http://localhost:3000

## Mettre en ligne (pour l'utiliser sur ton téléphone)
Le dossier contient un `Dockerfile` : Render, Railway ou Fly.io le déploient directement
(yt-dlp et ffmpeg sont installés automatiquement). Ouvre ensuite l'adresse sur ton iPhone
→ Partager → « Sur l'écran d'accueil » pour l'installer comme une app.

Garde yt-dlp à jour (`yt-dlp -U`) : les sites changent souvent.

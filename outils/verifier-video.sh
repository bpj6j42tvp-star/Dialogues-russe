#!/usr/bin/env bash
# Vérifie une vidéo exportée (sur un ordinateur avec ffmpeg/ffprobe).
# Usage : outils/verifier-video.sh video.mp4 [dossier_images] [nom:temps ...]
#   sans « nom:temps », extrait 3 images : 5 s, milieu, 2 s avant la fin.
#   ex. : outils/verifier-video.sh ep1.mp4 . accroche:0.5 avant:35.4 apres:37.9 fin:41.6
# Contrôles : H.264 yuv420p, AAC, 1080x1920, 30 i/s constants, durée vidéo = durée audio (±0,1 s),
# nombre d'images ≈ durée × 30, index « moov » au début (faststart). Extrait 3 images de contrôle.
set -euo pipefail
f="$1"; out="${2:-$(dirname "$f")}"; mkdir -p "$out"; shift $(( $# >= 2 ? 2 : 1 )); points=("$@")
q() { ffprobe -v error "$@" -of default=nw=1:nk=1 "$f"; }
vcodec=$(q -select_streams v:0 -show_entries stream=codec_name)
pix=$(q -select_streams v:0 -show_entries stream=pix_fmt)
wh=$(q -select_streams v:0 -show_entries stream=width,height | paste -sd x)
rate=$(q -select_streams v:0 -show_entries stream=r_frame_rate)
avg=$(q -select_streams v:0 -show_entries stream=avg_frame_rate)
acodec=$(q -select_streams a:0 -show_entries stream=codec_name)
vdur=$(q -select_streams v:0 -show_entries stream=duration)
adur=$(q -select_streams a:0 -show_entries stream=duration)
frames=$(q -select_streams v:0 -count_packets -show_entries stream=nb_read_packets)
moov_first=$(python3 - "$f" <<'PY'
import struct,sys
d=open(sys.argv[1],'rb'); order=[]
while True:
    h=d.read(8)
    if len(h)<8: break
    size,typ=struct.unpack('>I4s',h); typ=typ.decode('latin1')
    if size==1: size=struct.unpack('>Q',d.read(8))[0]; d.seek(size-16,1)
    else: d.seek(size-8,1)
    order.append(typ)
    if size==0: break
print('oui' if 'moov' in order and 'mdat' in order and order.index('moov')<order.index('mdat') else 'non', ' '.join(order))
PY
)
ok=1; chk() { if eval "$2"; then echo "✓ $1"; else echo "✗ $1"; ok=0; fi; }
chk "Vidéo $vcodec $pix" '[ "$vcodec" = h264 ] && [ "$pix" = yuv420p ]'
chk "Audio $acodec" '[ "$acodec" = aac ]'
chk "Taille $wh" '[ "$wh" = 1080x1920 ]'
chk "Fréquence r=$rate avg=$avg" '[ "$rate" = 30/1 ] && [ "$avg" = 30/1 ]'
chk "Durées vidéo $vdur s / audio $adur s (±0,1 s)" 'python3 -c "import sys;sys.exit(abs($vdur-$adur)>0.1)"'
chk "Images $frames ≈ $adur × 30" 'python3 -c "import sys;sys.exit(abs($frames-round($adur*30))>1)"'
chk "Faststart (moov avant mdat) : $moov_first" '[ "${moov_first%% *}" = oui ]'
mid=$(python3 -c "print($vdur/2)"); end=$(python3 -c "print($vdur-2)")
[ ${#points[@]} -eq 0 ] && points=("05s:5" "milieu:$mid" "fin-2s:$end")
for p in "${points[@]}"; do
  n=${p%%:*}; t=${p#*:}
  ffmpeg -v error -y -ss "$t" -i "$f" -frames:v 1 "$out/controle-$n.png"
  echo "  image de contrôle $n (t=$t s) → $out/controle-$n.png"
done
[ $ok = 1 ] && echo "RÉSULTAT : OK" || { echo "RÉSULTAT : ÉCHEC"; exit 1; }

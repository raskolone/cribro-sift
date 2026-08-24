#!/bin/bash
#
# Przeniesienie zbudowanej aplikacji do /Applications — razem z tym,
# o czym samo kopiowanie nie mówi systemowi.
#
# Zwykłe `cp -R` zostawia aplikację działającą, ale NIEWIDOCZNĄ dla
# Spotlighta: nowy bundle ma nowy numer i-węzła, a indeks dalej opisuje
# ten skasowany. Aplikacja jest wtedy w /Applications, uruchamia się
# z Findera, ma ważny podpis — i nie da się jej znaleźć ⌘spacją.
# Dokładnie to się stało 22 sierpnia 2026.
#
# Dlatego po skopiowaniu robimy jeszcze dwie rzeczy:
#   lsregister -f   — LaunchServices: Launchpad, „Otwórz w…", domyślne typy
#   mdimport        — Spotlight: wyszukiwanie i szybkie uruchamianie
#
#   bash scripts/install.sh

set -euo pipefail

SRC="${1:-$HOME/CribroSift-build/mac-arm64/Cribro Sift.app}"
DST="/Applications/Cribro Sift.app"
LSREG="/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister"

[ -d "$SRC" ] || { echo "Nie ma czego instalować: $SRC"; echo "Zbuduj najpierw:  npm run app"; exit 1; }

# Kopiowanie na działającą aplikację kończy się bundlem posklejanym
# z dwóch wersji — i podpisem, który już się nie zgadza.
if pgrep -f "$DST/Contents/MacOS/" >/dev/null 2>&1; then
  echo "Zamykam działającą aplikację…"
  pkill -f "$DST/Contents/MacOS/" || true
  sleep 2
fi

echo "Instaluję: $DST"
rm -rf "$DST"
# ditto, nie cp: zachowuje atrybuty rozszerzone i prawa, na których stoi podpis.
ditto "$SRC" "$DST"

echo "── podpis ──"
codesign --verify --verbose=2 "$DST" 2>&1 | tail -2

echo "── rejestracja w systemie ──"
"$LSREG" -f "$DST"
mdimport "$DST"

# Sprawdzenie, a nie założenie: indeks albo jest, albo go nie ma.
# Czekamy, bo mdimport wraca, zanim indeks naprawdę usiądzie — jedno
# sprawdzenie od razu po nim wypisywało porażkę przy działającym indeksie.
echo -n "── Spotlight "
for _ in $(seq 1 10); do
  KIND=$(mdls -name kMDItemContentType -raw "$DST" 2>/dev/null || echo "(null)")
  [ "$KIND" = "com.apple.application-bundle" ] && break
  echo -n "."
  sleep 1
done

if [ "$KIND" = "com.apple.application-bundle" ]; then
  echo " widzi aplikację ✓"
else
  echo " NIE widzi jej (kMDItemContentType = $KIND)."
  echo "   Aplikacja działa, ale nie znajdziesz jej ⌘spacją. Spróbuj:"
  echo "   mdimport \"$DST\""
fi

echo
echo "Gotowe. Uruchom:  open -a \"Cribro Sift\""

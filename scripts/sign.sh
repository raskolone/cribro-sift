#!/bin/bash
# Podpis buildów lokalnych stałą tożsamością.
#
# Bez podpisu macOS nie potrafi zapamiętać zgód (mikrofon, Dostępność).
# Ale sam podpis to za mało — liczy się, CZYM aplikacja jest podpisana:
#
#   ad-hoc      →  designated requirement = cdhash H"…"
#   certyfikat  →  designated requirement = identifier "com.cribro.sift"
#                                           and certificate root = H"…"
#
# Cdhash to skrót zawartości bundla. Zmiana jednej linijki kodu zmienia
# app.asar, app.asar zmienia cdhash — i zgoda „Dostępność” zapisana przy
# poprzednim cdhashu przestaje pasować. Wpis w Ustawieniach zostaje,
# przełącznik wygląda na włączony, a AXIsProcessTrusted() zwraca false.
# Odcisk certyfikatu przetrwa dowolną liczbę przebudowań.
#
# Tożsamość zakłada `npm run identity` — raz. Do rozdania innym ludziom
# nadal potrzebny Developer ID i notaryzacja.
set -euo pipefail

APP="${1:-$HOME/CribroSift-build/mac-arm64/Cribro Sift.app}"
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
ENTS="$ROOT/build/entitlements.mac.plist"
NAME="${IDENTITY_NAME:-Cribro Sift Dev}"
KEYCHAIN="$HOME/Library/Keychains/cribro-sign.keychain-db"
KEYCHAIN_PASS="cribro"

[ -d "$APP" ] || { echo "Nie znaleziono: $APP — najpierw npm run pack"; exit 1; }

# Po nazwie szukać nie można: gdyby ten sam CN trafił kiedyś do dwóch pęków,
# codesign odmówiłby wyboru. Odcisk SHA-1 jest jednoznaczny.
IDENTITY=""
if [ -f "$KEYCHAIN" ]; then
  security unlock-keychain -p "$KEYCHAIN_PASS" "$KEYCHAIN" 2>/dev/null || true
  IDENTITY="$(security find-identity -v -p codesigning "$KEYCHAIN" 2>/dev/null \
    | grep "$NAME" | head -1 | awk '{print $2}')"
fi

if [ -n "$IDENTITY" ]; then
  KC=(--keychain "$KEYCHAIN")
  echo "Tożsamość: $NAME ($IDENTITY)"
else
  IDENTITY="-"
  KC=()
  echo "UWAGA: brak tożsamości „${NAME}” — podpisuję ad-hoc."
  echo "       Zgoda „Dostępność” przepadnie przy najbliższej przebudowie."
  echo "       Napraw to raz: npm run identity"
fi

sign() { codesign --force --sign "$IDENTITY" "${KC[@]+"${KC[@]}"}" --timestamp=none "$@"; }

echo "Podpisuję: $APP"

# Rozszerzone atrybuty (iCloud, pobieranie z sieci) blokują codesign.
xattr -cr "$APP"

# Kolejność ma znaczenie: najpierw to, co w środku, potem sama aplikacja.
find "$APP/Contents/Frameworks" -name "*.dylib" -o -name "*.node" 2>/dev/null | while read -r lib; do
  sign "$lib" 2>/dev/null || true
done

# Moduł natywny skrótu (uiohook) leży poza asarem i musi być podpisany tą samą
# tożsamością — inaczej hardened runtime odmówi go załadować.
find "$APP/Contents/Resources/app.asar.unpacked" -name "*.node" 2>/dev/null | while read -r node; do
  sign "$node" 2>/dev/null || true
done

# Program pomocniczy od dźwięku spotkań. Podpis tą samą tożsamością nie jest
# formalnością: zgoda „Nagrywanie ekranu” pamięta, CZYM program jest
# podpisany, tak samo jak zgoda „Dostępność” (patrz komentarz na górze).
# Podpisany inaczej niż bundle byłby dla systemu osobnym programem — z osobną
# zgodą do klikania i osobnym wpisem w Ustawieniach.
if [ -f "$APP/Contents/Resources/cribro-tap" ]; then
  sign --options runtime --entitlements "$ROOT/build/entitlements.tap.plist" \
    "$APP/Contents/Resources/cribro-tap"
fi

for helper in "$APP/Contents/Frameworks/"*.app; do
  [ -d "$helper" ] && sign --options runtime --entitlements "$ENTS" "$helper"
done

for fw in "$APP/Contents/Frameworks/"*.framework; do
  [ -d "$fw" ] && sign "$fw"
done

# Atrybuty potrafią wrócić w trakcie podpisywania wnętrza — czyścimy raz jeszcze.
xattr -cr "$APP"

sign --options runtime --entitlements "$ENTS" --identifier com.cribro.sift "$APP"

echo "── weryfikacja ──"
codesign --verify --strict --verbose=2 "$APP" 2>&1 | tail -2
codesign -dv "$APP" 2>&1 | grep -E "Identifier|Format"

# To jest ta linijka, którą trzeba obejrzeć po zmianie sposobu podpisywania.
# „cdhash H…” znaczy, że zgoda padnie przy następnej przebudowie.
echo "── wymaganie, po którym macOS rozpoznaje aplikację ──"
codesign -d -r- "$APP" 2>&1 | grep "designated"

#!/bin/bash
# Budowa cribro-tap — programu, który bierze dźwięk spotkania w dwóch torach.
#
# Electron nie umie na macOS wziąć dźwięku systemu (jego typy mówią wprost:
# „loopback … currently only supported on Windows”), więc ta jedna rzecz musi
# być natywna. Reszta modułu spotkań zostaje w JavaScripcie.
#
# Program powstaje UNIWERSALNY — arm64 i x86_64 sklejone w jeden plik. Nie
# dlatego, że ktoś dziś uruchamia Cribro na Intelu, tylko dlatego, że
# electron-builder pakuje dwa DMG-i i cichy brak architektury objawiłby się
# dopiero u kogoś innego, jako „nagrywanie nie działa” bez żadnego błędu.
#
# Minimum to macOS 14.4: tam Core Audio Process Taps (CATapDescription) stają
# się w praktyce używalne — patrz nagłówek native/tap/main.swift po to,
# dlaczego dźwięk systemu idzie tą drogą, a nie przez ScreenCaptureKit.
# Mikrofon nie ma tu żadnego dodatkowego progu: to zwykłe urządzenie
# wejściowe Core Audio, dostępne odkąd Core Audio w ogóle istnieje.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
SRC="$ROOT/native/tap/main.swift"
OUT_DIR="$ROOT/native/build"
OUT="$OUT_DIR/cribro-tap"
DEPLOY="14.4"

NAME="${IDENTITY_NAME:-Cribro Sift Dev}"
KEYCHAIN="$HOME/Library/Keychains/cribro-sign.keychain-db"
KEYCHAIN_PASS="cribro"

[ -f "$SRC" ] || { echo "Nie znaleziono źródła: $SRC"; exit 1; }
mkdir -p "$OUT_DIR"

# Info.plist WKLEJANY W BINARKĘ.
#
# cribro-tap jest gołym plikiem wykonywalnym, nie pakietem — nie ma katalogu
# Contents, w którym mógłby leżeć Info.plist. A jest podpisany własną
# tożsamością, więc dla TCC jest OSOBNYM klientem: Info.plist aplikacji obok
# go nie dotyczy.
#
# Bez NSCalendarsFullAccessUsageDescription EventKit odmawia NATYCHMIAST
# I BEZ PYTANIA — nie pada żadne okno, a program dostaje „denied”, jakby
# ktoś zgody odmówił. Dokładnie o to rozbijał się kalendarz. Szczegóły:
# build/tap-info.plist.
PLIST="$ROOT/build/tap-info.plist"
[ -f "$PLIST" ] || { echo "Nie znaleziono $PLIST — bez niego kalendarz nie zapyta o zgodę"; exit 1; }

build() {
  local arch="$1" out="$2"
  swiftc -O \
    -target "${arch}-apple-macos${DEPLOY}" \
    -framework AppKit -framework AudioToolbox -framework AVFoundation -framework CoreAudio -framework EventKit \
    -Xlinker -sectcreate -Xlinker __TEXT -Xlinker __info_plist -Xlinker "$PLIST" \
    -o "$out" "$SRC"
}

echo "Buduję cribro-tap (macOS ${DEPLOY}+)…"

build arm64 "$OUT_DIR/cribro-tap-arm64"

# Intel bywa nie do zbudowania na maszynie bez pełnego Xcode. To nie jest
# powód, żeby przerwać budowę — powód, żeby powiedzieć o tym głośno.
if build x86_64 "$OUT_DIR/cribro-tap-x86_64" 2>/dev/null; then
  lipo -create "$OUT_DIR/cribro-tap-arm64" "$OUT_DIR/cribro-tap-x86_64" -output "$OUT"
  rm -f "$OUT_DIR/cribro-tap-arm64" "$OUT_DIR/cribro-tap-x86_64"
  echo "Architektury: $(lipo -archs "$OUT")"
else
  mv "$OUT_DIR/cribro-tap-arm64" "$OUT"
  echo "UWAGA: x86_64 się nie zbudował — plik jest tylko arm64."
  echo "       Build na Intela wyjdzie bez nagrywania spotkań."
fi

# Podpis tą samą tożsamością co aplikacja. Zgoda „Nagrywanie dźwięku innych
# aplikacji” pamięta, CZYM program jest podpisany — dokładnie tak samo jak
# zgoda „Dostępność” (patrz scripts/sign.sh i rozdział o cdhashu w README).
# Program pomocniczy podpisany inaczej niż bundle to druga tożsamość i druga
# zgoda do klikania.
IDENTITY=""
if [ -f "$KEYCHAIN" ]; then
  security unlock-keychain -p "$KEYCHAIN_PASS" "$KEYCHAIN" 2>/dev/null || true
  IDENTITY="$(security find-identity -v -p codesigning "$KEYCHAIN" 2>/dev/null \
    | grep "$NAME" | head -1 | awk '{print $2}')"
fi

if [ -n "$IDENTITY" ]; then
  codesign --force --sign "$IDENTITY" --keychain "$KEYCHAIN" --timestamp=none \
    --options runtime --entitlements "$ROOT/build/entitlements.tap.plist" "$OUT"
  echo "Podpisany: $NAME"
else
  codesign --force --sign - --timestamp=none "$OUT"
  echo "UWAGA: brak tożsamości „${NAME}” — podpis ad-hoc."
  echo "       Zgoda „Nagrywanie dźwięku innych aplikacji” przepadnie przy przebudowie. Napraw: npm run identity"
fi

# Sprawdzenie, że opis naprawdę wszedł do binarki. Brak tej sekcji nie
# objawia się błędem budowania — objawia się kalendarzem, który milczy.
# `grep -q` zamyka potok po pierwszym trafieniu, otool dostaje SIGPIPE,
# a `set -o pipefail` czyta to jako porażkę całego potoku — czyli sprawdzenie
# meldowałoby brak sekcji dokładnie wtedy, gdy sekcja JEST. Stąd liczenie
# trafień zamiast pytania „czy jest”.
SECTIONS="$(otool -l "$OUT" 2>/dev/null | grep -c "__info_plist" || true)"
if [ "$SECTIONS" -gt 0 ]; then
  echo "Opisy zgód: wklejone w binarkę ✓"
else
  echo "UWAGA: w binarce nie ma sekcji __info_plist — kalendarz nie zapyta o zgodę."
fi

echo "Gotowe: $OUT"

#!/bin/bash
# Stała tożsamość podpisu dla buildów lokalnych. Uruchamiasz RAZ.
#
# DLACZEGO TO ISTNIEJE
# --------------------
# Podpis ad-hoc (`codesign -s -`) daje aplikacji „designated requirement”
# złożony wyłącznie z cdhashu, czyli skrótu zawartości bundla:
#
#     designated => cdhash H"6d31d852…"
#
# macOS zapamiętuje zgodę „Dostępność” razem z tym wymaganiem. Każda zmiana
# w kodzie zmienia app.asar, app.asar zmienia cdhash, a nowy cdhash to dla
# systemu **inny program**. Wpis w Ustawieniach zostaje, przełącznik dalej
# wygląda na włączony, ale AXIsProcessTrusted() zwraca false i skrót jest
# głuchy. Przełączanie tam i z powrotem nic nie da — system porównuje podpis.
#
# Certyfikat self-signed zmienia wymaganie na:
#
#     designated => identifier "com.cribro.sift" and certificate leaf = H"…"
#
# Odcisk certyfikatu nie zmienia się przy przebudowie, więc zgoda zostaje.
#
# DLACZEGO OSOBNY PĘK KLUCZY
# --------------------------
# Klucz zaimportowany do pęku logowania ma pustą „listę partycji” i codesign
# odbija się od niego z errSecInternalComponent, dopóki nie poda się hasła do
# logowania. Własny pęk z własnym hasłem rozwiązuje to bez pytania kogokolwiek
# o cokolwiek — i trzyma klucz deweloperski z dala od pęku logowania.
set -euo pipefail

NAME="${IDENTITY_NAME:-Cribro Sift Dev}"
KEYCHAIN="$HOME/Library/Keychains/cribro-sign.keychain-db"
KEYCHAIN_PASS="cribro"

if security find-identity -v -p codesigning "$KEYCHAIN" 2>/dev/null | grep -q "$NAME"; then
  echo "Tożsamość „${NAME}” już jest — nie ruszam."
  security find-identity -v -p codesigning "$KEYCHAIN"
  exit 0
fi

WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

echo "Generuję certyfikat „${NAME}” (ważny 10 lat, tylko na tym Macu)…"

# extendedKeyUsage=codeSigning jest obowiązkowe — bez tego
# `security find-identity -p codesigning` w ogóle nie pokaże certyfikatu.
openssl req -x509 -newkey rsa:2048 -nodes -days 3650 \
  -keyout "$WORK/key.pem" -out "$WORK/cert.pem" \
  -subj "/CN=$NAME/O=Cribro/C=PL" \
  -addext "basicConstraints=critical,CA:false" \
  -addext "keyUsage=critical,digitalSignature" \
  -addext "extendedKeyUsage=critical,codeSigning" 2>/dev/null

# Bez -legacy: macOS ma LibreSSL, które tej opcji nie zna.
openssl pkcs12 -export -inkey "$WORK/key.pem" -in "$WORK/cert.pem" \
  -name "$NAME" -out "$WORK/identity.p12" -passout pass:"$KEYCHAIN_PASS" 2>/dev/null

if [ ! -f "$KEYCHAIN" ]; then
  security create-keychain -p "$KEYCHAIN_PASS" "$KEYCHAIN"
fi

# -lut bez -l: pęk nie zamyka się po bezczynności, tylko po wylogowaniu.
security set-keychain-settings -t 21600 "$KEYCHAIN"
security unlock-keychain -p "$KEYCHAIN_PASS" "$KEYCHAIN"

security import "$WORK/identity.p12" -k "$KEYCHAIN" -P "$KEYCHAIN_PASS" \
  -T /usr/bin/codesign -T /usr/bin/security -A

# To jest ta linijka, bez której codesign mówi errSecInternalComponent.
security set-key-partition-list -S apple-tool:,apple:,codesign: \
  -s -k "$KEYCHAIN_PASS" "$KEYCHAIN" >/dev/null 2>&1

# Certyfikat sam sobie jest korzeniem, więc trzeba mu zaufać do podpisywania kodu.
security add-trusted-cert -p codeSign -k "$KEYCHAIN" "$WORK/cert.pem"

# Pęk musi być na liście wyszukiwania, inaczej codesign nie zbuduje łańcucha
# do korzenia, choćby dostał ścieżkę przez --keychain.
EXISTING="$(security list-keychains -d user | sed 's/[\" ]//g')"
if ! printf '%s\n' "$EXISTING" | grep -q "cribro-sign"; then
  # shellcheck disable=SC2086
  security list-keychains -d user -s $EXISTING "$KEYCHAIN"
fi

echo "── gotowe ──"
security find-identity -v -p codesigning "$KEYCHAIN"
echo "Pęk: $KEYCHAIN"

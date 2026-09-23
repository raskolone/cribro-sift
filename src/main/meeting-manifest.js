"use strict";

const fs = require("fs");
const path = require("path");
const { wavHeader } = require("./tap");

/**
 * Zarządzanie atomowym manifestem sesji spotkania (MeetingSessionManifest)
 * oraz odzyskiwaniem niedomkniętych plików WAV.
 *
 * Audio jest jedynym źródłem prawdy.
 */

const MANIFEST_FILE = "manifest.json";

/**
 * Tworzy początkowy obiekt manifestu sesji.
 *
 * @param {object} params
 * @param {string} params.meetingId
 * @param {string} params.dir
 * @param {string} params.micAudioPath
 * @param {string} params.systemAudioPath
 * @returns {object} MeetingSessionManifest
 */
function createManifest({ meetingId, dir, micAudioPath, systemAudioPath, startedAt = null }) {
  const manifest = {
    meetingId,
    startedAt: startedAt || new Date().toISOString(),
    stoppedAt: null,
    micAudioPath,
    systemAudioPath,
    writtenMicSamples: 0,
    writtenSystemSamples: 0,
    recordingStatus: "recording", // idle | recording | recording_live_degraded | stopping | recording_interrupted
    liveStatus: "ok",            // ok | degraded | error
    finalizationStatus: "idle",  // idle | finalizing | complete | audio_saved_transcript_failed
    liveGaps: [],                // Array<{ start: number, end: number, reason: string }>
    batchJobId: null,
    lastError: null,             // { code: string, message: string, retryable: boolean }
    metrics: null,
  };

  saveManifestAtomically(dir, manifest);
  return manifest;
}

/**
 * Zapisuje manifest na dysku atomowo (najpierw plik tymczasowy, potem rename).
 *
 * @param {string} dir
 * @param {object} manifest
 */
function saveManifestAtomically(dir, manifest) {
  if (!dir) return;
  try {
    fs.mkdirSync(dir, { recursive: true });
    const target = path.join(dir, MANIFEST_FILE);
    const temp = path.join(dir, `${MANIFEST_FILE}.tmp.${Date.now()}`);
    fs.writeFileSync(temp, JSON.stringify(manifest, null, 2), "utf8");
    fs.renameSync(temp, target);
  } catch (err) {
    // Awaria zapisu manifestu nie może zatrzymać procesu nagrywania
    console.error(`[MANIFEST] Błąd atomowego zapisu manifestu w ${dir}:`, err?.message || err);
  }
}

/**
 * Wczytuje manifest z dysku.
 *
 * @param {string} dir
 * @returns {object|null}
 */
function loadManifest(dir) {
  if (!dir) return null;
  const target = path.join(dir, MANIFEST_FILE);
  try {
    if (!fs.existsSync(target)) return null;
    const raw = fs.readFileSync(target, "utf8");
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

/**
 * Naprawa nagłówka WAV na podstawie fizycznego rozmiaru pliku lub liczby zapisanych próbek.
 *
 * Jeśli aplikacja uległa awarii lub została ubita przed naciśnięciem Stop,
 * plik WAV zawiera zera w nagłówku w polu długości danych (44 bajty).
 *
 * @param {string} filePath
 * @param {number} [knownSamples]
 * @returns {boolean} true jeśli plik został naprawiony/zweryfikowany
 */
function repairWavHeaderIfNeeded(filePath, knownSamples = null) {
  if (!filePath || !fs.existsSync(filePath)) return false;
  try {
    const stats = fs.statSync(filePath);
    if (stats.size < 44) return false;

    const payloadFromDisk = stats.size - 44;
    // Jeśli plik ma próbki na dysku (np. po finish() i paddingu ciszą), używamy faktycznego rozmiaru z dysku
    const finalPayload = payloadFromDisk > 0 ? payloadFromDisk : (Number.isFinite(knownSamples) && knownSamples > 0 ? knownSamples * 2 : 0);

    const fd = fs.openSync(filePath, "r+");
    try {
      const header = wavHeader(finalPayload);
      fs.writeSync(fd, header, 0, 44, 0);
    } finally {
      fs.closeSync(fd);
    }
    return true;
  } catch (err) {
    console.error(`[MANIFEST] Błąd naprawy nagłówka WAV dla ${filePath}:`, err?.message || err);
    return false;
  }
}

module.exports = {
  MANIFEST_FILE,
  createManifest,
  saveManifestAtomically,
  loadManifest,
  repairWavHeaderIfNeeded,
};

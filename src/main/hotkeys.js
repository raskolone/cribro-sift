"use strict";

const { globalShortcut, systemPreferences } = require("electron");

/**
 * Silnik skrótu.
 *
 * Jeden komplet klawiszy (domyślnie ⌃+⌥) obsługuje dwa sposoby mówienia
 * i oba są włączone zawsze — nie ma czego przestawiać w ustawieniach,
 * bo gest sam mówi, o który sposób chodzi:
 *
 *   TRZYMANIE       przytrzymujesz klawisze i mówisz, puszczasz — koniec.
 *                   Dobre do jednego zdania rzuconego w biegu.
 *
 *   BEZ TRZYMANIA   stukasz dwa razy pod rząd i nagrywanie zostaje włączone.
 *   (hands-off)     Ręce wolne. Kolejne stuknięcie kończy i przesiewa.
 *                   Dobre do dłuższej wypowiedzi albo notatki ze spotkania.
 *                   Nie ma przełącznika, który by to włączał — gest jest
 *                   przełącznikiem. Kto trzyma, ten trzyma; kto stuknął
 *                   dwa razy, ten chciał wolnych rąk.
 *
 *   ESC             przerywa nagranie i je kasuje. Nic nie idzie do transkrypcji.
 *
 * O tym, czy stuknięcie było stuknięciem, decyduje czas: krócej niż
 * ARM_MS to stuknięcie, dłużej — trzymanie. Dzięki temu oba sposoby
 * mieszczą się na tych samych klawiszach i nigdy nie kolidują.
 *
 * Backendy:
 *   1. uiohook       widzi wciśnięcie ORAZ puszczenie, więc umie jedno i drugie.
 *                    Wymaga zgody „Dostępność".
 *   2. globalShortcut wbudowany w Electron, bez uprawnień, ale zna tylko
 *                    wciśnięcie — stąd zwykły przełącznik: raz start, raz stop.
 */

const KEY = {
  Alt: [56, 3640],
  Ctrl: [29, 3613],
  Shift: [42, 54],
  Meta: [3675, 3676],
  Space: [57],
};

const ESC = 1;
const ARM_MS = 220; // poniżej tego progu to stuknięcie, powyżej — trzymanie
const DOUBLE_TAP_MS = 450; // ile czasu ma drugie stuknięcie

class HotkeyEngine {
  constructor({ onStart, onStop, onCancel, isRecording }) {
    this.onStart = onStart;
    this.onStop = onStop;
    this.onCancel = onCancel;
    // Nagranie mogło ruszyć przyciskiem w oknie albo z widgetu — Escape
    // ma je przerywać tak samo, więc pytamy o stan aplikacji, nie tylko o swój.
    this.isRecording = isRecording ?? (() => false);

    this.backend = "none";
    this.uiohook = null;
    this.config = null;

    this.down = new Set();
    this.comboDown = false; // czy komplet klawiszy jest właśnie wciśnięty
    this.pressedAt = 0;
    this.lastTapAt = 0;
    this.armTimer = null;
    this.swallowRelease = false; // puszczenie po „zakończ" nie może nic wywołać
    this.escapeArmed = false; // czy Escape jest w tej chwili nasz

    /** "idle" | "hold" | "handsfree" */
    this.mode = "idle";
  }

  /**
   * Zawsze próbujemy uiohooka: to jedyny backend, który widzi puszczenie
   * klawisza, więc jedyny, który zna trzymanie i podwójne stuknięcie.
   * Przełącznik ⌃⌥Spacja jest tym, co zostaje bez zgody „Dostępność" —
   * wyborem w ustawieniach nigdy nie był, bo nikt nie wybiera gorszego.
   *
   * @returns {"uiohook"|"globalShortcut"|"none"}
   */
  start(config) {
    this.stop();
    this.config = config;

    if (this.#startUiohook(config)) {
      this.backend = "uiohook";
      return this.backend;
    }

    this.backend = this.#startGlobalShortcut(config) ? "globalShortcut" : "none";
    return this.backend;
  }

  /**
   * Escape na czas nagrywania.
   *
   * uiohook widzi każde wciśnięcie, więc tam Escape działa sam z siebie.
   * Bez zgody „Dostępność" zostaje globalShortcut, który widzi wyłącznie
   * to, co sam zarejestruje — a Escape zabrany systemowi na stałe zamykałby
   * cudze okna dialogowe zamiast naszego nagrania. Stąd rejestracja na
   * dokładnie ten czas, w którym nagranie trwa.
   */
  armCancelKey() {
    if (this.backend !== "globalShortcut" || this.escapeArmed) return;
    try {
      this.escapeArmed = globalShortcut.register("Escape", () => {
        if (!this.recording) return;
        this.#reset();
        this.onCancel();
      });
    } catch {
      this.escapeArmed = false;
    }
  }

  disarmCancelKey() {
    if (!this.escapeArmed) return;
    this.escapeArmed = false;
    try {
      globalShortcut.unregister("Escape");
    } catch {
      /* mogło już zniknąć razem z resztą */
    }
  }

  stop() {
    this.disarmCancelKey();
    if (this.uiohook) {
      try {
        this.uiohook.stop();
      } catch {
        /* hook mógł już nie żyć */
      }
      this.uiohook.removeAllListeners?.();
      this.uiohook = null;
    }
    globalShortcut.unregisterAll();
    this.#reset();
    this.backend = "none";
  }

  #reset() {
    this.disarmCancelKey();
    clearTimeout(this.armTimer);
    this.armTimer = null;
    this.down.clear();
    this.comboDown = false;
    this.lastTapAt = 0;
    this.swallowRelease = false;
    this.mode = "idle";
  }

  /** Czy nagrywanie trwa — niezależnie od tego, którym sposobem ruszyło. */
  get recording() {
    return this.mode === "hold" || this.mode === "handsfree" || this.isRecording();
  }

  /**
   * Nagranie ruszyło poza silnikiem (przycisk, widget, notatnik).
   * Przejmujemy je jak tryb bez trzymania, żeby ⌃⌥ je kończyło,
   * a Escape kasował.
   */
  adopt() {
    clearTimeout(this.armTimer);
    this.armTimer = null;
    this.mode = "handsfree";
    this.lastTapAt = 0;
  }

  #startUiohook(config) {
    // uiohook wystartuje nawet bez zgody „Dostępność" — tyle że nie dostanie
    // ani jednego zdarzenia. Cicho martwy skrót jest gorszy niż jawny fallback,
    // więc pytamy system, zanim mu zaufamy.
    if (process.platform === "darwin" && !systemPreferences.isTrustedAccessibilityClient(false)) {
      return false;
    }

    let uIOhook;
    try {
      ({ uIOhook } = require("uiohook-napi"));
    } catch {
      return false; // moduł natywny niedostępny
    }

    const keys = (config.hold ?? []).map((name) => KEY[name] ?? []);
    const comboComplete = () => keys.every((codes) => codes.some((code) => this.down.has(code)));

    uIOhook.on("keydown", (event) => {
      // Escape kasuje nagranie razem z dźwiękiem — nic nie idzie dalej.
      if (event.keycode === ESC && this.recording) {
        this.#reset();
        this.onCancel();
        return;
      }

      this.down.add(event.keycode);
      if (this.comboDown || !comboComplete()) return;

      this.comboDown = true;
      this.pressedAt = Date.now();

      // W trybie bez trzymania kolejne wciśnięcie znaczy „kończ".
      if (this.mode === "handsfree") {
        this.mode = "idle";
        this.swallowRelease = true;
        this.onStop({ trigger: "hands-off" });
        return;
      }

      // Trzymanie uzbraja się z opóźnieniem — inaczej każde stuknięcie
      // otwierałoby i zamykało mikrofon.
      this.armTimer = setTimeout(() => {
        this.armTimer = null;
        if (this.comboDown && this.mode === "idle") {
          this.mode = "hold";
          this.onStart({ trigger: "hold" });
        }
      }, ARM_MS);
    });

    uIOhook.on("keyup", (event) => {
      this.down.delete(event.keycode);
      if (!this.comboDown || comboComplete()) return;

      this.comboDown = false;
      const heldFor = Date.now() - this.pressedAt;
      clearTimeout(this.armTimer);
      this.armTimer = null;

      if (this.swallowRelease) {
        this.swallowRelease = false;
        return;
      }

      // Puszczenie po trzymaniu = koniec nagrania.
      if (this.mode === "hold") {
        this.mode = "idle";
        this.onStop({ trigger: "hold-release" });
        return;
      }

      if (heldFor >= ARM_MS) return;

      // Stuknięcie. Drugie w porę włącza tryb bez trzymania.
      const now = Date.now();
      if (now - this.lastTapAt < DOUBLE_TAP_MS) {
        this.lastTapAt = 0;
        this.mode = "handsfree";
        this.onStart({ trigger: "hands-off" });
      } else {
        this.lastTapAt = now;
      }
    });

    try {
      uIOhook.start();
      this.uiohook = uIOhook;
      return true;
    } catch {
      return false; // brak zgody Dostępność
    }
  }

  #startGlobalShortcut(config) {
    const accelerator = config.toggleAccelerator || "Control+Alt+Space";
    try {
      const bound = globalShortcut.register(accelerator, () => {
        if (this.recording) {
          this.mode = "idle";
          this.onStop({ trigger: "toggle" });
        } else {
          this.mode = "handsfree";
          this.onStart({ trigger: "toggle" });
        }
      });

      // Bez uiohooka nie widzimy Escape'u globalnie, więc rejestrujemy go
      // tylko na czas nagrywania — inaczej odbieralibyśmy Esc całemu systemowi.
      return bound;
    } catch {
      return false;
    }
  }

  /**
   * Nagranie skończyło się inaczej niż klawiszem. Zerujemy tylko własny
   * stan — zbiór wciśniętych klawiszy odzwierciedla fizyczną klawiaturę
   * i nie wolno go zmyślać.
   */
  release() {
    this.disarmCancelKey();
    clearTimeout(this.armTimer);
    this.armTimer = null;
    this.mode = "idle";
    this.lastTapAt = 0;
    this.swallowRelease = this.comboDown; // jeszcze trzyma — puszczenie ma być nieme
  }
}

module.exports = { HotkeyEngine, ARM_MS, DOUBLE_TAP_MS };

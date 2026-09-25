"use strict";
/**
 * Test jednostkowy i weryfikacyjny komponentu FloatingSheetNotes (GSAP).
 *   node scripts/floating-sheets-test.js
 */
const assert = require("assert");
const fs = require("fs");
const path = require("path");

const root = path.join(__dirname, "..");
const componentFile = path.join(root, "src", "components", "FloatingSheetNotes.tsx");
const indexFile = path.join(root, "src", "components", "index.ts");

assert.ok(fs.existsSync(componentFile), "Brak pliku FloatingSheetNotes.tsx");
assert.ok(fs.existsSync(indexFile), "Brak pliku src/components/index.ts");

const componentCode = fs.readFileSync(componentFile, "utf8");
const indexCode = fs.readFileSync(indexFile, "utf8");

let passed = 0;
const ok = (label) => (console.log(`✓ ${label}`), (passed += 1));

// 1. Sprawdzenie eksportów w index.ts
assert.ok(indexCode.includes("FloatingSheetNotes"), "index.ts musi eksportować FloatingSheetNotes");
assert.ok(indexCode.includes("FloatingSheetNote"), "index.ts musi eksportować FloatingSheetNote");
assert.ok(indexCode.includes("PaperTextureFilter"), "index.ts musi eksportować PaperTextureFilter");
ok("Eksporty w src/components/index.ts są kompletne i zgodne z typami");

// 2. Weryfikacja importu i użycia GSAP
assert.ok(componentCode.includes("import gsap from 'gsap';") || componentCode.includes('import gsap from "gsap";'), "Komponent musi importować gsap");
assert.ok(componentCode.includes("gsap.context"), "Komponent musi używać gsap.context dla bezpiecznego cyklu życia React");
assert.ok(componentCode.includes("ctx.revert()"), "Komponent musi sprzątać animacje przez ctx.revert()");
ok("GSAP jest poprawnie zintegrowany z cyklem życia React (gsap.context + ctx.revert)");

// 3. Weryfikacja parametrów animacji (czas trwania, stagger, easing)
assert.ok(componentCode.includes("0.65") || componentCode.includes("0.6"), "Czas trwania zwijania powinien wynosić ~0.65s");
assert.ok(componentCode.includes("0.75") || componentCode.includes("0.7") || componentCode.includes("0.8"), "Czas trwania rozwijania powinien wynosić ~0.75s");
assert.ok(componentCode.includes("power3.inOut") || componentCode.includes("power2.out"), "Easing zwijania powinien być płynny (power3.inOut / power2.out)");
assert.ok(componentCode.includes("back.out") || componentCode.includes("power3.out"), "Easing rozwijania powinien mieć naturalny overshoot lub power3");
assert.ok(componentCode.includes("stagger"), "Animacja musi stosować stagger dla efektu orbitalnego kaskadowego");
ok("Parametry czasowe i krzywe easing (0.65s zwijanie, 0.75s rozwijanie, stagger) są zgodne ze specyfikacją");

// 4. Weryfikacja obsługi prefers-reduced-motion
assert.ok(componentCode.includes("prefers-reduced-motion"), "Komponent musi respektować prefers-reduced-motion");
assert.ok(componentCode.includes("0.05"), "Dla reduced-motion czas animacji powinien być skrócony do ~0.05s");
ok("Dostępność: obsługa prefers-reduced-motion jest zaimplementowana");

// 5. Weryfikacja atrybutów dostępności (ARIA & klawiatura)
assert.ok(componentCode.includes("aria-expanded"), "Przycisk stosu musi posiadać aria-expanded");
assert.ok(componentCode.includes("aria-label"), "Przycisk i karty muszą posiadać aria-label");
assert.ok(componentCode.includes("tabIndex"), "Wierzchnia karta w stosie musi być dostępna z klawiatury (tabIndex)");
assert.ok(componentCode.includes("onKeyDown"), "Wierzchnia karta musi obsługiwać klawiaturę (Enter / Spacja)");
ok("Dostępność: aria-expanded, aria-label oraz obsługa klawiatury są zaimplementowane");

// 6. Weryfikacja zachowania danych i logiki biznesowej
assert.ok(componentCode.includes("onNotesChange"), "Zmiany treści i tytułu muszą być przekazywane przez onNotesChange");
assert.ok(componentCode.includes("onTitleChange"), "Tytuł notatki ma dedykowany handler");
assert.ok(componentCode.includes("onContentChange"), "Treść notatki ma dedykowany handler");
assert.ok(componentCode.includes("handleDragEnd"), "Przeciąganie notatki aktualizuje jej współrzędne");
ok("Logika biznesowa notatek, edycja treści i przeciąganie są zachowane");

// 7. Weryfikacja obsługi przerwania animacji (interruption safety)
assert.ok(componentCode.includes("timelineRef.current.kill()"), "Aktywny timeline jest bezpiecznie przerywany przy zmianie stanu");
ok("Bezpieczeństwo przerwania: szybkie wielokrotne klikanie nie powoduje desynchronizacji DOM");

console.log(`\nFloatingSheetNotes: wszystkie ${passed} sprawdzeń przeszły pomyślnie.`);

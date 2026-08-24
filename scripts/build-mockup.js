"use strict";

/**
 * Składa modułowe źródła w pojedyncze pliki HTML do podglądu w przeglądarce.
 *
 * Dzięki temu interfejs aplikacji istnieje tylko raz: w Electronie rozmawia
 * z procesem głównym, a w przeglądarce — z atrapą mostu. Ten sam plik,
 * ten sam CSS, żadnej osobnej „wersji makietowej", która zdąży się rozjechać.
 *
 *   node scripts/build-mockup.js   →   dist/app.html, dist/landing.html
 */

const fs = require("fs");
const path = require("path");

const root = path.join(__dirname, "..");
const dist = path.join(root, "dist");

const read = (...parts) => fs.readFileSync(path.join(root, ...parts), "utf8");

/** Wstawia treść plików w miejsce znaczników <link> i <script src>. */
function inline(html, baseDir) {
  return html
    .replace(/<link[^>]+href="((?!https?:)[^"]+\.css)"[^>]*>/g, (match, href) => {
      const css = fs.readFileSync(path.join(baseDir, href), "utf8");
      return `<style>\n${css}\n</style>`;
    })
    .replace(/<script src="((?!https?:)[^"]+)"><\/script>/g, (match, src) => {
      const js = fs.readFileSync(path.join(baseDir, src), "utf8");
      return `<script>\n${js}\n</script>`;
    });
}

/**
 * Artefakty na claude.ai dostają własny szkielet dokumentu, więc oddajemy
 * samą zawartość: tytuł, fonty, style i treść bez <html>/<head>/<body>.
 */
function stripDocument(html) {
  const head = html.match(/<head[^>]*>([\s\S]*?)<\/head>/i)?.[1] ?? "";
  const body = html.match(/<body[^>]*>([\s\S]*?)<\/body>/i)?.[1] ?? html;
  const keep = head
    .replace(/<meta[^>]*charset[^>]*>/gi, "")
    .replace(/<meta[^>]*viewport[^>]*>/gi, "")
    .trim();
  return `${keep}\n${body.trim()}\n`;
}

fs.mkdirSync(dist, { recursive: true });

const app = inline(read("src", "renderer", "index.html"), path.join(root, "src", "renderer"));
fs.writeFileSync(
  path.join(dist, "app.html"),
  // Okno Electrona nazywa się „Cribro Sift"; samodzielny podgląd niech
  // nosi nazwę ekranu, który pokazuje — inaczej obie strony mają ten sam tytuł.
  stripDocument(app).replace("<title>Cribro Sift</title>", "<title>Panel Cribro</title>"),
  "utf8",
);

const landing = inline(read("landing", "index.html"), path.join(root, "landing"));
fs.writeFileSync(path.join(dist, "landing.html"), stripDocument(landing), "utf8");

for (const file of ["app.html", "landing.html"]) {
  const size = fs.statSync(path.join(dist, file)).size;
  console.log(`dist/${file}  ${(size / 1024).toFixed(0)} kB`);
}

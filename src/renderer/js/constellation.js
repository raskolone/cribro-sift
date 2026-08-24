/* Nocturne Green — constellation background.

   ODSTĘPSTWO OD PAKIETU — WYGLĄD: lineAlpha i dotAlpha podniesione o 15%
   względem design/themes/constellation.js. Okno aplikacji jest mniejsze niż
   strona, dla której motyw powstał, więc przy oryginalnych wartościach tło
   ledwie się zaznaczało.

   ODSTĘPSTWO OD PAKIETU — RACHUNEK: pakietowa wersja rysuje 60 klatek na
   sekundę, liczy odległość każdego punktu do każdego innego i woła `stroke()`
   osobno dla każdej linii. Na stronie to nie przeszkadza, w tej aplikacji
   przeszkadzało bardzo, i to z powodu, który widać dopiero tutaj:

       NAD TŁEM LEŻY SZKŁO. Panele, pasek boczny i menu mają
       `backdrop-filter: blur(46px)`. Rozmycie tła przelicza się przy KAŻDEJ
       zmianie tego, co pod nim — a pod nim jest właśnie ta animacja. Jedna
       klatka tła to więc nie „narysuj sto kresek", tylko „narysuj sto kresek
       i rozmyj pół ekranu jeszcze raz". Stąd zacięcia przy pisaniu w notatce
       i przy rozkładaniu listy: dwie kosztowne rzeczy trafiały w tę samą
       klatkę.

   Zmienione jest więc pięć rzeczy, wszystkie o tempo, żadna o wygląd:

     1. 30 klatek na sekundę zamiast 60. Punkty dryfują 0,16 piksela na
        klatkę — przy takim ruchu różnicy nie widać, a rachunku jest połowa.
     2. Sąsiedztwa szukamy w siatce komórek wielkości promienia łączenia,
        a nie „każdy z każdym". Przy 120 punktach to ~8 porównań na punkt
        zamiast 119.
     3. Odległości porównujemy w kwadratach — pierwiastek liczy się dopiero
        dla linii, które naprawdę powstaną.
     4. Linie idą do pięciu ścieżek pogrupowanych kryciem zamiast do stu
        osobnych `stroke()`. Kropki — do jednej.
     5. Animacja staje, gdy okno jest schowane, gdy straciło aktywność
        i na czas cięższych przejść w interfejsie (patrz `pause`/`resume`).

   Usage:  <canvas id="constellation"></canvas>  +  <script src="constellation.js"></script>
   Canvas must be: position:fixed; inset:0; width:100%; height:100%; z-index:0; pointer-events:none;
   App content sits in a wrapper at position:relative; z-index:1.               */

(function () {
  var cv = document.getElementById('constellation');
  if (!cv) return;

  Object.assign(cv.style, {
    position: 'fixed', inset: '0', width: '100%', height: '100%',
    zIndex: '0', pointerEvents: 'none'
  });

  var ctx = cv.getContext('2d', { alpha: true, desynchronized: true });
  /* Retina liczy się cztery razy dłużej, a rysujemy rozmyte kropki i kreski
     o kryciu poniżej 0,2. Półtora piksela na piksel wystarcza, żeby nie było
     widać schodków, i zdejmuje połowę powierzchni do wypełnienia. */
  var dpr = Math.min(window.devicePixelRatio || 1, 1.5);
  var w = 0, h = 0, pts = [], raf = null;

  var CFG = {
    color: '114,240,180',  // --accent, as an rgb triplet
    link: 148,             // px at which a line appears
    lineAlpha: 0.196,      // 0.17 z pakietu +15%
    dotAlpha: 0.483,       // 0.42 z pakietu +15%
    density: 15500,        // one point per N px² — higher is sparser
    min: 38, max: 120,
    speed: 0.16,           // px per frame
    fps: 30,               // klatek na sekundę
    bands: 5               // ile stopni krycia dla linii
  };

  var FRAME = 1000 / CFG.fps;
  var LINK2 = CFG.link * CFG.link;

  /* Siatka do szukania sąsiadów. Komórka jest wielkości promienia łączenia,
     więc partnerzy punktu leżą w jego komórce i w ośmiu wokół — i tylko tam.
     Tablice trzymamy między klatkami i czyścimy w miejscu, żeby nie
     produkować śmieci trzydzieści razy na sekundę. */
  var cols = 0, rows = 0, cells = [];

  function seed() {
    w = cv.clientWidth; h = cv.clientHeight;
    cv.width = Math.round(w * dpr); cv.height = Math.round(h * dpr);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

    var n = Math.round(Math.min(CFG.max, Math.max(CFG.min, (w * h) / CFG.density)));
    pts = [];
    for (var i = 0; i < n; i++) pts.push({
      x: Math.random() * w, y: Math.random() * h,
      vx: (Math.random() - 0.5) * CFG.speed,
      vy: (Math.random() - 0.5) * CFG.speed,
      r: 0.8 + Math.random() * 1.5
    });

    cols = Math.max(1, Math.ceil(w / CFG.link));
    rows = Math.max(1, Math.ceil(h / CFG.link));
    cells = new Array(cols * rows);
    for (var c = 0; c < cells.length; c++) cells[c] = [];
  }

  /* Pięć ścieżek, po jednej na stopień krycia. Linia bliska pełnego promienia
     jest ledwie widoczna, więc różnicy między „0,031" a „0,034" nie widać —
     a różnicę między stoma wywołaniami `stroke()` a pięcioma widać w klatce. */
  var bands = [];
  for (var b = 0; b < CFG.bands; b++) bands.push(new Path2D());

  function draw() {
    ctx.clearRect(0, 0, w, h);

    for (var c = 0; c < cells.length; c++) cells[c].length = 0;

    for (var i = 0; i < pts.length; i++) {
      var p = pts[i];
      p.x += p.vx; p.y += p.vy;
      if (p.x < -20) p.x = w + 20; else if (p.x > w + 20) p.x = -20;
      if (p.y < -20) p.y = h + 20; else if (p.y > h + 20) p.y = -20;

      var cxi = p.x < 0 ? 0 : p.x >= w ? cols - 1 : (p.x / CFG.link) | 0;
      var cyi = p.y < 0 ? 0 : p.y >= h ? rows - 1 : (p.y / CFG.link) | 0;
      if (cxi >= cols) cxi = cols - 1;
      if (cyi >= rows) cyi = rows - 1;
      cells[cyi * cols + cxi].push(p);
    }

    for (var k = 0; k < bands.length; k++) bands[k] = new Path2D();

    /* Idziemy komórkami, a w każdej patrzymy na nią samą i na cztery
       sąsiednie „w przód". Cztery, nie osiem: każdą parę mamy wtedy
       policzoną dokładnie raz, tak samo jak w pętli „b = a + 1". */
    for (var cy = 0; cy < rows; cy++) {
      for (var cx = 0; cx < cols; cx++) {
        var here = cells[cy * cols + cx];
        if (!here.length) continue;

        for (var a = 0; a < here.length; a++) {
          var pa = here[a];

          for (var t = a + 1; t < here.length; t++) link(pa, here[t]);

          for (var d = 0; d < 4; d++) {
            var nx = cx + [1, -1, 0, 1][d];
            var ny = cy + [0, 1, 1, 1][d];
            if (nx < 0 || nx >= cols || ny >= rows) continue;
            var near = cells[ny * cols + nx];
            for (var u = 0; u < near.length; u++) link(pa, near[u]);
          }
        }
      }
    }

    ctx.lineWidth = 1;
    for (var s = 0; s < bands.length; s++) {
      // Środek przedziału: linia o kryciu z jego brzegu i tak jest o włos
      // od sąsiedniej, a wybór środka nie faworyzuje żadnego z brzegów.
      var alpha = CFG.lineAlpha * ((s + 0.5) / bands.length);
      ctx.strokeStyle = 'rgba(' + CFG.color + ',' + alpha.toFixed(3) + ')';
      ctx.stroke(bands[s]);
    }

    var dots = new Path2D();
    for (var j = 0; j < pts.length; j++) {
      dots.moveTo(pts[j].x + pts[j].r, pts[j].y);
      dots.arc(pts[j].x, pts[j].y, pts[j].r, 0, Math.PI * 2);
    }
    ctx.fillStyle = 'rgba(' + CFG.color + ',' + CFG.dotAlpha + ')';
    ctx.fill(dots);
  }

  function link(pa, pb) {
    var dx = pa.x - pb.x, dy = pa.y - pb.y;
    var d2 = dx * dx + dy * dy;
    if (d2 > LINK2) return;
    // Pierwiastek dopiero tutaj — dla par, które naprawdę dają linię.
    var near = 1 - Math.sqrt(d2) / CFG.link;
    var band = (near * CFG.bands) | 0;
    if (band >= CFG.bands) band = CFG.bands - 1;
    bands[band].moveTo(pa.x, pa.y);
    bands[band].lineTo(pb.x, pb.y);
  }

  /* ── Kiedy w ogóle rysować ────────────────────────────────────
     Trzy powody, żeby stanąć, i wszystkie sprowadzają się do jednego: nikt
     na to tło w tej chwili nie patrzy albo patrzy na coś ważniejszego. */
  var last = 0;
  var stopped = 0;        // ile rzeczy naraz prosi o postój
  var focused = true;     // czy okno w ogóle jest tym, na które ktoś patrzy

  function tick(now) {
    raf = requestAnimationFrame(tick);
    if (now - last < FRAME) return;
    last = now;
    draw();
  }

  function start() {
    if (raf || stopped || !focused || document.hidden) return;
    last = 0;
    raf = requestAnimationFrame(tick);
  }

  function stop() {
    if (!raf) return;
    cancelAnimationFrame(raf);
    raf = null;
  }

  /**
   * Postój na czas cięższego przejścia w interfejsie.
   *
   * Wołane parami (`pause()` … `resume()`) i policzone, bo przejścia
   * potrafią się nałożyć — zwijanie listy w trakcie otwierania menu nie ma
   * prawa wznowić tła w połowie tego pierwszego.
   */
  function pause() {
    stopped += 1;
    stop();
  }

  function resume() {
    stopped = Math.max(0, stopped - 1);
    if (!stopped) start();
  }

  window.CribroConstellation = { pause: pause, resume: resume };

  if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
    seed(); draw();  // one static frame
    return;
  }

  seed();

  var resizeTimer = null;
  window.addEventListener('resize', function () {
    // Ciągnięcie za róg okna sypie zdarzeniami co klatkę, a `seed` sieje
    // punkty od nowa. Bez tej zwłoki tło mrugało przez cały gest.
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(function () { seed(); if (!raf) draw(); }, 120);
  });

  document.addEventListener('visibilitychange', function () {
    if (document.hidden) stop(); else start();
  });

  /* Okno bez aktywności widać dalej, ale nikt w nim nic nie robi — a Electron
     trzyma ich kilka naraz (Notatnik obok okna głównego). Tło w każdym z nich
     kosztowałoby tyle samo, co w tym jednym, na które ktoś patrzy. */
  window.addEventListener('blur', function () { focused = false; stop(); });
  window.addEventListener('focus', function () { focused = true; start(); });
  focused = document.hasFocus();

  start();
  draw(); // pierwsza klatka od razu, bez czekania na rytm
})();

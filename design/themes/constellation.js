/* Nocturne Green — constellation background.
   Drifting points joined by proximity lines. No cursor interaction by design.
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

  var ctx = cv.getContext('2d');
  var dpr = Math.min(window.devicePixelRatio || 1, 2);
  var w = 0, h = 0, pts = [], raf = null;

  var CFG = {
    color: '114,240,180',  // --accent, as an rgb triplet
    link: 148,             // px at which a line appears
    lineAlpha: 0.17,       // alpha at zero distance
    dotAlpha: 0.42,
    density: 15500,        // one point per N px² — higher is sparser
    min: 38, max: 120,
    speed: 0.16            // px per frame
  };

  function seed() {
    w = cv.clientWidth; h = cv.clientHeight;
    cv.width = w * dpr; cv.height = h * dpr;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    var n = Math.round(Math.min(CFG.max, Math.max(CFG.min, (w * h) / CFG.density)));
    pts = [];
    for (var i = 0; i < n; i++) pts.push({
      x: Math.random() * w, y: Math.random() * h,
      vx: (Math.random() - 0.5) * CFG.speed,
      vy: (Math.random() - 0.5) * CFG.speed,
      r: 0.8 + Math.random() * 1.5
    });
  }

  function draw() {
    ctx.clearRect(0, 0, w, h);

    for (var i = 0; i < pts.length; i++) {
      var p = pts[i];
      p.x += p.vx; p.y += p.vy;
      if (p.x < -20) p.x = w + 20; else if (p.x > w + 20) p.x = -20;
      if (p.y < -20) p.y = h + 20; else if (p.y > h + 20) p.y = -20;
    }

    ctx.lineWidth = 1;
    for (var a = 0; a < pts.length; a++) {
      for (var b = a + 1; b < pts.length; b++) {
        var dx = pts[a].x - pts[b].x, dy = pts[a].y - pts[b].y;
        var d = Math.sqrt(dx * dx + dy * dy);
        if (d > CFG.link) continue;
        ctx.strokeStyle = 'rgba(' + CFG.color + ',' + (CFG.lineAlpha * (1 - d / CFG.link)).toFixed(3) + ')';
        ctx.beginPath();
        ctx.moveTo(pts[a].x, pts[a].y);
        ctx.lineTo(pts[b].x, pts[b].y);
        ctx.stroke();
      }
    }

    ctx.fillStyle = 'rgba(' + CFG.color + ',' + CFG.dotAlpha + ')';
    for (var k = 0; k < pts.length; k++) {
      ctx.beginPath();
      ctx.arc(pts[k].x, pts[k].y, pts[k].r, 0, Math.PI * 2);
      ctx.fill();
    }

    raf = requestAnimationFrame(draw);
  }

  if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
    seed(); draw(); cancelAnimationFrame(raf);  // one static frame
    return;
  }

  seed();
  window.addEventListener('resize', seed);
  document.addEventListener('visibilitychange', function () {
    if (document.hidden) { cancelAnimationFrame(raf); raf = null; }
    else if (!raf) draw();
  });
  draw();
})();

/**
 * Markup Canvas Engine for Cribro Sift ("Tekst z ekranu").
 *
 * Umożliwia zaawansowaną edycję graficzną zrzutu ekranu:
 * - Kadrowanie (Crop)
 * - Zakreślacz (Highlighter)
 * - Kształty: Prostokąt, Elipsa, Trójkąt, Linia, Strzałka
 * - Dymki dialogowe (Speech Bubbles z ruchomym ogonkiem i tekstem)
 * - Pola tekstowe z edycją rozmiaru i koloru
 * - Zaznaczanie, przesuwanie, skalowanie, uchwyty transformacji
 * - Historia operacji (Undo/Redo) i usuwanie klawiszem Delete
 * - Eksport do wysokiej rozdzielczości PNG
 */

class MarkupEngine {
  constructor({ canvas, overlay, onStateChange } = {}) {
    this.canvas = canvas;
    this.ctx = canvas.getContext("2d");
    this.overlay = overlay; // kontener na inline text editor lub pomocnicze warstwy
    this.onStateChange = onStateChange || (() => {});

    this.baseImage = null; // HTMLImageElement
    this.imgWidth = 0;
    this.imgHeight = 0;

    // Bieżące ustawienia narzędzi
    this.tool = "select"; // select, crop, highlighter, rectangle, ellipse, triangle, line, arrow, bubble, text
    this.color = "#ef4444"; // domyślnie wyrazisty czerwony
    this.lineWidth = 4; // 2, 4, 8
    this.fontSize = 24; // 16, 24, 36, 48

    // Obiekty naniesione na obraz
    this.objects = [];
    this.selectedId = null;

    // Kadrowanie (współrzędne w układzie pikseli bazowego obrazu)
    this.cropRect = null; // { x, y, width, height } lub null

    // Historia (Undo / Redo)
    this.history = [];
    this.historyIndex = -1;

    // Stan myszy / dotyku
    this.pointer = {
      isDown: false,
      mode: "none", // 'draw', 'move', 'resize', 'tail', 'endpoint', 'crop-resize', 'crop-move'
      handle: null,
      startX: 0,
      startY: 0,
      lastX: 0,
      lastY: 0,
      targetObj: null,
      initialSnapshot: null,
    };

    // Obsługa edycji tekstu
    this.activeTextEditor = null;

    this.#initEvents();
  }

  /** Wczytanie obrazu bazowego */
  async loadImage(src) {
    return new Promise((resolve, reject) => {
      const img = new Image();
      img.crossOrigin = "anonymous";
      img.onload = () => {
        this.baseImage = img;
        this.imgWidth = img.naturalWidth || img.width;
        this.imgHeight = img.naturalHeight || img.height;
        this.cropRect = { x: 0, y: 0, width: this.imgWidth, height: this.imgHeight };
        this.objects = [];
        this.selectedId = null;
        this.history = [];
        this.historyIndex = -1;
        this.pushHistory();
        this.resize();
        this.render();
        resolve(this);
      };
      img.onerror = (err) => reject(err);
      img.src = src;
    });
  }

  /** Dopasowanie rozmiaru canvasa do widoku */
  resize() {
    if (!this.baseImage) return;
    const parent = this.canvas.parentElement;
    if (!parent) return;

    const availableWidth = Math.max(200, parent.clientWidth - 32);
    const availableHeight = Math.max(150, parent.clientHeight - 32);

    const aspect = this.imgWidth / this.imgHeight;
    let w = availableWidth;
    let h = w / aspect;

    if (h > availableHeight) {
      h = availableHeight;
      w = h * aspect;
    }

    this.displayScale = w / this.imgWidth;
    this.canvas.width = this.imgWidth;
    this.canvas.height = this.imgHeight;
    this.canvas.style.width = `${Math.round(w)}px`;
    this.canvas.style.height = `${Math.round(h)}px`;

    this.render();
  }

  setTool(tool) {
    if (this.tool === tool) return;
    this.#commitTextEditor();
    this.tool = tool;
    if (tool !== "select") {
      this.selectedId = null;
    }
    this.render();
    this.onStateChange(this.getState());
  }

  setColor(color) {
    this.color = color;
    if (this.selectedId) {
      const obj = this.getObject(this.selectedId);
      if (obj) {
        obj.color = color;
        this.pushHistory();
        this.render();
      }
    }
    this.onStateChange(this.getState());
  }

  setLineWidth(width) {
    this.lineWidth = width;
    if (this.selectedId) {
      const obj = this.getObject(this.selectedId);
      if (obj && obj.lineWidth !== undefined) {
        obj.lineWidth = width;
        this.pushHistory();
        this.render();
      }
    }
    this.onStateChange(this.getState());
  }

  setFontSize(size) {
    this.fontSize = size;
    if (this.selectedId) {
      const obj = this.getObject(this.selectedId);
      if (obj && obj.fontSize !== undefined) {
        obj.fontSize = size;
        this.pushHistory();
        this.render();
      }
    }
    this.onStateChange(this.getState());
  }

  getState() {
    return {
      tool: this.tool,
      color: this.color,
      lineWidth: this.lineWidth,
      fontSize: this.fontSize,
      canUndo: this.historyIndex > 0,
      canRedo: this.historyIndex < this.history.length - 1,
      hasSelection: !!this.selectedId,
      selectedType: this.getObject(this.selectedId)?.type || null,
    };
  }

  getObject(id) {
    return this.objects.find((o) => o.id === id);
  }

  pushHistory() {
    // Usunięcie przyszłych stanów jeśli jesteśmy w środku historii
    if (this.historyIndex < this.history.length - 1) {
      this.history = this.history.slice(0, this.historyIndex + 1);
    }

    const snapshot = {
      objects: JSON.parse(JSON.stringify(this.objects)),
      cropRect: this.cropRect ? { ...this.cropRect } : null,
      selectedId: this.selectedId,
    };

    this.history.push(snapshot);
    if (this.history.length > 50) this.history.shift();
    this.historyIndex = this.history.length - 1;

    this.onStateChange(this.getState());
  }

  undo() {
    this.#commitTextEditor();
    if (this.historyIndex > 0) {
      this.historyIndex--;
      this.#applyHistorySnapshot(this.history[this.historyIndex]);
    }
  }

  redo() {
    this.#commitTextEditor();
    if (this.historyIndex < this.history.length - 1) {
      this.historyIndex++;
      this.#applyHistorySnapshot(this.history[this.historyIndex]);
    }
  }

  #applyHistorySnapshot(snapshot) {
    if (!snapshot) return;
    this.objects = JSON.parse(JSON.stringify(snapshot.objects || []));
    this.cropRect = snapshot.cropRect ? { ...snapshot.cropRect } : null;
    this.selectedId = snapshot.selectedId || null;
    this.render();
    this.onStateChange(this.getState());
  }

  deleteSelected() {
    this.#commitTextEditor();
    if (this.selectedId) {
      this.objects = this.objects.filter((o) => o.id !== this.selectedId);
      this.selectedId = null;
      this.pushHistory();
      this.render();
    }
  }

  resetCrop() {
    this.cropRect = { x: 0, y: 0, width: this.imgWidth, height: this.imgHeight };
    this.pushHistory();
    this.render();
  }

  /** Zwraca współrzędne w pikselach bazowego obrazu */
  #getCanvasCoords(e) {
    const rect = this.canvas.getBoundingClientRect();
    const clientX = e.clientX ?? (e.touches && e.touches[0]?.clientX) ?? 0;
    const clientY = e.clientY ?? (e.touches && e.touches[0]?.clientY) ?? 0;

    const scaleX = this.imgWidth / rect.width;
    const scaleY = this.imgHeight / rect.height;

    return {
      x: (clientX - rect.left) * scaleX,
      y: (clientY - rect.top) * scaleY,
    };
  }

  #initEvents() {
    const onPointerDown = (e) => this.#onMouseDown(e);
    const onPointerMove = (e) => this.#onMouseMove(e);
    const onPointerUp = (e) => this.#onMouseUp(e);
    const onDblClick = (e) => this.#onDoubleClick(e);

    this.canvas.addEventListener("mousedown", onPointerDown);
    window.addEventListener("mousemove", onPointerMove);
    window.addEventListener("mouseup", onPointerUp);
    this.canvas.addEventListener("dblclick", onDblClick);

    // Touch support
    this.canvas.addEventListener("touchstart", onPointerDown, { passive: false });
    window.addEventListener("touchmove", onPointerMove, { passive: false });
    window.addEventListener("touchend", onPointerUp);

    // Klawisze skrótów: Undo, Redo, Delete
    this.keyHandler = (e) => {
      // Jeśli jesteśmy w textarea lub input, nie przechwytujemy Delete / Undo
      if (["INPUT", "TEXTAREA"].includes(document.activeElement?.tagName)) return;

      if ((e.metaKey || e.ctrlKey) && !e.shiftKey && e.key.toLowerCase() === "z") {
        e.preventDefault();
        this.undo();
      } else if ((e.metaKey || e.ctrlKey) && e.shiftKey && e.key.toLowerCase() === "z") {
        e.preventDefault();
        this.redo();
      } else if (e.key === "Backspace" || e.key === "Delete") {
        if (this.selectedId) {
          e.preventDefault();
          this.deleteSelected();
        }
      }
    };
    window.addEventListener("keydown", this.keyHandler);
  }

  destroy() {
    window.removeEventListener("keydown", this.keyHandler);
  }

  #onMouseDown(e) {
    if (!this.baseImage) return;
    if (e.touches && e.touches.length > 1) return;

    this.#commitTextEditor();
    const pt = this.#getCanvasCoords(e);
    this.pointer.isDown = true;
    this.pointer.startX = pt.x;
    this.pointer.startY = pt.y;
    this.pointer.lastX = pt.x;
    this.pointer.lastY = pt.y;

    if (this.tool === "crop") {
      // Sprawdź czy kliknięto w uchwyt kadrowania lub wnętrze kadru
      const handle = this.#hitTestCropHandle(pt.x, pt.y);
      if (handle) {
        this.pointer.mode = "crop-resize";
        this.pointer.handle = handle;
        this.pointer.initialSnapshot = { ...this.cropRect };
        return;
      }
      if (this.#isPointInRect(pt.x, pt.y, this.cropRect)) {
        this.pointer.mode = "crop-move";
        this.pointer.initialSnapshot = { ...this.cropRect };
        return;
      }
      // Rozpocznij nowy kadr od zera
      this.cropRect = { x: pt.x, y: pt.y, width: 0, height: 0 };
      this.pointer.mode = "crop-resize";
      this.pointer.handle = "se";
      this.pointer.initialSnapshot = { ...this.cropRect };
      return;
    }

    if (this.tool === "select") {
      // 1. Sprawdź uchwyty zaznaczonego obiektu
      if (this.selectedId) {
        const obj = this.getObject(this.selectedId);
        if (obj) {
          const handle = this.#hitTestHandles(obj, pt.x, pt.y);
          if (handle) {
            this.pointer.mode = handle.type; // 'resize', 'tail', 'endpoint'
            this.pointer.handle = handle.id;
            this.pointer.targetObj = obj;
            this.pointer.initialSnapshot = JSON.parse(JSON.stringify(obj));
            return;
          }
        }
      }

      // 2. Sprawdź kliknięcie w jakikolwiek obiekt (od góry do dołu)
      const hit = this.#hitTestObject(pt.x, pt.y);
      if (hit) {
        this.selectedId = hit.id;
        this.pointer.mode = "move";
        this.pointer.targetObj = hit;
        this.pointer.initialSnapshot = JSON.parse(JSON.stringify(hit));
        this.render();
        this.onStateChange(this.getState());
        return;
      }

      // 3. Kliknięto w puste tło - odznacz
      this.selectedId = null;
      this.pointer.mode = "none";
      this.render();
      this.onStateChange(this.getState());
      return;
    }

    // Narzędzia rysowania obiektów
    const newId = `obj_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
    let newObj = null;

    if (this.tool === "highlighter") {
      newObj = {
        id: newId,
        type: "highlighter",
        points: [{ x: pt.x, y: pt.y }],
        color: this.color,
        lineWidth: Math.max(16, this.lineWidth * 5),
        opacity: 0.38,
      };
    } else if (this.tool === "rectangle") {
      newObj = {
        id: newId,
        type: "rectangle",
        x: pt.x,
        y: pt.y,
        width: 0,
        height: 0,
        color: this.color,
        lineWidth: this.lineWidth,
        fill: "transparent",
      };
    } else if (this.tool === "ellipse") {
      newObj = {
        id: newId,
        type: "ellipse",
        x: pt.x,
        y: pt.y,
        width: 0,
        height: 0,
        color: this.color,
        lineWidth: this.lineWidth,
        fill: "transparent",
      };
    } else if (this.tool === "triangle") {
      newObj = {
        id: newId,
        type: "triangle",
        x: pt.x,
        y: pt.y,
        width: 0,
        height: 0,
        color: this.color,
        lineWidth: this.lineWidth,
        fill: "transparent",
      };
    } else if (this.tool === "line") {
      newObj = {
        id: newId,
        type: "line",
        x1: pt.x,
        y1: pt.y,
        x2: pt.x,
        y2: pt.y,
        color: this.color,
        lineWidth: this.lineWidth,
      };
    } else if (this.tool === "arrow") {
      newObj = {
        id: newId,
        type: "arrow",
        x1: pt.x,
        y1: pt.y,
        x2: pt.x,
        y2: pt.y,
        color: this.color,
        lineWidth: this.lineWidth,
      };
    } else if (this.tool === "bubble") {
      newObj = {
        id: newId,
        type: "bubble",
        x: pt.x,
        y: pt.y,
        width: 140,
        height: 70,
        tailX: pt.x - 20,
        tailY: pt.y + 100,
        text: "Komentarz…",
        color: this.color,
        lineWidth: this.lineWidth,
        fontSize: this.fontSize,
      };
    } else if (this.tool === "text") {
      newObj = {
        id: newId,
        type: "text",
        x: pt.x,
        y: pt.y,
        width: 160,
        height: 40,
        text: "Tekst…",
        color: this.color,
        fontSize: this.fontSize,
      };
    }

    if (newObj) {
      this.objects.push(newObj);
      this.selectedId = newId;
      this.pointer.mode = "draw";
      this.pointer.targetObj = newObj;
      this.pointer.initialSnapshot = JSON.parse(JSON.stringify(newObj));
      this.render();
      this.onStateChange(this.getState());
    }
  }

  #onMouseMove(e) {
    if (!this.pointer.isDown || !this.baseImage) return;
    const pt = this.#getCanvasCoords(e);
    const dx = pt.x - this.pointer.startX;
    const dy = pt.y - this.pointer.startY;

    if (this.pointer.mode === "crop-move") {
      const snap = this.pointer.initialSnapshot;
      let newX = Math.max(0, Math.min(this.imgWidth - snap.width, snap.x + dx));
      let newY = Math.max(0, Math.min(this.imgHeight - snap.height, snap.y + dy));
      this.cropRect.x = newX;
      this.cropRect.y = newY;
      this.render();
      return;
    }

    if (this.pointer.mode === "crop-resize") {
      const snap = this.pointer.initialSnapshot;
      const h = this.pointer.handle;
      let { x, y, width, height } = snap;

      if (h.includes("e")) width = Math.max(20, Math.min(this.imgWidth - x, snap.width + dx));
      if (h.includes("s")) height = Math.max(20, Math.min(this.imgHeight - y, snap.height + dy));
      if (h.includes("w")) {
        const potentialW = snap.width - dx;
        if (potentialW >= 20 && snap.x + dx >= 0) {
          x = snap.x + dx;
          width = potentialW;
        }
      }
      if (h.includes("n")) {
        const potentialH = snap.height - dy;
        if (potentialH >= 20 && snap.y + dy >= 0) {
          y = snap.y + dy;
          height = potentialH;
        }
      }

      this.cropRect = { x, y, width, height };
      this.render();
      return;
    }

    const obj = this.pointer.targetObj;
    if (!obj) return;

    if (this.pointer.mode === "draw") {
      if (obj.type === "highlighter") {
        obj.points.push({ x: pt.x, y: pt.y });
      } else if (["rectangle", "ellipse", "triangle"].includes(obj.type)) {
        obj.x = Math.min(this.pointer.startX, pt.x);
        obj.y = Math.min(this.pointer.startY, pt.y);
        obj.width = Math.abs(pt.x - this.pointer.startX);
        obj.height = Math.abs(pt.y - this.pointer.startY);
      } else if (["line", "arrow"].includes(obj.type)) {
        obj.x2 = pt.x;
        obj.y2 = pt.y;
      } else if (obj.type === "bubble") {
        obj.width = Math.max(60, pt.x - obj.x);
        obj.height = Math.max(40, pt.y - obj.y);
        obj.tailX = obj.x + obj.width / 4;
        obj.tailY = obj.y + obj.height + 35;
      } else if (obj.type === "text") {
        obj.width = Math.max(50, pt.x - obj.x);
        obj.height = Math.max(30, pt.y - obj.y);
      }
      this.render();
      return;
    }

    if (this.pointer.mode === "move") {
      const snap = this.pointer.initialSnapshot;
      if (["rectangle", "ellipse", "triangle", "text"].includes(obj.type)) {
        obj.x = snap.x + dx;
        obj.y = snap.y + dy;
      } else if (obj.type === "bubble") {
        obj.x = snap.x + dx;
        obj.y = snap.y + dy;
        obj.tailX = snap.tailX + dx;
        obj.tailY = snap.tailY + dy;
      } else if (["line", "arrow"].includes(obj.type)) {
        obj.x1 = snap.x1 + dx;
        obj.y1 = snap.y1 + dy;
        obj.x2 = snap.x2 + dx;
        obj.y2 = snap.y2 + dy;
      } else if (obj.type === "highlighter") {
        obj.points = snap.points.map((p) => ({ x: p.x + dx, y: p.y + dy }));
      }
      this.render();
      return;
    }

    if (this.pointer.mode === "tail" && obj.type === "bubble") {
      obj.tailX = pt.x;
      obj.tailY = pt.y;
      this.render();
      return;
    }

    if (this.pointer.mode === "endpoint" && ["line", "arrow"].includes(obj.type)) {
      if (this.pointer.handle === "start") {
        obj.x1 = pt.x;
        obj.y1 = pt.y;
      } else {
        obj.x2 = pt.x;
        obj.y2 = pt.y;
      }
      this.render();
      return;
    }

    if (this.pointer.mode === "resize") {
      const snap = this.pointer.initialSnapshot;
      const h = this.pointer.handle;
      let { x, y, width, height } = snap;

      if (h.includes("e")) width = Math.max(20, snap.width + dx);
      if (h.includes("s")) height = Math.max(20, snap.height + dy);
      if (h.includes("w")) {
        const potW = snap.width - dx;
        if (potW >= 20) {
          x = snap.x + dx;
          width = potW;
        }
      }
      if (h.includes("n")) {
        const potH = snap.height - dy;
        if (potH >= 20) {
          y = snap.y + dy;
          height = potH;
        }
      }

      obj.x = x;
      obj.y = y;
      obj.width = width;
      obj.height = height;
      this.render();
      return;
    }
  }

  #onMouseUp(_e) {
    if (!this.pointer.isDown) return;
    const mode = this.pointer.mode;
    this.pointer.isDown = false;
    this.pointer.mode = "none";
    this.pointer.handle = null;
    this.pointer.targetObj = null;
    this.pointer.initialSnapshot = null;

    // Normalizacja wymiarów
    if (this.selectedId) {
      const obj = this.getObject(this.selectedId);
      if (obj && ["rectangle", "ellipse", "triangle"].includes(obj.type)) {
        if (obj.width < 5 && obj.height < 5) {
          obj.width = 80;
          obj.height = 60;
        }
      }
    }

    if (mode !== "none") {
      this.pushHistory();
    }

    if (this.tool !== "select" && this.tool !== "crop" && this.tool !== "highlighter") {
      // Automatyczny powrót do narzędzia wyboru po narysowaniu kształtu
      this.tool = "select";
      this.onStateChange(this.getState());
    }

    this.render();
  }

  #onDoubleClick(e) {
    const pt = this.#getCanvasCoords(e);
    const hit = this.#hitTestObject(pt.x, pt.y);
    if (hit && (hit.type === "text" || hit.type === "bubble")) {
      this.#openInlineTextEditor(hit);
    }
  }

  #openInlineTextEditor(obj) {
    this.#commitTextEditor();
    const rect = this.canvas.getBoundingClientRect();
    const scaleX = rect.width / this.imgWidth;
    const scaleY = rect.height / this.imgHeight;

    const editor = document.createElement("textarea");
    editor.className = "markup-inline-editor";
    editor.value = obj.text || "";

    let posX = obj.x;
    let posY = obj.y;
    let posW = obj.width;
    let posH = obj.height;

    if (obj.type === "bubble") {
      posX += 10;
      posY += 10;
      posW -= 20;
      posH -= 20;
    }

    const screenX = rect.left + posX * scaleX;
    const screenY = rect.top + posY * scaleY;
    const screenW = Math.max(120, posW * scaleX);
    const screenH = Math.max(50, posH * scaleY);

    Object.assign(editor.style, {
      position: "fixed",
      left: `${screenX}px`,
      top: `${screenY}px`,
      width: `${screenW}px`,
      height: `${screenH}px`,
      fontSize: `${Math.max(12, (obj.fontSize || this.fontSize) * scaleY)}px`,
      color: obj.color || this.color,
      background: "rgba(18, 18, 24, 0.85)",
      backdropFilter: "blur(4px)",
      border: `1.5px solid ${obj.color || this.color}`,
      borderRadius: "6px",
      padding: "6px",
      outline: "none",
      resize: "none",
      zIndex: "1000",
      fontFamily: "DM Sans, sans-serif",
      lineHeight: "1.4",
      boxShadow: "0 4px 12px rgba(0,0,0,0.5)",
    });

    document.body.appendChild(editor);
    editor.focus();
    editor.select();

    const finish = () => {
      obj.text = editor.value.trim() || (obj.type === "bubble" ? "…" : "Tekst");
      if (editor.parentElement) editor.parentElement.removeChild(editor);
      this.activeTextEditor = null;
      this.pushHistory();
      this.render();
    };

    editor.addEventListener("blur", finish);
    editor.addEventListener("keydown", (ev) => {
      if (ev.key === "Enter" && !ev.shiftKey) {
        ev.preventDefault();
        editor.blur();
      } else if (ev.key === "Escape") {
        ev.preventDefault();
        editor.blur();
      }
    });

    this.activeTextEditor = { editor, finish };
  }

  #commitTextEditor() {
    if (this.activeTextEditor) {
      this.activeTextEditor.finish();
    }
  }

  /* ─────────────────────────────────────────────────────────────
     HIT TESTING (Uchwyty i obiekty)
     ───────────────────────────────────────────────────────────── */

  #hitTestHandles(obj, px, py) {
    const r = 12 / (this.displayScale || 1); // promień trafienia uchwytu

    if (["line", "arrow"].includes(obj.type)) {
      if (Math.hypot(px - obj.x1, py - obj.y1) <= r) return { type: "endpoint", id: "start" };
      if (Math.hypot(px - obj.x2, py - obj.y2) <= r) return { type: "endpoint", id: "end" };
      return null;
    }

    if (obj.type === "bubble" && obj.tailX !== undefined) {
      if (Math.hypot(px - obj.tailX, py - obj.tailY) <= r) return { type: "tail", id: "tail" };
    }

    if (["rectangle", "ellipse", "triangle", "bubble", "text"].includes(obj.type)) {
      const handles = this.#getBoxHandles(obj);
      for (const h of handles) {
        if (Math.hypot(px - h.x, py - h.y) <= r) {
          return { type: "resize", id: h.id };
        }
      }
    }

    return null;
  }

  #getBoxHandles(obj) {
    const { x, y, width, height } = obj;
    return [
      { id: "nw", x, y },
      { id: "n", x: x + width / 2, y },
      { id: "ne", x: x + width, y },
      { id: "e", x: x + width, y: y + height / 2 },
      { id: "se", x: x + width, y: y + height },
      { id: "s", x: x + width / 2, y: y + height },
      { id: "sw", x, y: y + height },
      { id: "w", x, y: y + height / 2 },
    ];
  }

  #hitTestCropHandle(px, py) {
    if (!this.cropRect) return null;
    const r = 14 / (this.displayScale || 1);
    const handles = this.#getBoxHandles(this.cropRect);
    for (const h of handles) {
      if (Math.hypot(px - h.x, py - h.y) <= r) return h.id;
    }
    return null;
  }

  #hitTestObject(px, py) {
    // Sprawdzamy od najświeższych obiektów (na wierzchu)
    for (let i = this.objects.length - 1; i >= 0; i--) {
      const obj = this.objects[i];
      if (["rectangle", "bubble", "text"].includes(obj.type)) {
        if (this.#isPointInRect(px, py, obj)) return obj;
      } else if (obj.type === "ellipse") {
        const cx = obj.x + obj.width / 2;
        const cy = obj.y + obj.height / 2;
        const rx = obj.width / 2;
        const ry = obj.height / 2;
        if (rx > 0 && ry > 0 && Math.pow((px - cx) / rx, 2) + Math.pow((py - cy) / ry, 2) <= 1) {
          return obj;
        }
      } else if (obj.type === "triangle") {
        if (this.#isPointInTriangle(px, py, obj)) return obj;
      } else if (["line", "arrow"].includes(obj.type)) {
        if (this.#distToSegment(px, py, obj.x1, obj.y1, obj.x2, obj.y2) <= Math.max(10, obj.lineWidth * 2)) {
          return obj;
        }
      } else if (obj.type === "highlighter") {
        for (const pt of obj.points) {
          if (Math.hypot(px - pt.x, py - pt.y) <= obj.lineWidth) return obj;
        }
      }
    }
    return null;
  }

  #isPointInRect(px, py, rect) {
    if (!rect) return false;
    const x1 = Math.min(rect.x, rect.x + (rect.width || 0));
    const x2 = Math.max(rect.x, rect.x + (rect.width || 0));
    const y1 = Math.min(rect.y, rect.y + (rect.height || 0));
    const y2 = Math.max(rect.y, rect.y + (rect.height || 0));
    return px >= x1 - 5 && px <= x2 + 5 && py >= y1 - 5 && py <= y2 + 5;
  }

  #isPointInTriangle(px, py, obj) {
    const p1 = { x: obj.x + obj.width / 2, y: obj.y };
    const p2 = { x: obj.x, y: obj.y + obj.height };
    const p3 = { x: obj.x + obj.width, y: obj.y + obj.height };
    const area = 0.5 * (-p2.y * p3.x + p1.y * (-p2.x + p3.x) + p1.x * (p2.y - p3.y) + p2.x * p3.y);
    const s = (1 / (2 * area)) * (p1.y * p3.x - p1.x * p3.y + (p3.y - p1.y) * px + (p1.x - p3.x) * py);
    const t = (1 / (2 * area)) * (p1.x * p2.y - p1.y * p2.x + (p1.y - p2.y) * px + (p2.x - p1.x) * py);
    return s > 0 && t > 0 && 1 - s - t > 0;
  }

  #distToSegment(px, py, x1, y1, x2, y2) {
    const l2 = Math.pow(x2 - x1, 2) + Math.pow(y2 - y1, 2);
    if (l2 === 0) return Math.hypot(px - x1, py - y1);
    let t = ((px - x1) * (x2 - x1) + (py - y1) * (y2 - y1)) / l2;
    t = Math.max(0, Math.min(1, t));
    return Math.hypot(px - (x1 + t * (x2 - x1)), py - (y1 + t * (y2 - y1)));
  }

  /* ─────────────────────────────────────────────────────────────
     RENDEROWANIE (Rysowanie Canvas)
     ───────────────────────────────────────────────────────────── */

  render() {
    const ctx = this.ctx;
    ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);

    if (!this.baseImage) return;

    // 1. Rysuj bazowy obrazek
    ctx.drawImage(this.baseImage, 0, 0, this.imgWidth, this.imgHeight);

    // 2. Rysuj zakreślacze
    for (const obj of this.objects.filter((o) => o.type === "highlighter")) {
      this.#drawObject(ctx, obj);
    }

    // 3. Rysuj pozostałe obiekty
    for (const obj of this.objects.filter((o) => o.type !== "highlighter")) {
      this.#drawObject(ctx, obj);
    }

    // 4. Rysuj zaznaczenie i uchwyty
    if (this.selectedId) {
      const obj = this.getObject(this.selectedId);
      if (obj) this.#drawSelectionHandles(ctx, obj);
    }

    // 5. Rysuj maskę kadrowania (jeśli tryb kadrowania jest aktywny lub kadr jest mniejszy)
    if (this.tool === "crop" && this.cropRect) {
      this.#drawCropOverlay(ctx);
    }
  }

  #drawObject(ctx, obj) {
    ctx.save();
    ctx.strokeStyle = obj.color;
    ctx.fillStyle = obj.color;
    ctx.lineWidth = obj.lineWidth || this.lineWidth;
    ctx.lineCap = "round";
    ctx.lineJoin = "round";

    if (obj.type === "highlighter") {
      if (!obj.points || obj.points.length < 2) {
        ctx.restore();
        return;
      }
      ctx.globalAlpha = obj.opacity || 0.38;
      ctx.beginPath();
      ctx.moveTo(obj.points[0].x, obj.points[0].y);
      for (let i = 1; i < obj.points.length; i++) {
        ctx.lineTo(obj.points[i].x, obj.points[i].y);
      }
      ctx.stroke();
    } else if (obj.type === "rectangle") {
      ctx.beginPath();
      ctx.roundRect(obj.x, obj.y, obj.width, obj.height, 6);
      ctx.stroke();
    } else if (obj.type === "ellipse") {
      ctx.beginPath();
      const cx = obj.x + obj.width / 2;
      const cy = obj.y + obj.height / 2;
      const rx = Math.max(1, Math.abs(obj.width) / 2);
      const ry = Math.max(1, Math.abs(obj.height) / 2);
      ctx.ellipse(cx, cy, rx, ry, 0, 0, 2 * Math.PI);
      ctx.stroke();
    } else if (obj.type === "triangle") {
      ctx.beginPath();
      ctx.moveTo(obj.x + obj.width / 2, obj.y);
      ctx.lineTo(obj.x, obj.y + obj.height);
      ctx.lineTo(obj.x + obj.width, obj.y + obj.height);
      ctx.closePath();
      ctx.stroke();
    } else if (obj.type === "line") {
      ctx.beginPath();
      ctx.moveTo(obj.x1, obj.y1);
      ctx.lineTo(obj.x2, obj.y2);
      ctx.stroke();
    } else if (obj.type === "arrow") {
      this.#drawArrow(ctx, obj.x1, obj.y1, obj.x2, obj.y2, obj.lineWidth);
    } else if (obj.type === "bubble") {
      this.#drawSpeechBubble(ctx, obj);
    } else if (obj.type === "text") {
      this.#drawText(ctx, obj);
    }

    ctx.restore();
  }

  #drawArrow(ctx, x1, y1, x2, y2, lineWidth) {
    const headLength = Math.max(16, lineWidth * 3.5);
    const angle = Math.atan2(y2 - y1, x2 - x1);

    ctx.beginPath();
    ctx.moveTo(x1, y1);
    ctx.lineTo(x2, y2);
    ctx.stroke();

    // Grot strzałki
    ctx.beginPath();
    ctx.moveTo(x2, y2);
    ctx.lineTo(
      x2 - headLength * Math.cos(angle - Math.PI / 6),
      y2 - headLength * Math.sin(angle - Math.PI / 6),
    );
    ctx.lineTo(
      x2 - headLength * Math.cos(angle + Math.PI / 6),
      y2 - headLength * Math.sin(angle + Math.PI / 6),
    );
    ctx.closePath();
    ctx.fill();
  }

  #drawSpeechBubble(ctx, obj) {
    const { x, y, width, height, tailX, tailY, color, lineWidth, fontSize, text } = obj;
    const r = 12;

    ctx.save();
    ctx.fillStyle = "rgba(18, 18, 24, 0.88)";
    ctx.strokeStyle = color;
    ctx.lineWidth = lineWidth;

    // Rysowanie zaokrąglonego prostokąta z wcięciem na ogonek
    ctx.beginPath();
    ctx.roundRect(x, y, width, height, r);
    ctx.fill();
    ctx.stroke();

    // Ogonek dymka (trójkąt od dolnej/bocznej krawędzi do tailX, tailY)
    const baseCenterX = Math.max(x + 20, Math.min(x + width - 20, tailX));
    const baseCenterY = y + height;

    ctx.beginPath();
    ctx.moveTo(baseCenterX - 12, baseCenterY - 1);
    ctx.lineTo(tailX, tailY);
    ctx.lineTo(baseCenterX + 12, baseCenterY - 1);
    ctx.closePath();
    ctx.fillStyle = "rgba(18, 18, 24, 0.88)";
    ctx.fill();
    ctx.stroke();

    // Wewnętrzny tekst
    ctx.fillStyle = color;
    ctx.font = `500 ${fontSize || 20}px "DM Sans", sans-serif`;
    ctx.textBaseline = "middle";
    this.#wrapText(ctx, text || "", x + 12, y + height / 2, width - 24, (fontSize || 20) * 1.3);

    ctx.restore();
  }

  #drawText(ctx, obj) {
    const { x, y, width, height, color, fontSize, text } = obj;
    ctx.save();
    ctx.fillStyle = color;
    ctx.font = `600 ${fontSize || 24}px "DM Sans", sans-serif`;
    ctx.textBaseline = "top";
    this.#wrapText(ctx, text || "", x, y, Math.max(width, 200), (fontSize || 24) * 1.3);
    ctx.restore();
  }

  #wrapText(ctx, text, x, y, maxWidth, lineHeight) {
    const lines = String(text).split("\n");
    let currentY = y;
    for (const rawLine of lines) {
      const words = rawLine.split(" ");
      let line = "";
      for (let n = 0; n < words.length; n++) {
        const testLine = line + words[n] + " ";
        const metrics = ctx.measureText(testLine);
        const testWidth = metrics.width;
        if (testWidth > maxWidth && n > 0) {
          ctx.fillText(line.trim(), x, currentY);
          line = words[n] + " ";
          currentY += lineHeight;
        } else {
          line = testLine;
        }
      }
      ctx.fillText(line.trim(), x, currentY);
      currentY += lineHeight;
    }
  }

  #drawSelectionHandles(ctx, obj) {
    ctx.save();
    const handleRadius = Math.max(5, 6 / (this.displayScale || 1));

    if (["line", "arrow"].includes(obj.type)) {
      this.#drawHandle(ctx, obj.x1, obj.y1, handleRadius);
      this.#drawHandle(ctx, obj.x2, obj.y2, handleRadius);
      ctx.restore();
      return;
    }

    if (obj.type === "bubble" && obj.tailX !== undefined) {
      this.#drawHandle(ctx, obj.tailX, obj.tailY, handleRadius, "#3b82f6");
    }

    // Ramka obwiedni
    ctx.strokeStyle = "rgba(59, 130, 246, 0.8)";
    ctx.lineWidth = Math.max(1, 1.5 / (this.displayScale || 1));
    ctx.setLineDash([4 / (this.displayScale || 1), 4 / (this.displayScale || 1)]);
    ctx.strokeRect(obj.x, obj.y, obj.width, obj.height);
    ctx.setLineDash([]);

    // 8 uchwytów
    const handles = this.#getBoxHandles(obj);
    for (const h of handles) {
      this.#drawHandle(ctx, h.x, h.y, handleRadius);
    }

    ctx.restore();
  }

  #drawHandle(ctx, x, y, radius, fillColor = "#ffffff") {
    ctx.beginPath();
    ctx.arc(x, y, radius, 0, 2 * Math.PI);
    ctx.fillStyle = fillColor;
    ctx.fill();
    ctx.strokeStyle = "#1e1e24";
    ctx.lineWidth = Math.max(1, 1.5 / (this.displayScale || 1));
    ctx.stroke();
  }

  #drawCropOverlay(ctx) {
    const { x, y, width, height } = this.cropRect;
    ctx.save();

    // Ciemna maska wokół kadru
    ctx.fillStyle = "rgba(0, 0, 0, 0.6)";
    ctx.fillRect(0, 0, this.imgWidth, y);
    ctx.fillRect(0, y + height, this.imgWidth, this.imgHeight - (y + height));
    ctx.fillRect(0, y, x, height);
    ctx.fillRect(x + width, y, this.imgWidth - (x + width), height);

    // Krawędź kadru
    ctx.strokeStyle = "#e5b968";
    ctx.lineWidth = Math.max(2, 2 / (this.displayScale || 1));
    ctx.strokeRect(x, y, width, height);

    // Siatka trójpodziału
    ctx.strokeStyle = "rgba(229, 185, 104, 0.25)";
    ctx.lineWidth = 1 / (this.displayScale || 1);
    ctx.beginPath();
    ctx.moveTo(x + width / 3, y);
    ctx.lineTo(x + width / 3, y + height);
    ctx.moveTo(x + (2 * width) / 3, y);
    ctx.lineTo(x + (2 * width) / 3, y + height);
    ctx.moveTo(x, y + height / 3);
    ctx.lineTo(x + width, y + height / 3);
    ctx.moveTo(x, y + (2 * height) / 3);
    ctx.lineTo(x + width, y + (2 * height) / 3);
    ctx.stroke();

    // Uchwyty narożne kadru
    const handleRadius = Math.max(6, 7 / (this.displayScale || 1));
    const handles = this.#getBoxHandles(this.cropRect);
    for (const h of handles) {
      this.#drawHandle(ctx, h.x, h.y, handleRadius, "#e5b968");
    }

    ctx.restore();
  }

  /**
   * Eksportuje gotowy, wyedytowany zrzut do PNG data URL w pełnej rozdzielczości.
   * Uwzględnia kadrowanie (jeśli jest mniejsze niż cały obraz) oraz wszystkie naniesione wektory.
   */
  exportImage() {
    this.#commitTextEditor();
    if (!this.baseImage) return null;

    let crop = this.cropRect;
    if (
      !crop ||
      crop.width <= 0 ||
      crop.height <= 0 ||
      (crop.x === 0 && crop.y === 0 && crop.width === this.imgWidth && crop.height === this.imgHeight)
    ) {
      crop = { x: 0, y: 0, width: this.imgWidth, height: this.imgHeight };
    }

    const outCanvas = document.createElement("canvas");
    outCanvas.width = Math.round(crop.width);
    outCanvas.height = Math.round(crop.height);
    const outCtx = outCanvas.getContext("2d");

    // Przesunięcie o pozycję kadru
    outCtx.translate(-crop.x, -crop.y);

    // 1. Rysuj bazowy obrazek
    outCtx.drawImage(this.baseImage, 0, 0, this.imgWidth, this.imgHeight);

    // 2. Rysuj zakreślacze
    for (const obj of this.objects.filter((o) => o.type === "highlighter")) {
      this.#drawObject(outCtx, obj);
    }

    // 3. Rysuj pozostałe obiekty
    for (const obj of this.objects.filter((o) => o.type !== "highlighter")) {
      this.#drawObject(outCtx, obj);
    }

    const dataUrl = outCanvas.toDataURL("image/png");
    return {
      dataUrl,
      width: outCanvas.width,
      height: outCanvas.height,
    };
  }
}

window.MarkupEngine = MarkupEngine;

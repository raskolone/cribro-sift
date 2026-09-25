import React, { useState, useRef, useEffect, useCallback } from 'react';
import gsap from 'gsap';

export type NoteColor =
  | 'yellow'
  | 'violet'
  | 'rose'
  | 'mint'
  | 'amber'
  | 'sky'
  | 'graphite';

export interface FloatingNoteData {
  id: string;
  title: string;
  content: string;
  color: NoteColor;
  x: number;
  y: number;
  width?: number;
  height?: number;
  zIndex?: number;
  rotation?: number;
  pinned?: boolean;
  updatedAt?: string;
}

export interface FloatingSheetNotesProps {
  notes?: FloatingNoteData[];
  initialStacked?: boolean;
  onNotesChange?: (notes: FloatingNoteData[]) => void;
  onStackChange?: (isStacked: boolean) => void;
  onNoteSelect?: (id: string) => void;
  className?: string;
}

export interface FloatingSheetNoteProps {
  note: FloatingNoteData;
  index: number;
  isStacked: boolean;
  isTopCard?: boolean;
  cardRef?: (el: HTMLDivElement | null) => void;
  innerRef?: (el: HTMLDivElement | null) => void;
  handleRef?: (el: HTMLDivElement | null) => void;
  onDragStart?: (id: string, e: React.PointerEvent<HTMLDivElement>) => void;
  onClick?: () => void;
  onStack?: (id: string) => void;
  onContentChange?: (id: string, content: string) => void;
  onTitleChange?: (id: string, title: string) => void;
}

const COLOR_MAP: Record<NoteColor, { bg: string; accent: string; headerText: string }> = {
  yellow: {
    bg: '#eed98b',
    accent: '#d97706',
    headerText: '#000000',
  },
  violet: {
    bg: '#d8d0f0',
    accent: '#6366f1',
    headerText: '#000000',
  },
  rose: {
    bg: '#e8c4c8',
    accent: '#ec4899',
    headerText: '#000000',
  },
  mint: {
    bg: '#c8e6d5',
    accent: '#10b981',
    headerText: '#000000',
  },
  amber: {
    bg: '#f5e49b',
    accent: '#f97316',
    headerText: '#000000',
  },
  sky: {
    bg: '#c8dff0',
    accent: '#0284c7',
    headerText: '#000000',
  },
  graphite: {
    bg: '#dedad2',
    accent: '#475569',
    headerText: '#000000',
  },
};

const DEFAULT_NOTES: FloatingNoteData[] = [
  {
    id: 'note-1',
    title: 'Spotkanie projektowe',
    content: '1. Omówić architekturę szeptu AI\n2. Przegląd nowego algorytmu sita\n3. Wdrożenie widżetu macOS 26',
    color: 'yellow',
    x: 80,
    y: 80,
    width: 300,
    height: 320,
    rotation: -2,
    pinned: true,
  },
  {
    id: 'note-2',
    title: 'Notatki z dyktowania',
    content: 'Czysty strumień Deepgram Nova-3. Fonetyczna normalizacja żargonu programistycznego.',
    color: 'sky',
    x: 420,
    y: 110,
    width: 300,
    height: 320,
    rotation: 3,
  },
  {
    id: 'note-3',
    title: 'Zadania na dziś',
    content: '• Weryfikacja podpisów kext / tap\n• Spotlight re-index bez duplikatów\n• WCAG AAA dla Light Mode',
    color: 'mint',
    x: 220,
    y: 430,
    width: 300,
    height: 320,
    rotation: -1.5,
  },
];

/**
 * PaperTextureFilter — Delikatna tekstura papieru w wektorowym formacie SVG.
 */
export const PaperTextureFilter: React.FC = () => (
  <svg className="absolute w-0 h-0 pointer-events-none" aria-hidden="true">
    <defs>
      <filter id="paper-texture" x="0%" y="0%" width="100%" height="100%">
        <feTurbulence type="fractalNoise" baseFrequency="0.04" numOctaves="4" result="noise" />
        <feDiffuseLighting in="noise" lightingColor="#fff" surfaceScale="1.2" result="light">
          <feDistantLight azimuth="45" elevation="60" />
        </feDiffuseLighting>
        <feBlend mode="multiply" in="SourceGraphic" in2="light" />
      </filter>
    </defs>
  </svg>
);

/**
 * FloatingSheetNote — Pojedyncza notatka "Floating Sheets".
 */
export const FloatingSheetNote: React.FC<FloatingSheetNoteProps> = ({
  note,
  index,
  isStacked,
  isTopCard = false,
  cardRef,
  innerRef,
  handleRef,
  onDragStart,
  onClick,
  onStack,
  onContentChange,
  onTitleChange,
}) => {
  const palette = COLOR_MAP[note.color] || COLOR_MAP.yellow;
  const cardWidth = note.width ?? 300;
  const cardMinHeight = note.height ?? 320;
  const initialRot = (note.rotation ?? 0) * 0.5;

  return (
    <div
      ref={cardRef}
      onClick={onClick}
      onPointerDown={(e) => {
        if (!isStacked && onDragStart) {
          onDragStart(note.id, e);
        }
      }}
      role={isStacked && isTopCard ? 'button' : undefined}
      tabIndex={isStacked && isTopCard ? 0 : undefined}
      aria-label={isStacked && isTopCard ? 'Rozwiń stosik notatek' : undefined}
      onKeyDown={(e) => {
        if (isStacked && isTopCard && (e.key === 'Enter' || e.key === ' ')) {
          e.preventDefault();
          onClick?.();
        }
      }}
      style={{
        position: 'absolute',
        top: 0,
        left: 0,
        width: cardWidth,
        minHeight: cardMinHeight,
        padding: 24,
        borderRadius: 16,
        border: '1px solid rgba(0, 0, 0, 0.08)',
        backgroundColor: palette.bg,
        fontFamily: 'system-ui, -apple-system, sans-serif',
        fontSize: 16,
        color: '#18181b',
        cursor: isStacked ? (isTopCard ? 'pointer' : 'default') : 'grab',
        userSelect: isStacked ? 'none' : 'auto',
        pointerEvents: isStacked ? (isTopCard ? 'auto' : 'none') : 'auto',
        transform: `translate3d(${note.x}px, ${note.y}px, 0px) rotate(${initialRot}deg) scale(1)`,
        transformOrigin: '50% 50%',
        willChange: 'transform, opacity, box-shadow',
        boxShadow: '0px 10px 30px rgba(0,0,0,0.1)',
        zIndex: note.zIndex ?? 10 + index,
      }}
      className="flex flex-col select-none overflow-hidden"
    >
      {/* ── Uchwyt do przeciągania (Drag Handle) ── */}
      <div ref={handleRef} className="drag-handle-container">
        <div className="flex justify-center mb-4 cursor-grab">
          <div className="w-8 h-1 rounded-full bg-black/10" />
        </div>
      </div>

      {/* ── Wewnętrzna zawartość notatki ── */}
      <div
        ref={innerRef}
        className="note-inner-content flex-1 flex flex-col"
        style={{
          pointerEvents: isStacked ? 'none' : 'auto',
        }}
      >
        {/* Tytuł notatki */}
        <input
          type="text"
          value={note.title}
          disabled={isStacked}
          onChange={(e) => onTitleChange?.(note.id, e.target.value)}
          placeholder="Tytuł notatki"
          aria-label="Tytuł notatki"
          className="w-full bg-transparent font-bold text-[16px] text-black leading-tight outline-none border-none mb-3 pb-1 border-b border-black/[0.04] focus:border-black/20 transition-colors"
          style={{ color: '#000000' }}
        />

        {/* Treść notatki */}
        <textarea
          value={note.content}
          disabled={isStacked}
          onChange={(e) => onContentChange?.(note.id, e.target.value)}
          placeholder="Zanotuj myśl..."
          aria-label="Treść notatki"
          className="flex-1 w-full bg-transparent resize-none outline-none text-[#18181b] text-[15px] leading-relaxed placeholder:text-neutral-500"
          style={{
            fontFamily: 'system-ui, -apple-system, sans-serif',
          }}
        />

        {/* Stopka z przyciskiem zwijania w stosik */}
        <div className="pt-3 mt-auto border-t border-black/[0.06] flex items-center justify-between text-xs text-neutral-700 font-mono">
          <span>{note.content.trim().split(/\s+/).filter(Boolean).length} słów</span>
          <button
            type="button"
            aria-label="Zwiń wszystkie kartki w stosik"
            onClick={(e) => {
              e.stopPropagation();
              onStack?.(note.id);
            }}
            className="flex items-center gap-1.5 px-2.5 py-1 rounded-md text-[11px] font-sans font-medium bg-black/[0.04] hover:bg-black/[0.08] active:scale-95 text-neutral-800 transition-all"
            title="Zwiń wszystkie kartki w stosik w tym miejscu"
          >
            <svg className="w-3 h-3 text-neutral-700" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <path d="M7 4.5h10a2 2 0 0 1 2 2v10" strokeLinecap="round" />
              <rect x="4" y="7.5" width="13" height="13" rx="2.5" />
            </svg>
            <span>Zwiń w stosik</span>
          </button>
        </div>
      </div>
    </div>
  );
};

/**
 * FloatingSheetNotes — Główny kontener pływających notatek na macOS ("Floating Sheets").
 * Zarządza animacją stosu w GSAP z fizyką ruchu i krzywymi przejść tożsamymi z górnym widgetem.
 */
export const FloatingSheetNotes: React.FC<FloatingSheetNotesProps> = ({
  notes: initialNotes = DEFAULT_NOTES,
  initialStacked = false,
  onNotesChange,
  onStackChange,
  onNoteSelect,
  className = '',
}) => {
  const [notes, setNotes] = useState<FloatingNoteData[]>(initialNotes);
  const [isStacked, setIsStacked] = useState(initialStacked);
  const [originId, setOriginId] = useState<string | null>(null);

  // Synchronizacja przy zmianie zewnętrznych propsów initialNotes
  useEffect(() => {
    setNotes(initialNotes);
  }, [initialNotes]);

  const notesRef = useRef<FloatingNoteData[]>(notes);
  notesRef.current = notes;

  const isStackedRef = useRef<boolean>(isStacked);
  isStackedRef.current = isStacked;

  const containerRef = useRef<HTMLDivElement>(null);
  const cardRefs = useRef<Record<string, HTMLDivElement | null>>({});
  const innerRefs = useRef<Record<string, HTMLDivElement | null>>({});
  const handleRefs = useRef<Record<string, HTMLDivElement | null>>({});
  const timelineRef = useRef<gsap.core.Timeline | null>(null);
  const gsapCtxRef = useRef<gsap.Context | null>(null);
  const isInitialMount = useRef(true);

  const toggleStack = useCallback((id?: string) => {
    setIsStacked((prevStacked) => {
      const nextStacked = !prevStacked;
      if (nextStacked) {
        setOriginId(id || notesRef.current[0]?.id || null);
      } else {
        setOriginId(null);
      }
      onStackChange?.(nextStacked);
      return nextStacked;
    });
  }, [onStackChange]);

  const handleDragEnd = useCallback((id: string, newX: number, newY: number) => {
    setNotes((prev) => {
      const updated = prev.map((n) => (n.id === id ? { ...n, x: newX, y: newY } : n));
      onNotesChange?.(updated);
      return updated;
    });
  }, [onNotesChange]);

  const updateNoteContent = useCallback((id: string, content: string) => {
    setNotes((prev) => {
      const updated = prev.map((n) => (n.id === id ? { ...n, content } : n));
      onNotesChange?.(updated);
      return updated;
    });
  }, [onNotesChange]);

  const updateNoteTitle = useCallback((id: string, title: string) => {
    setNotes((prev) => {
      const updated = prev.map((n) => (n.id === id ? { ...n, title } : n));
      onNotesChange?.(updated);
      return updated;
    });
  }, [onNotesChange]);

  // Obsługa przeciągania pojedynczej karty myszą w stanie rozwiniętym
  const handlePointerDrag = useCallback((id: string, e: React.PointerEvent<HTMLDivElement>) => {
    if (isStackedRef.current) return;
    const targetCard = cardRefs.current[id];
    if (!targetCard) return;

    // Ignoruj kliknięcia w elementy edycyjne
    const target = e.target as HTMLElement;
    if (target.closest('input, textarea, button, a')) return;

    e.preventDefault();
    const startX = e.clientX;
    const startY = e.clientY;
    const currentNote = notesRef.current.find((n) => n.id === id);
    if (!currentNote) return;

    const initialX = currentNote.x;
    const initialY = currentNote.y;

    targetCard.setPointerCapture(e.pointerId);

    const onPointerMove = (moveEvent: PointerEvent) => {
      const dx = moveEvent.clientX - startX;
      const dy = moveEvent.clientY - startY;
      gsap.set(targetCard, { x: initialX + dx, y: initialY + dy });
    };

    const onPointerUp = (upEvent: PointerEvent) => {
      targetCard.removeEventListener('pointermove', onPointerMove);
      targetCard.removeEventListener('pointerup', onPointerUp);
      targetCard.removeEventListener('pointercancel', onPointerUp);
      try {
        targetCard.releasePointerCapture(upEvent.pointerId);
      } catch {}

      const finalDx = upEvent.clientX - startX;
      const finalDy = upEvent.clientY - startY;
      if (Math.hypot(finalDx, finalDy) > 3) {
        let finalX = initialX + finalDx;
        let finalY = initialY + finalDy;

        // Ograniczenie pozycji do granic kontenera, jeśli kontener jest dostępny
        if (containerRef.current) {
          const containerRect = containerRef.current.getBoundingClientRect();
          const cardWidth = currentNote.width ?? 300;
          const cardHeight = currentNote.height ?? 320;
          finalX = Math.max(0, Math.min(finalX, containerRect.width - cardWidth));
          finalY = Math.max(0, Math.min(finalY, containerRect.height - cardHeight));
          gsap.set(targetCard, { x: finalX, y: finalY });
        }

        handleDragEnd(id, finalX, finalY);
      }
    };

    targetCard.addEventListener('pointermove', onPointerMove);
    targetCard.addEventListener('pointerup', onPointerUp);
    targetCard.addEventListener('pointercancel', onPointerUp);
  }, [handleDragEnd]);

  // Główna synchronizacja animacji GSAP z fizyką i feeling of motion tożsamym z górnym widgetem
  useEffect(() => {
    const currentNotes = notesRef.current;
    const originNote = currentNotes.find((n) => n.id === originId) || currentNotes[0];
    const otherNotes = currentNotes.filter((n) => n.id !== originNote?.id);
    const orderedNotes = originNote ? [...otherNotes, originNote] : currentNotes;

    const isReducedMotion =
      typeof window !== 'undefined' &&
      window.matchMedia &&
      window.matchMedia('(prefers-reduced-motion: reduce)').matches;

    // Bezpieczne przerwanie aktywnego timeline'u
    if (timelineRef.current) {
      timelineRef.current.kill();
      timelineRef.current = null;
    }

    if (isInitialMount.current) {
      isInitialMount.current = false;
      gsapCtxRef.current = gsap.context(() => {}, containerRef);

      // Inicjalizacja pozycji startowych
      currentNotes.forEach((note, idx) => {
        const cardEl = cardRefs.current[note.id];
        const innerEl = innerRefs.current[note.id];
        const handleEl = handleRefs.current[note.id];
        if (!cardEl) return;

        gsap.set(cardEl, {
          x: note.x,
          y: note.y,
          scale: 1,
          rotation: (note.rotation ?? 0) * 0.5,
          zIndex: note.zIndex ?? 10 + idx,
          opacity: 1,
          boxShadow: '0px 10px 30px rgba(0,0,0,0.1)',
        });
        if (innerEl) gsap.set(innerEl, { opacity: 1 });
        if (handleEl) gsap.set(handleEl, { opacity: 1 });
      });
      return;
    }

    const tl = gsap.timeline();
    timelineRef.current = tl;

    if (isStacked) {
      // ── ZWIJANIE DO STOSU (COLLAPSE — MOTION PARITY Z WIDGETEM) ──
      // Widget: --t-fold: 0.34s, cubic-bezier(0.22, 1, 0.36, 1), kaskada od zewnątrz do wewnątrz (19ms)
      const duration = isReducedMotion ? 0.05 : 0.38;
      const ease = isReducedMotion ? 'none' : 'power2.inOut';
      const foldStep = isReducedMotion ? 0 : 0.019; // 19ms krok kaskady

      const cascadeSteps = [
        { dx: -10, dy: 8, rot: -2.5 },
        { dx: 14, dy: -12, rot: 3.5 },
        { dx: -14, dy: 14, rot: -3.8 },
        { dx: 18, dy: -16, rot: 4.2 },
        { dx: -8, dy: -6, rot: -1.8 },
      ];

      orderedNotes.forEach((n, idx) => {
        const cardEl = cardRefs.current[n.id];
        const innerEl = innerRefs.current[n.id];
        const handleEl = handleRefs.current[n.id];
        if (!cardEl) return;

        const isTop = idx === orderedNotes.length - 1;
        const distFromTop = orderedNotes.length - 1 - idx;
        const step = isTop ? { dx: 0, dy: 0, rot: 0 } : cascadeSteps[(distFromTop - 1) % cascadeSteps.length];

        const targetX = originNote.x + step.dx;
        const targetY = originNote.y + step.dy;
        const targetRot = isReducedMotion ? 0 : step.rot;
        const targetZIndex = isTop ? 40 : (n.zIndex ?? 10 + idx);
        const targetShadow = isTop
          ? '0px 20px 38px -6px rgba(0,0,0,0.32), 0px 10px 18px -4px rgba(0,0,0,0.18), 0px 2px 6px rgba(0,0,0,0.12)'
          : '0px 8px 20px -2px rgba(0,0,0,0.18), 0px 3px 8px -1px rgba(0,0,0,0.10)';

        // Kaskada: karty spodnie składają się pierwsze, wierzchnia domyka stos
        const cardStartTime = distFromTop * foldStep;

        tl.to(
          cardEl,
          {
            x: targetX,
            y: targetY,
            scale: 0.46,
            rotation: targetRot,
            zIndex: targetZIndex,
            boxShadow: targetShadow,
            duration,
            ease,
            overwrite: 'auto',
          },
          cardStartTime
        );

        if (innerEl) {
          tl.to(
            innerEl,
            {
              opacity: 0,
              duration: duration * 0.45,
              ease: 'power2.in',
              overwrite: 'auto',
            },
            cardStartTime
          );
        }

        if (handleEl) {
          tl.to(
            handleEl,
            {
              opacity: 0,
              duration: duration * 0.35,
              ease: 'power2.in',
              overwrite: 'auto',
            },
            cardStartTime
          );
        }
      });
    } else {
      // ── ROZWIJANIE ZE STOSU (EXPAND — MOTION PARITY Z WIDGETEM) ──
      // Widget: --t-fold: 0.34s-0.42s, cubic-bezier(0.22, 1, 0.36, 1) / power3.out, stagger: 38ms (--fold-step)
      const duration = isReducedMotion ? 0.05 : 0.42;
      const ease = isReducedMotion ? 'none' : 'power3.out';
      const foldStep = isReducedMotion ? 0 : 0.038; // 38ms dokładny krok kaskady widgetu

      const reverseOrdered = [...orderedNotes].reverse();

      reverseOrdered.forEach((n, idx) => {
        const cardEl = cardRefs.current[n.id];
        const innerEl = innerRefs.current[n.id];
        const handleEl = handleRefs.current[n.id];
        if (!cardEl) return;

        const naturalRotation = isReducedMotion ? 0 : (n.rotation ?? 0) * 0.5;
        // Rozkładanie: od wierzchu do spodu z opóźnieniem 38ms
        const cardStartTime = idx * foldStep;

        tl.to(
          cardEl,
          {
            x: n.x,
            y: n.y,
            scale: 1.0,
            rotation: naturalRotation,
            zIndex: n.zIndex ?? 10 + idx,
            boxShadow: '0px 10px 30px rgba(0,0,0,0.1)',
            duration,
            ease,
            overwrite: 'auto',
          },
          cardStartTime
        );

        if (innerEl) {
          tl.to(
            innerEl,
            {
              opacity: 1,
              duration: duration * 0.55,
              ease: 'power2.out',
              overwrite: 'auto',
            },
            cardStartTime + duration * 0.25
          );
        }

        if (handleEl) {
          tl.to(
            handleEl,
            {
              opacity: 1,
              duration: duration * 0.45,
              ease: 'power2.out',
              overwrite: 'auto',
            },
            cardStartTime + duration * 0.2
          );
        }
      });
    }
  }, [isStacked, originId]);

  // Sprzątanie kontekstu GSAP wyłącznie przy odmontowaniu całego komponentu
  useEffect(() => {
    return () => {
      if (timelineRef.current) {
        timelineRef.current.kill();
        timelineRef.current = null;
      }
      const ctx = gsapCtxRef.current;
      if (ctx) {
        ctx.revert();
      }
    };
  }, []);

  const originNote = notes.find((n) => n.id === originId) || notes[0];

  return (
    <div
      ref={containerRef}
      className={`relative w-full h-full min-h-[600px] overflow-hidden select-none ${className}`}
    >
      <PaperTextureFilter />

      {/* ── Lista Notatek Floating Sheets ── */}
      <div className="relative w-full h-full">
        {notes.map((note, index) => {
          const isTopCard = isStacked && originNote?.id === note.id;
          return (
            <FloatingSheetNote
              key={note.id}
              note={note}
              index={index}
              isStacked={isStacked}
              isTopCard={isTopCard}
              cardRef={(el) => {
                cardRefs.current[note.id] = el;
              }}
              innerRef={(el) => {
                innerRefs.current[note.id] = el;
              }}
              handleRef={(el) => {
                handleRefs.current[note.id] = el;
              }}
              onDragStart={handlePointerDrag}
              onClick={() => {
                if (isStacked) {
                  setIsStacked(false);
                  setOriginId(null);
                  onStackChange?.(false);
                }
                onNoteSelect?.(note.id);
              }}
              onStack={(id) => toggleStack(id)}
              onContentChange={updateNoteContent}
              onTitleChange={updateNoteTitle}
            />
          );
        })}
      </div>

      {/* ── Kontroler stosu (Zwiń / Rozwiń) ── */}
      <div className="absolute bottom-5 right-6 z-50 flex items-center gap-2">
        <button
          type="button"
          aria-expanded={!isStacked}
          aria-label={isStacked ? 'Rozwiń notatki ze stosu' : 'Zwiń wszystkie notatki w stosik'}
          onClick={() => toggleStack()}
          className="flex items-center gap-2 px-4 py-2 rounded-full text-xs font-semibold bg-white border border-slate-300 text-slate-800 shadow-md hover:bg-slate-50 active:scale-95 transition-all backdrop-blur-md focus:outline-none focus:ring-2 focus:ring-slate-400"
        >
          <svg
            className="w-3.5 h-3.5 text-slate-700"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
          >
            {isStacked ? (
              <path d="M4 8h16M4 16h16" strokeLinecap="round" strokeLinejoin="round" />
            ) : (
              <>
                <path d="M7 4.5h10a2 2 0 0 1 2 2v10" strokeLinecap="round" />
                <rect x="4" y="7.5" width="13" height="13" rx="2.5" />
              </>
            )}
          </svg>
          <span>{isStacked ? 'Rozwiń notatki' : 'Zwiń w stosik'}</span>
        </button>
      </div>
    </div>
  );
};

export default FloatingSheetNotes;


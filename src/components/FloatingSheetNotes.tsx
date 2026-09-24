import React, { useState } from 'react';
import { motion } from 'framer-motion';

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
  rotation?: number;
  pinned?: boolean;
  updatedAt?: string;
}

export interface FloatingSheetNotesProps {
  notes?: FloatingNoteData[];
  onNotesChange?: (notes: FloatingNoteData[]) => void;
  onNoteSelect?: (id: string) => void;
  className?: string;
}

export interface FloatingSheetNoteProps {
  note: FloatingNoteData;
  index: number;
  isStacked: boolean;
  isStackOrigin?: boolean;
  stackTarget?: { x: number; y: number; rotate: number; zIndex: number; isTop: boolean };
  onDragEnd?: (id: string, newX: number, newY: number) => void;
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
    rotation: 3,
  },
  {
    id: 'note-3',
    title: 'Zadania na dziś',
    content: '• Weryfikacja podpisów kext / tap\n• Spotlight re-index bez duplikatów\n• WCAG AAA dla Light Mode',
    color: 'mint',
    x: 220,
    y: 430,
    rotation: -1.5,
  },
];

/**
 * FloatingSheetNote — Pojedyncza notatka "Floating Sheets" (Opcja 2).
 * Posiada:
 * - Wymiary bazowe: 300px szerokości, min 320px wysokości
 * - Po zwinięciu: skalowanie 0.46 (zwarty bloczek, -30% względem poprzedniej skali)
 * - Asymetryczna kaskada kart z kotwicą w miejscu wywołującej notatki
 * - Sprężysta animacja rozwijania i zwijania (stiffness: 260, damping: 24)
 */
export const FloatingSheetNote: React.FC<FloatingSheetNoteProps> = ({
  note,
  index,
  isStacked,
  stackTarget,
  onDragEnd,
  onClick,
  onStack,
  onContentChange,
  onTitleChange,
}) => {
  const palette = COLOR_MAP[note.color] || COLOR_MAP.yellow;
  const rotationVal = note.rotation ?? 0;

  const targetX = isStacked ? (stackTarget?.x ?? note.x) : note.x;
  const targetY = isStacked ? (stackTarget?.y ?? note.y) : note.y;
  const targetRot = isStacked ? (stackTarget?.rotate ?? 0) : rotationVal * 0.5;
  const targetZIndex = isStacked ? (stackTarget?.zIndex ?? index) : 10;
  const isTopCard = stackTarget?.isTop ?? false;

  return (
    <motion.div
      layout
      initial={false}
      drag={!isStacked}
      dragMomentum={false}
      onDragEnd={(_event, info) => {
        if (!isStacked && onDragEnd) {
          onDragEnd(note.id, note.x + info.offset.x, note.y + info.offset.y);
        }
      }}
      onClick={onClick}
      animate={{
        x: targetX,
        y: targetY,
        rotate: targetRot,
        scale: isStacked ? 0.46 : 1.0,
        zIndex: targetZIndex,
        boxShadow: isStacked
          ? isTopCard
            ? '0px 20px 38px -6px rgba(0,0,0,0.32), 0px 10px 18px -4px rgba(0,0,0,0.18), 0px 2px 6px rgba(0,0,0,0.12)'
            : '0px 8px 20px -2px rgba(0,0,0,0.18), 0px 3px 8px -1px rgba(0,0,0,0.10)'
          : '0px 10px 30px rgba(0,0,0,0.1)',
      }}
      transition={{
        type: 'spring',
        stiffness: 260,
        damping: 24,
        mass: 0.85,
      }}
      style={{
        position: 'absolute',
        width: 300,
        minHeight: 320,
        padding: 24,
        borderRadius: 16,
        border: '1px solid rgba(0, 0, 0, 0.08)',
        backgroundColor: palette.bg,
        fontFamily: 'system-ui, -apple-system, sans-serif',
        fontSize: 16,
        color: '#18181b',
        cursor: isStacked ? 'pointer' : 'grab',
        userSelect: isStacked ? 'none' : 'auto',
        willChange: 'transform',
      }}
      className="flex flex-col select-none overflow-hidden"
    >
      {/* ── Drag Handle ── */}
      <div className={isStacked ? 'opacity-0' : 'opacity-100 transition-opacity duration-200'}>
        <div className="flex justify-center mb-4">
          <div className="w-8 h-1 rounded-full bg-black/10" />
        </div>
      </div>

      {/* ── Inner Content ── */}
      <div className={`flex-1 flex flex-col ${isStacked ? 'opacity-0 pointer-events-none' : 'opacity-100 transition-opacity duration-200'}`}>
        {/* Tytuł notatki */}
        <input
          type="text"
          value={note.title}
          disabled={isStacked}
          onChange={(e) => onTitleChange?.(note.id, e.target.value)}
          placeholder="Tytuł notatki"
          className="w-full bg-transparent font-bold text-[16px] text-black leading-tight outline-none border-none mb-3 pb-1 border-b border-black/[0.04] focus:border-black/20 transition-colors"
          style={{ color: '#000000' }}
        />

        {/* Treść notatki */}
        <textarea
          value={note.content}
          disabled={isStacked}
          onChange={(e) => onContentChange?.(note.id, e.target.value)}
          placeholder="Zanotuj myśl..."
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
    </motion.div>
  );
};

/**
 * FloatingSheetNotes — Główny kontener pływających notatek na macOS ("Floating Sheets").
 */
export const FloatingSheetNotes: React.FC<FloatingSheetNotesProps> = ({
  notes: initialNotes = DEFAULT_NOTES,
  onNotesChange,
  onNoteSelect,
  className = '',
}) => {
  const [notes, setNotes] = useState<FloatingNoteData[]>(initialNotes);
  const [isStacked, setIsStacked] = useState(false);
  const [originId, setOriginId] = useState<string | null>(null);

  const toggleStack = (id?: string) => {
    if (isStacked) {
      setIsStacked(false);
      setOriginId(null);
    } else {
      setOriginId(id || notes[0]?.id || null);
      setIsStacked(true);
    }
  };

  const handleDragEnd = (id: string, newX: number, newY: number) => {
    const updated = notes.map((n) => (n.id === id ? { ...n, x: newX, y: newY } : n));
    setNotes(updated);
    onNotesChange?.(updated);
  };

  const updateNoteContent = (id: string, content: string) => {
    const updated = notes.map((n) => (n.id === id ? { ...n, content } : n));
    setNotes(updated);
    onNotesChange?.(updated);
  };

  const updateNoteTitle = (id: string, title: string) => {
    const updated = notes.map((n) => (n.id === id ? { ...n, title } : n));
    setNotes(updated);
    onNotesChange?.(updated);
  };

  // Obliczenie celów kaskadowych względem notatki kotwiczącej (originNote)
  const originNote = notes.find((n) => n.id === originId) || notes[0];
  const otherNotes = notes.filter((n) => n.id !== originNote?.id);
  const orderedNotes = originNote ? [...otherNotes, originNote] : notes;

  const stackTargetsMap = new Map<string, { x: number; y: number; rotate: number; zIndex: number; isTop: boolean }>();
  if (originNote) {
    orderedNotes.forEach((n, idx) => {
      const isTop = idx === orderedNotes.length - 1;
      if (isTop) {
        stackTargetsMap.set(n.id, {
          x: originNote.x,
          y: originNote.y,
          rotate: 0,
          zIndex: 30,
          isTop: true,
        });
      } else {
        const distFromTop = orderedNotes.length - 1 - idx;
        const cascadeSteps = [
          { dx: -10, dy: 8, rot: -2.5 },   // środkowa
          { dx: 14, dy: -12, rot: 3.5 },   // spodnia
          { dx: -14, dy: 14, rot: -3.8 },
          { dx: 18, dy: -16, rot: 4.2 },
          { dx: -8, dy: -6, rot: -1.8 },
        ];
        const step = cascadeSteps[(distFromTop - 1) % cascadeSteps.length];
        stackTargetsMap.set(n.id, {
          x: originNote.x + step.dx,
          y: originNote.y + step.dy,
          rotate: step.rot,
          zIndex: 10 + idx,
          isTop: false,
        });
      }
    });
  }

  return (
    <div className={`relative w-full h-full min-h-[600px] overflow-hidden select-none ${className}`}>
      {/* ── Lista Notatek Floating Sheets ── */}
      <div className="relative w-full h-full">
        {notes.map((note, index) => (
          <FloatingSheetNote
            key={note.id}
            note={note}
            index={index}
            isStacked={isStacked}
            stackTarget={stackTargetsMap.get(note.id)}
            onDragEnd={handleDragEnd}
            onClick={() => {
              if (isStacked) {
                setIsStacked(false);
                setOriginId(null);
              }
              onNoteSelect?.(note.id);
            }}
            onStack={(id) => toggleStack(id)}
            onContentChange={updateNoteContent}
            onTitleChange={updateNoteTitle}
          />
        ))}
      </div>

      {/* ── Kontroler stosu (Zwiń / Rozwiń) ── */}
      <div className="absolute bottom-5 right-6 z-50 flex items-center gap-2">
        <button
          type="button"
          onClick={() => toggleStack()}
          className="flex items-center gap-2 px-4 py-2 rounded-full text-xs font-semibold bg-white border border-slate-300 text-slate-800 shadow-md hover:bg-slate-50 active:scale-95 transition-all backdrop-blur-md"
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

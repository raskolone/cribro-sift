import React, { useState } from 'react';
import { motion, AnimatePresence } from 'framer-motion';

export type NoteColor = 'yellow' | 'sky' | 'violet' | 'mint' | 'amber' | 'rose' | 'graphite';

export interface FloatingNoteData {
  id: string;
  title: string;
  content: string;
  color: NoteColor;
  x: number;
  y: number;
  pinned?: boolean;
  updatedAt?: string;
}

export interface FloatingSheetNotesProps {
  notes?: FloatingNoteData[];
  onNotesChange?: (notes: FloatingNoteData[]) => void;
  onNoteSelect?: (id: string) => void;
  stackCorner?: 'bottom-right' | 'bottom-left' | 'top-right' | 'top-left';
  className?: string;
}

const COLOR_PALETTES: Record<
  NoteColor,
  {
    bg: string;
    gradient: string;
    border: string;
    headerText: string;
    accentDot: string;
  }
> = {
  yellow: {
    bg: '#fef9c3',
    gradient: 'linear-gradient(145deg, #fffbeb 0%, #fef08a 45%, #fde047 100%)',
    border: 'rgba(161, 98, 7, 0.18)',
    headerText: '#451a03',
    accentDot: '#d97706',
  },
  sky: {
    bg: '#e0f2fe',
    gradient: 'linear-gradient(145deg, #f0f9ff 0%, #bae6fd 45%, #7dd3fc 100%)',
    border: 'rgba(3, 105, 161, 0.18)',
    headerText: '#0c4a6e',
    accentDot: '#0284c7',
  },
  violet: {
    bg: '#ede9fe',
    gradient: 'linear-gradient(145deg, #f5f3ff 0%, #ddd6fe 45%, #c4b5fd 100%)',
    border: 'rgba(109, 40, 217, 0.18)',
    headerText: '#3b0764',
    accentDot: '#7c3aed',
  },
  mint: {
    bg: '#dcfce7',
    gradient: 'linear-gradient(145deg, #f0fdf4 0%, #bbf7d0 45%, #86efac 100%)',
    border: 'rgba(20, 83, 45, 0.18)',
    headerText: '#064e3b',
    accentDot: '#16a34a',
  },
  amber: {
    bg: '#ffedd5',
    gradient: 'linear-gradient(145deg, #fff7ed 0%, #fed7aa 45%, #fdba74 100%)',
    border: 'rgba(194, 65, 12, 0.18)',
    headerText: '#451a03',
    accentDot: '#ea580c',
  },
  rose: {
    bg: '#ffe4e6',
    gradient: 'linear-gradient(145deg, #fff1f2 0%, #fecdd3 45%, #fda4af 100%)',
    border: 'rgba(159, 18, 57, 0.18)',
    headerText: '#4c0519',
    accentDot: '#e11d48',
  },
  graphite: {
    bg: '#f8fafc',
    gradient: 'linear-gradient(145deg, #ffffff 0%, #fafaf9 45%, #f4f4f5 100%)',
    border: 'rgba(24, 24, 27, 0.16)',
    headerText: '#09090b',
    accentDot: '#475569',
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
    pinned: true,
  },
  {
    id: 'note-2',
    title: 'Notatki z dyktowania',
    content: 'Czysty strumień Deepgram Nova-3. Fonetyczna normalizacja żargonu programistycznego.',
    color: 'sky',
    x: 370,
    y: 110,
  },
  {
    id: 'note-3',
    title: 'Zadania na dziś',
    content: '• Weryfikacja podpisów kext / tap\n• Spotlight re-index bez duplikatów\n• WCAG AAA dla Light Mode',
    color: 'mint',
    x: 180,
    y: 350,
  },
];

/**
 * FloatingSheetNotes — Komponent pływających notatek dla macOS (Cribro Sift).
 * Implementuje koncepcję "Floating Sheets" (Opcja 2):
 * - Faktura papieru (SVG filter feTurbulence + feDiffuseLighting)
 * - Płynna animacja zwijania do stosika i rozwijania (Framer Motion spring physics)
 * - Naprzemienne mikro-obroty w stosie (+1.5° / -1.5°)
 * - Wysoki kontrast typografii i głębokie atramentowe kolory fontów
 */
export const FloatingSheetNotes: React.FC<FloatingSheetNotesProps> = ({
  notes: initialNotes = DEFAULT_NOTES,
  onNotesChange,
  onNoteSelect,
  className = '',
}) => {
  const [notes, setNotes] = useState<FloatingNoteData[]>(initialNotes);
  const [isStacked, setIsStacked] = useState(false);
  const [activeNoteId, setActiveNoteId] = useState<string | null>(null);

  const toggleStack = () => {
    setIsStacked((prev) => !prev);
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

  return (
    <div className={`relative w-full h-full min-h-[600px] overflow-hidden select-none ${className}`}>
      {/* ── SVG Paper Texture Filter ── */}
      <svg className="absolute w-0 h-0 pointer-events-none" aria-hidden="true">
        <defs>
          <filter id="floating-paper-noise" x="0%" y="0%" width="100%" height="100%">
            <feTurbulence type="fractalNoise" baseFrequency="0.04" numOctaves="3" result="noise" />
            <feDiffuseLighting in="noise" lightingColor="#ffffff" surfaceScale="1.1" result="light">
              <feDistantLight azimuth="65" elevation="55" />
            </feDiffuseLighting>
            <feBlend mode="multiply" in="SourceGraphic" in2="light" result="blend" />
          </filter>
        </defs>
      </svg>

      {/* ── Floating Notes Canvas ── */}
      <div className="relative w-full h-full">
        {notes.map((note, index) => {
          const palette = COLOR_PALETTES[note.color] || COLOR_PALETTES.yellow;
          const isEven = index % 2 === 0;
          const stackRot = isEven ? 1.5 : -1.5;
          const stackOffset = index * 4;

          return (
            <motion.div
              key={note.id}
              drag={!isStacked}
              dragMomentum={false}
              onDragEnd={(_e, info) => {
                if (!isStacked) {
                  handleDragEnd(note.id, note.x + info.offset.x, note.y + info.offset.y);
                }
              }}
              onClick={() => {
                if (isStacked) {
                  setIsStacked(false);
                }
                setActiveNoteId(note.id);
                onNoteSelect?.(note.id);
              }}
              initial={false}
              animate={
                isStacked
                  ? {
                      x: `calc(100% - 150px - ${stackOffset}px)`,
                      y: `calc(100% - 140px - ${stackOffset}px)`,
                      scale: 0.38,
                      rotate: stackRot,
                      zIndex: index + 10,
                      boxShadow: '0 2px 6px rgba(0,0,0,0.18)',
                    }
                  : {
                      x: note.x,
                      y: note.y,
                      scale: 1,
                      rotate: 0,
                      zIndex: activeNoteId === note.id ? 40 : index + 1,
                      boxShadow:
                        '0 12px 30px -5px rgba(0, 0, 0, 0.12), 0 4px 10px -2px rgba(0, 0, 0, 0.05)',
                    }
              }
              transition={{
                type: 'spring',
                stiffness: 180,
                damping: 22,
                mass: 0.8,
                delay: isStacked ? 0 : index * 0.04,
              }}
              style={{
                position: 'absolute',
                width: 270,
                minHeight: 250,
                background: palette.gradient,
                borderColor: palette.border,
                borderWidth: '1px',
                borderRadius: '8px',
                fontFamily:
                  '-apple-system, BlinkMacSystemFont, "SF Pro Text", "SF Pro Display", sans-serif',
                cursor: isStacked ? 'pointer' : 'default',
              }}
              className="flex flex-col border shadow-paper overflow-hidden select-none"
            >
              {/* ── Subtelna faktura papieru (Paper Noise Overlay) ── */}
              <div
                className="absolute inset-0 pointer-events-none opacity-40 mix-blend-multiply"
                style={{
                  filter: 'url(#floating-paper-noise)',
                  background: palette.bg,
                }}
              />

              {/* ── Drag Handle Pill & Header ── */}
              <div className="relative z-10 flex flex-col pt-2 px-3 pb-1 border-b border-black/[0.06] bg-black/[0.02]">
                {/* Drag Pill */}
                <div className="flex justify-center mb-1.5">
                  <div className="w-8 h-1 rounded-full bg-black/15 cursor-grab active:cursor-grabbing hover:bg-black/25 transition-colors" />
                </div>

                {/* Header Title & Actions */}
                <div className="flex items-center justify-between gap-2">
                  <input
                    type="text"
                    value={note.title}
                    disabled={isStacked}
                    onChange={(e) => updateNoteTitle(note.id, e.target.value)}
                    className="flex-1 bg-transparent font-bold text-[14.5px] leading-tight tracking-tight outline-none border-none truncate focus:ring-1 focus:ring-black/10 rounded px-1 -mx-1"
                    style={{ color: palette.headerText }}
                  />
                  <div className="flex items-center gap-1.5">
                    <span
                      className="w-2.5 h-2.5 rounded-full"
                      style={{ backgroundColor: palette.accentDot }}
                    />
                  </div>
                </div>
              </div>

              {/* ── Body Content (Fades to opacity 0 on stack) ── */}
              <motion.div
                animate={{ opacity: isStacked ? 0 : 1 }}
                transition={{ duration: 0.2, delay: isStacked ? 0 : 0.15 }}
                className="relative z-10 flex-1 p-3.5 flex flex-col"
              >
                <textarea
                  value={note.content}
                  disabled={isStacked}
                  onChange={(e) => updateNoteContent(note.id, e.target.value)}
                  placeholder="Zanotuj myśl..."
                  className="flex-1 w-full h-full bg-transparent resize-none outline-none text-[#0f172a] text-[13.5px] font-medium leading-relaxed placeholder:text-slate-500"
                  style={{
                    WebkitFontSmoothing: 'subpixel-antialiased',
                  }}
                />

                {/* Footer metadata */}
                <div className="pt-2 mt-auto border-t border-black/[0.05] flex items-center justify-between text-[10.5px] text-slate-600 font-mono">
                  <span>{note.content.trim().split(/\s+/).filter(Boolean).length} słów</span>
                  <span>{note.pinned ? '📌 Przypięta' : 'Zapisano'}</span>
                </div>
              </motion.div>
            </motion.div>
          );
        })}
      </div>

      {/* ── Bottom Floating Controls ── */}
      <div className="absolute bottom-5 right-6 z-50 flex items-center gap-2">
        <button
          type="button"
          onClick={toggleStack}
          className="flex items-center gap-2 px-3.5 py-1.5 rounded-full text-xs font-semibold bg-white/95 border border-slate-300 text-slate-800 shadow-md hover:bg-slate-50 active:scale-95 transition-all backdrop-blur-md"
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

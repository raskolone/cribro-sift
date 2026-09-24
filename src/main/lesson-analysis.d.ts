export type VocabularyCategory = "idiom" | "collocation" | "business" | "general";

export interface LessonVocabularyItem {
  term: string;
  translation: string;
  contextSentence: string;
  category: VocabularyCategory;
}

export interface LessonAreaForImprovement {
  originalError: string;
  correctedForm: string;
  ruleExplanation: string;
}

export interface LessonAnalysis {
  topic: string;
  summaryPoints: string[];
  vocabularyItems: LessonVocabularyItem[];
  areasForImprovement: LessonAreaForImprovement[];
  homeworkProposal: string;
  nextLessonPlan: string;
  studentSpeaking: string;
  studentInsights: string;
}

export interface AnalyzeOptions {
  apiKey: string;
  model?: string;
  timeoutMs?: number;
}

export declare function analyzeLessonTranscript(
  transcript: string,
  options: AnalyzeOptions
): Promise<LessonAnalysis>;

export declare function parseAnalysisResponse(raw: string): LessonAnalysis | null;

export declare const SYSTEM_INSTRUCTION: string;
export declare const LESSON_ANALYSIS_SCHEMA: object;
export declare const DEFAULT_MODEL: string;

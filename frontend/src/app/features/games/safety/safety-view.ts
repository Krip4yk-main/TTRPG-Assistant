import {
  type CatalogWarningDto,
  type SafetyList,
  type SafetyTool,
  hasSafetyInfo,
} from '@nri/shared';

/** Межі чи завіси для показу: слаги каталожних тем і власні формулювання майстра. */
export interface SafetyTopicsView {
  slugs: string[];
  custom: string[];
}

/** Безпека гри для показу (сторінка гри, діалог заявки). */
export interface SafetyView {
  tools: SafetyTool[];
  lines: SafetyTopicsView;
  veils: SafetyTopicsView;
}

function topics(list: SafetyList, warnings: readonly CatalogWarningDto[]): SafetyTopicsView {
  return {
    slugs: list.warningIds
      .map((id) => warnings.find((w) => w.id === id)?.slug)
      .filter((s): s is string => !!s),
    custom: [...list.custom],
  };
}

/**
 * Безпека гри у вигляді для показу; майстер нічого не заповнив — `null` (блок не
 * показується зовсім). Невідомі id каталогу пропускаються.
 */
export function toSafetyView(
  g: { safetyTools: readonly SafetyTool[]; lines: SafetyList; veils: SafetyList },
  warnings: readonly CatalogWarningDto[],
): SafetyView | null {
  if (!hasSafetyInfo(g)) return null;
  return {
    tools: [...g.safetyTools],
    lines: topics(g.lines, warnings),
    veils: topics(g.veils, warnings),
  };
}

/** Чи є в списку хоч одна тема. */
export const hasTopics = (t: SafetyTopicsView): boolean => t.slugs.length + t.custom.length > 0;

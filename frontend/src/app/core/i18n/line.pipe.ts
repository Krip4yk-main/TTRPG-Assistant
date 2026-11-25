import { Pipe, inject, type PipeTransform } from '@angular/core';
import { TranslateService } from '@ngx-translate/core';
import type { LinePart } from '../games/game-card.vm';

/**
 * Однорядковий підсумок з частин моделі (`LinePart[]`): ключі перекладаються, частини
 * з'єднуються « · ». Мова застосунку не перемикається на льоту, тож пайп чистий.
 */
@Pipe({ name: 'nriLine' })
export class LinePipe implements PipeTransform {
  private readonly translate = inject(TranslateService);

  transform(parts: readonly LinePart[]): string {
    return parts.map((p) => ('key' in p ? this.translate.instant(p.key) : p.text)).join(' · ');
  }
}

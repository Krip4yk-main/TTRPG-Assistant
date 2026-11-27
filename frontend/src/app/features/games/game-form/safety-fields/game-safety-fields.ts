import {
  ChangeDetectionStrategy,
  Component,
  computed,
  effect,
  input,
  output,
  signal,
  untracked,
} from '@angular/core';
import { FormControl, ReactiveFormsModule } from '@angular/forms';
import { MatButtonModule } from '@angular/material/button';
import { MatCheckboxModule } from '@angular/material/checkbox';
import { MatFormFieldModule } from '@angular/material/form-field';
import { MatIconModule } from '@angular/material/icon';
import { MatInputModule } from '@angular/material/input';
import { MatTooltipModule } from '@angular/material/tooltip';
import { TranslatePipe } from '@ngx-translate/core';
import {
  type CatalogWarningDto,
  SAFETY_CUSTOM_LENGTH,
  SAFETY_CUSTOM_MAX,
  SAFETY_TOOLS,
  type SafetyList,
  type SafetyTool,
  hasSafetyInfo,
  safetyTextKey,
} from '@nri/shared';
import { WarningChip } from '../../../../shared/warning-chip/warning-chip';

export type SafetyKind = 'lines' | 'veils';

/** Зміна полів безпеки: лише ті, що змінилися (переміщення теми змінює обидва списки). */
export interface SafetyChange {
  safetyTools?: SafetyTool[];
  lines?: SafetyList;
  veils?: SafetyList;
}

const OTHER: Record<SafetyKind, SafetyKind> = { lines: 'veils', veils: 'lines' };

/**
 * Секція форми гри «Безпека гри (необов'язково)»: інструменти безпеки, межі (lines) і завіси
 * (veils) — теми з каталогу попереджень і власні формулювання. Згорнута, доки нічого не
 * заповнено. Одна тема не може бути і межею, і завісою: вибір в одному списку прибирає її з
 * іншого. Значення тримає батьківська форма; компонент лише повідомляє зміни.
 */
@Component({
  selector: 'nri-game-safety-fields',
  imports: [
    ReactiveFormsModule,
    MatButtonModule,
    MatCheckboxModule,
    MatFormFieldModule,
    MatIconModule,
    MatInputModule,
    MatTooltipModule,
    TranslatePipe,
    WarningChip,
  ],
  templateUrl: './game-safety-fields.html',
  styleUrl: './game-safety-fields.less',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class GameSafetyFields {
  readonly tools = input.required<readonly SafetyTool[]>();
  readonly lines = input.required<SafetyList>();
  readonly veils = input.required<SafetyList>();
  readonly warnings = input<readonly CatalogWarningDto[]>([]);
  readonly disabled = input(false);
  /** Помилки (ключі i18n) біля інструментів, меж і завіс. */
  readonly toolsError = input<string | null>(null);
  readonly linesError = input<string | null>(null);
  readonly veilsError = input<string | null>(null);
  readonly changed = output<SafetyChange>();

  protected readonly allTools = SAFETY_TOOLS;
  protected readonly kinds: readonly SafetyKind[] = ['lines', 'veils'];
  protected readonly maxCustom = SAFETY_CUSTOM_MAX;
  protected readonly maxLength = SAFETY_CUSTOM_LENGTH;
  protected readonly newCustom: Record<SafetyKind, FormControl<string>> = {
    lines: new FormControl('', { nonNullable: true }),
    veils: new FormControl('', { nonNullable: true }),
  };

  private readonly filled = computed(() =>
    hasSafetyInfo({ safetyTools: this.tools(), lines: this.lines(), veils: this.veils() }),
  );
  private readonly hasError = computed(
    () => !!(this.toolsError() || this.linesError() || this.veilsError()),
  );
  /** Секцію розгорнуто (користувачем або бо в ній уже є дані чи помилка). */
  protected readonly expanded = signal(false);

  constructor() {
    // Дані з'явилися (гру завантажено, відновлено копію) чи є помилка — розгортаємо; самі
    // не згортаємо: користувач міг усе прибрати й далі редагувати.
    effect(() => {
      if (this.filled() || this.hasError()) untracked(() => this.expanded.set(true));
    });
  }

  protected onToggle(event: Event): void {
    this.expanded.set((event.target as HTMLDetailsElement).open);
  }

  protected list(kind: SafetyKind): SafetyList {
    return kind === 'lines' ? this.lines() : this.veils();
  }

  protected error(kind: SafetyKind): string | null {
    return kind === 'lines' ? this.linesError() : this.veilsError();
  }

  protected toolChecked(tool: SafetyTool): boolean {
    return this.tools().includes(tool);
  }

  protected setTool(tool: SafetyTool, checked: boolean): void {
    const current = this.tools();
    const next = checked ? [...current, tool] : current.filter((t) => t !== tool);
    this.changed.emit({ safetyTools: SAFETY_TOOLS.filter((t) => next.includes(t)) });
  }

  protected warningSelected(kind: SafetyKind, id: number): boolean {
    return this.list(kind).warningIds.includes(id);
  }

  /** Тема каталогу: вмикає/вимикає в списку; увімкнена — прибирається з іншого списку. */
  protected toggleWarning(kind: SafetyKind, id: number): void {
    const list = this.list(kind);
    if (list.warningIds.includes(id)) {
      this.emitLists(kind, { ...list, warningIds: list.warningIds.filter((x) => x !== id) });
      return;
    }
    const other = this.list(OTHER[kind]);
    this.emitLists(
      kind,
      { ...list, warningIds: [...list.warningIds, id] },
      other.warningIds.includes(id)
        ? { ...other, warningIds: other.warningIds.filter((x) => x !== id) }
        : undefined,
    );
  }

  /** Власне формулювання: обрізане, без повторів (без урахування регістру), до 10 у списку. */
  protected addCustom(kind: SafetyKind): void {
    const control = this.newCustom[kind];
    const text = control.value.trim().slice(0, SAFETY_CUSTOM_LENGTH);
    const list = this.list(kind);
    if (!text || this.disabled()) return;
    const key = safetyTextKey(text);
    if (list.custom.some((s) => safetyTextKey(s) === key)) {
      control.setValue('');
      return;
    }
    if (list.custom.length >= SAFETY_CUSTOM_MAX) return;
    const other = this.list(OTHER[kind]);
    const inOther = other.custom.some((s) => safetyTextKey(s) === key);
    this.emitLists(
      kind,
      { ...list, custom: [...list.custom, text] },
      inOther
        ? { ...other, custom: other.custom.filter((s) => safetyTextKey(s) !== key) }
        : undefined,
    );
    control.setValue('');
  }

  protected removeCustom(kind: SafetyKind, index: number): void {
    const list = this.list(kind);
    this.emitLists(kind, { ...list, custom: list.custom.filter((_, i) => i !== index) });
  }

  private emitLists(kind: SafetyKind, list: SafetyList, other?: SafetyList): void {
    const change: SafetyChange = { [kind]: list };
    if (other) change[OTHER[kind]] = other;
    this.changed.emit(change);
  }
}

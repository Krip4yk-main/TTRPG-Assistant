import {
  ChangeDetectionStrategy,
  Component,
  computed,
  effect,
  inject,
  input,
  inputBinding,
  output,
  outputBinding,
  untracked,
  viewChild,
  ViewContainerRef,
} from '@angular/core';
import { FALLBACK_SLOTS } from './fallback/fallback-slots';
import { SLOT_OUTPUTS, type SlotName, type SlotOutputEvent } from './slots';
import { ThemeService } from './theme.service';

/**
 * Хост слоту: рендерить компонент чинного дизайну для `name` через
 * `ViewContainerRef.createComponent` з `inputBinding`/`outputBinding`. Поки слоти дизайну не
 * завантажились (або чанк не завантажився) — простий резервний компонент з `fallback/`.
 *
 * `[inputs]` — значення inputs слоту (реактивні: зміна значення не перестворює компонент);
 * outputs слоту (`SLOT_OUTPUTS`) приходять як `(output)` з `{ name, value }`.
 */
@Component({
  selector: 'nri-slot',
  templateUrl: './slot.html',
  styleUrl: './slot.less',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class Slot {
  private readonly theme = inject(ThemeService);
  private readonly outlet = viewChild.required('outlet', { read: ViewContainerRef });

  readonly name = input.required<SlotName>();
  readonly inputs = input<Record<string, unknown>>({});
  readonly output = output<SlotOutputEvent>();

  private readonly component = computed(
    () => this.theme.slots()?.[this.name()] ?? FALLBACK_SLOTS[this.name()],
  );
  /** Набір імен inputs: компонент перестворюється лише коли він змінюється. */
  private readonly inputNames = computed(() => Object.keys(this.inputs()).sort().join('|'), {
    equal: (a, b) => a === b,
  });

  constructor() {
    effect(() => {
      const type = this.component();
      const name = this.name();
      const names = this.inputNames();
      const outlet = this.outlet();
      untracked(() => {
        outlet.clear();
        outlet.createComponent(type, {
          bindings: [
            ...(names ? names.split('|') : []).map((key) =>
              inputBinding(key, () => this.inputs()[key]),
            ),
            ...SLOT_OUTPUTS[name].map((out) =>
              outputBinding(out, (value: unknown) => this.output.emit({ name: out, value })),
            ),
          ],
        });
      });
    });
  }
}

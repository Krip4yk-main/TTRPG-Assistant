/**
 * Помічники тестів для `mat-select` (список варіантів живе в оверлеї, а не в самому елементі).
 * `settle` — функція тесту, що прогонює виявлення змін і чекає стабільності.
 */

type Settle = () => Promise<void>;

/** Текст обраного варіанта в полі (порожній, якщо нічого не обрано). */
export function selectedText(select: HTMLElement): string {
  return select.querySelector('.mat-mdc-select-value-text')?.textContent?.trim() ?? '';
}

export function isSelectDisabled(select: HTMLElement): boolean {
  return select.getAttribute('aria-disabled') === 'true';
}

/** Відкриває список і повертає його варіанти (саме цього списку — за `aria-controls`). */
export async function openOptions(select: HTMLElement, settle: Settle): Promise<HTMLElement[]> {
  select.querySelector<HTMLElement>('.mat-mdc-select-trigger')!.click();
  await settle();
  const panel = document.getElementById(select.getAttribute('aria-controls')!)!;
  return [...panel.querySelectorAll<HTMLElement>('mat-option')];
}

export function optionText(option: HTMLElement): string {
  return option.textContent!.trim();
}

export function isOptionDisabled(option: HTMLElement): boolean {
  return option.getAttribute('aria-disabled') === 'true';
}

export function isOptionSelected(option: HTMLElement): boolean {
  return option.getAttribute('aria-selected') === 'true';
}

/** Відкриває список і обирає варіант за номером. */
export async function pickIndex(select: HTMLElement, index: number, settle: Settle): Promise<void> {
  const options = await openOptions(select, settle);
  options[index].click();
  await settle();
}

/** Відкриває список і обирає перший варіант, що містить `text`. */
export async function pickText(select: HTMLElement, text: string, settle: Settle): Promise<void> {
  const options = await openOptions(select, settle);
  const option = options.find((o) => optionText(o).includes(text));
  if (!option) throw new Error(`No option containing "${text}"`);
  option.click();
  await settle();
}

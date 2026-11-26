/**
 * Інтерактивні елементи всередині картки гри мають власну дію — клік по них не відкриває гру.
 * Елемент з власною дією може позначити себе атрибутом `data-card-interactive` — тоді клік
 * будь-де в ньому теж не відкриває гру (так обкладинка-вкладення `CoverAttachment` позначає
 * весь свій хост: і місце, звідки картинка виїхала наперед, а не лише кнопку). Нові дизайни
 * цей файл не змінюють. Посилання-назва з класом `open` — виняток: це та сама дія «відкрити
 * гру» (головна для клавіатури), її клік спливає до картки, і та переходить сама (рівно раз).
 */
const INTERACTIVE =
  'a, button, input, select, textarea, label, [role="button"], [data-card-interactive]';

/**
 * Чи має клік по картці гри відкрити гру (спільне правило дизайнів, де клікабельна вся
 * картка). Ні — середня кнопка, клік з модифікатором (звична поведінка посилання: нова
 * вкладка тощо), уже оброблений клік, клік по інтерактивному елементу (крім посилання-назви
 * `.open`) і — якщо `respectSelection` — завершення виділення тексту цієї картки.
 */
export function isCardOpenClick(
  event: MouseEvent,
  host: HTMLElement,
  { respectSelection }: { respectSelection: boolean },
): boolean {
  if (event.defaultPrevented || event.button !== 0) return false;
  if (event.ctrlKey || event.metaKey || event.shiftKey || event.altKey) return false;
  const interactive = (event.target as Element).closest(INTERACTIVE);
  if (interactive && !interactive.classList.contains('open')) return false;
  if (!interactive && respectSelection) {
    const sel = document.getSelection();
    if (sel?.toString() && sel.anchorNode && host.contains(sel.anchorNode)) return false;
  }
  return true;
}

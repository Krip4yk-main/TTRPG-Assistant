import { isCardOpenClick } from './card-click';

/** Спільне правило «клік по картці відкриває гру» (дизайни з клікабельною карткою). */
describe('isCardOpenClick', () => {
  let card: HTMLElement;

  beforeEach(() => {
    card = document.createElement('div');
    card.innerHTML = `
      <p class="body">Текст</p>
      <a class="open" href="/games/1">Назва</a>
      <a class="gm" href="/users/x">Майстер</a>
      <div class="marked" data-card-interactive><span class="inner">Вкладення</span></div>
    `;
    document.body.appendChild(card);
  });

  afterEach(() => card.remove());

  const ev = (target: Element, init: MouseEventInit = {}) => {
    const e = new MouseEvent('click', { bubbles: true, cancelable: true, button: 0, ...init });
    Object.defineProperty(e, 'target', { value: target });
    return e;
  };
  const opens = (sel: string, init?: MouseEventInit) =>
    isCardOpenClick(ev(card.querySelector(sel)!, init), card, { respectSelection: true });

  it('a plain click on the card body or on the title link opens the game', () => {
    expect(opens('.body')).toBe(true);
    expect(opens('a.open')).toBe(true);
  });

  it('other links, modifier and middle clicks do not', () => {
    expect(opens('a.gm')).toBe(false);
    expect(opens('.body', { ctrlKey: true })).toBe(false);
    expect(opens('.body', { button: 1 })).toBe(false);
  });

  it('any element marked data-card-interactive (and its content) does not open the game', () => {
    expect(opens('.marked')).toBe(false);
    expect(opens('.inner')).toBe(false);
  });
});

import { TestBed } from '@angular/core/testing';
import { TranslateService, provideTranslateService } from '@ngx-translate/core';
import { LinePipe } from './line.pipe';

describe('LinePipe', () => {
  it('translates keys, keeps texts and joins parts with « · »', () => {
    TestBed.configureTestingModule({ providers: [provideTranslateService({ lang: 'uk' })] });
    const t = TestBed.inject(TranslateService);
    t.setTranslation('uk', { games: { kind: { oneshot: 'Ваншот' } } });
    t.use('uk');
    const pipe = TestBed.runInInjectionContext(() => new LinePipe());
    expect(pipe.transform([{ text: 'GURPS' }, { key: 'games.kind.oneshot' }])).toBe(
      'GURPS · Ваншот',
    );
  });
});

import { Directive, input } from '@angular/core';
import { DeferBlockBehavior, DeferBlockState, TestBed } from '@angular/core/testing';
import { provideHttpClient } from '@angular/common/http';
import { provideHttpClientTesting } from '@angular/common/http/testing';
import { TranslateService, provideTranslateService } from '@ngx-translate/core';
import { App } from './app';
import { Slot } from './theming/slot';

/** Заглушка слоту (без шаблону): оболонка дизайну тут не потрібна. */
// eslint-disable-next-line @angular-eslint/directive-selector -- підміняє елемент <nri-slot>
@Directive({ selector: 'nri-slot' })
class StubSlot {
  readonly name = input<string>();
}

describe('App', () => {
  it('loads the env banner and the tester report in a deferred block (not on first paint)', async () => {
    TestBed.configureTestingModule({
      imports: [App],
      providers: [
        provideHttpClient(),
        provideHttpClientTesting(),
        provideTranslateService({ fallbackLang: 'uk' }),
      ],
      deferBlockBehavior: DeferBlockBehavior.Manual,
    });
    TestBed.overrideComponent(App, { remove: { imports: [Slot] }, add: { imports: [StubSlot] } });
    await TestBed.compileComponents();
    TestBed.inject(TranslateService).use('uk');
    const fixture = TestBed.createComponent(App);
    fixture.detectChanges();
    const el = fixture.nativeElement as HTMLElement;
    expect(el.querySelector('nri-slot')).not.toBeNull();
    expect(el.querySelector('nri-env-banner')).toBeNull();
    expect(el.querySelector('nri-tester-report')).toBeNull();

    const [block] = await fixture.getDeferBlocks();
    await block!.render(DeferBlockState.Complete);
    expect(el.querySelector('nri-env-banner')).not.toBeNull();
    expect(el.querySelector('nri-tester-report')).not.toBeNull();
  });
});

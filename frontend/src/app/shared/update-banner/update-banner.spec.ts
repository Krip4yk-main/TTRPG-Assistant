import { TestBed } from '@angular/core/testing';
import { provideTranslateService } from '@ngx-translate/core';
import { UpdateBanner } from './update-banner';

describe('UpdateBanner', () => {
  async function create(visible: boolean) {
    await TestBed.configureTestingModule({
      imports: [UpdateBanner],
      providers: [provideTranslateService()],
    }).compileComponents();
    const fixture = TestBed.createComponent(UpdateBanner);
    fixture.componentRef.setInput('visible', visible);
    fixture.detectChanges();
    return fixture;
  }

  it('keeps a polite live region even while hidden', async () => {
    const fixture = await create(false);
    const el = fixture.nativeElement as HTMLElement;
    expect(el.querySelector('[aria-live="polite"]')).not.toBeNull();
    expect(el.querySelector('.banner')).toBeNull();
  });

  it('shows the text and emits refresh on click; busy disables the button', async () => {
    const fixture = await create(true);
    const el = fixture.nativeElement as HTMLElement;
    const refresh = vi.fn();
    fixture.componentInstance.refresh.subscribe(refresh);
    expect(el.querySelector('.banner')!.textContent).toContain('live.updates');
    el.querySelector<HTMLButtonElement>('button.refresh')!.click();
    expect(refresh).toHaveBeenCalledOnce();
    fixture.componentRef.setInput('busy', true);
    fixture.detectChanges();
    expect(el.querySelector<HTMLButtonElement>('button.refresh')!.disabled).toBe(true);
  });
});

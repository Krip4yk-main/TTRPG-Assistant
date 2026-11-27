import { TestBed } from '@angular/core/testing';
import { TranslateService, provideTranslateService } from '@ngx-translate/core';
import uk from '../../../assets/i18n/uk.json';
import { EnvBanner } from './env-banner';

describe('EnvBanner', () => {
  async function create(env: string) {
    await TestBed.configureTestingModule({
      imports: [EnvBanner],
      providers: [provideTranslateService({ fallbackLang: 'uk' })],
    }).compileComponents();
    const translate = TestBed.inject(TranslateService);
    translate.setTranslation('uk', uk);
    translate.use('uk');
    const fixture = TestBed.createComponent(EnvBanner);
    fixture.componentRef.setInput('deployEnv', env);
    fixture.detectChanges();
    return fixture.nativeElement as HTMLElement;
  }

  it('shows a status banner on dev', async () => {
    const banner = (await create('dev')).querySelector('[role="status"]');
    expect(banner?.textContent).toContain('Тестове середовище');
  });

  it.each(['local', 'prod'])('renders nothing on %s', async (env) => {
    expect((await create(env)).querySelector('.env-banner')).toBeNull();
  });
});

import { computed, signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { Router, provideRouter, type Route, type Routes } from '@angular/router';
import type { MeDto, ViewMode } from '@nri/shared';
import { routes as appRoutes } from '../../app.routes';
import { AuthStore } from '../auth/auth.store';
import { ViewModeRouting, gmPage, playerPage } from './view-mode-routing';
import { ViewModeStore } from './view-mode.store';

class FakeAuth {
  private readonly state = signal<MeDto | null>(null);
  readonly me = this.state.asReadonly();
  readonly isActive = computed(() => this.state()?.status === 'active');
  setMe(user: MeDto | null): void {
    this.state.set(user);
  }
}

/** Незбережені зміни: сторінка не відпускає, поки `leave` не дозволить. */
let leave = true;

/** Сторінки без компонентів (`children: []`): перевіряємо лише маршрутизацію. */
const routes: Routes = [
  { path: '', children: [] },
  { path: 'my-games', children: [], data: gmPage('/my-applications') },
  { path: 'my-applications', children: [], data: playerPage('/my-games') },
  { path: 'games/new', children: [], data: gmPage(), canDeactivate: [() => leave] },
  { path: 'games/:id/applications', children: [], data: gmPage() },
  { path: 'games/:id', children: [] },
  { path: 'calendar', children: [] },
  {
    path: 'my-games/broken',
    children: [],
    data: gmPage(),
    resolve: {
      boom: () => {
        throw new Error('chunk failed');
      },
    },
  },
];

function setup(defaultView: ViewMode = 'player') {
  sessionStorage.clear();
  leave = true;
  TestBed.resetTestingModule();
  TestBed.configureTestingModule({
    providers: [provideRouter(routes), { provide: AuthStore, useClass: FakeAuth }],
  });
  TestBed.inject(AuthStore).setMe({ id: 1, status: 'active', defaultView } as unknown as MeDto);
  const routing = TestBed.inject(ViewModeRouting);
  return { routing, router: TestBed.inject(Router), store: TestBed.inject(ViewModeStore) };
}

describe('ViewModeRouting', () => {
  describe('перемикання виду', () => {
    it('на спільній сторінці — лише вид, без переходу', async () => {
      const { routing, router, store } = setup();
      await router.navigateByUrl('/games/7');
      await routing.switchTo('gm');
      expect(store.mode()).toBe('gm');
      expect(router.url).toBe('/games/7');
      await routing.switchTo('player');
      expect(store.mode()).toBe('player');
      expect(router.url).toBe('/games/7');
    });

    it('«Мої ігри» → вид гравця: перехід на відповідник «Мої заявки»', async () => {
      const { routing, router, store } = setup('gm');
      await router.navigateByUrl('/my-games');
      await routing.switchTo('player');
      expect(router.url).toBe('/my-applications');
      expect(store.mode()).toBe('player');
    });

    it('«Мої заявки» → вид майстра: перехід на «Мої ігри»', async () => {
      const { routing, router, store } = setup();
      await router.navigateByUrl('/my-applications');
      await routing.switchTo('gm');
      expect(router.url).toBe('/my-games');
      expect(store.mode()).toBe('gm');
    });

    it('сторінка майстра без відповідника → головна у виді гравця', async () => {
      const { routing, router, store } = setup('gm');
      await router.navigateByUrl('/games/7/applications');
      await routing.switchTo('player');
      expect(router.url).toBe('/');
      expect(store.mode()).toBe('player');
    });

    it('незбережені зміни (guard не відпускає) — лишаємося на сторінці й у тому ж виді', async () => {
      const { routing, router, store } = setup('gm');
      await router.navigateByUrl('/games/new');
      leave = false;
      expect(await routing.switchTo('player')).toBe(false);
      expect(router.url).toBe('/games/new');
      expect(store.mode()).toBe('gm');
      leave = true;
      expect(await routing.switchTo('player')).toBe(true);
      expect(router.url).toBe('/');
      expect(store.mode()).toBe('player');
    });
  });

  describe('пряме посилання на сторінку іншого виду', () => {
    it('сторінка майстра у виді гравця → вид майстра, сторінка відкривається', async () => {
      const { router, store } = setup();
      expect(store.mode()).toBe('player');
      await router.navigateByUrl('/games/7/applications');
      expect(router.url).toBe('/games/7/applications');
      expect(store.mode()).toBe('gm');
    });

    it('сторінка гравця у виді майстра → вид гравця', async () => {
      const { router, store } = setup('gm');
      await router.navigateByUrl('/my-applications');
      expect(router.url).toBe('/my-applications');
      expect(store.mode()).toBe('player');
    });

    it('спільна сторінка вид не змінює', async () => {
      const { router, store } = setup('gm');
      await router.navigateByUrl('/calendar');
      await router.navigateByUrl('/games/7');
      expect(store.mode()).toBe('gm');
    });

    it('навігація, яку скасував guard, вид не змінює', async () => {
      const { router, store } = setup('gm');
      await router.navigateByUrl('/games/new');
      leave = false;
      await router.navigateByUrl('/my-applications');
      expect(router.url).toBe('/games/new');
      expect(store.mode()).toBe('gm');
    });
  });

  describe('вид застосовується лише після успішної навігації', () => {
    it('збій навігації (помилка резолвера) вид не змінює', async () => {
      const { router, store } = setup();
      await router.navigateByUrl('/calendar');
      await router.navigateByUrl('/my-games/broken').catch(() => undefined);
      expect(store.mode()).toBe('player');
    });

    it('навігація, витіснена іншою, вид не змінює — застосовується вид останньої', async () => {
      const { router, store } = setup();
      const first = router.navigateByUrl('/my-games');
      const second = router.navigateByUrl('/calendar');
      await Promise.all([first, second]);
      expect(router.url).toBe('/calendar');
      expect(store.mode()).toBe('player');
    });
  });

  it('маршрути застосунку позначені видом', () => {
    const find = (path: string): Route | undefined => appRoutes.find((r) => r.path === path);
    const gm = ['my-games', 'games/new', 'games/:id/edit', 'games/:id/applications'];
    for (const path of gm) expect(find(path)?.data?.['view'], path).toBe('gm');
    expect(find('my-applications')?.data?.['view']).toBe('player');
    expect(find('my-games')?.data?.['viewCounterpart']).toBe('/my-applications');
    expect(find('my-applications')?.data?.['viewCounterpart']).toBe('/my-games');
    for (const path of ['', 'games/:id', 'calendar', 'account', 'games/:id/rate']) {
      expect(find(path)?.data?.['view'], path).toBeUndefined();
    }
  });
});

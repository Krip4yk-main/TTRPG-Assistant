import { computed, signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { Router, provideRouter, type Routes } from '@angular/router';
import type { MeDto } from '@nri/shared';
import { AuthStore } from '../../core/auth/auth.store';
import { gmPage } from '../../core/view-mode/view-mode-routing';
import { ShellController } from './shell-controller';

class FakeAuth {
  private readonly state = signal<MeDto | null>({
    id: 1,
    status: 'active',
    defaultView: 'gm',
  } as unknown as MeDto);
  readonly me = this.state.asReadonly();
  readonly isActive = computed(() => this.state()?.status === 'active');
}

let leave = true;

const routes: Routes = [
  { path: '', children: [] },
  {
    path: 'broken',
    children: [],
    resolve: {
      boom: () => {
        throw new Error('chunk load failed');
      },
    },
  },
  { path: 'games/edit', children: [], data: gmPage('/broken') },
  { path: 'games/new', children: [], data: gmPage(), canDeactivate: [() => leave] },
];

describe('ShellController.setMode', () => {
  beforeEach(() => {
    sessionStorage.clear();
    leave = true;
    TestBed.resetTestingModule();
    TestBed.configureTestingModule({
      providers: [provideRouter(routes), { provide: AuthStore, useClass: FakeAuth }],
    });
  });

  it('скасований перехід повертає перемикач до справжнього виду', async () => {
    const shell = TestBed.inject(ShellController);
    await TestBed.inject(Router).navigateByUrl('/games/new');
    const toggle = { value: 'gm' as unknown };
    leave = false;
    toggle.value = 'player'; // користувач клацнув «Вид гравця»
    await shell.setMode('player', toggle);
    expect(shell.viewMode.mode()).toBe('gm');
    expect(toggle.value).toBe('gm');
  });

  it('успішний перехід перемикач не чіпає', async () => {
    const shell = TestBed.inject(ShellController);
    await TestBed.inject(Router).navigateByUrl('/games/new');
    const toggle = { value: 'player' as unknown };
    await shell.setMode('player', toggle);
    expect(shell.viewMode.mode()).toBe('player');
    expect(toggle.value).toBe('player');
  });

  it('збій навігації (NavigationError) не лишає перемикач хибним і не кидає виняток', async () => {
    const shell = TestBed.inject(ShellController);
    await TestBed.inject(Router).navigateByUrl('/games/edit');
    const toggle = { value: 'player' as unknown };
    await expect(shell.setMode('player', toggle)).resolves.toBeUndefined();
    expect(shell.viewMode.mode()).toBe('gm');
    expect(toggle.value).toBe('gm');
  });
});

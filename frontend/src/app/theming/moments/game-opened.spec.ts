import { TestBed } from '@angular/core/testing';
import { Router, provideRouter } from '@angular/router';
import { GameOpenedMoment } from './game-opened';

describe('GameOpenedMoment', () => {
  let moment: GameOpenedMoment;
  let router: Router;
  /** Що забрала б сторінка гри, створена під час переходу. */
  let taken: (number | null)[];

  beforeEach(() => {
    taken = [];
    TestBed.configureTestingModule({
      providers: [
        provideRouter([
          { path: '', children: [] },
          {
            path: 'games/:id',
            children: [],
            // Сторінка гри забирає позначку під час активації (як конструктор GameDetails).
            resolve: { _: () => taken.push(TestBed.inject(GameOpenedMoment).take()) },
          },
          { path: 'blocked', children: [], canActivate: [() => false] },
        ]),
      ],
    });
    moment = TestBed.inject(GameOpenedMoment);
    router = TestBed.inject(Router);
  });

  it('без позначки картки — null (пряма адреса, оновлення)', async () => {
    await router.navigateByUrl('/games/7');
    expect(taken).toEqual([null]);
  });

  it('позначка картки доходить до сторінки гри рівно раз', async () => {
    moment.fromCard(7);
    await router.navigateByUrl('/games/7');
    expect(taken).toEqual([7]);
    await router.navigateByUrl('/');
    await router.navigateByUrl('/games/7');
    expect(taken).toEqual([7, null]);
  });

  it('скасований перехід (guard) знімає позначку', async () => {
    moment.fromCard(7);
    await router.navigateByUrl('/blocked');
    expect(moment.take()).toBeNull();
  });

  it('завершений інший перехід знімає позначку', async () => {
    moment.fromCard(7);
    await router.navigateByUrl('/');
    expect(moment.take()).toBeNull();
  });
});

import { HttpClient } from '@angular/common/http';
import { Injectable, inject, signal } from '@angular/core';
import { firstValueFrom } from 'rxjs';
import type { CatalogDto } from '@nri/shared';

/** Каталог систем, жанрів і попереджень. Завантажується один раз за сесію застосунку. */
@Injectable({ providedIn: 'root' })
export class CatalogStore {
  private readonly http = inject(HttpClient);
  private readonly state = signal<CatalogDto | null>(null);
  private loading: Promise<void> | null = null;

  readonly catalog = this.state.asReadonly();

  load(): Promise<void> {
    if (this.state()) return Promise.resolve();
    this.loading ??= firstValueFrom(this.http.get<CatalogDto>('/api/catalog'))
      .then((dto) => {
        this.state.set(dto);
      })
      .finally(() => {
        this.loading = null;
      });
    return this.loading;
  }

  systemName(id: number): string | null {
    return this.state()?.systems.find((s) => s.id === id)?.name ?? null;
  }

  /** Ключ перекладу жанру (`genres.<slug>`). */
  genreKey(id: number): string | null {
    const g = this.state()?.genres.find((x) => x.id === id);
    return g ? `genres.${g.slug}` : null;
  }
}

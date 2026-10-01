import { Injectable, signal } from '@angular/core';

@Injectable({ providedIn: 'root' })
export class RandomizerService {
  private readonly itemsSignal = signal<string[]>([]);
  private readonly historySignal = signal<string[]>([]);

  readonly items = this.itemsSignal.asReadonly();
  readonly history = this.historySignal.asReadonly();

  setItems(items: string[]): void {
    this.itemsSignal.set(items);
    this.historySignal.set([]);
  }

  /** Chooses a winner without recording it — call commit() when the wheel stops. */
  chooseWinner(excludeLast: boolean): string | null {
    const items = this.itemsSignal();
    if (items.length === 0) return null;

    let pool = items;
    if (excludeLast && items.length > 1) {
      const last = this.historySignal()[0];
      pool = last ? items.filter(i => i !== last) : items;
      if (pool.length === 0) pool = items;
    }
    return pool[Math.floor(Math.random() * pool.length)];
  }

  commit(picked: string): void {
    this.historySignal.update(h => [picked, ...h].slice(0, 50));
  }

  resetHistory(): void {
    this.historySignal.set([]);
  }
}
import { Injectable, signal } from '@angular/core';

const QUEUE_SIZE = 2;                      // "up next" block
const TAPE_SIZE = 2;                       // "last" block — recent displayed values
const HISTORY_LIMIT = 50;
const STORE_PREFIX = 'randomizer:rolls:';

export interface RollSnapshot {
  lastShown: string | null;
  lastShownFinal: boolean;
  tape: string[];
  history: string[];
  queue: string[];
}

@Injectable({ providedIn: 'root' })
export class RandomizerService {
  private readonly itemsSignal = signal<string[]>([]);
  private readonly historySignal = signal<string[]>([]);
  private readonly queueSignal = signal<string[]>([]);
  private readonly tapeSignal = signal<string[]>([]);

  private lastShown: string | null = null;
  private lastShownFinal = false;
  private platformId: string | null = null;
  private spinExcludeLast = false;

  readonly items = this.itemsSignal.asReadonly();
  readonly history = this.historySignal.asReadonly();
  readonly queue = this.queueSignal.asReadonly();
  /** Values shown right before the current one — feeds the "last" carousel block. */
  readonly tape = this.tapeSignal.asReadonly();

  // ---------- items ----------
  setItems(items: string[], excludeLast = false): void {
    this.itemsSignal.set(items);
    const alive = new Set(items);
    this.historySignal.update(h => h.filter(i => alive.has(i)));
    this.queueSignal.update(q => q.filter(i => alive.has(i)));
    this.tapeSignal.update(t => t.filter(i => alive.has(i)));
    if (this.lastShown && !alive.has(this.lastShown)) {
      this.lastShown = null;
      this.lastShownFinal = false;
    }
    this.fillQueue(excludeLast);
    this.save();
  }

  // ---------- spin lifecycle ----------
  /** Fixes the final winner (queue head, validated against excludeLast). No mutation. */
  beginSpin(excludeLast: boolean): string | null {
    const items = this.itemsSignal();
    if (items.length === 0) return null;
    this.spinExcludeLast = excludeLast;

    let winner = this.queueSignal()[0] ?? this.rand([]);
    if (!winner) return null;

    const last = this.historySignal()[0] ?? null;
    if (excludeLast && items.length > 1 && winner === last) {
      winner = this.rand([last]) ?? winner;
    }
    return winner;
  }

  /**
   * Called on EVERY roll tick with the currently displayed value.
   * Slides the previous value into the "last" block tape and persists —
   * so even a non-final (interrupted) roll result ends up stored.
   */
  recordTick(value: string): void {
    const prev = this.lastShown;
    if (prev !== null && prev !== value) {
      this.tapeSignal.update(t => [prev, ...t].slice(0, TAPE_SIZE));
    }
    this.lastShown = value;
    this.lastShownFinal = false;
    this.save();
  }

  /** Wheel stopped: the current (last shown) value becomes the final result. */
  commit(): void {
    const winner = this.lastShown;
    if (!winner) return;
    this.lastShownFinal = true;
    this.historySignal.update(h => [winner, ...h].slice(0, HISTORY_LIMIT));
    this.queueSignal.update(q => q.filter(i => i !== winner));
    this.fillQueue(this.spinExcludeLast);
    this.save();
  }

  /** Spin interrupted — ticks are already stored; just reset the spin flag. */
  cancelSpin(): void {
    this.spinExcludeLast = false;
  }

  resetHistory(excludeLast = false): void {
    this.lastShown = null;
    this.lastShownFinal = false;
    this.historySignal.set([]);
    this.queueSignal.set([]);
    this.tapeSignal.set([]);
    this.fillQueue(excludeLast);
    this.save();
  }

  refreshQueue(excludeLast: boolean): void {
    this.queueSignal.set([]);
    this.fillQueue(excludeLast);
    this.save();
  }

  // ---------- persistence ----------
  restore(platformId: string, excludeLast = false): RollSnapshot | null {
    this.platformId = platformId;
    try {
      const raw = localStorage.getItem(STORE_PREFIX + platformId);
      const alive = new Set(this.itemsSignal());
      const snap = raw ? (JSON.parse(raw) as Partial<RollSnapshot>) : null;

      this.historySignal.set((snap?.history ?? []).filter(i => alive.has(i)));
      this.queueSignal.set((snap?.queue ?? []).filter(i => alive.has(i)));
      this.tapeSignal.set((snap?.tape ?? []).filter(i => alive.has(i)).slice(0, TAPE_SIZE));
      this.lastShown = snap?.lastShown && alive.has(snap.lastShown) ? snap.lastShown : null;
      this.lastShownFinal = snap?.lastShownFinal ?? false;

      this.fillQueue(excludeLast);
      this.save();
      return {
        lastShown: this.lastShown,
        lastShownFinal: this.lastShownFinal,
        tape: this.tapeSignal(),
        history: this.historySignal(),
        queue: this.queueSignal()
      };
    } catch {
      this.fillQueue(excludeLast);
      return null;
    }
  }

  private save(): void {
    if (!this.platformId) return;
    const snap = {
      lastShown: this.lastShown,
      lastShownFinal: this.lastShownFinal,
      tape: this.tapeSignal(),
      history: this.historySignal().slice(0, 10),
      queue: this.queueSignal()
    };
    try { localStorage.setItem(STORE_PREFIX + this.platformId, JSON.stringify(snap)); }
    catch { /* storage unavailable — session-only mode */ }
  }

  // ---------- internals ----------
  private rand(exclude: string[]): string | null {
    const items = this.itemsSignal();
    const pool = items.filter(i => !exclude.includes(i));
    const source = pool.length ? pool : items;   // tiny lists: allow repeats
    return source.length ? source[Math.floor(Math.random() * source.length)] : null;
  }

  private fillQueue(excludeLast: boolean): void {
    const queue = [...this.queueSignal()];
    while (queue.length < QUEUE_SIZE) {
      const exclude = [...queue];
      if (excludeLast && queue.length === 0) {
        const last = this.historySignal()[0];
        if (last) exclude.push(last);
      }
      const item = this.rand(exclude);
      if (!item || queue.includes(item)) break;
      queue.push(item);
    }
    this.queueSignal.set(queue);
  }
}
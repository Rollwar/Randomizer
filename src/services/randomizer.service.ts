import { Injectable, signal } from '@angular/core';

const QUEUE_SIZE = 2;                      // "up next" block
const TAPE_SIZE = 2;                       // "last" block — recent displayed values
const HISTORY_LIMIT = 50;
const STORE_PREFIX = 'randomizer:rolls:';  // offline cache, + platformId

export interface RollSnapshot {
  lastShown: string | null;     // center value: final winner OR interrupted tick
  lastShownFinal: boolean;      // false = spin was interrupted (non-final)
  tape: string[];               // values shown right before the center (recent first)
  history: string[];            // final winners only
  queue: string[];              // upcoming picks
}

/** Fire-and-forget sink: the component debounces these into PUT /api/rolls. */
type PersistSink = (platformId: string, snapshot: RollSnapshot) => void;

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
  private persistSink: PersistSink | null = null;

  readonly items = this.itemsSignal.asReadonly();
  readonly history = this.historySignal.asReadonly();
  readonly queue = this.queueSignal.asReadonly();
  /** Values shown right before the current one — feeds the "last" carousel block. */
  readonly tape = this.tapeSignal.asReadonly();

  /** Component wires this to the server API (debounced). */
  setPersistSink(fn: PersistSink | null): void {
    this.persistSink = fn;
  }

  // ---------- items ----------
  /**
   * Replaces the item list. persist=false during initial load:
   * the snapshot that follows (server or cache) takes care of saving.
   */
  setItems(items: string[], excludeLast = false, persist = true): void {
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
    if (persist) this.save();
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
   * Slides the previous value into the "last" tape and persists —
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

  /** Spin interrupted — ticks are already stored; just reset the spin rule. */
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

  /** Regenerates the visible queue (rule changed / carousel re-enabled). */
  refreshQueue(excludeLast: boolean): void {
    this.queueSignal.set([]);
    this.fillQueue(excludeLast);
    this.save();
  }

  // ---------- persistence ----------
  /**
   * Attaches to a platform. Server snapshot wins; localStorage is the
   * fallback when the server has none (offline / first run).
   */
  loadSnapshot(
    platformId: string,
    serverSnapshot: RollSnapshot | null | undefined,
    excludeLast = false
  ): RollSnapshot | null {
    this.platformId = platformId;
    if (serverSnapshot) {
      this.applySnapshot(serverSnapshot);
      this.fillQueue(excludeLast);
      this.save();   // sync the offline cache with the adopted state
      return this.currentSnapshot();
    }
    return this.restore(platformId, excludeLast);
  }

  /** Offline fallback: read the localStorage cache. */
  restore(platformId: string, excludeLast = false): RollSnapshot | null {
    this.platformId = platformId;
    try {
      const raw = localStorage.getItem(STORE_PREFIX + platformId);
      const snap = raw ? (JSON.parse(raw) as Partial<RollSnapshot>) : null;
      this.applySnapshot(snap ?? {});
      this.fillQueue(excludeLast);
      this.save();
      return this.currentSnapshot();
    } catch {
      this.fillQueue(excludeLast);
      return null;
    }
  }

  private applySnapshot(snap: Partial<RollSnapshot>): void {
    const alive = new Set(this.itemsSignal());
    this.historySignal.set((snap.history ?? []).filter(i => alive.has(i)));
    this.queueSignal.set((snap.queue ?? []).filter(i => alive.has(i)));
    this.tapeSignal.set((snap.tape ?? []).filter(i => alive.has(i)).slice(0, TAPE_SIZE));
    this.lastShown = snap.lastShown && alive.has(snap.lastShown) ? snap.lastShown : null;
    this.lastShownFinal = snap.lastShownFinal ?? false;
  }

  private currentSnapshot(): RollSnapshot {
    return {
      lastShown: this.lastShown,
      lastShownFinal: this.lastShownFinal,
      tape: this.tapeSignal(),
      history: this.historySignal(),
      queue: this.queueSignal()
    };
  }

  private save(): void {
    const snap: RollSnapshot = {
      lastShown: this.lastShown,
      lastShownFinal: this.lastShownFinal,
      tape: this.tapeSignal(),
      history: this.historySignal().slice(0, 10),
      queue: this.queueSignal()
    };

    if (!this.platformId) return;

    // 1) offline cache — every tick (cheap)
    try { localStorage.setItem(STORE_PREFIX + this.platformId, JSON.stringify(snap)); }
    catch { /* storage unavailable */ }

    // 2) server mirror — the sink (component debounces HTTP)
    this.persistSink?.(this.platformId, snap);
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
      if (!item || queue.includes(item)) break;  // tiny list guard
      queue.push(item);
    }
    this.queueSignal.set(queue);
  }
}
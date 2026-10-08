import { Component, OnDestroy, OnInit, computed, inject, signal } from '@angular/core';
import { CommonModule } from '@angular/common';
import { GameApiService } from '../services/game-api.service';
import { RandomizerService, RollSnapshot } from '../services/randomizer.service';
import { AudioService } from '../services/audio.service';
import { AssetsManifest, GamePlatform, StorageFormat } from './models';

// ---------- Electron bridge ----------
interface ElectronAppInfo {
  name: string;
  version: string;
  electron: string;
  author?: string;
}

interface RandomizerBridge {
  isDesktop: boolean;
  openRouletteFolder(): Promise<string>;
  openPlatformsFolder(): Promise<string>;
  /** Optional: requires the 'app:info' handler from the author-metadata step. */
  getAppInfo?(): Promise<ElectronAppInfo>;
  minimize(): void;
  toggleMaximize(): void;
  close(): void;
}

declare global {
  interface Window { randomizer?: RandomizerBridge; }
}

// ---------- local types / constants ----------
type SectionId = 'assets' | 'editor' | 'history' | 'sound' | 'theme';
type Theme = 'default' | 'green' | 'purple';

const ACCORDION_KEY = 'randomizer:accordion';
const CAROUSEL_KEY = 'randomizer:carousel';
const THEME_KEY = 'randomizer:theme';

function readAccordionState(): Record<SectionId, boolean> {
  const defaults: Record<SectionId, boolean> = {
    assets: false, editor: true, history: false, sound: false, theme: false
  };
  try {
    const raw = localStorage.getItem(ACCORDION_KEY);
    return raw ? { ...defaults, ...JSON.parse(raw) } : defaults;
  } catch { return defaults; }
}

function readCarouselPref(): boolean {
  try { return localStorage.getItem(CAROUSEL_KEY) !== '0'; } catch { return true; }
}

function readThemePref(): Theme {
  try {
    const t = localStorage.getItem(THEME_KEY);
    return t === 'green' || t === 'purple' ? t : 'default';
  } catch { return 'default'; }
}

@Component({
  selector: 'app-root',
  standalone: true,
  imports: [CommonModule],
  templateUrl: './app.component.html',
  styleUrls: ['./app.component.css']
})
export class AppComponent implements OnInit, OnDestroy {
  // ---------- deps ----------
  private readonly api = inject(GameApiService);
  private readonly randomizer = inject(RandomizerService);
  readonly audio = inject(AudioService);

  // ---------- internal timers / guards ----------
  private spinTimeout: ReturnType<typeof setTimeout> | null = null;
  private loadSeq = 0;
  private unsubEvents: (() => void) | null = null;
  private rollsSaveTimer: ReturnType<typeof setTimeout> | null = null;
  private pendingRolls: { id: string; snap: RollSnapshot } | null = null;
  private readonly flushRollsOnUnload = () => this.flushRollsSave();

  // ---------- backend state ----------
  readonly platforms = signal<GamePlatform[]>([]);
  readonly selectedPlatform = signal<string | null>(null);
  readonly storageFormat = signal<StorageFormat>('json');

  // ---------- roulette assets ----------
  readonly assets = signal<AssetsManifest | null>(null);
  readonly bgFile = signal<string | null>(null);

  // ---------- ui state ----------
  readonly newItem = signal('');
  readonly result = signal<string | null>(null);
  readonly isSpinning = signal(false);
  readonly excludeLast = signal(false);
  readonly loading = signal(false);
  readonly saving = signal(false);
  readonly dirty = signal(false);
  readonly savedAt = signal<string | null>(null);
  readonly error = signal<string | null>(null);
  readonly serverUpdated = signal(false);

  // ---------- spin settings: 1 s … 2 min ----------
  readonly spinMinMs = 1000;
  readonly spinMaxMs = 120000;
  readonly spinDurationMs = signal(5000);

  // ---------- carousel ----------
  readonly carouselEnabled = signal(readCarouselPref());
  readonly spinPreview = signal<string[] | null>(null); // flicker during spin

  // ---------- theme ----------
  readonly themes: Theme[] = ['default', 'green', 'purple'];
  readonly theme = signal<Theme>(readThemePref());

  // ---------- accordions (persisted) ----------
  readonly expanded = signal<Record<SectionId, boolean>>(readAccordionState());

  // ---------- optional app info (Electron About) ----------
  readonly appInfo = signal<ElectronAppInfo | null>(null);

  // ---------- derived from services ----------
  readonly items = this.randomizer.items;
  readonly history = this.randomizer.history;
  readonly volume = this.audio.volume;

  readonly isDesktop = typeof window !== 'undefined' && !!window.randomizer?.isDesktop;

  readonly currentPlatform = computed(
    () => this.platforms().find(p => p.id === this.selectedPlatform()) ?? null
  );
  readonly selectedPlatformIndex = computed(() =>
    this.platforms().findIndex(p => p.id === this.selectedPlatform())
  );
  readonly selectedIcon = computed(() => this.iconFor(this.selectedPlatformIndex()));
  readonly canPick = computed(
    () => this.items().length > 0 && !this.isSpinning() && !this.loading()
  );

  // carousel slots: [2nd last, last] … [next 1, next 2]
  readonly prevSlots = computed<string[]>(() =>
    this.carouselEnabled() ? [...this.randomizer.tape()].reverse() : []
  );
  readonly nextSlots = computed<string[]>(() => {
    if (!this.carouselEnabled()) return [];
    const source = (this.isSpinning() ? this.spinPreview() : null) ?? this.randomizer.queue();
    return source.filter((x): x is string => !!x).slice(0, 2);
  });

  // ---------- asset summaries ----------
  readonly assetsSummary = computed(() => {
    const a = this.assets();
    if (!a) return 'not scanned';
    const plat = a.platformCount ?? this.platforms().length;
    return `${a.music.length} music · ${a.stopSound ? 'stop ✓' : 'no stop'} · ${a.icons.length} icons · ${a.backgrounds.length} bg · ${plat} platforms`;
  });
  readonly musicCount = computed(() => this.assets()?.music.length ?? 0);
  readonly iconCount = computed(() => this.assets()?.icons.length ?? 0);
  readonly bgCount = computed(() => this.assets()?.backgrounds.length ?? 0);
  readonly hasStopSound = computed(() => this.assets()?.stopSound != null);
  readonly musicMeta = computed(() => {
    const n = this.musicCount();
    return n ? ` · ${n} tracks` : '';
  });

  readonly resultBackground = computed(() => {
    const file = this.bgFile();
    return file
      ? `linear-gradient(var(--overlay), var(--overlay)), url('/roulette/${encodeURIComponent(file)}')`
      : null;
  });

  // ================= lifecycle =================
  ngOnInit(): void {
    this.applyTheme(this.theme());

    this.api.getPlatforms().subscribe({
      next: platforms => {
        this.platforms.set(platforms);
        if (platforms.length) this.selectPlatform(platforms[0].id);
      },
      error: () => this.error.set('Backend is not reachable. Run "npm run server" first.')
    });

    this.loadAssets();

    this.unsubEvents = this.api.onServerEvents({
      platforms: () => this.refreshPlatforms(),
      list: id => this.onServerListChanged(id)
    });

    // server values win over the early-applied localStorage ones
    this.api.getSettings().subscribe({
      next: s => {
        const t = s?.theme;
        if ((t === 'default' || t === 'green' || t === 'purple') && t !== this.theme()) {
          this.setTheme(t, { persist: false });
        }
        const v = s?.volume;
        if (typeof v === 'number' && v >= 0 && v <= 100 && v !== this.audio.volume()) {
          this.audio.setVolume(v);
        }
      },
      error: () => { /* backend down — localStorage values already active */ }
    });

    // roll-state persistence: service -> debounced PUT /api/rolls
    this.randomizer.setPersistSink((id, snap) => this.queueRollsSave(id, snap));
    window.addEventListener('beforeunload', this.flushRollsOnUnload);

    // optional (requires the preload handler from the author step)
    window.randomizer?.getAppInfo?.()
      .then(info => this.appInfo.set(info))
      .catch(() => { /* not exposed — fine */ });
  }

  ngOnDestroy(): void {
    window.removeEventListener('beforeunload', this.flushRollsOnUnload);
    this.flushRollsSave();
    this.stopSpin();
    this.unsubEvents?.();
  }

  // ================= window controls (Electron title bar) =================
  minimizeWindow(): void { window.randomizer?.minimize(); }
  toggleMaximizeWindow(): void { window.randomizer?.toggleMaximize(); }
  closeWindow(): void { window.randomizer?.close(); }

  // ================= accordions =================
  isExpanded(section: SectionId): boolean {
    return !!this.expanded()[section];
  }

  toggleSection(section: SectionId): void {
    this.expanded.update(map => {
      const next = { ...map, [section]: !map[section] };
      try { localStorage.setItem(ACCORDION_KEY, JSON.stringify(next)); } catch { /* private mode */ }
      return next;
    });
  }

  // ================= theme =================
  setTheme(t: Theme, opts: { persist?: boolean } = {}): void {
    const persist = opts.persist ?? true;
    this.theme.set(t);
    try { localStorage.setItem(THEME_KEY, t); } catch { /* private mode */ }
    this.applyTheme(t);
    if (persist) {
      this.api.saveSettings({ theme: t }).subscribe({ error: () => { /* offline — cache holds it */ } });
    }
  }

  private applyTheme(t: Theme): void {
    document.documentElement.setAttribute('data-theme', t);
  }

  // ================= roulette assets =================
  loadAssets(): void {
    this.api.getAssets().subscribe({
      next: manifest => {
        this.assets.set(manifest);
        this.rotateBackground();
      },
      error: () => { /* error banner already shown by the platforms call */ }
    });
  }

  /** RuletIco1 → first platform, RuletIco2 → second, … */
  iconFor(index: number): string | null {
    const icons = this.assets()?.icons ?? [];
    return icons[index] ? `/roulette/${encodeURIComponent(icons[index])}` : null;
  }

  private rotateBackground(): void {
    const backgrounds = this.assets()?.backgrounds ?? [];
    this.bgFile.set(backgrounds.length
      ? backgrounds[Math.floor(Math.random() * backgrounds.length)]
      : null);
  }

  openRouletteFolder(): void {
    void window.randomizer?.openRouletteFolder();
  }

  openPlatformsFolder(): void {
    void window.randomizer?.openPlatformsFolder();
  }

  // ================= platform / list =================
  selectPlatform(id: string): void {
    if (this.selectedPlatform() === id) return;
    this.flushRollsSave();          // push pending state of the OLD platform first
    this.stopSpin();                // abort any running spin (pending result discarded)
    this.selectedPlatform.set(id);
    this.result.set(null);
    this.rotateBackground();
    this.loadList();
  }

  reload(): void {
    this.serverUpdated.set(false);
    this.loadList();
  }

  private loadList(): void {
    const id = this.selectedPlatform();
    if (!id) return;

    const seq = ++this.loadSeq;
    this.loading.set(true);
    this.error.set(null);
    this.dirty.set(false);
    this.savedAt.set(null);

    this.api.getList(id, this.storageFormat()).subscribe({
      next: list => {
        if (seq !== this.loadSeq) return; // stale response
        // persist=false: the snapshot below takes over saving
        this.randomizer.setItems(list.items, this.excludeLast(), false);
        this.api.getRolls(id).subscribe({
          next: serverSnap => {
            if (seq !== this.loadSeq) return;
            const snap = this.randomizer.loadSnapshot(id, serverSnap, this.excludeLast());
            this.result.set(snap?.lastShown ?? null);
            this.loading.set(false);
          },
          error: () => {
            if (seq !== this.loadSeq) return;
            const snap = this.randomizer.restore(id, this.excludeLast());
            this.result.set(snap?.lastShown ?? null);
            this.loading.set(false);
          }
        });
      },
      error: () => {
        if (seq !== this.loadSeq) return;
        this.error.set('Failed to load the list from the backend.');
        this.loading.set(false);
      }
    });
  }

  setFormat(format: StorageFormat): void {
    this.storageFormat.set(format);
  }

  save(): void {
    const id = this.selectedPlatform();
    if (!id || this.saving()) return;

    this.saving.set(true);
    this.error.set(null);

    this.api.saveList(id, this.items(), this.storageFormat()).subscribe({
      next: () => {
        this.saving.set(false);
        this.dirty.set(false);
        this.savedAt.set(new Date().toLocaleTimeString());
      },
      error: () => {
        this.saving.set(false);
        this.error.set('Failed to save the list.');
      }
    });
  }

  // ================= SSE =================
  private refreshPlatforms(): void {
    this.api.getPlatforms().subscribe(platforms => {
      this.platforms.set(platforms);
      if (!platforms.length) { this.selectedPlatform.set(null); return; }
      const stillThere = platforms.some(p => p.id === this.selectedPlatform());
      if (!stillThere) this.selectPlatform(platforms[0].id);
    });
  }

  private onServerListChanged(id: string): void {
    if (id !== this.selectedPlatform()) return;
    if (this.dirty() || this.isSpinning()) {
      this.serverUpdated.set(true);   // don't clobber unsaved edits / an ongoing spin
    } else {
      this.loadList();
    }
  }

  // ================= roll-state persistence =================
  private queueRollsSave(id: string, snap: RollSnapshot): void {
    this.pendingRolls = { id, snap };
    if (this.rollsSaveTimer) return;            // one timer, latest snapshot wins
    this.rollsSaveTimer = setTimeout(() => {
      this.rollsSaveTimer = null;
      const p = this.pendingRolls;
      this.pendingRolls = null;
      if (p) this.api.saveRolls(p.id, p.snap).subscribe({ error: () => { /* offline — cache holds it */ } });
    }, 500);
  }

  private flushRollsSave(): void {
    if (this.rollsSaveTimer) { clearTimeout(this.rollsSaveTimer); this.rollsSaveTimer = null; }
    const p = this.pendingRolls;
    this.pendingRolls = null;
    if (p) this.api.saveRolls(p.id, p.snap).subscribe({ error: () => { /* ignore */ } });
  }

  // ================= spin settings =================
  onDurationInput(event: Event): void {
    this.spinDurationMs.set(Number((event.target as HTMLInputElement).value));
  }

  onVolumeInput(event: Event): void {
    const v = Number((event.target as HTMLInputElement).value);
    this.audio.setVolume(v);
    this.api.saveSettings({ volume: v }).subscribe({ error: () => { /* offline — cache holds it */ } });
  }

  testStopSound(): void {
    this.audio.playEndSound(this.assets()?.stopSound ?? null);
  }

  formatDuration(ms: number): string {
    const totalSec = Math.round(ms / 1000);
    if (totalSec >= 60) {
      return `${Math.floor(totalSec / 60)}:${String(totalSec % 60).padStart(2, '0')} min`;
    }
    return `${(ms / 1000).toFixed(1)} s`;
  }

  // ================= carousel / options =================
  toggleCarousel(event: Event): void {
    const on = (event.target as HTMLInputElement).checked;
    this.carouselEnabled.set(on);
    try { localStorage.setItem(CAROUSEL_KEY, on ? '1' : '0'); } catch { /* private mode */ }
    if (on) this.randomizer.refreshQueue(this.excludeLast());
  }

  toggleExclude(event: Event): void {
    this.excludeLast.set((event.target as HTMLInputElement).checked);
    // re-validate the displayed "up next" against the new rule
    this.randomizer.refreshQueue(this.excludeLast());
  }

  // ================= editor =================
  onNewItemInput(event: Event): void {
    this.newItem.set((event.target as HTMLInputElement).value);
  }

  addItem(): void {
    const value = this.newItem().trim();
    if (!value) return;
    this.randomizer.setItems([...this.items(), value], this.excludeLast());
    this.newItem.set('');
    this.dirty.set(true);
  }

  removeItem(index: number): void {
    this.randomizer.setItems(this.items().filter((_, i) => i !== index), this.excludeLast());
    this.dirty.set(true);
  }

  clearList(): void {
    this.randomizer.setItems([], this.excludeLast());
    this.dirty.set(true);
  }

  onFileSelected(event: Event): void {
    const input = event.target as HTMLInputElement;
    const file = input.files?.[0];
    input.value = '';
    if (!file) return;
    if (!file.name.toLowerCase().endsWith('.txt')) {
      this.error.set('Please choose a .txt file.');
      return;
    }
    file.text().then(text => {
      const items = text.split(/\r?\n/).map(l => l.trim()).filter(Boolean);
      if (items.length === 0) { this.error.set('The file is empty.'); return; }
      this.randomizer.setItems(items, this.excludeLast());
      this.dirty.set(true);
      this.error.set(null);
    });
  }

  // ================= randomizer =================
  pick(): void {
    if (!this.canPick()) return;

    const items = this.items();
    const winner = this.randomizer.beginSpin(this.excludeLast());
    if (!winner) return;

    this.isSpinning.set(true);
    this.result.set(null);
    if (this.carouselEnabled()) this.spinPreview.set(this.randomPair(items));
    this.audio.playSpinMusic(this.assets()?.music ?? []);

    // deceleration schedule: sum of delays === duration exactly
    const duration = this.spinDurationMs();
    const steps = Math.min(Math.max(Math.round(duration / 80), 12), 400);
    const base = 40;
    const growth = duration > steps * base
      ? (2 * (duration - steps * base)) / (steps * (steps - 1))
      : 0;

    let step = 0;
    const tick = () => {
      step++;
      if (step >= steps) {
        this.finishSpin(winner);
        return;
      }
      const value = items[Math.floor(Math.random() * items.length)];
      this.result.set(value);
      this.randomizer.recordTick(value);   // every tick is stored
      if (this.carouselEnabled()) this.spinPreview.set(this.randomPair(items));
      this.spinTimeout = setTimeout(tick, base + growth * step);
    };
    this.spinTimeout = setTimeout(tick, base);
  }

  private randomPair(items: string[]): string[] {
    return [
      items[Math.floor(Math.random() * items.length)],
      items[Math.floor(Math.random() * items.length)]
    ];
  }

  private finishSpin(winner: string): void {
    this.spinTimeout = null;
    this.result.set(winner);
    this.randomizer.recordTick(winner);  // final tick slides the previous one into the tape
    this.randomizer.commit();            // marks it final: history + queue + persist
    this.isSpinning.set(false);
    this.spinPreview.set(null);
    this.audio.stopSpinMusic();
    this.audio.playEndSound(this.assets()?.stopSound ?? null);
  }

  resetHistory(): void {
    this.randomizer.resetHistory(this.excludeLast());
    this.result.set(null);
  }

  private stopSpin(): void {
    if (this.spinTimeout !== null) {
      clearTimeout(this.spinTimeout);
      this.spinTimeout = null;
    }
    this.audio.stopSpinMusic();
    this.spinPreview.set(null);
    this.randomizer.cancelSpin();
    this.isSpinning.set(false);
  }
}
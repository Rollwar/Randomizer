import { Component, OnDestroy, OnInit, computed, inject, signal } from '@angular/core';
import { CommonModule } from '@angular/common';
import { GameApiService } from '../services/game-api.service';
import { RandomizerService } from '../services/randomizer.service';
import { AudioService } from '../services/audio.service';
import { AssetsManifest, GamePlatform, StorageFormat } from './models';

interface RandomizerBridge {
  isDesktop: boolean;
  openRouletteFolder(): Promise<string>;
  minimize(): void;
  toggleMaximize(): void;
  close(): void;
}

declare global {
  interface Window { randomizer?: RandomizerBridge; }
}

type SectionId = 'assets' | 'editor' | 'history' | 'sound';

@Component({
  selector: 'app-root',
  standalone: true,
  imports: [CommonModule],
  templateUrl: './app.component.html',
  styleUrls: ['./app.component.css']
})
export class AppComponent implements OnInit, OnDestroy {
  private static readonly ACCORDION_KEY = 'randomizer:accordion';

  private readonly api = inject(GameApiService);
  private readonly randomizer = inject(RandomizerService);
  readonly audio = inject(AudioService);
  private spinTimeout: ReturnType<typeof setTimeout> | null = null;
  private loadSeq = 0;

  // backend state
  readonly platforms = signal<GamePlatform[]>([]);
  readonly selectedPlatform = signal<string | null>(null);
  readonly storageFormat = signal<StorageFormat>('json');

  // roulette assets
  readonly assets = signal<AssetsManifest | null>(null);
  readonly bgFile = signal<string | null>(null);

  // ui state
  readonly newItem = signal('');
  readonly result = signal<string | null>(null);
  readonly isSpinning = signal(false);
  readonly excludeLast = signal(false);
  readonly loading = signal(false);
  readonly saving = signal(false);
  readonly dirty = signal(false);
  readonly savedAt = signal<string | null>(null);
  readonly error = signal<string | null>(null);

  // spin settings: 1 s … 2 min
  readonly spinMinMs = 1000;
  readonly spinMaxMs = 120000;
  readonly spinDurationMs = signal(5000);

  // accordions (persisted)
  readonly expanded = signal<Record<SectionId, boolean>>(AppComponent.readAccordionState());

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
  readonly assetsSummary = computed(() => {
    const a = this.assets();
    if (!a) return 'not scanned';
    return `${a.music.length} music · ${a.stopSound ? 'stop ✓' : 'no stop'} · ${a.icons.length} icons · ${a.backgrounds.length} bg`;
  });

  readonly musicCount = computed(() => this.assets()?.music.length ?? 0);
  readonly iconCount = computed(() => this.assets()?.icons.length ?? 0);
  readonly bgCount = computed(() => this.assets()?.backgrounds.length ?? 0);
  readonly hasStopSound = computed(() => this.assets()?.stopSound != null);
  readonly musicMeta = computed(() => {
  const n = this.assets()?.music.length ?? 0;
  return n ? ` · ${n} tracks` : '';
});

  readonly resultBackground = computed(() => {
    const file = this.bgFile();
    return file
      ? `linear-gradient(rgba(15, 23, 42, 0.78), rgba(15, 23, 42, 0.78)), url('/roulette/${encodeURIComponent(file)}')`
      : null;
  });

  ngOnInit(): void {
    this.api.getPlatforms().subscribe({
      next: platforms => {
        this.platforms.set(platforms);
        if (platforms.length) this.selectPlatform(platforms[0].id);
      },
      error: () => this.error.set('Backend is not reachable. Run "npm run server" first.')
    });
    this.loadAssets();
  }

  // ---------- window controls (Electron title bar) ----------
  minimizeWindow(): void { window.randomizer?.minimize(); }
  toggleMaximizeWindow(): void { window.randomizer?.toggleMaximize(); }
  closeWindow(): void { window.randomizer?.close(); }

  // ---------- accordions ----------
  private static readAccordionState(): Record<SectionId, boolean> {
    const defaults: Record<SectionId, boolean> = {
      assets: false, editor: true, history: false, sound: false
    };
    try {
      const raw = localStorage.getItem(AppComponent.ACCORDION_KEY);
      return raw ? { ...defaults, ...JSON.parse(raw) } : defaults;
    } catch { return defaults; }
  }

  isExpanded(section: SectionId): boolean {
    return !!this.expanded()[section];
  }

  toggleSection(section: SectionId): void {
    this.expanded.update(map => {
      const next = { ...map, [section]: !map[section] };
      try { localStorage.setItem(AppComponent.ACCORDION_KEY, JSON.stringify(next)); } catch { /* private mode */ }
      return next;
    });
  }

  // ---------- roulette assets ----------
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

  // ---------- platform / list ----------
  selectPlatform(id: string): void {
    if (this.selectedPlatform() === id) return;
    this.selectedPlatform.set(id);
    this.result.set(null);
    this.rotateBackground();
    this.loadList();
  }

  reload(): void {
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
        this.randomizer.setItems(list.items);
        this.loading.set(false);
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

  // ---------- spin settings ----------
  onDurationInput(event: Event): void {
    this.spinDurationMs.set(Number((event.target as HTMLInputElement).value));
  }

  onVolumeInput(event: Event): void {
    this.audio.setVolume(Number((event.target as HTMLInputElement).value));
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

  // ---------- editor ----------
  onNewItemInput(event: Event): void {
    this.newItem.set((event.target as HTMLInputElement).value);
  }

  addItem(): void {
    const value = this.newItem().trim();
    if (!value) return;
    this.randomizer.setItems([...this.items(), value]);
    this.newItem.set('');
    this.dirty.set(true);
  }

  removeItem(index: number): void {
    this.randomizer.setItems(this.items().filter((_, i) => i !== index));
    this.dirty.set(true);
  }

  clearList(): void {
    this.randomizer.setItems([]);
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
      this.randomizer.setItems(items);
      this.dirty.set(true);
      this.error.set(null);
    });
  }

  // ---------- randomizer ----------
  pick(): void {
    if (!this.canPick()) return;

    const items = this.items();
    const winner = this.randomizer.chooseWinner(this.excludeLast());
    if (!winner) return;

    this.isSpinning.set(true);
    this.result.set(null);
    this.audio.playSpinMusic(this.assets()?.music ?? []);

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
      this.result.set(items[Math.floor(Math.random() * items.length)]);
      this.spinTimeout = setTimeout(tick, base + growth * step);
    };
    this.spinTimeout = setTimeout(tick, base);
  }

  private finishSpin(winner: string): void {
    this.spinTimeout = null;
    this.result.set(winner);
    this.randomizer.commit(winner);
    this.isSpinning.set(false);
    this.audio.stopSpinMusic();
    this.audio.playEndSound(this.assets()?.stopSound ?? null);
  }

  toggleExclude(event: Event): void {
    this.excludeLast.set((event.target as HTMLInputElement).checked);
  }

  resetHistory(): void {
    this.randomizer.resetHistory();
    this.result.set(null);
  }

  private stopSpin(): void {
    if (this.spinTimeout !== null) {
      clearTimeout(this.spinTimeout);
      this.spinTimeout = null;
    }
    this.audio.stopSpinMusic();
    this.isSpinning.set(false);
  }

  ngOnDestroy(): void {
    this.stopSpin();
  }
}
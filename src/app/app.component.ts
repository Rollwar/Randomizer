import { Component, OnDestroy, OnInit, computed, inject, signal } from '@angular/core';
import { CommonModule } from '@angular/common';
import { GameApiService } from '../services/game-api.service';
import { RandomizerService } from '../services/randomizer.service';
import { GamePlatform, StorageFormat } from './models';

@Component({
  selector: 'app-root',
  standalone: true,
  imports: [CommonModule],
  templateUrl: './app.component.html',
  styleUrls: ['./app.component.css']
})
export class AppComponent implements OnInit, OnDestroy {
  private readonly api = inject(GameApiService);
  private readonly randomizer = inject(RandomizerService);
  private spinInterval: ReturnType<typeof setInterval> | null = null;
  private loadSeq = 0;

  // backend state
  readonly platforms = signal<GamePlatform[]>([]);
  readonly selectedPlatform = signal<string | null>(null);
  readonly storageFormat = signal<StorageFormat>('json');

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

  readonly items = this.randomizer.items;
  readonly history = this.randomizer.history;

  readonly currentPlatform = computed(
    () => this.platforms().find(p => p.id === this.selectedPlatform()) ?? null
  );
  readonly canPick = computed(
    () => this.items().length > 0 && !this.isSpinning() && !this.loading()
  );

  ngOnInit(): void {
    this.api.getPlatforms().subscribe({
      next: platforms => {
        this.platforms.set(platforms);
        if (platforms.length) this.selectPlatform(platforms[0].id);
      },
      error: () => this.error.set('Backend is not reachable. Run "npm run server" first.')
    });
  }

  selectPlatform(id: string): void {
    if (this.selectedPlatform() === id) return;
    this.selectedPlatform.set(id);
    this.result.set(null);
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

  // import .txt into the current platform (not persisted until "Save")
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

    this.isSpinning.set(true);
    this.result.set(null);

    let ticks = 0;
    const maxTicks = 15;

    this.spinInterval = setInterval(() => {
      const items = this.items();
      ticks++;
      if (ticks >= maxTicks) {
        this.stopSpin();
        this.result.set(this.randomizer.pickRandom(this.excludeLast()));
      } else {
        this.result.set(items[Math.floor(Math.random() * items.length)]);
      }
    }, 80);
  }

  toggleExclude(event: Event): void {
    this.excludeLast.set((event.target as HTMLInputElement).checked);
  }

  resetHistory(): void {
    this.randomizer.resetHistory();
    this.result.set(null);
  }

  private stopSpin(): void {
    if (this.spinInterval !== null) {
      clearInterval(this.spinInterval);
      this.spinInterval = null;
    }
    this.isSpinning.set(false);
  }

  ngOnDestroy(): void {
    this.stopSpin();
  }
}
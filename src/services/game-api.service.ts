import { Injectable, inject } from '@angular/core';
import { HttpClient } from '@angular/common/http';
import { Observable } from 'rxjs';
import { AssetsManifest, GamePlatform, ListPayload, StorageFormat } from '../app/models';
import { RollSnapshot } from './randomizer.service';

export interface AppSettings {
  theme?: string;   // 'default' | 'green' | 'purple'
  volume?: number;  // 0..100
}

@Injectable({ providedIn: 'root' })
export class GameApiService {
  private readonly http = inject(HttpClient);
  private readonly base = '/api';

  // ---------- platforms ----------
  getPlatforms(): Observable<GamePlatform[]> {
    return this.http.get<GamePlatform[]>(`${this.base}/platforms`);
  }

  /** Force re-import of {platform}.games.txt, overwriting the stored list. */
  importPlatform(platformId: string): Observable<{ imported: boolean; count?: number; reason?: string }> {
    return this.http.post<{ imported: boolean; count?: number; reason?: string }>(
      `${this.base}/platforms/${platformId}/import`, {}
    );
  }

  // ---------- roulette media ----------
  getAssets(): Observable<AssetsManifest> {
    return this.http.get<AssetsManifest>(`${this.base}/assets`);
  }

  // ---------- game lists ----------
  getList(platformId: string, format: StorageFormat): Observable<ListPayload> {
    return this.http.get<ListPayload>(`${this.base}/lists/${platformId}`, { params: { format } });
  }

  saveList(platformId: string, items: string[], format: StorageFormat): Observable<ListPayload> {
    return this.http.put<ListPayload>(`${this.base}/lists/${platformId}`, { items, format });
  }

  clearList(platformId: string): Observable<ListPayload> {
    return this.http.delete<ListPayload>(`${this.base}/lists/${platformId}`);
  }

  // ---------- settings (theme, volume) ----------
  getSettings(): Observable<AppSettings> {
    return this.http.get<AppSettings>(`${this.base}/settings`);
  }

  saveSettings(patch: AppSettings): Observable<AppSettings> {
    return this.http.put<AppSettings>(`${this.base}/settings`, patch);
  }

  // ---------- per-platform roll state ----------
  getRolls(platformId: string): Observable<RollSnapshot | null> {
    return this.http.get<RollSnapshot | null>(`${this.base}/rolls/${platformId}`);
  }

  saveRolls(platformId: string, snapshot: RollSnapshot): Observable<{ saved: boolean }> {
    return this.http.put<{ saved: boolean }>(`${this.base}/rolls/${platformId}`, snapshot);
  }

  // ---------- SSE: server push events ----------
  /** Subscribes to server push events. Returns an unsubscribe function. */
  onServerEvents(handlers: { platforms: () => void; list: (platformId: string) => void }): () => void {
    const es = new EventSource('/api/events');
    es.onmessage = ev => {
      try {
        const msg = JSON.parse(ev.data) as { type: 'platforms' | 'list'; platform?: string };
        if (msg.type === 'platforms') handlers.platforms();
        else if (msg.type === 'list' && msg.platform) handlers.list(msg.platform);
      } catch { /* ignore malformed frames */ }
    };
    return () => es.close();
  }
}
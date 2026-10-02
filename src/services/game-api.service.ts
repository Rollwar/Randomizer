import { Injectable, inject } from '@angular/core';
import { HttpClient } from '@angular/common/http';
import { Observable } from 'rxjs';
import { AssetsManifest, GamePlatform, ListPayload, StorageFormat } from '../app/models';

@Injectable({ providedIn: 'root' })
export class GameApiService {
  private readonly http = inject(HttpClient);
  private readonly base = '/api';

  getPlatforms(): Observable<GamePlatform[]> {
    return this.http.get<GamePlatform[]>(`${this.base}/platforms`);
  }

  getAssets(): Observable<AssetsManifest> {
    return this.http.get<AssetsManifest>(`${this.base}/assets`);
  }

  getList(platformId: string, format: StorageFormat): Observable<ListPayload> {
    return this.http.get<ListPayload>(`${this.base}/lists/${platformId}`, { params: { format } });
  }

  saveList(platformId: string, items: string[], format: StorageFormat): Observable<ListPayload> {
    return this.http.put<ListPayload>(`${this.base}/lists/${platformId}`, { items, format });
  }

  clearList(platformId: string): Observable<ListPayload> {
    return this.http.delete<ListPayload>(`${this.base}/lists/${platformId}`);
  }

  /** Subscribes to server push events (SSE). Returns an unsubscribe function. */
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
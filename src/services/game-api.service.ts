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
}
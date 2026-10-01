export interface GamePlatform { id: string; name: string; }

export type StorageFormat = 'json' | 'xml';

export interface ListPayload {
  platform: string;
  format: StorageFormat;
  items: string[];
  updatedAt: string | null;
}
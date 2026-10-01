export interface GamePlatform { id: string; name: string; }

export type StorageFormat = 'json' | 'xml';

export interface ListPayload {
  platform: string;
  format: StorageFormat;
  items: string[];
  updatedAt: string | null;
}

export interface AssetsManifest {
  dir: string;
  music: string[];
  stopSound: string | null;
  icons: string[];
  backgrounds: string[];
}
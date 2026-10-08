import { Injectable, signal } from '@angular/core';

const VOLUME_KEY = 'randomizer:volume';

@Injectable({ providedIn: 'root' })
export class AudioService {
  private spinAudio: HTMLAudioElement | null = null;
  private endAudio: HTMLAudioElement | null = null;
  private lastTrack: string | null = null;

  readonly volume = signal(this.readStoredVolume());

  setVolume(value: number): void {
    const v = Math.min(100, Math.max(0, Math.round(value)));
    this.volume.set(v);
    try { localStorage.setItem(VOLUME_KEY, String(v)); } catch { /* private mode */ }
    if (this.spinAudio) this.spinAudio.volume = v / 100;
    if (this.endAudio) this.endAudio.volume = v / 100;
  }

  /** Starts looping spin music (random track from /roulette, no immediate repeat). */
  playSpinMusic(tracks: string[]): void {
    this.stopSpinMusic();
    if (!tracks.length) return;

    let track = tracks[Math.floor(Math.random() * tracks.length)];
    if (tracks.length > 1 && track === this.lastTrack) {
      track = tracks[(tracks.indexOf(track) + 1) % tracks.length];
    }
    this.lastTrack = track;

    const audio = new Audio(`/roulette/${encodeURIComponent(track)}`);
    audio.loop = true;
    audio.volume = this.volume() / 100;
    this.spinAudio = audio;
    audio.play().catch(() => { /* autoplay blocked — spin continues silently */ });
  }

  stopSpinMusic(): void {
    if (this.spinAudio) {
      this.spinAudio.pause();
      this.spinAudio.currentTime = 0;
      this.spinAudio = null;
    }
  }

  /** One-shot "wheel stopped" sound. */
  playEndSound(file: string | null): void {
    if (!file) return;
    this.endAudio?.pause();
    const audio = new Audio(`/roulette/${encodeURIComponent(file)}`);
    audio.volume = this.volume() / 100;
    this.endAudio = audio;
    audio.play().catch(() => { /* ignore */ });
  }

  private readStoredVolume(): number {
    try {
      const v = Number(localStorage.getItem(VOLUME_KEY));
      return Number.isFinite(v) && v > 0 ? Math.min(100, v) : 70;
    } catch { return 70; }
  }
}
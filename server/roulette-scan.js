const express = require('express');
const fs = require('fs');
const path = require('path');

const AUDIO_EXTS = new Set(['.mp3', '.wav', '.ogg', '.m4a', '.flac', '.aac', '.wma', '.opus']);
const IMAGE_EXTS = new Set(['.jpg', '.jpeg', '.png', '.webp', '.gif', '.bmp']);

/**
 * Scans the roulette folder (case-insensitive names):
 *   Rulett01.mp3, Rulett02.ogg …  → spin music (loops during the spin)
 *   RulettEnd.wav                 → "wheel stopped" sound
 *   RuletIco1.png, RuletIco2.png… → platform icons, matched to /api/platforms order
 *   any other image               → roulette background
 */
function scanRoulette(dir) {
  const manifest = { dir, music: [], stopSound: null, icons: [], backgrounds: [] };
  let entries = [];
  try { entries = fs.readdirSync(dir); } catch { return manifest; }

  const fileNumber = name => {
    const m = name.match(/(\d+)/);
    return m ? parseInt(m[1], 10) : Number.MAX_SAFE_INTEGER; // RuletIco10 after RuletIco9
  };

  for (const name of entries) {
    const ext = path.extname(name).toLowerCase();
    const base = path.basename(name, ext).toLowerCase();

    if (AUDIO_EXTS.has(ext)) {
      if (base === 'rulettend') { if (!manifest.stopSound) manifest.stopSound = name; }
      else if (base.startsWith('rulett')) manifest.music.push(name);
    } else if (IMAGE_EXTS.has(ext)) {
      if (base.startsWith('ruletico')) manifest.icons.push(name);
      else manifest.backgrounds.push(name);
    }
  }

  manifest.music.sort((a, b) => fileNumber(a) - fileNumber(b) || a.localeCompare(b));
  manifest.icons.sort((a, b) => fileNumber(a) - fileNumber(b) || a.localeCompare(b));
  manifest.backgrounds.sort();
  return manifest;
}

module.exports = { scanRoulette };
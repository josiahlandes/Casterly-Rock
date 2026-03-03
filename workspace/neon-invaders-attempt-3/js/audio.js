// Neon Invaders - Audio System
// Procedural sound generation using Web Audio API

import { AUDIO } from './config.js';

export class AudioSystem {
  constructor() {
    this.context = null;
    this.enabled = AUDIO.enabled;
    this.volume = AUDIO.volume;
    this.masterGain = null;
  }

  // Initialize audio context (must be called after user interaction)
  init() {
    if (this.context) return;
    
    try {
      const AudioContext = window.AudioContext || window.webkitAudioContext;
      this.context = new AudioContext();
      
      // Create master gain node
      this.masterGain = this.context.createGain();
      this.masterGain.gain.value = this.volume;
      this.masterGain.connect(this.context.destination);
    } catch (e) {
      console.warn('Web Audio API not supported');
      this.enabled = false;
    }
  }

  // Resume audio context (for browsers that suspend it)
  resume() {
    if (this.context && this.context.state === 'suspended') {
      this.context.resume();
    }
  }

  // Toggle audio on/off
  toggle() {
    this.enabled = !this.enabled;
    if (this.masterGain) {
      this.masterGain.gain.value = this.enabled ? this.volume : 0;
    }
    return this.enabled;
  }

  // Play a sound effect
  play(soundType, params = {}) {
    if (!this.enabled || !this.context) return;
    
    try {
      switch (soundType) {
        case 'shoot':
          this.playShoot(params);
          break;
        case 'explosion':
          this.playExplosion(params);
          break;
        case 'powerup':
          this.playPowerup(params);
          break;
        case 'hit':
          this.playHit(params);
          break;
        case 'levelUp':
          this.playLevelUp(params);
          break;
        case 'gameOver':
          this.playGameOver(params);
          break;
      }
    } catch (e) {
      // Silently fail if audio context is invalid
    }
  }

  // Player shoot sound (high-pitched blip)
  playShoot(params = {}) {
    const oscillator = this.context.createOscillator();
    const gainNode = this.context.createGain();
    
    oscillator.connect(gainNode);
    gainNode.connect(this.masterGain);
    
    oscillator.type = 'square';
    oscillator.frequency.setValueAtTime(880, this.context.currentTime);
    oscillator.frequency.exponentialRampToValueAtTime(440, this.context.currentTime + 0.1);
    
    gainNode.gain.setValueAtTime(0.1 * this.volume, this.context.currentTime);
    gainNode.gain.exponentialRampToValueAtTime(0.01, this.context.currentTime + 0.1);
    
    oscillator.start(this.context.currentTime);
    oscillator.stop(this.context.currentTime + 0.1);
  }

  // Explosion sound (noise burst)
  playExplosion(params = {}) {
    const bufferSize = this.context.sampleRate * 0.3; // 300ms
    const buffer = this.context.createBuffer(1, bufferSize, this.context.sampleRate);
    const data = buffer.getChannelData(0);
    
    // Generate white noise
    for (let i = 0; i < bufferSize; i++) {
      data[i] = Math.random() * 2 - 1;
    }
    
    const noise = this.context.createBufferSource();
    noise.buffer = buffer;
    
    const gainNode = this.context.createGain();
    noise.connect(gainNode);
    gainNode.connect(this.masterGain);
    
    // Low-pass filter for explosion sound
    const filter = this.context.createBiquadFilter();
    filter.type = 'lowpass';
    filter.frequency.value = 1000;
    
    gainNode.connect(filter);
    filter.connect(this.masterGain);
    
    gainNode.gain.setValueAtTime(0.3 * this.volume, this.context.currentTime);
    gainNode.gain.exponentialRampToValueAtTime(0.01, this.context.currentTime + 0.3);
    
    noise.start(this.context.currentTime);
  }

  // Power-up collection sound (ascending tones)
  playPowerup(params = {}) {
    const now = this.context.currentTime;
    
    // Play three ascending notes
    [523.25, 659.25, 783.99].forEach((freq, i) > {
      const oscillator = this.context.createOscillator();
      const gainNode = this.context.createGain();
      
      oscillator.connect(gainNode);
      gainNode.connect(this.masterGain);
      
      oscillator.type = 'sine';
      oscillator.frequency.value = freq;
      
      const startTime = now + i * 0.08;
      gainNode.gain.setValueAtTime(0.15 * this.volume, startTime);
      gainNode.gain.exponentialRampToValueAtTime(0.01, startTime + 0.15);
      
      oscillator.start(startTime);
      oscillator.stop(startTime + 0.15);
    });
  }

  // Enemy hit sound (short blip)
  playHit(params = {}) {
    const oscillator = this.context.createOscillator();
    const gainNode = this.context.createGain();
    
    oscillator.connect(gainNode);
    gainNode.connect(this.masterGain);
    
    oscillator.type = 'square';
    oscillator.frequency.setValueAtTime(440, this.context.currentTime);
    oscillator.frequency.exponentialRampToValueAtTime(220, this.context.currentTime + 0.05);
    
    gainNode.gain.setValueAtTime(0.08 * this.volume, this.context.currentTime);
    gainNode.gain.exponentialRampToValueAtTime(0.01, this.context.currentTime + 0.05);
    
    oscillator.start(this.context.currentTime);
    oscillator.stop(this.context.currentTime + 0.05);
  }

  // Level up sound (ascending arpeggio)
  playLevelUp(params = {}) {
    const now = this.context.currentTime;
    const notes = [261.63, 329.63, 392.00, 523.25, 659.25, 783.99, 1046.50];
    
    notes.forEach((freq, i) > {
      const oscillator = this.context.createOscillator();
      const gainNode = this.context.createGain();
      
      oscillator.connect(gainNode);
      gainNode.connect(this.masterGain);
      
      oscillator.type = 'sine';
      oscillator.frequency.value = freq;
      
      const startTime = now + i * 0.1;
      gainNode.gain.setValueAtTime(0.1 * this.volume, startTime);
      gainNode.gain.exponentialRampToValueAtTime(0.01, startTime + 0.2);
      
      oscillator.start(startTime);
      oscillator.stop(startTime + 0.2);
    });
  }

  // Game over sound (descending tones)
  playGameOver(params = {}) {
    const now = this.context.currentTime;
    const notes = [523.25, 440.00, 392.00, 329.63, 261.63];
    
    notes.forEach((freq, i) > {
      const oscillator = this.context.createOscillator();
      const gainNode = this.context.createGain();
      
      oscillator.connect(gainNode);
      gainNode.connect(this.masterGain);
      
      oscillator.type = 'sine';
      oscillator.frequency.value = freq;
      
      const startTime = now + i * 0.2;
      gainNode.gain.setValueAtTime(0.2 * this.volume, startTime);
      gainNode.gain.exponentialRampToValueAtTime(0.01, startTime + 0.3);
      
      oscillator.start(startTime);
      oscillator.stop(startTime + 0.3);
    });
  }

  // Set volume (0.0 to 1.0)
  setVolume(volume) {
    this.volume = Math.max(0, Math.min(1, volume));
    if (this.masterGain) {
      this.masterGain.gain.value = this.enabled ? this.volume : 0;
    }
  }

  // Get volume
  getVolume() {
    return this.volume;
  }

  // Check if audio is enabled
  isEnabled() {
    return this.enabled;
  }
}

export default AudioSystem;

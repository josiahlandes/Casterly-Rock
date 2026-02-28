// Procedural audio system using Web Audio API
export class AudioSystem {
  constructor() {
    this.audioContext = null;
    this.masterGain = null;
    this.enabled = true;
    this.volume = 0.3;
    
    // Sound cache for reusing oscillators
    this.sounds = {
      shoot: null,
      enemyHit: null,
      playerHit: null,
      powerup: null,
      enemyShoot: null,
      gameOver: null
    };
  }
  
  init() {
    if (this.audioContext) return;
    
    try {
      this.audioContext = new (window.AudioContext || window.webkitAudioContext)();
      this.masterGain = this.audioContext.createGain();
      this.masterGain.gain.value = this.volume;
      this.masterGain.connect(this.audioContext.destination);
    } catch (e) {
      console.warn('Web Audio API not supported');
      this.enabled = false;
    }
  }
  
  setVolume(value) {
    this.volume = Math.max(0, Math.min(1, value));
    if (this.masterGain) {
      this.masterGain.gain.value = this.volume;
    }
  }
  
  toggle() {
    this.enabled = !this.enabled;
    return this.enabled;
  }
  
  // Create a sound effect with envelope
  playTone(frequency, type, duration, volume = 1, attack = 0.01, decay = 0.1) {
    if (!this.enabled || !this.audioContext) return;
    
    const oscillator = this.audioContext.createOscillator();
    const gainNode = this.audioContext.createGain();
    
    oscillator.type = type;
    oscillator.frequency.setValueAtTime(frequency, this.audioContext.currentTime);
    
    // Envelope
    gainNode.gain.setValueAtTime(0, this.audioContext.currentTime);
    gainNode.gain.linearRampToValueAtTime(volume, this.audioContext.currentTime + attack);
    gainNode.gain.exponentialRampToValueAtTime(0.01, this.audioContext.currentTime + duration);
    
    oscillator.connect(gainNode);
    gainNode.connect(this.masterGain);
    
    oscillator.start(this.audioContext.currentTime);
    oscillator.stop(this.audioContext.currentTime + duration);
  }
  
  // Shoot sound - high pitch blip
  playShoot() {
    this.playTone(880, 'square', 0.1, 0.3);
    setTimeout(() => this.playTone(660, 'square', 0.1, 0.2), 50);
  }
  
  // Enemy hit sound - descending tone
  playEnemyHit() {
    this.playTone(440, 'sawtooth', 0.15, 0.4);
    setTimeout(() => this.playTone(330, 'sawtooth', 0.15, 0.3), 50);
    setTimeout(() => this.playTone(220, 'sawtooth', 0.15, 0.2), 100);
  }
  
  // Player hit sound - low descending
  playPlayerHit() {
    this.playTone(200, 'sawtooth', 0.3, 0.5);
    setTimeout(() => this.playTone(150, 'sawtooth', 0.3, 0.4), 100);
    setTimeout(() => this.playTone(100, 'sawtooth', 0.3, 0.3), 200);
  }
  
  // Power-up sound - ascending arpeggio
  playPowerup() {
    [523, 659, 784, 1047].forEach((freq, i) => {
      setTimeout(() => this.playTone(freq, 'sine', 0.15, 0.3), i * 80);
    });
  }
  
  // Enemy shoot sound
  playEnemyShoot() {
    this.playTone(300, 'square', 0.08, 0.2);
  }
  
  // Game over sound - dramatic descending
  playGameOver() {
    [400, 350, 300, 250, 200, 150].forEach((freq, i) => {
      setTimeout(() => this.playTone(freq, 'sawtooth', 0.4, 0.4), i * 200);
    });
  }
  
  // Victory sound - ascending arpeggio
  playVictory() {
    [330, 440, 554, 660, 880, 1108].forEach((freq, i) => {
      setTimeout(() => this.playTone(freq, 'sine', 0.2, 0.3), i * 100);
    });
  }
  
  // Explosion sound - noise burst
  playExplosion() {
    if (!this.enabled || !this.audioContext) return;
    
    const bufferSize = this.audioContext.sampleRate * 0.3;
    const buffer = this.audioContext.createBuffer(1, bufferSize, this.audioContext.sampleRate);
    const data = buffer.getChannelData(0);
    
    for (let i = 0; i < bufferSize; i++) {
      data[i] = (Math.random() * 2 - 1) * (1 - i / bufferSize);
    }
    
    const noise = this.audioContext.createBufferSource();
    noise.buffer = buffer;
    
    const gainNode = this.audioContext.createGain();
    gainNode.gain.setValueAtTime(0.5, this.audioContext.currentTime);
    gainNode.gain.exponentialRampToValueAtTime(0.01, this.audioContext.currentTime + 0.3);
    
    noise.connect(gainNode);
    gainNode.connect(this.masterGain);
    
    noise.start(this.audioContext.currentTime);
  }
  
  // Background ambience - subtle drone
  startAmbience() {
    if (!this.enabled || !this.audioContext) return;
    
    const oscillator = this.audioContext.createOscillator();
    const gainNode = this.audioContext.createGain();
    
    oscillator.type = 'sine';
    oscillator.frequency.value = 55; // Low A
    
    gainNode.gain.value = 0.05;
    
    oscillator.connect(gainNode);
    gainNode.connect(this.masterGain);
    
    oscillator.start();
    this.ambienceOscillator = oscillator;
  }
  
  stopAmbience() {
    if (this.ambienceOscillator) {
      this.ambienceOscillator.stop();
      this.ambienceOscillator = null;
    }
  }
  
  // Resume audio context (needed after user interaction)
  resume() {
    if (this.audioContext && this.audioContext.state === 'suspended') {
      this.audioContext.resume();
    }
  }
}

export const audio = new AudioSystem();

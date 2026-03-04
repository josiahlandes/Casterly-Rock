// Procedural Audio System using Web Audio API

import { AUDIO } from './config.js';

class AudioSystem {
    constructor() {
        this.context = null;
        this.masterGain = null;
        this.initialized = false;
    }
    
    init() {
        if (this.initialized) return;
        
        try {
            this.context = new (window.AudioContext || window.webkitAudioContext)();
            this.masterGain = this.context.createGain();
            this.masterGain.gain.value = 0.3; // Master volume
            this.masterGain.connect(this.context.destination);
            this.initialized = true;
        } catch (e) {
            console.warn('Web Audio API not supported');
            this.initialized = false;
        }
    }
    
    ensureInitialized() {
        if (!this.initialized) {
            this.init();
        }
        if (this.context && this.context.state === 'suspended') {
            this.context.resume();
        }
    }
    
    // Create oscillator with envelope
    playTone(frequency, type, duration, startTime = 0) {
        if (!this.initialized) return;
        
        const oscillator = this.context.createOscillator();
        const gainNode = this.context.createGain();
        
        oscillator.type = type;
        oscillator.frequency.setValueAtTime(frequency, this.context.currentTime + startTime);
        
        // Envelope
        gainNode.gain.setValueAtTime(0, this.context.currentTime + startTime);
        gainNode.gain.linearRampToValueAtTime(1, this.context.currentTime + startTime + 0.01);
        gainNode.gain.exponentialRampToValueAtTime(0.001, this.context.currentTime + startTime + duration);
        
        oscillator.connect(gainNode);
        gainNode.connect(this.masterGain);
        
        oscillator.start(this.context.currentTime + startTime);
        oscillator.stop(this.context.currentTime + startTime + duration + 0.1);
        
        // Disconnect after playback
        setTimeout(() => {
            oscillator.disconnect();
            gainNode.disconnect();
        }, (duration + 0.1) * 1000);
    }
    
    // Create frequency sweep
    playSweep(startFreq, endFreq, duration, type = 'sine') {
        if (!this.initialized) return;
        
        const oscillator = this.context.createOscillator();
        const gainNode = this.context.createGain();
        
        oscillator.type = type;
        oscillator.frequency.setValueAtTime(startFreq, this.context.currentTime);
        oscillator.frequency.exponentialRampToValueAtTime(endFreq, this.context.currentTime + duration);
        
        gainNode.gain.setValueAtTime(1, this.context.currentTime);
        gainNode.gain.exponentialRampToValueAtTime(0.001, this.context.currentTime + duration);
        
        oscillator.connect(gainNode);
        gainNode.connect(this.masterGain);
        
        oscillator.start();
        oscillator.stop(this.context.currentTime + duration + 0.1);
        
        setTimeout(() => {
            oscillator.disconnect();
            gainNode.disconnect();
        }, (duration + 0.1) * 1000);
    }
    
    // Create noise burst
    playNoise(duration) {
        if (!this.initialized) return;
        
        const bufferSize = this.context.sampleRate * duration;
        const buffer = this.context.createBuffer(1, bufferSize, this.context.sampleRate);
        const data = buffer.getChannelData(0);
        
        for (let i = 0; i < bufferSize; i++) {
            data[i] = Math.random() * 2 - 1;
        }
        
        const noiseSource = this.context.createBufferSource();
        const gainNode = this.context.createGain();
        
        noiseSource.buffer = buffer;
        
        gainNode.gain.setValueAtTime(1, this.context.currentTime);
        gainNode.gain.exponentialRampToValueAtTime(0.001, this.context.currentTime + duration);
        
        noiseSource.connect(gainNode);
        gainNode.connect(this.masterGain);
        
        noiseSource.start();
        
        setTimeout(() => {
            noiseSource.disconnect();
            gainNode.disconnect();
        }, duration * 1000 + 100);
    }
    
    // Player shoot sound - short high-pitched "pew"
    playPlayerShoot() {
        this.ensureInitialized();
        if (!this.initialized) return;
        
        const oscillator = this.context.createOscillator();
        const gainNode = this.context.createGain();
        
        oscillator.type = 'sine';
        oscillator.frequency.setValueAtTime(AUDIO.PLAYER_SHOOT_FREQ, this.context.currentTime);
        oscillator.frequency.exponentialRampToValueAtTime(AUDIO.PLAYER_SHOOT_FREQ * 0.5, this.context.currentTime + AUDIO.PLAYER_SHOOT_DECAY);
        
        gainNode.gain.setValueAtTime(0.5, this.context.currentTime);
        gainNode.gain.exponentialRampToValueAtTime(0.001, this.context.currentTime + AUDIO.PLAYER_SHOOT_DECAY);
        
        oscillator.connect(gainNode);
        gainNode.connect(this.masterGain);
        
        oscillator.start();
        oscillator.stop(this.context.currentTime + AUDIO.PLAYER_SHOOT_DECAY + 0.1);
        
        setTimeout(() => {
            oscillator.disconnect();
            gainNode.disconnect();
        }, (AUDIO.PLAYER_SHOOT_DECAY + 0.1) * 1000);
    }
    
    // Enemy shoot sound - lower "thwip"
    playEnemyShoot() {
        this.ensureInitialized();
        if (!this.initialized) return;
        
        const oscillator = this.context.createOscillator();
        const gainNode = this.context.createGain();
        
        oscillator.type = 'triangle';
        oscillator.frequency.setValueAtTime(AUDIO.ENEMY_SHOOT_FREQ, this.context.currentTime);
        
        gainNode.gain.setValueAtTime(0.3, this.context.currentTime);
        gainNode.gain.exponentialRampToValueAtTime(0.001, this.context.currentTime + AUDIO.ENEMY_SHOOT_DECAY);
        
        oscillator.connect(gainNode);
        gainNode.connect(this.masterGain);
        
        oscillator.start();
        oscillator.stop(this.context.currentTime + AUDIO.ENEMY_SHOOT_DECAY + 0.1);
        
        setTimeout(() => {
            oscillator.disconnect();
            gainNode.disconnect();
        }, (AUDIO.ENEMY_SHOOT_DECAY + 0.1) * 1000);
    }
    
    // Enemy destroyed sound - noise burst + sine sweep
    playEnemyDestroyed() {
        this.ensureInitialized();
        if (!this.initialized) return;
        
        // Noise burst
        this.playNoise(AUDIO.ENEMY_DESTROY_DECAY);
        
        // Sine sweep down
        this.playSweep(
            AUDIO.ENEMY_DESTROY_START,
            AUDIO.ENEMY_DESTROY_END,
            AUDIO.ENEMY_DESTROY_DECAY,
            'sine'
        );
    }
    
    // Player hit sound - low thud
    playPlayerHit() {
        this.ensureInitialized();
        if (!this.initialized) return;
        
        const oscillator = this.context.createOscillator();
        const gainNode = this.context.createGain();
        
        oscillator.type = 'sine';
        oscillator.frequency.setValueAtTime(AUDIO.PLAYER_HIT_FREQ, this.context.currentTime);
        
        // Slight distortion via frequency modulation
        oscillator.frequency.setValueAtTime(AUDIO.PLAYER_HIT_FREQ, this.context.currentTime);
        oscillator.frequency.linearRampToValueAtTime(AUDIO.PLAYER_HIT_FREQ * 0.8, this.context.currentTime + AUDIO.PLAYER_HIT_DECAY * 0.3);
        oscillator.frequency.linearRampToValueAtTime(AUDIO.PLAYER_HIT_FREQ, this.context.currentTime + AUDIO.PLAYER_HIT_DECAY);
        
        gainNode.gain.setValueAtTime(0.6, this.context.currentTime);
        gainNode.gain.exponentialRampToValueAtTime(0.001, this.context.currentTime + AUDIO.PLAYER_HIT_DECAY);
        
        oscillator.connect(gainNode);
        gainNode.connect(this.masterGain);
        
        oscillator.start();
        oscillator.stop(this.context.currentTime + AUDIO.PLAYER_HIT_DECAY + 0.1);
        
        setTimeout(() => {
            oscillator.disconnect();
            gainNode.disconnect();
        }, (AUDIO.PLAYER_HIT_DECAY + 0.1) * 1000);
    }
    
    // Power-up collect sound - ascending arpeggio
    playPowerUpCollect() {
        this.ensureInitialized();
        if (!this.initialized) return;
        
        const notes = AUDIO.POWERUP_NOTES;
        const decay = AUDIO.POWERUP_DECAY;
        
        notes.forEach((freq, i) => {
            setTimeout(() => {
                this.playTone(freq, 'sine', decay);
            }, i * decay * 1000);
        });
    }
    
    // Level complete sound - triumphant jingle
    playLevelComplete() {
        this.ensureInitialized();
        if (!this.initialized) return;
        
        const notes = AUDIO.LEVEL_NOTES;
        const decay = AUDIO.LEVEL_DECAY;
        
        notes.forEach((freq, i) => {
            setTimeout(() => {
                this.playTone(freq, 'square', decay);
            }, i * decay * 1000);
        });
    }
    
    // Game over sound - descending sad tone
    playGameOver() {
        this.ensureInitialized();
        if (!this.initialized) return;
        
        this.playSweep(
            AUDIO.GAMEOVER_START,
            AUDIO.GAMEOVER_END,
            AUDIO.GAMEOVER_DECAY,
            'sine'
        );
    }
    
    // Score pop sound - quick blip
    playScorePop() {
        this.ensureInitialized();
        if (!this.initialized) return;
        
        const oscillator = this.context.createOscillator();
        const gainNode = this.context.createGain();
        
        oscillator.type = 'sine';
        oscillator.frequency.setValueAtTime(880, this.context.currentTime);
        
        gainNode.gain.setValueAtTime(0.2, this.context.currentTime);
        gainNode.gain.exponentialRampToValueAtTime(0.001, this.context.currentTime + 0.05);
        
        oscillator.connect(gainNode);
        gainNode.connect(this.masterGain);
        
        oscillator.start();
        oscillator.stop(this.context.currentTime + 0.05);
        
        setTimeout(() => {
            oscillator.disconnect();
            gainNode.disconnect();
        }, 100);
    }
}

// Export singleton instance
export const audio = new AudioSystem();
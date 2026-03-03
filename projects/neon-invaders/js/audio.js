// Procedural Audio Controller using Web Audio API
export default class AudioController {
    constructor() {
        this.audioContext = null;
        this.enabled = true;
        this.volume = 0.3;
        this.initialized = false;
    }
    
    init() {
        if (this.initialized) return;
        try {
            this.audioContext = new (window.AudioContext || window.webkitAudioContext)();
            this.initialized = true;
        } catch (e) {
            console.warn('Web Audio API not supported');
            this.enabled = false;
        }
    }
    
    ensureContext() {
        if (!this.initialized) {
            this.init();
        }
        if (this.audioContext && this.audioContext.state === 'suspended') {
            this.audioContext.resume();
        }
    }
    
    playPlayerShoot() {
        if (!this.enabled || !this.audioContext) return;
        this.ensureContext();
        
        const osc = this.audioContext.createOscillator();
        const gain = this.audioContext.createGain();
        
        osc.connect(gain);
        gain.connect(this.audioContext.destination);
        
        osc.type = 'sine';
        osc.frequency.setValueAtTime(880, this.audioContext.currentTime);
        osc.frequency.exponentialRampToValueAtTime(440, this.audioContext.currentTime + 0.1);
        
        gain.gain.setValueAtTime(this.volume, this.audioContext.currentTime);
        gain.gain.exponentialRampToValueAtTime(0.01, this.audioContext.currentTime + 0.1);
        
        osc.start(this.audioContext.currentTime);
        osc.stop(this.audioContext.currentTime + 0.1);
        osc.disconnect();
        gain.disconnect();
    }
    
    playEnemyShoot() {
        if (!this.enabled || !this.audioContext) return;
        this.ensureContext();
        
        const osc = this.audioContext.createOscillator();
        const gain = this.audioContext.createGain();
        
        osc.connect(gain);
        gain.connect(this.audioContext.destination);
        
        osc.type = 'triangle';
        osc.frequency.setValueAtTime(440, this.audioContext.currentTime);
        osc.frequency.exponentialRampToValueAtTime(220, this.audioContext.currentTime + 0.08);
        
        gain.gain.setValueAtTime(this.volume * 0.7, this.audioContext.currentTime);
        gain.gain.exponentialRampToValueAtTime(0.01, this.audioContext.currentTime + 0.08);
        
        osc.start(this.audioContext.currentTime);
        osc.stop(this.audioContext.currentTime + 0.08);
        osc.disconnect();
        gain.disconnect();
    }
    
    playEnemyDestroyed() {
        if (!this.enabled || !this.audioContext) return;
        this.ensureContext();
        
        // White noise burst
        const bufferSize = this.audioContext.sampleRate * 0.3;
        const buffer = this.audioContext.createBuffer(1, bufferSize, this.audioContext.sampleRate);
        const data = buffer.getChannelData(0);
        for (let i = 0; i < bufferSize; i++) {
            data[i] = (Math.random() * 2 - 1) * (1 - i / bufferSize);
        }
        
        const noise = this.audioContext.createBufferSource();
        noise.buffer = buffer;
        const noiseGain = this.audioContext.createGain();
        noiseGain.gain.setValueAtTime(this.volume * 0.5, this.audioContext.currentTime);
        noiseGain.gain.exponentialRampToValueAtTime(0.01, this.audioContext.currentTime + 0.3);
        
        noise.connect(noiseGain);
        noiseGain.connect(this.audioContext.destination);
        noise.start(this.audioContext.currentTime);
        
        // Sine sweep
        const osc = this.audioContext.createOscillator();
        const oscGain = this.audioContext.createGain();
        osc.connect(oscGain);
        oscGain.connect(this.audioContext.destination);
        
        osc.type = 'sine';
        osc.frequency.setValueAtTime(200, this.audioContext.currentTime);
        osc.frequency.exponentialRampToValueAtTime(50, this.audioContext.currentTime + 0.3);
        
        oscGain.gain.setValueAtTime(this.volume * 0.5, this.audioContext.currentTime);
        oscGain.gain.exponentialRampToValueAtTime(0.01, this.audioContext.currentTime + 0.3);
        
        osc.start(this.audioContext.currentTime);
        osc.stop(this.audioContext.currentTime + 0.3);
    }
    
    playPlayerHit() {
        if (!this.enabled || !this.audioContext) return;
        this.ensureContext();
        
        const osc = this.audioContext.createOscillator();
        const gain = this.audioContext.createGain();
        
        osc.connect(gain);
        gain.connect(this.audioContext.destination);
        
        osc.type = 'sine';
        osc.frequency.setValueAtTime(100, this.audioContext.currentTime);
        osc.frequency.exponentialRampToValueAtTime(50, this.audioContext.currentTime + 0.2);
        
        gain.gain.setValueAtTime(this.volume * 0.8, this.audioContext.currentTime);
        gain.gain.exponentialRampToValueAtTime(0.01, this.audioContext.currentTime + 0.2);
        
        osc.start(this.audioContext.currentTime);
        osc.stop(this.audioContext.currentTime + 0.2);
        osc.disconnect();
        gain.disconnect();
    }
    
    playPowerUpCollect() {
        if (!this.enabled || !this.audioContext) return;
        this.ensureContext();
        
        const notes = [523.25, 659.25, 783.99]; // C5, E5, G5
        
        notes.forEach((freq, i) => {
            const osc = this.audioContext.createOscillator();
            const gain = this.audioContext.createGain();
            
            osc.connect(gain);
            gain.connect(this.audioContext.destination);
            
            osc.type = 'sine';
            osc.frequency.setValueAtTime(freq, this.audioContext.currentTime + i * 0.05);
            
            gain.gain.setValueAtTime(0, this.audioContext.currentTime + i * 0.05);
            gain.gain.linearRampToValueAtTime(this.volume, this.audioContext.currentTime + i * 0.05 + 0.01);
            gain.gain.exponentialRampToValueAtTime(0.01, this.audioContext.currentTime + i * 0.05 + 0.05);
            
            osc.start(this.audioContext.currentTime + i * 0.05);
            osc.stop(this.audioContext.currentTime + i * 0.05 + 0.06);
        });
    }
    
    playLevelComplete() {
        if (!this.enabled || !this.audioContext) return;
        this.ensureContext();
        
        const notes = [261.63, 329.63, 392.00, 523.25]; // C4, E4, G4, C5
        
        notes.forEach((freq, i) => {
            const osc = this.audioContext.createOscillator();
            const gain = this.audioContext.createGain();
            
            osc.connect(gain);
            gain.connect(this.audioContext.destination);
            
            osc.type = 'sine';
            osc.frequency.setValueAtTime(freq, this.audioContext.currentTime + i * 0.1);
            
            gain.gain.setValueAtTime(0, this.audioContext.currentTime + i * 0.1);
            gain.gain.linearRampToValueAtTime(this.volume, this.audioContext.currentTime + i * 0.1 + 0.02);
            gain.gain.exponentialRampToValueAtTime(0.01, this.audioContext.currentTime + i * 0.1 + 0.1);
            
            osc.start(this.audioContext.currentTime + i * 0.1);
            osc.stop(this.audioContext.currentTime + i * 0.1 + 0.12);
        });
    }
    
    playGameOver() {
        if (!this.enabled || !this.audioContext) return;
        this.ensureContext();
        
        const osc = this.audioContext.createOscillator();
        const gain = this.audioContext.createGain();
        
        osc.connect(gain);
        gain.connect(this.audioContext.destination);
        
        osc.type = 'sine';
        osc.frequency.setValueAtTime(300, this.audioContext.currentTime);
        osc.frequency.exponentialRampToValueAtTime(100, this.audioContext.currentTime + 0.8);
        
        gain.gain.setValueAtTime(this.volume * 0.6, this.audioContext.currentTime);
        gain.gain.exponentialRampToValueAtTime(0.01, this.audioContext.currentTime + 0.8);
        
        osc.start(this.audioContext.currentTime);
        osc.stop(this.audioContext.currentTime + 0.8);
        osc.disconnect();
        gain.disconnect();
    }
    
    playCombo(text) {
        if (!this.enabled || !this.audioContext) return;
        this.ensureContext();
        
        // Play a rising tone based on combo level
        const baseFreq = 440;
        const multiplier = parseInt(text.replace('x', '').replace(' COMBO!', '')) || 2;
        
        const osc = this.audioContext.createOscillator();
        const gain = this.audioContext.createGain();
        
        osc.connect(gain);
        gain.connect(this.audioContext.destination);
        
        osc.type = 'sine';
        osc.frequency.setValueAtTime(baseFreq, this.audioContext.currentTime);
        osc.frequency.linearRampToValueAtTime(baseFreq * (1 + multiplier * 0.2), this.audioContext.currentTime + 0.15);
        
        gain.gain.setValueAtTime(this.volume * 0.4, this.audioContext.currentTime);
        gain.gain.exponentialRampToValueAtTime(0.01, this.audioContext.currentTime + 0.15);
        
        osc.start(this.audioContext.currentTime);
        osc.stop(this.audioContext.currentTime + 0.15);
    }
}

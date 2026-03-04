// Levels Module (Level progression, wave definitions)

import { LEVEL } from './config.js';
import { audio } from './audio.js';

export class LevelManager {
    constructor() {
        this.currentLevel = 1;
        this.transitionTimer = 0;
        this.inTransition = false;
    }
    
    startLevel(level) {
        this.currentLevel = level;
        this.inTransition = true;
        this.transitionTimer = LEVEL.TRANSITION_TIME;
        
        // Play level complete sound for levels > 1
        if (level > 1) {
            audio.playLevelComplete();
        }
    }
    
    update(dt) {
        if (this.inTransition) {
            this.transitionTimer -= dt;
            if (this.transitionTimer <= 0) {
                this.inTransition = false;
                return true; // Level transition complete
            }
        }
        return false;
    }
    
    getTransitionProgress() {
        if (!this.inTransition) return 1;
        return 1 - (this.transitionTimer / LEVEL.TRANSITION_TIME);
    }
    
    isTransitioning() {
        return this.inTransition;
    }
    
    getCurrentLevel() {
        return this.currentLevel;
    }
    
    nextLevel() {
        this.currentLevel++;
        this.startLevel(this.currentLevel);
    }
    
    reset() {
        this.currentLevel = 1;
        this.inTransition = false;
        this.transitionTimer = 0;
    }
}

// Export singleton
export const levels = new LevelManager();
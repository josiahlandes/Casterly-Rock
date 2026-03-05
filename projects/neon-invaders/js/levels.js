// Levels - Level progression and wave definitions
import { CONFIG } from './config.js';

export class LevelManager {
    constructor() {
        this.currentLevel = 1;
        this.transitionTime = 0;
        this.inTransition = false;
        this.transitionMessage = '';
    }
    
    startNextLevel() {
        this.currentLevel++;
        this.inTransition = true;
        this.transitionTime = CONFIG.LEVEL_TRANSITION_TIME;
        this.transitionMessage = `LEVEL ${this.currentLevel}`;
    }
    
    startInitialLevel() {
        this.currentLevel = 1;
        this.inTransition = true;
        this.transitionTime = CONFIG.LEVEL_TRANSITION_TIME;
        this.transitionMessage = 'LEVEL 1';
    }
    
    update(dt) {
        if (this.inTransition) {
            this.transitionTime -= dt;
            if (this.transitionTime <= 0) {
                this.inTransition = false;
                return true; // Transition complete
            }
        }
        return false;
    }
    
    isTransitioning() {
        return this.inTransition;
    }
    
    getTransitionMessage() {
        return this.transitionMessage;
    }
    
    getCurrentLevel() {
        return this.currentLevel;
    }
    
    getStartingY() {
        // Each level starts one row lower
        return CONFIG.ENEMY_START_Y + (this.currentLevel - 1) * CONFIG.LEVEL_START_Y_OFFSET;
    }
    
    isBonusFrequencyLevel() {
        return this.currentLevel % CONFIG.LEVEL_BONUS_FREQUENCY === 0;
    }
    
    reset() {
        this.currentLevel = 1;
        this.inTransition = false;
        this.transitionTime = 0;
    }
}
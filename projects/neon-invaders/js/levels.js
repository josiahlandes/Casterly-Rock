// Level Manager for progression and wave definitions
export default class LevelManager {
    constructor(audioController) {
        this.audioController = audioController;
        this.currentLevel = 1;
        this.maxLevel = 100;
        this.transitionTime = 2000;
        this.transitionTimer = 0;
        this.inTransition = false;
    }
    
    startLevel(level) {
        this.currentLevel = level;
        this.inTransition = true;
        this.transitionTimer = this.transitionTime;
        this.audioController.playLevelComplete();
    }
    
    update(dt) {
        if (this.inTransition) {
            this.transitionTimer -= dt;
            if (this.transitionTimer <= 0) {
                this.inTransition = false;
                return true; // Transition complete
            }
        }
        return false;
    }
    
    getTransitionProgress() {
        if (!this.inTransition) return 1;
        return 1 - (this.transitionTimer / this.transitionTime);
    }
    
    isTransitioning() {
        return this.inTransition;
    }
    
    getNextLevel() {
        return Math.min(this.currentLevel + 1, this.maxLevel);
    }
    
    getCurrentLevel() {
        return this.currentLevel;
    }
    
    getStartY() {
        // Each level starts 10px lower, clamped to minimum 20px
        return Math.max(20, 60 - (this.currentLevel - 1) * 10);
    }
    
    getFireMultiplier() {
        // Every 5 levels, enemies fire 50% more
        return Math.floor(this.currentLevel / 5) > 0 ? 1.5 : 1.0;
    }
    
    reset() {
        this.currentLevel = 1;
        this.inTransition = false;
        this.transitionTimer = 0;
    }
}

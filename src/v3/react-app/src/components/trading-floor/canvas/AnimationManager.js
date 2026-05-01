// src/components/trading-floor/canvas/AnimationManager.js

/**
 * Centralized manager for sprite animations.
 * Supports:
 *  - Smooth cross‑fade transitions
 *  - Interruptible playback with priority
 *  - Gap‑filling transitional animations
 *  - Queueing and prioritization
 */
export default class AnimationManager {
    /** @param {Phaser.Scene} scene */
    constructor(scene) {
        this.scene = scene;
        this.sprites = new Map(); // sprite -> { queue: [], current: null }
        this.transitionMap = {}; // { fromKey: { toKey: 'transitionAnim' } }
    }

    /** Register a sprite for management */
    register(sprite) {
        if (!this.sprites.has(sprite)) {
            this.sprites.set(sprite, { queue: [], current: null });
        }
    }

    /** Define a transition animation between two states */
    addTransition(fromKey, toKey, transitionAnim) {
        if (!this.transitionMap[fromKey]) this.transitionMap[fromKey] = {};
        this.transitionMap[fromKey][toKey] = transitionAnim;
    }

    /** Play an animation on a sprite with options */
    play(sprite, animKey, { priority = 0, interrupt = false, blendDuration = 200 } = {}) {
        const entry = this.sprites.get(sprite);
        if (!entry) return this.register(sprite) && this.play(sprite, animKey, { priority, interrupt, blendDuration });

        const current = entry.current;
        if (current && !interrupt) {
            // Queue if lower priority
            entry.queue.push({ animKey, priority, blendDuration });
            entry.queue.sort((a, b) => b.priority - a.priority);
            return;
        }

        // If there is a current animation, try to play a transition first
        if (current && this.transitionMap[current] && this.transitionMap[current][animKey]) {
            const transAnim = this.transitionMap[current][animKey];
            this._crossFade(sprite, transAnim, blendDuration, () => {
                this._startAnim(sprite, animKey, blendDuration);
            });
        } else {
            this._startAnim(sprite, animKey, blendDuration);
        }
    }

    _startAnim(sprite, animKey, blendDuration) {
        const entry = this.sprites.get(sprite);
        entry.current = animKey;
        // Cross‑fade in new animation
        this._crossFade(sprite, animKey, blendDuration, () => {
            // After animation completes, check queue
            this._processQueue(sprite);
        });
    }

    _crossFade(sprite, animKey, duration, onComplete) {
        // Fade out current texture (if any) and fade in new one
        const prevAlpha = sprite.alpha;
        sprite.setAlpha(0);
        sprite.play(animKey);
        this.scene.tweens.add({
            targets: sprite,
            alpha: 1,
            duration: duration,
            ease: 'Linear',
            onComplete: () => {
                if (onComplete) onComplete();
            }
        });
    }

    _processQueue(sprite) {
        const entry = this.sprites.get(sprite);
        if (!entry) return;
        if (entry.queue.length === 0) {
            entry.current = null;
            return;
        }
        const next = entry.queue.shift();
        this.play(sprite, next.animKey, { priority: next.priority, interrupt: true, blendDuration: next.blendDuration });
    }

    /** Reset sprite to its idle animation */
    reset(sprite, idleKey) {
        const entry = this.sprites.get(sprite);
        if (entry) {
            entry.queue = [];
        }
        this.play(sprite, idleKey, { interrupt: true, blendDuration: 100 });
    }

    /** Cleanup resources */
    dispose() {
        this.sprites.clear();
        this.transitionMap = {};
    }
}

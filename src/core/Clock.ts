/**
 * Manages the timeline of commits with undo/redo capabilities.
 */
class Clock {
    t: number;
    p: number;

    constructor() {
        // Maximum timestamp in history
        this.t = 0;
        // Current position in history
        this.p = 0;
    }

    /**
     * Advances the clock, handling branch truncation if needed.
     * @returns {number} New current time
     */
    tick(): number {
        if (this.p < this.t) {
            // Truncate future history when branching
            this.t = this.p;
        }
        this.p++;
        this.t = this.p;
        return this.p;
    }

    /**
     * Moves backward in time.
     * @returns {number} New current time
     */
    undo(): number {
        if (this.p > 0) this.p--;
        return this.p;
    }

    /**
     * Moves forward in time.
     * @returns {number} New current time
     */
    redo(): number {
        if (this.p < this.t) this.p++;
        return this.p;
    }

    /**
     * Returns true if undo is possible (not at the beginning of history).
     */
    canUndo(): boolean {
        return this.p > 0;
    }

    /**
     * Returns true if redo is possible (not at the end of history).
     */
    canRedo(): boolean {
        return this.p < this.t;
    }

    /**
     * Gets current time.
     * @returns {number}
     */
    peek(): number {
        return this.p;
    }

    /**
     * Gets maximum available time.
     * @returns {number}
     */
    max(): number {
        return this.t;
    }

    /**
     * Jumps to a specific time (for advanced use cases).
     * @param {number} time
     */
    resetTo(time: number): void {
        if (time >= 0 && time <= this.t) {
            this.p = time;
        }
    }
}

export default Clock;

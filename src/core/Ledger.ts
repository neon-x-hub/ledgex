import Clock from "./Clock.js";
import Layer from "./Layer.js";

interface LedgerOptions {
    bufferSize?: number;
    toleranceWindow?: number;
}

class Ledger {
    clock: Clock;
    layers: Map<string, Layer>;
    genesis: Layer;
    bufferSize: number;
    toleranceWindow: number;
    lastFlushTime: number;
    subscribers: Set<() => void>;
    _pendingNotification: boolean;

    /**
     * Initializes a new instance of the Ledger class.
     * @param {Object} [options] - Optional parameters to customize behavior.
     * @param {number} [options.bufferSize=100] - Maximum number of history records to store.
     * @param {number} [options.toleranceWindow=20] - Time window for ignoring intermediate state updates.
     */
    constructor({ bufferSize = 100, toleranceWindow = 20 }: LedgerOptions = {}) {
        this.clock = new Clock();
        this.layers = new Map();
        this.genesis = new Layer(this.clock);
        this.bufferSize = bufferSize;
        this.toleranceWindow = toleranceWindow;
        this.lastFlushTime = 0;
        this.subscribers = new Set();
        this._pendingNotification = false;
    }

    /**
     * Set values at current time, automatically flattening nested objects
     * @param {Record<string, Record<string, any>>} updates - Key-value pairs of layerId and updates
     * @return {void}
     */
    set(updates: Record<string, Record<string, any>>): void {
        // 1. Check for meaningful updates
        let hasMeaningfulUpdate = false;
        const timeBeforeCheck = this.clock.peek();

        for (const [layerId, layerUpdates] of Object.entries(updates)) {
            const layer = this.layers.get(layerId);
            if (!layer) {
                // New layer is a meaningful update if updates object has keys
                if (Object.keys(layerUpdates).length > 0) {
                    hasMeaningfulUpdate = true;
                    break;
                }
            } else {
                if (layer.isUpdateMeaningful(layerUpdates, timeBeforeCheck)) {
                    hasMeaningfulUpdate = true;
                    break;
                }
            }
        }

        if (!hasMeaningfulUpdate) return;

        const isFork = this.clock.p < this.clock.t;
        const time = this.clock.tick();

        if (isFork) {
            this.prune(time);
        }

        for (const [layerId, layerUpdates] of Object.entries(updates)) {
            this._getLayer(layerId, time).set(layerUpdates, time);
        }

        this._autoFlush(time);

        this._notify();
    }

    /**
     * Returns a layer object with the given layerId.
     * If the layer does not exist, it will be created and its genesis will be set to true.
     * If the layer exists but is not active at the given time, it will be marked as active.
     * @param {string} layerId
     * @param {number} [timeIfNotSet=this.clock.peek()] - Time to set genesis if layer is not active
     * @returns {Layer} The layer object
     */
    _getLayer(layerId: string, timeIfNotSet: number = this.clock.peek()): Layer {
        if (!this.layers.has(layerId)) {
            const layer = new Layer(this.clock);
            this.layers.set(layerId, layer);
            this.genesis.set(layerId, true, timeIfNotSet);
        } else if (!this._isLayerActive(layerId, timeIfNotSet)) {
            this.genesis.set(layerId, true, timeIfNotSet);
        }
        return this.layers.get(layerId)!;
    }

    /**
     * Gets the state of the given layerIds or all layers at a specific time (defaults to current time).
     * @param {string[]|undefined} layerIds - Optional array of layerIds to get state for.
     * @param {number} [time=this.clock.peek()] - Time to query state at.
     * @returns {Record<string, Record<string, any>>} - Object with layerId as key and state as value.
     */
    get(layerIds?: string[], time: number = this.clock.peek()): Record<string, Record<string, any>> {
        const result: Record<string, Record<string, any>> = {};
        const targets = layerIds || [...this.layers.keys()];

        for (const layerId of targets) {
            if (this._isLayerActive(layerId, time)) {
                result[layerId] = this.layers.get(layerId)!.getState(time);
            }
        }
        return result;
    }

    /**
     * Reverts the state to the previous meaningful state.
     * If there is no previous state, this method does nothing.
     * @returns {Record<string, Record<string, any>>|undefined} The state after the undo operation.
     *  If there was no previous state, this method returns undefined.
     */
    undo(): Record<string, Record<string, any>> | undefined {
        const prevTime = this.clock.peek();
        const time = this.clock.undo();
        if (time === prevTime) {
            return undefined;
        }
        const state = this.get();
        this._notify();
        return state;
    }

    /**
     * Re-applies the state to the next meaningful state.
     * If there is no next state, this method does nothing.
     * @returns {Record<string, Record<string, any>>|undefined} The state after the redo operation.
     *  If there was no next state, this method returns undefined.
     */
    redo(): Record<string, Record<string, any>> | undefined {
        const prevTime = this.clock.peek();
        const time = this.clock.redo();
        if (time === prevTime) {
            return undefined;
        }
        const state = this.get();
        this._notify();
        return state;
    }

    /**
     * Deactivates a layer.
     * If the layer does not exist or is already inactive, this method does nothing.
     * @param {string} layerId - The ID of the layer to deactivate
     * @returns {void}
     */
    remove(layerId: string): void {
        if (this._isLayerActive(layerId)) {
            const isFork = this.clock.p < this.clock.t;
            const time = this.clock.tick();
            if (isFork) {
                this.prune(time);
            }
            this.genesis.set(layerId, false, time);
            this._notify();
        }
    }

    /**
     * Prunes the history of all layers and genesis to the given minTime.
     * This method removes all history entries older than minTime and also removes any layers that end up with no state.
     * This is useful for memory management, as it removes all unnecessary history entries.
     * @param {number} minTime - The minimum time to keep history for.
     * @returns {void}
     */
    prune(minTime: number): void {
        for (const [layerId, layer] of this.layers) {
            layer.prune(minTime);
            const state = layer.getState();
            if (state && Object.keys(state).length === 0) {
                this.layers.delete(layerId);
            }
        }
        this.genesis.prune(minTime);
        this._notify();
    }

    /**
     * Flushes the history of all layers and genesis to the given minTime.
     * This method removes all history entries older than minTime and also removes any layers that end up with no state.
     * This is useful for memory management, as it removes all unnecessary history entries.
     * The method also updates the last flush time to the current time.
     * @returns {void}
     */
    flush(): void {
        const minTime = this.clock.t - this.bufferSize;
        this.lastFlushTime = this.clock.t;

        for (const [layerId, layer] of this.layers) {
            layer.flush(minTime);
        }
        this.genesis.flush(minTime);
        this._notify();
    }

    _isLayerActive(layerId: string, time: number = this.clock.peek()): boolean {
        const layerState = this.genesis.get(layerId, time);
        return layerState || false;
    }

    _autoFlush(currentTime: number): void {
        if (currentTime - this.lastFlushTime >
            (this.bufferSize + this.toleranceWindow)) {
            this.flush();
        }
    }

    /**
     * Subscribe to state changes
     * @param {Function} callback - Called after any state change
     * @returns {Function} Unsubscribe function
     */
    subscribe(callback: () => void): () => void {
        this.subscribers.add(callback);
        return () => this.subscribers.delete(callback);
    }

    /**
     * Notify all subscribers (internal)
     */
    _notify(): void {
        if (this._pendingNotification) return;
        this._pendingNotification = true;
        queueMicrotask(() => {
            this._pendingNotification = false;
            this.subscribers.forEach(cb => cb());
        });
    }
}

export default Ledger;

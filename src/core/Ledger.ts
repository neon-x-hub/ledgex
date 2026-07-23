import Clock from "./Clock.js";
import Layer from "./Layer.js";
import CommitNode from "./CommitNode.js";

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
            const layer = this._getLayer(layerId, this.clock.peek() + 1);
            if (layer.isUpdateMeaningful(layerUpdates, timeBeforeCheck)) {
                hasMeaningfulUpdate = true;
                break;
            }
        }

        if (!hasMeaningfulUpdate) return;

        const isFork = this.clock.p < this.clock.t;
        const time = this.clock.tick();

        if (isFork) {
            this.prune(time);
        }

        for (const [layerId, layerUpdates] of Object.entries(updates)) {
            this._getLayer(layerId).set(layerUpdates, time);
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
     * Gets the current state of the given layerIds or all layers if no layerIds are provided.
     * @param {string[]|undefined} layerIds - Optional array of layerIds to get state for.
     * @returns {Record<string, Record<string, any>>} - Object with layerId as key and current state as value.
     */
    get(layerIds?: string[]): Record<string, Record<string, any>> {
        const result: Record<string, Record<string, any>> = {};
        const targets = layerIds || [...this.layers.keys()];
        const time = this.clock.peek();

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
     * @returns {Record<string, Record<string, any>>|undefined} The state before the undo operation.
     *  If there was no previous state, this method returns undefined.
     */
    undo(): Record<string, Record<string, any>> | undefined {
        const time = this.clock.undo();
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
        const time = this.clock.redo();
        const state = this.get();
        this._notify();
        return state;
    }

    /**
     * Deactivates a layer.
     * If the layer does not exist, this method does nothing.
     * @param {string} layerId - The ID of the layer to deactivate
     * @returns {void}
     */
    remove(layerId: string): void {
        this.clock.tick();
        this.genesis.set(layerId, false);
        this._notify();
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

    // Internal Utilities
    _getOrCreateLayer(layerId: string): Layer {
        if (!this.layers.has(layerId)) {
            const layer = new Layer(this.clock);
            this.layers.set(layerId, layer);
            this.genesis.set(layerId, [
                new CommitNode(this.clock.t, true)
            ]);
        }
        return this.layers.get(layerId)!;
    }

    _isLayerActive(layerId: string, time?: number): boolean {
        const layerState = this.genesis.get(layerId);
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
        queueMicrotask(() => {
            this.subscribers.forEach(cb => cb());
        });
    }
}

export default Ledger;

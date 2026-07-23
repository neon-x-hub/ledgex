import Clock from "./Clock.js";
import Layer from "./Layer.js";

export interface LedgerOptions {
    bufferSize?: number;
    toleranceWindow?: number;
}

export interface HistoryEntry {
    time: number;
    label?: string;
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
    _pendingChangedLayers: Set<string> | 'all';
    _layerSubscribers: Map<string, Set<(state: Record<string, any> | undefined) => void>>;
    _history: Map<number, string | undefined>;


    /**
     * Initializes a new instance of the Ledger class.
     * @param {LedgerOptions} [options] - Optional parameters to customize behavior.
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
        this._pendingChangedLayers = new Set();
        this._layerSubscribers = new Map();
        this._history = new Map();

    }

    // ─── Core Methods ────────────────────────────────────────────────────────

    /**
     * Sets values on one or more layers at the current time.
     * Pass multiple layers to group them into a single undo/redo step.
     * Automatically flattens nested plain objects into dot-notation keys.
     * @param {Record<string, Record<string, any>>} updates - Map of layerId → key-value updates.
     * @param {{ label?: string }} [options] - Optional. `label` names this step in `getHistory()`.
     */
    set(updates: Record<string, Record<string, any>>, options?: { label?: string }): void {
        // Check for meaningful updates without touching layer state
        let hasMeaningfulUpdate = false;
        const timeBeforeCheck = this.clock.peek();

        for (const [layerId, layerUpdates] of Object.entries(updates)) {
            const layer = this.layers.get(layerId);
            if (!layer) {
                if (Object.keys(layerUpdates).length > 0) {
                    hasMeaningfulUpdate = true;
                    break;
                }
            } else if (layer.isUpdateMeaningful(layerUpdates, timeBeforeCheck)) {
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

        this._history.set(time, options?.label);

        const changedLayers: string[] = [];
        for (const [layerId, layerUpdates] of Object.entries(updates)) {
            this._getLayer(layerId, time).set(layerUpdates, time);
            changedLayers.push(layerId);
        }

        this._autoFlush(time);
        this._notify(changedLayers);
    }

    /**
     * Gets the state of the given layerIds or all layers at a specific time.
     * @param {string[]} [layerIds] - Optional array of layerIds to get state for.
     * @param {number} [time=this.clock.peek()] - Time step to query state at.
     * @returns {Record<string, Record<string, any>>}
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
     * Returns `undefined` if already at the beginning of history.
     */
    undo(): Record<string, Record<string, any>> | undefined {
        const prevTime = this.clock.peek();
        const time = this.clock.undo();
        if (time === prevTime) return undefined;
        const state = this.get();
        this._notify('all');
        return state;
    }

    /**
     * Re-applies the next meaningful state.
     * Returns `undefined` if already at the end of history.
     */
    redo(): Record<string, Record<string, any>> | undefined {
        const prevTime = this.clock.peek();
        const time = this.clock.redo();
        if (time === prevTime) return undefined;
        const state = this.get();
        this._notify('all');
        return state;
    }

    /**
     * Returns true if undo is possible (not at the beginning of history).
     */
    canUndo(): boolean {
        return this.clock.canUndo();
    }

    /**
     * Returns true if redo is possible (not at the end of history).
     */
    canRedo(): boolean {
        return this.clock.canRedo();
    }

    /**
     * Deactivates a layer at the current time.
     * Does nothing if the layer is already inactive.
     * @param {string} layerId
     */
    remove(layerId: string): void {
        if (this._isLayerActive(layerId)) {
            const isFork = this.clock.p < this.clock.t;
            const time = this.clock.tick();
            if (isFork) {
                this.prune(time);
            }
            this.genesis.set(layerId, false, time);
            this._history.set(time, undefined);
            this._notify([layerId]);
        }
    }

    /**
     * Resets the entire Ledger to its initial empty state.
     * All layers, history, and subscriptions state are cleared.
     * Global and layer-scoped subscribers are NOT removed, but are notified.
     */
    clear(): void {
        this.clock = new Clock();
        this.layers = new Map();
        this.genesis = new Layer(this.clock);
        this.lastFlushTime = 0;
        this._history = new Map();
        this._pendingNotification = false;

        this._pendingChangedLayers = new Set();
        this._notify('all');
    }

    /**
     * Returns a sorted list of history entries for each meaningful time step.
     * Entries that had a `label` passed to `set()` will include it.
     * @returns {HistoryEntry[]}
     */
    getHistory(): HistoryEntry[] {
        const entries: HistoryEntry[] = [];
        for (const [time, label] of this._history) {
            entries.push(label !== undefined ? { time, label } : { time });
        }
        return entries.sort((a, b) => a.time - b.time);
    }

    /**
     * Prunes the history of all layers and genesis to the given minTime.
     * Removes history entries older than minTime. Layers with no remaining
     * state are deleted.
     * @param {number} minTime
     */
    prune(minTime: number): void {
        for (const [layerId, layer] of this.layers) {
            layer.prune(minTime);
            if (Object.keys(layer.getState()).length === 0) {
                this.layers.delete(layerId);
            }
        }
        this.genesis.prune(minTime);
        for (const time of this._history.keys()) {
            if (time < minTime) this._history.delete(time);
        }
        this._notify();
    }

    /**
     * Flushes history of all layers, keeping only the last `bufferSize` steps.
     * Called automatically when history grows too large.
     */
    flush(): void {
        const minTime = this.clock.t - this.bufferSize;
        this.lastFlushTime = this.clock.t;
        for (const layer of this.layers.values()) {
            layer.flush(minTime);
        }
        this.genesis.flush(minTime);
        for (const time of this._history.keys()) {
            if (time < minTime) this._history.delete(time);
        }
        this._notify();
    }

    // ─── Subscriptions ───────────────────────────────────────────────────────

    /**
     * Subscribes to any state change across all layers.
     * @param {Function} callback - Called after any state change (asynchronously).
     * @returns {Function} Unsubscribe function.
     */
    subscribe(callback: () => void): () => void {
        this.subscribers.add(callback);
        return () => this.subscribers.delete(callback);
    }

    /**
     * Subscribes to changes for a specific layer only.
     * The callback receives the new layer state, or `undefined` if the layer
     * was deactivated. The internal subscriber map entry is cleaned up when
     * the last subscriber for that layer unsubscribes.
     * @param {string} layerId
     * @param {Function} callback - Called with the layer's new state.
     * @returns {Function} Unsubscribe function.
     */
    subscribeToLayer(layerId: string, callback: (state: Record<string, any> | undefined) => void): () => void {
        if (!this._layerSubscribers.has(layerId)) {
            this._layerSubscribers.set(layerId, new Set());
        }
        this._layerSubscribers.get(layerId)!.add(callback);
        return () => {
            const subs = this._layerSubscribers.get(layerId);
            if (subs) {
                subs.delete(callback);
                // Clean up map entry when last subscriber is removed
                if (subs.size === 0) {
                    this._layerSubscribers.delete(layerId);
                }
            }
        };
    }

    // ─── Internal Utilities ──────────────────────────────────────────────────



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

    _isLayerActive(layerId: string, time: number = this.clock.peek()): boolean {
        return this.genesis.get(layerId, time) || false;
    }

    _autoFlush(currentTime: number): void {
        if (currentTime - this.lastFlushTime > (this.bufferSize + this.toleranceWindow)) {
            this.flush();
        }
    }

    _notify(changedLayers?: 'all' | string[]): void {
        // Accumulate changed layers
        if (changedLayers) {
            if (changedLayers === 'all') {
                this._pendingChangedLayers = 'all';
            } else if (this._pendingChangedLayers !== 'all') {
                changedLayers.forEach(l => (this._pendingChangedLayers as Set<string>).add(l));
            }
        }
        // Deduplicate: only schedule one microtask per tick
        if (this._pendingNotification) return;
        this._pendingNotification = true;
        queueMicrotask(() => {
            this._pendingNotification = false;
            const changed = this._pendingChangedLayers;
            this._pendingChangedLayers = new Set();

            // Notify global subscribers
            this.subscribers.forEach(cb => cb());

            // Notify layer-scoped subscribers
            if (this._layerSubscribers.size > 0) {
                if (changed === 'all') {
                    for (const [lId, subs] of this._layerSubscribers) {
                        const state = this._isLayerActive(lId)
                            ? this.layers.get(lId)?.getState()
                            : undefined;
                        subs.forEach(cb => cb(state));
                    }
                } else {
                    for (const lId of changed) {
                        const subs = this._layerSubscribers.get(lId);
                        if (subs) {
                            const state = this._isLayerActive(lId)
                                ? this.layers.get(lId)?.getState()
                                : undefined;
                            subs.forEach(cb => cb(state));
                        }
                    }
                }
            }
        });
    }
}

export default Ledger;

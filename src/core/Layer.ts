import CommitNode from "./CommitNode.js";
import Clock from "./Clock.js";

function isPlainObject(val: any): boolean {
    if (val === null || typeof val !== 'object') return false;
    const proto = Object.getPrototypeOf(val);
    return proto === null || proto === Object.prototype;
}

class Layer {
    clock: Clock;
    flushThreshold: number;
    history: Map<string, CommitNode[]>;
    _stateCache: Map<number, Record<string, any>>;
    _hasNestedKeys: boolean;

    /**
     * @param {Clock} clock - Shared clock instance
     * @param {number} [flushThreshold=30] - Max history entries to keep per key
     */
    constructor(clock: Clock, flushThreshold: number = 30) {
        this.clock = clock;
        this.flushThreshold = flushThreshold;
        this.history = new Map();
        this._stateCache = new Map();
        this._hasNestedKeys = false;
    }

    /**
     * Sets values at current time, automatically flattening nested objects.
     * @param {string|Object} keyOrObject - Key or object of key-value pairs
     * @param {any} [valueOrTime] - Value if first param is string, or time if first param is object
     * @param {number} [time] - Custom timestamp
     */
    set(keyOrObject: string | Record<string, any>, valueOrTime?: any, time?: number): void {
        if (isPlainObject(keyOrObject)) {
            const actualTime = typeof valueOrTime === 'number' ? valueOrTime : this.clock.peek();
            const flatUpdates = this._flattenObject(keyOrObject as Record<string, any>);
            for (const [key, val] of Object.entries(flatUpdates)) {
                this._setSingleKey(key, val, actualTime);
            }
        } else {
            const actualTime = typeof time === 'number' ? time : this.clock.peek();
            this._setSingleKey(keyOrObject as string, valueOrTime, actualTime);
        }
    }

    isUpdateMeaningful(updates: any, time: number): boolean {
        if (updates === null || typeof updates !== 'object') return false;

        const flat = this._flattenObject(updates);

        return Object.entries(flat).some(([key, val]) => {
            const commits = this.history.get(key) || [];
            const prev = this._findLatestCommit(commits, time)?.v;
            return !CommitNode.valuesEqual(prev, val);
        });
    }

    _trimHistory(minTime: number, { direction = "after", keepLatest = false }: { direction?: "before" | "after"; keepLatest?: boolean } = {}): void {
        this._stateCache.clear();
        for (const [key, commits] of this.history) {
            if (commits.length === 0) continue;
            const effectiveMinTime = direction === "before" ? minTime - 1 : minTime;
            const lastValid = this._findLatestCommit(commits, effectiveMinTime);
            const idx = lastValid ? commits.indexOf(lastValid) : -1;
            let newCommits: CommitNode[];
            if (lastValid) {
                if (direction === "after") {
                    // Keep from lastValid onward, rebasing its timestamp
                    lastValid.t = minTime;
                    newCommits = commits.slice(idx);
                } else if (direction === "before") {
                    // Keep from beginning up to and including lastValid
                    newCommits = commits.slice(0, idx + 1);
                } else {
                    throw new Error(`Unknown trim direction: ${direction}`);
                }
            } else if (keepLatest && commits.length > 0) {
                newCommits = [commits[commits.length - 1]];
            } else {
                newCommits = [];
            }
            if (newCommits.length === 0) {
                this.history.delete(key);
                continue;
            }
            this.history.set(key, newCommits);
        }
    }

    // Fork pruning (exact match)
    prune(forkTime: number): void {
        this._trimHistory(forkTime, { direction: "before", keepLatest: false });
    }

    // History flushing (keep at least one)
    flush(thresholdTime: number): void {
        this._trimHistory(thresholdTime, { direction: "after", keepLatest: true });
    }

    // Internal Helpers

    /**
     * Inserts a CommitNode into a commits array in sorted order by time.
     * Uses a fast-path append when the new commit is >= the last commit's time.
     * @private
     */
    _insertCommit(commits: CommitNode[], node: CommitNode): void {
        if (commits.length === 0 || node.t >= commits[commits.length - 1].t) {
            commits.push(node);
            return;
        }
        // Binary search for the correct insertion index
        let low = 0, high = commits.length;
        while (low < high) {
            const mid = (low + high) >> 1;
            if (commits[mid].t <= node.t) {
                low = mid + 1;
            } else {
                high = mid;
            }
        }
        commits.splice(low, 0, node);
    }

    _setSingleKey(key: string, value: any, time: number): void {
        this._stateCache.clear();
        const commits = this.history.get(key) || [];
        this._insertCommit(commits, new CommitNode(time, value));
        this.history.set(key, commits);

        if (key.includes('.')) {
            this._hasNestedKeys = true;
        }

        // Shadow/tombstone any nested sub-keys starting with `${key}.`
        if (this._hasNestedKeys) {
            const prefix = `${key}.`;
            for (const existingKey of this.history.keys()) {
                if (existingKey.startsWith(prefix)) {
                    const subCommits = this.history.get(existingKey)!;
                    if (subCommits.length > 0 && subCommits[subCommits.length - 1].v !== undefined) {
                        this._insertCommit(subCommits, new CommitNode(time, undefined));
                    }
                }
            }
        }

        // Shadow/tombstone any parent keys
        const parts = key.split('.');
        let parentKey = '';
        for (let i = 0; i < parts.length - 1; i++) {
            parentKey = parentKey ? `${parentKey}.${parts[i]}` : parts[i];
            const parentCommits = this.history.get(parentKey);
            if (parentCommits && parentCommits.length > 0 && parentCommits[parentCommits.length - 1].v !== undefined) {
                this._insertCommit(parentCommits, new CommitNode(time, undefined));
            }
        }
    }

    /**
     * Marks a key as deleted at current time
     * @param {string} key
     */
    remove(key: string): void {
        this.set(key, undefined); // Tombstone
    }

    /**
     * Gets value of a key at specific time (defaults to current time)
     * @param {string} key
     * @param {number} [time=this.clock.peek()]
     * @returns {any|undefined} undefined means key doesn't exist at this time
     */
    get(key: string, time: number = this.clock.peek()): any {
        const commits = this.history.get(key);
        if (!commits || commits.length === 0) return undefined;
        return this._findLatestCommit(commits, time)?.v;
    }

    /**
     * Gets full state at specific time
     * @param {number} [time=this.clock.peek()]
     * @returns {Object} Key-value pairs of alive keys
     */
    getState(time: number = this.clock.peek()): Record<string, any> {
        if (this._stateCache.has(time)) {
            return this._stateCache.get(time)!;
        }
        const state: Record<string, any> = {};
        for (const [key, commits] of this.history) {
            const value = this._findLatestCommit(commits, time)?.v;
            if (value !== undefined) { // Skip tombstones
                state[key] = value;
            }
        }
        const deflattened = this._deflattenObject(state);
        this._stateCache.set(time, deflattened);
        return deflattened;
    }

    /**
     * Binary search for latest commit <= target time
     * @private
     */
    _findLatestCommit(commits: CommitNode[], targetTime: number): CommitNode | undefined {
        let low = 0;
        let high = commits.length - 1;
        let result: CommitNode | undefined;

        while (low <= high) {
            const mid = (low + high) >> 1;
            if (commits[mid].t <= targetTime) {
                result = commits[mid];
                low = mid + 1;
            } else {
                high = mid - 1;
            }
        }
        return result;
    }

    /**
     * Recursively flattens nested plain objects into dot-notation keys.
     * Throws a descriptive error if a circular reference is detected.
     * @private
     */
    _flattenObject(
        obj: Record<string, any>,
        prefix: string = '',
        _visited: WeakSet<object> = new WeakSet(),
        target: Record<string, any> = {}
    ): Record<string, any> {
        if (_visited.has(obj)) {
            throw new Error(`Circular reference detected at key "${prefix || '(root)'}"`);
        }
        _visited.add(obj);

        for (const k in obj) {
            const val = obj[k];
            const fullKey = prefix.length ? `${prefix}.${k}` : k;
            if (isPlainObject(val)) {
                this._flattenObject(val, fullKey, _visited, target);
            } else {
                target[fullKey] = val;
            }
        }
        return target;
    }

    /**
     * Recursively deflattens an object with dot notation keys
     * back into a nested object structure.
     * @private
     */
    _deflattenObject(obj: Record<string, any>): Record<string, any> {
        const result: Record<string, any> = {};
        for (const key in obj) {
            const value = obj[key];
            const firstDot = key.indexOf('.');
            
            if (firstDot === -1) {
                // Fast path for non-nested keys: no array allocations or string splits
                result[key] = value;
                continue;
            }

            let current = result;
            let start = 0;
            let dotIdx = firstDot;

            while (dotIdx !== -1) {
                const part = key.substring(start, dotIdx);
                let next = current[part];
                if (next === undefined || typeof next !== 'object' || next === null) {
                    next = {};
                    current[part] = next;
                }
                current = next;
                start = dotIdx + 1;
                dotIdx = key.indexOf('.', start);
            }
            current[key.substring(start)] = value;
        }
        return result;
    }
}

export default Layer;

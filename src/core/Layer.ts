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

    /**
     * @param {Clock} clock - Shared clock instance
     * @param {number} [flushThreshold=30] - Max history entries to keep per key
     */
    constructor(clock: Clock, flushThreshold: number = 30) {
        this.clock = clock;
        this.flushThreshold = flushThreshold;
        this.history = new Map(); // Map<string, CommitNode<any>[]>
    }

    /**
     * Sets values at current time, automatically flattening nested objects
     * @param {string|Object} keyOrObject - Key or object of key-value pairs
     * @param {any} [valueOrTime] - Required if first param is string
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
        for (const [key, commits] of this.history) {
            if (commits.length === 0) continue;
            const effectiveMinTime = direction === "before" ? minTime - 1 : minTime;
            const lastValid = this._findLatestCommit(commits, effectiveMinTime);
            const idx = commits.indexOf(lastValid!);
            let newCommits: CommitNode[];
            if (lastValid) {
                if (direction === "after") {
                    // Keep from lastValid onward
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
            // if the newCommits is empty, remove the key
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
    _setSingleKey(key: string, value: any, time: number): void {
        const commits = this.history.get(key) || [];
        commits.push(new CommitNode(time, value));
        this.history.set(key, commits);

        // 1. Shadow/tombstone any nested keys starting with `${key}.`
        const prefix = `${key}.`;
        for (const existingKey of this.history.keys()) {
            if (existingKey.startsWith(prefix)) {
                const subCommits = this.history.get(existingKey);
                if (subCommits && subCommits.length > 0 && subCommits[subCommits.length - 1].v !== undefined) {
                    subCommits.push(new CommitNode(time, undefined));
                }
            }
        }

        // 2. Shadow/tombstone any parent keys
        const parts = key.split('.');
        let parentKey = '';
        for (let i = 0; i < parts.length - 1; i++) {
            parentKey = parentKey ? `${parentKey}.${parts[i]}` : parts[i];
            const parentCommits = this.history.get(parentKey);
            if (parentCommits && parentCommits.length > 0 && parentCommits[parentCommits.length - 1].v !== undefined) {
                parentCommits.push(new CommitNode(time, undefined));
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
        const state: Record<string, any> = {};
        for (const [key, commits] of this.history) {
            const value = this._findLatestCommit(commits, time)?.v;
            if (value !== undefined) { // Skip tombstones
                state[key] = value;
            }
        }
        return this._deflattenObject(state);
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
            const mid = (low + high) >> 1; // Bitwise version is slightly faster
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
     * Recursively flattens nested objects into dot notation
     * @private
     */
    _flattenObject(obj: Record<string, any>, prefix: string = ''): Record<string, any> {
        return Object.keys(obj).reduce((acc: Record<string, any>, k: string) => {
            const pre = prefix.length ? `${prefix}.` : '';
            if (isPlainObject(obj[k])) {
                Object.assign(acc, this._flattenObject(obj[k], pre + k));
            } else {
                acc[pre + k] = obj[k];
            }
            return acc;
        }, {});
    }

    /**
     * Recursively deflattens an object with dot notation keys
     * back into a nested object structure.
     * @private
     */
    _deflattenObject(obj: Record<string, any>): Record<string, any> {
        const result: Record<string, any> = {};
        for (const [key, value] of Object.entries(obj)) {
            const keys = key.split('.');
            let current = result;
            keys.forEach((part, index) => {
                if (index === keys.length - 1) {
                    current[part] = value;
                } else {
                    if (!current[part] || typeof current[part] !== 'object') {
                        current[part] = {};
                    }
                    current = current[part];
                }
            });
        }
        return result;
    }
}

export default Layer;

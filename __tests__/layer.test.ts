import { describe, test, expect } from '@jest/globals';
import Clock from '../src/core/Clock.js';
import Layer from '../src/core/Layer.js';

function makeLayer(): { clock: Clock; layer: Layer } {
    const clock = new Clock();
    const layer = new Layer(clock);
    return { clock, layer };
}

describe('Layer – isolated unit tests', () => {

    // ─── get / set ────────────────────────────────────────────────────────────

    test('get() returns undefined for missing keys', () => {
        const { layer } = makeLayer();
        expect(layer.get('x')).toBeUndefined();
    });

    test('set() with string key stores value at current time', () => {
        const { clock, layer } = makeLayer();
        clock.tick();
        layer.set('x', 42, clock.peek());
        expect(layer.get('x')).toBe(42);
    });

    test('set() with object key flattens and stores all keys', () => {
        const { clock, layer } = makeLayer();
        clock.tick();
        layer.set({ a: 1, b: { c: 2 } }, clock.peek());
        expect(layer.get('a')).toBe(1);
        expect(layer.get('b.c')).toBe(2);
    });

    test('get() returns undefined for a key tombstoned at current time', () => {
        const { clock, layer } = makeLayer();
        clock.tick(); layer.set('x', 1, clock.peek());
        clock.tick(); layer.set('x', undefined, clock.peek());
        expect(layer.get('x')).toBeUndefined();
    });

    // ─── isUpdateMeaningful ───────────────────────────────────────────────────

    test('isUpdateMeaningful() returns false for same value', () => {
        const { clock, layer } = makeLayer();
        clock.tick(); layer.set({ x: 1 }, clock.peek());
        expect(layer.isUpdateMeaningful({ x: 1 }, clock.peek())).toBe(false);
    });

    test('isUpdateMeaningful() returns true for a different value', () => {
        const { clock, layer } = makeLayer();
        clock.tick(); layer.set({ x: 1 }, clock.peek());
        expect(layer.isUpdateMeaningful({ x: 2 }, clock.peek())).toBe(true);
    });

    test('isUpdateMeaningful() returns true for a new key', () => {
        const { clock, layer } = makeLayer();
        clock.tick();
        expect(layer.isUpdateMeaningful({ x: 1 }, clock.peek())).toBe(true);
    });

    // ─── flush / prune ────────────────────────────────────────────────────────

    test('flush() keeps the latest commit per key', () => {
        const { clock, layer } = makeLayer();
        clock.tick(); layer.set({ x: 1 }, clock.peek()); // t=1
        clock.tick(); layer.set({ x: 2 }, clock.peek()); // t=2
        clock.tick(); layer.set({ x: 3 }, clock.peek()); // t=3
        layer.flush(2); // keep from t=2 onward
        expect(layer.get('x', 3)).toBe(3);
        expect(layer.get('x', 2)).toBe(2);
        expect(layer.get('x', 1)).toBeUndefined(); // pruned
    });

    test('flush() on empty history does not throw', () => {
        const { layer } = makeLayer();
        expect(() => layer.flush(5)).not.toThrow();
    });

    test('prune() keeps only commits up to (not including) forkTime, enabling fork branching', () => {
        const { clock, layer } = makeLayer();
        clock.tick(); layer.set({ x: 1 }, clock.peek()); // t=1
        clock.tick(); layer.set({ x: 2 }, clock.peek()); // t=2
        clock.tick(); layer.set({ x: 3 }, clock.peek()); // t=3
        // prune at forkTime=3: keeps commits where t < 3 (i.e. t=1 and t=2)
        layer.prune(3);
        expect(layer.get('x', 3)).toBe(2); // last commit before t=3 was x=2
        expect(layer.get('x', 2)).toBe(2);
        expect(layer.get('x', 1)).toBe(1);
    });

    // ─── Ordered insertion ────────────────────────────────────────────────────

    test('_insertCommit() maintains sorted order for out-of-order inserts', () => {
        const { layer } = makeLayer();
        const commits: any[] = [];
        layer._insertCommit(commits, { t: 3, v: 'c' } as any);
        layer._insertCommit(commits, { t: 1, v: 'a' } as any);
        layer._insertCommit(commits, { t: 2, v: 'b' } as any);
        expect(commits.map(c => c.t)).toEqual([1, 2, 3]);
        expect(commits.map(c => c.v)).toEqual(['a', 'b', 'c']);
    });

    test('_insertCommit() fast-path appends when time >= last', () => {
        const { layer } = makeLayer();
        const commits: any[] = [{ t: 1, v: 'a' }];
        layer._insertCommit(commits, { t: 2, v: 'b' } as any);
        expect(commits.length).toBe(2);
        expect(commits[1].t).toBe(2);
    });

    // ─── Circular reference detection ────────────────────────────────────────

    test('_flattenObject() throws a descriptive error on circular reference', () => {
        const { clock, layer } = makeLayer();
        clock.tick();
        const obj: any = { x: 1 };
        obj.self = obj; // circular!
        expect(() => layer.set(obj, clock.peek())).toThrow(/circular/i);
    });

    test('_flattenObject() does not throw for non-circular nested objects', () => {
        const { clock, layer } = makeLayer();
        clock.tick();
        expect(() => layer.set({ a: { b: { c: 42 } } }, clock.peek())).not.toThrow();
        expect(layer.get('a.b.c')).toBe(42);
    });

    // ─── Date preservation ────────────────────────────────────────────────────

    test('Date objects are stored as-is and not recursively flattened', () => {
        const { clock, layer } = makeLayer();
        const d = new Date('2026-01-01');
        clock.tick(); layer.set({ d }, clock.peek());
        expect(layer.get('d')).toBeInstanceOf(Date);
        expect(layer.get('d').getTime()).toBe(d.getTime());
    });
});

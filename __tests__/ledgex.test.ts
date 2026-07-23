import { Ledgex } from "../src/index.js";
import { jest } from '@jest/globals';

describe("Ledger – functional correctness", () => {
    let ledger: Ledgex;

    beforeEach(() => {
        ledger = new Ledgex({ bufferSize: 5, toleranceWindow: 2 });
    });

    // -------------------------
    // Basic behavior
    // -------------------------
    test("initial state is empty", () => {
        expect(ledger.get()).toEqual({});
    });

    test("set() creates a layer and stores state", () => {
        ledger.set({
            layerA: { count: 1 }
        });

        const state = ledger.get();

        expect(state.layerA).toEqual({ count: 1 });
    });

    test("multiple layers are stored independently", () => {
        ledger.set({
            layerA: { a: 1 },
            layerB: { b: 2 }
        });

        const state = ledger.get();

        expect(state.layerA).toEqual({ a: 1 });
        expect(state.layerB).toEqual({ b: 2 });
    });

    // -------------------------
    // Time progression
    // -------------------------
    test("subsequent sets advance time and overwrite state", () => {
        ledger.set({ layerA: { x: 1 } });
        ledger.set({ layerA: { x: 2 } });

        const state = ledger.get();

        expect(state.layerA).toEqual({ x: 2 });
    });

    test("undo restores previous state", () => {
        ledger.set({ layerA: { v: 1 } });
        ledger.set({ layerA: { v: 2 } });

        ledger.undo();
        const state = ledger.get();

        expect(state.layerA).toEqual({ v: 1 });
    });

    test("redo reapplies undone state", () => {
        ledger.set({ layerA: { v: 1 } });
        ledger.set({ layerA: { v: 2 } });

        ledger.undo();
        ledger.redo();

        const state = ledger.get();

        expect(state.layerA).toEqual({ v: 2 });
    });

    // -------------------------
    // Layer activation / removal
    // -------------------------
    test("remove() deactivates a layer", () => {
        ledger.set({ layerA: { x: 1 } });
        ledger.remove("layerA");

        const state = ledger.get();

        expect(state.layerA).toBeUndefined();
    });

    test("removed layer can be re-added later", () => {
        ledger.set({ layerA: { x: 1 } });
        ledger.remove("layerA");
        ledger.set({ layerA: { x: 2 } });

        const state = ledger.get();

        expect(state.layerA).toEqual({ x: 2 });
    });

    // -------------------------
    // Partial get()
    // -------------------------
    test("get(layerIds) returns only requested layers", () => {
        ledger.set({
            layerA: { a: 1 },
            layerB: { b: 2 }
        });

        const state = ledger.get(["layerB"]);

        expect(state).toEqual({ layerB: { b: 2 } });
    });

    // -------------------------
    // Flushing
    // -------------------------
    test("flush does not change visible state", () => {
        ledger.set({ layerA: { x: 1 } });
        ledger.set({ layerA: { x: 2 } });

        const before = ledger.get();
        ledger.flush();
        const after = ledger.get();

        expect(after).toEqual(before);
    });

    test("autoFlush triggers after buffer + tolerance exceeded", () => {
        ledger.set({ layerA: { x: 1 } });

        for (let i = 0; i < 10; i++) {
            ledger.set({ layerA: { x: i } });
        }

        expect(ledger.lastFlushTime).toBeGreaterThan(0);
    });

    // -------------------------
    // Meaningful update filtering
    // -------------------------
    test("no-op updates do not advance time", () => {
        ledger.set({ layerA: { x: 1 } });
        const timeBefore = ledger.clock.peek();

        // same value again
        ledger.set({ layerA: { x: 1 } });

        const timeAfter = ledger.clock.peek();

        expect(timeAfter).toBe(timeBefore);
    });

    // -------------------------
    // Fork handling
    // -------------------------
    test("setting after undo creates a fork and preserves correctness", () => {
        ledger.set({ layerA: { v: 1 } });
        ledger.set({ layerA: { v: 2 } });

        ledger.undo();
        ledger.set({ layerA: { v: 3 } });

        const state = ledger.get();

        expect(state.layerA).toEqual({ v: 3 });
    });

    // -------------------------
    // Subscriptions
    // -------------------------
    test("subscriber is notified after state change", async () => {
        const cb = jest.fn();
        ledger.subscribe(cb as any);

        ledger.set({ layerA: { x: 1 } });

        await Promise.resolve(); // flush microtask

        expect(cb).toHaveBeenCalledTimes(1);
    });

    test("unsubscribe prevents further notifications", async () => {
        const cb = jest.fn();
        const unsubscribe = ledger.subscribe(cb as any);

        unsubscribe();
        ledger.set({ layerA: { x: 1 } });

        await Promise.resolve();

        expect(cb).not.toHaveBeenCalled();
    });

    // -------------------------
    // Invariants
    // -------------------------
    test("get() never returns inactive layers", () => {
        ledger.set({ layerA: { x: 1 } });
        ledger.remove("layerA");

        ledger.set({ layerB: { y: 2 } });

        const state = ledger.get();

        expect(state).toEqual({ layerB: { y: 2 } });
    });

    // -------------------------
    // Regression & Bug Fix Verification
    // -------------------------
    test("Date objects are preserved and not flattened", () => {
        const testDate = new Date("2026-07-23T18:00:00.000Z");
        ledger.set({
            layerA: { created: testDate }
        });
        const state = ledger.get();
        expect(state.layerA.created).toBeInstanceOf(Date);
        expect(state.layerA.created.getTime()).toBe(testDate.getTime());
    });

    test("overwriting parent key shadows all nested keys", () => {
        ledger.set({
            layerA: { user: { name: "Alice", age: 30 } }
        });
        expect(ledger.get().layerA).toEqual({ user: { name: "Alice", age: 30 } });

        // Overwrite user object with primitive
        ledger.set({
            layerA: { user: "Bob" }
        });
        expect(ledger.get().layerA).toEqual({ user: "Bob" });

        // Overwrite user with undefined (deleting it)
        ledger.set({
            layerA: { user: undefined }
        });
        expect(ledger.get().layerA).toEqual({});
    });

    test("setting nested key shadows previous parent primitive values", () => {
        ledger.set({
            layerA: { user: "Bob" }
        });
        expect(ledger.get().layerA).toEqual({ user: "Bob" });

        // Now set nested key user.name
        ledger.set({
            layerA: { user: { name: "Alice" } }
        });
        expect(ledger.get().layerA).toEqual({ user: { name: "Alice" } });
    });

    test("historical state queries get() with time parameter", () => {
        ledger.set({ layerA: { x: 1 } }); // t=1
        ledger.set({ layerA: { x: 2 } }); // t=2

        expect(ledger.get(undefined, 1)).toEqual({ layerA: { x: 1 } });
        expect(ledger.get(undefined, 2)).toEqual({ layerA: { x: 2 } });
        expect(ledger.get()).toEqual({ layerA: { x: 2 } }); // current time remains t=2
    });

    test("no-op undo() and redo() return undefined at boundaries", () => {
        expect(ledger.undo()).toBeUndefined();
        
        ledger.set({ layerA: { x: 1 } });
        expect(ledger.redo()).toBeUndefined();
        
        ledger.undo();
        expect(ledger.undo()).toBeUndefined();
    });

    test("subscriber notifications are batched/deduplicated on auto-flush", async () => {
        const cb = jest.fn();
        ledger.subscribe(cb as any);

        // Populate to trigger autoFlush on next set
        ledger.set({ layerA: { x: 0 } });
        await Promise.resolve();
        cb.mockClear();

        // Perform write that triggers auto-flush
        for (let i = 1; i <= 10; i++) {
            ledger.set({ layerA: { x: i } });
        }

        await Promise.resolve();

        // With batching/deduplication, the callback should only be triggered once per tick
        // (even though flush() and set() both notify)
        expect(cb).toHaveBeenCalledTimes(1);
    });
});


import Clock from '../src/core/Clock.js';

describe('Clock – isolated unit tests', () => {
    let clock: Clock;

    beforeEach(() => {
        clock = new Clock();
    });

    test('initial state is t=0, p=0', () => {
        expect(clock.peek()).toBe(0);
        expect(clock.max()).toBe(0);
    });

    test('tick() advances both p and t', () => {
        expect(clock.tick()).toBe(1);
        expect(clock.peek()).toBe(1);
        expect(clock.max()).toBe(1);
    });

    test('multiple ticks() advance sequentially', () => {
        clock.tick();
        clock.tick();
        expect(clock.tick()).toBe(3);
        expect(clock.max()).toBe(3);
    });

    test('undo() decrements p and clamps at 0', () => {
        clock.tick(); // p=1
        expect(clock.undo()).toBe(0);
        expect(clock.undo()).toBe(0); // already at 0, stays
        expect(clock.max()).toBe(1);  // max stays at 1
    });

    test('redo() increments p and clamps at max', () => {
        clock.tick(); // t=1, p=1
        clock.undo(); // p=0
        expect(clock.redo()).toBe(1);
        expect(clock.redo()).toBe(1); // already at max, stays
    });

    test('canUndo() returns correct boolean', () => {
        expect(clock.canUndo()).toBe(false);
        clock.tick();
        expect(clock.canUndo()).toBe(true);
        clock.undo();
        expect(clock.canUndo()).toBe(false);
    });

    test('canRedo() returns correct boolean', () => {
        clock.tick();
        expect(clock.canRedo()).toBe(false);
        clock.undo();
        expect(clock.canRedo()).toBe(true);
        clock.redo();
        expect(clock.canRedo()).toBe(false);
    });

    test('resetTo() sets position within valid bounds', () => {
        clock.tick(); clock.tick(); clock.tick(); // t=3, p=3
        clock.resetTo(2);
        expect(clock.peek()).toBe(2);
        expect(clock.max()).toBe(3);
    });

    test('resetTo() ignores out-of-bounds values', () => {
        clock.tick(); // t=1, p=1
        clock.resetTo(-1);
        expect(clock.peek()).toBe(1); // unchanged
        clock.resetTo(99);
        expect(clock.peek()).toBe(1); // unchanged, 99 > max
    });

    test('tick() after undo truncates future (fork)', () => {
        clock.tick(); clock.tick(); // t=2, p=2
        clock.undo();               // p=1
        clock.tick();               // fork: t becomes 2, p=2
        expect(clock.peek()).toBe(2);
        expect(clock.max()).toBe(2);
        expect(clock.canRedo()).toBe(false); // no future to redo
    });

    test('peek() does not mutate state', () => {
        clock.tick();
        clock.peek();
        expect(clock.peek()).toBe(1);
        expect(clock.max()).toBe(1);
    });
});

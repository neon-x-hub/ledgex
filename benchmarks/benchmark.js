import { Ledgex } from '../dist/esm/index.js';
import { performance } from 'node:perf_hooks';

/**
 * Naive Full-Snapshot Implementation
 * Stores a complete deep clone of the entire state on every update step.
 */
class NaiveSnapshotLedger {
    constructor() {
        this.history = []; // Array of { time: number, state: Record<string, any> }
        this.currentTime = 0;
        this.currentState = {};
    }

    set(updates) {
        this.currentTime++;
        // Apply deep updates to internal current state
        for (const [layerId, layerUpdates] of Object.entries(updates)) {
            if (!this.currentState[layerId]) {
                this.currentState[layerId] = {};
            }
            this._deepMerge(this.currentState[layerId], layerUpdates);
        }
        // Save full snapshot of entire state at this timestamp
        this.history.push({
            time: this.currentTime,
            state: structuredClone(this.currentState)
        });
    }

    get(layerIds, time = this.currentTime) {
        const entry = this.history.find(h => h.time === time);
        if (!entry) return {};
        
        const targets = layerIds || Object.keys(entry.state);
        const result = {};
        for (const layerId of targets) {
            if (entry.state[layerId]) {
                result[layerId] = structuredClone(entry.state[layerId]);
            }
        }
        return result;
    }

    _deepMerge(target, source) {
        for (const key of Object.keys(source)) {
            if (source[key] !== null && typeof source[key] === 'object' && !Array.isArray(source[key])) {
                if (!target[key] || typeof target[key] !== 'object') {
                    target[key] = {};
                }
                this._deepMerge(target[key], source[key]);
            } else {
                target[key] = source[key];
            }
        }
    }
}

// ─── Benchmark Data Helpers ──────────────────────────────────────────────────

function createInitialState(numLayers, propsPerLayer) {
    const state = {};
    for (let l = 0; l < numLayers; l++) {
        const layerId = `layer_${l}`;
        state[layerId] = {};
        const categories = 10;
        const itemsPerCategory = Math.floor(propsPerLayer / categories);
        
        for (let c = 0; c < categories; c++) {
            const catName = `category_${c}`;
            state[layerId][catName] = {};
            for (let i = 0; i < itemsPerCategory; i++) {
                state[layerId][catName][`attr_${i}`] = `initial_val_${l}_${c}_${i}`;
            }
        }
    }
    return state;
}

function generatePartialUpdate(initialState, numLayers, propsPerLayer, mutationRatio, stepIndex) {
    const update = {};
    const categories = 10;
    const itemsPerCategory = Math.floor(propsPerLayer / categories);
    const numMutationsPerLayer = Math.floor(propsPerLayer * mutationRatio);

    for (let l = 0; l < numLayers; l++) {
        const layerId = `layer_${l}`;
        update[layerId] = {};

        for (let m = 0; m < numMutationsPerLayer; m++) {
            // Pick a deterministic category and attribute to mutate
            const c = (stepIndex * 7 + m * 3) % categories;
            const i = (stepIndex * 13 + m * 17) % itemsPerCategory;
            const catName = `category_${c}`;
            
            if (!update[layerId][catName]) {
                update[layerId][catName] = {};
            }
            update[layerId][catName][`attr_${i}`] = `updated_val_${stepIndex}_${m}`;
        }
    }
    return update;
}

function forceGC() {
    if (global.gc) {
        global.gc();
    }
}

function formatBytes(bytes) {
    if (bytes === 0) return '0 B';
    const k = 1024;
    const sizes = ['B', 'KB', 'MB', 'GB'];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i];
}

// ─── Benchmark Runner ────────────────────────────────────────────────────────

async function runBenchmark() {
    const NUM_LAYERS = 5;
    const PROPS_PER_LAYER = 2000; // 10,000 total attributes in state
    const UPDATE_STEPS = 500;
    const MUTATION_RATIO = 0.15;  // 15% of attributes modified per update (<20%)
    const READ_ITERATIONS = 1000;

    console.log('================================================================');
    console.log('              LEDGEX BENCHMARK SUITE                            ');
    console.log('================================================================');
    console.log(`Configuration:`);
    console.log(` - Layers: ${NUM_LAYERS}`);
    console.log(` - Properties per layer: ${PROPS_PER_LAYER.toLocaleString()} (Total: ${(NUM_LAYERS * PROPS_PER_LAYER).toLocaleString()} attributes)`);
    console.log(` - Update Steps (Ticks): ${UPDATE_STEPS}`);
    console.log(` - Mutation Ratio per Update: ${(MUTATION_RATIO * 100).toFixed(0)}% (${(NUM_LAYERS * PROPS_PER_LAYER * MUTATION_RATIO).toLocaleString()} mutated props/step)`);
    console.log(` - Read Queries per Test: ${READ_ITERATIONS.toLocaleString()}`);
    console.log('================================================================\n');

    // Generate workloads beforehand to ensure identical inputs
    console.log('Generating benchmark workload dataset...');
    const initialState = createInitialState(NUM_LAYERS, PROPS_PER_LAYER);
    const updateSequence = [];
    for (let s = 0; s < UPDATE_STEPS; s++) {
        updateSequence.push(generatePartialUpdate(initialState, NUM_LAYERS, PROPS_PER_LAYER, MUTATION_RATIO, s));
    }
    console.log('Workload ready.\n');

    // ─────────────────────────────────────────────────────────────────────────
    // 1. BENCHMARK: Naive Full Snapshot
    // ─────────────────────────────────────────────────────────────────────────
    forceGC();
    const memBeforeNaive = process.memoryUsage().heapUsed;
    const naiveLedger = new NaiveSnapshotLedger();

    // Write Phase
    const startNaiveWrite = performance.now();
    naiveLedger.set(initialState);
    for (let s = 0; s < UPDATE_STEPS; s++) {
        naiveLedger.set(updateSequence[s]);
    }
    const endNaiveWrite = performance.now();
    const naiveWriteDuration = endNaiveWrite - startNaiveWrite;

    forceGC();
    const memAfterNaive = process.memoryUsage().heapUsed;
    const naiveMemUsed = Math.max(0, memAfterNaive - memBeforeNaive);

    // Read Phase (Current State)
    const startNaiveReadCurrent = performance.now();
    for (let r = 0; r < READ_ITERATIONS; r++) {
        naiveLedger.get();
    }
    const endNaiveReadCurrent = performance.now();
    const naiveReadCurrentDuration = endNaiveReadCurrent - startNaiveReadCurrent;

    // Read Phase (Random Historical States)
    const startNaiveReadHistory = performance.now();
    for (let r = 0; r < READ_ITERATIONS; r++) {
        const randomTime = 1 + Math.floor(Math.random() * UPDATE_STEPS);
        naiveLedger.get(undefined, randomTime);
    }
    const endNaiveReadHistory = performance.now();
    const naiveReadHistoryDuration = endNaiveReadHistory - startNaiveReadHistory;


    // ─────────────────────────────────────────────────────────────────────────
    // 2. BENCHMARK: Ledgex (Delta Key-Value Commit Architecture)
    // ─────────────────────────────────────────────────────────────────────────
    forceGC();
    const memBeforeLedgex = process.memoryUsage().heapUsed;
    const ledgex = new Ledgex({ bufferSize: 1000 }); // keep full history for accurate comparison

    // Write Phase
    const startLedgexWrite = performance.now();
    ledgex.set(initialState);
    for (let s = 0; s < UPDATE_STEPS; s++) {
        ledgex.set(updateSequence[s]);
    }
    const endLedgexWrite = performance.now();
    const ledgexWriteDuration = endLedgexWrite - startLedgexWrite;

    forceGC();
    const memAfterLedgex = process.memoryUsage().heapUsed;
    const ledgexMemUsed = Math.max(0, memAfterLedgex - memBeforeLedgex);

    // Read Phase (Current State)
    const startLedgexReadCurrent = performance.now();
    for (let r = 0; r < READ_ITERATIONS; r++) {
        ledgex.get();
    }
    const endLedgexReadCurrent = performance.now();
    const ledgexReadCurrentDuration = endLedgexReadCurrent - startLedgexReadCurrent;

    // Read Phase (Random Historical States)
    const startLedgexReadHistory = performance.now();
    for (let r = 0; r < READ_ITERATIONS; r++) {
        const randomTime = 1 + Math.floor(Math.random() * UPDATE_STEPS);
        ledgex.get(undefined, randomTime);
    }
    const endLedgexReadHistory = performance.now();
    const ledgexReadHistoryDuration = endLedgexReadHistory - startLedgexReadHistory;

    // ─────────────────────────────────────────────────────────────────────────
    // REPORT RESULTS
    // ─────────────────────────────────────────────────────────────────────────
    const memorySavingsPct = ((1 - (ledgexMemUsed / naiveMemUsed)) * 100).toFixed(1);
    const writeSpeedupFactor = (naiveWriteDuration / ledgexWriteDuration).toFixed(2);
    const readCurrentRatio = (ledgexReadCurrentDuration / naiveReadCurrentDuration).toFixed(2);
    const readHistoryRatio = (ledgexReadHistoryDuration / naiveReadHistoryDuration).toFixed(2);

    console.log('================================================================');
    console.log('                     BENCHMARK RESULTS                          ');
    console.log('================================================================');
    console.log('');
    console.log('| Metric                              | Naive Full Snapshot | Ledgex (Delta Store) | Difference / Factor |');
    console.log('|-------------------------------------|---------------------|----------------------|---------------------|');
    console.log(`| Memory Consumption                  | ${formatBytes(naiveMemUsed).padStart(19)} | ${formatBytes(ledgexMemUsed).padStart(20)} | ${memorySavingsPct}% LESS memory   |`);
    console.log(`| Write Latency (${UPDATE_STEPS + 1} steps)       | ${(naiveWriteDuration.toFixed(2) + ' ms').padStart(19)} | ${(ledgexWriteDuration.toFixed(2) + ' ms').padStart(20)} | ${writeSpeedupFactor}x FASTER      |`);
    console.log(`| Read Current State (${READ_ITERATIONS} ops)   | ${(naiveReadCurrentDuration.toFixed(2) + ' ms').padStart(19)} | ${(ledgexReadCurrentDuration.toFixed(2) + ' ms').padStart(20)} | ${readCurrentRatio}x ratio        |`);
    console.log(`| Read Historical State (${READ_ITERATIONS} ops) | ${(naiveReadHistoryDuration.toFixed(2) + ' ms').padStart(19)} | ${(ledgexReadHistoryDuration.toFixed(2) + ' ms').padStart(20)} | ${readHistoryRatio}x ratio        |`);
    console.log('');
    console.log('Summary:');
    console.log(`- Memory: Ledgex saves ${memorySavingsPct}% memory compared to storing full snapshots.`);
    console.log(`- Write Speed: Ledgex is ${writeSpeedupFactor}x faster at processing partial state updates.`);
    console.log(`- Read Speed: Ledgex reconstructs full object states in ~${(ledgexReadCurrentDuration / READ_ITERATIONS).toFixed(3)} ms per get() query.`);
    console.log('================================================================');
}

runBenchmark().catch(console.error);

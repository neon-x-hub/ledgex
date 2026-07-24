# **Ledgex**

**"Smart, memory-efficient state management for JS apps with built-in undo/redo. Inspired by Git and Photoshop"**

![React Ledgex Logo](./images/banner.jpg)

[![npm](https://img.shields.io/npm/v/@ledgex/core)](https://www.npmjs.com/package/@ledgex/core)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](https://opensource.org/licenses/MIT)

`@ledgex/react` [![npm](https://img.shields.io/npm/v/@ledgex/react)](https://www.npmjs.com/package/@ledgex/react)
---

# Table of Contents
- [Features](#features)
- [Installation](#installation)
- [Basic Usage](#basic-usage)
- [Real-World Example](#real-world-example-photo-editor-layer-backups-undo--redo)
- [Advanced Features](#advanced-features)
- [Performance & Benchmarks](#performance--benchmarks)
- [Under the Hood](#under-the-hood)
- [API Reference](#ledgex-api-reference)
- [Support](#support)

# Features

* **Natively Written in TypeScript**
  Built with TypeScript out of the box, providing full type safety and rich auto-complete without requiring extra `@types/` packages.

* **Built-in Time Travel**
  Native **undo / redo** support with minimal runtime and memory overhead.

* **Layered State Management**
  Organize and isolate state changes using layers—similar to Photoshop layers—making complex state flows easier to manage.

* **Smart & Efficient History Storage**

  * Only **changed properties** are recorded—never entire objects
  * Repeated updates that don’t alter state are **automatically ignored**
  * Large objects (30+ properties) remain memory-efficient because unchanged values reference existing state

* **No Redundant History Entries**
  Only meaningful changes create history records. Setting the same value twice produces no extra entries.

* **Tiny Footprint**
  Under **8KB gzipped**, with no unnecessary dependencies.

* **Framework-Agnostic**
  Designed for **plain JavaScript** and works equally well in any environment (React, Vue, Svelte, or no framework at all).

---

# Installation

```bash
npm install @ledgex/core
```

---

# Ledgex

## Basic Usage

### 1. Create a Ledgex instance

```js
import { Ledgex } from '@ledgex/core';

// Create a global or scoped instance
const store = new Ledgex({
  bufferSize: 100 // optional, default is unlimited
});
```

You can create:

* **one global instance** for the entire app
* or **multiple instances** for isolated state domains (e.g. editor, history, settings)

---

### 2. Use anywhere

```js
const layer = store.get('background');

store.set('background', { color: '#202020' });

store.undo();
store.redo();
```

## Real-World Example: Photo Editor Layer Backups (Undo / Redo)

This example shows how **Ledgex** can be used to **efficiently back up complex UI state** in applications like photo editors, diagram tools, or design software.

### Concept

* Use **your own live state** for immediate rendering and user feedback
* Use **Ledgex** only for **history snapshots**
* Apply **throttling** to avoid recording excessive intermediate states

Ledgex becomes a **history engine**, not your rendering bottleneck.

---

### Example Code

```js
import throttle from 'lodash/throttle';
import { Ledgex } from '@ledgex/core';
import { layers, setLayers } from './layersStore'; // your live state

const ledgex = new Ledgex({ bufferSize: 200 });

// Throttle backups to once every 300ms
const throttledSet = throttle(ledgex.set.bind(ledgex), 300);

function handlePropsChange(layerId, newProps) {
  setLayers(prevLayers =>
    prevLayers.map(layer => {
      if (layer.id === layerId) {
        const updatedLayer = layer.clone();
        updatedLayer.updateProps(newProps);

        // Backup only meaningful state changes
        throttledSet(layerId, updatedLayer.toObject());

        return updatedLayer;
      }
      return layer;
    })
  );
}
```

---

### Why This Works So Well

* **Efficient Memory Usage**
  Only meaningful diffs are stored — no full snapshots during rapid updates.

* **Smooth User Experience**
  Live updates remain instant, while undo/redo history stays compact.

* **Throttle-Friendly**
  Dragging, sliders, and key presses don’t flood history with noise.

---

# Advanced Features

### Multi-layer Updates (One `set()` Call)

When all your changes are ready at the same time, pass them all in a single `set()` call.
This creates **one undo/redo entry** across all affected layers.

```ts
ledgex.set({
  layer1: { x: 100, y: 200 },
  layer2: { x: 100, y: 200 },
  layer3: { x: 100, y: 200 }
}); // Single undo/redo entry
```

**Use cases**: aligning multiple layers, applying a preset, group transformations.



### Deeply Nested Object Support

Ledgex efficiently handles **nested updates**, storing only the **deepest changes**.

```js
ledgex.set({
  layer1: {
    filters: {
      brightness: 1.2,
      contrast: 0.8
    }
  }
});
```

**Why it matters**:

* Safe for complex structured data
* No redundant history entries
* No memory blow-up with deep objects

---

## Efficient History Management

Ledgex gives you full control over **history size** using a configurable buffer.

```js
const ledgex = new Ledgex({
  bufferSize: 100 // keep last 100 meaningful changes
});
```

### How it works

* Limits the number of undo/redo steps kept in memory
* Oldest entries are automatically discarded
* Works together with diff-based storage

---

### Why This Matters

* **Memory Safety** → history never grows unbounded
* **Performance** → undo/redo remains fast
* **Flexibility** → tune buffer size per app or feature

---

# **`Ledgex` API Reference**

The `Ledgex` class is a **time-travel–enabled, layered state manager** with efficient history tracking, undo/redo support, and subscription-based updates.

It is framework-agnostic and designed for applications that require **precise state history**, such as editors, design tools, and complex UIs.

---

## Import

```js
import { Ledgex } from '@ledgex/core';
```

---

## Constructor

```js
new Ledgex(options?)
```

### Parameters

| Name                      | Type     | Default | Description                                        |
| ------------------------- | -------- | ------- | -------------------------------------------------- |
| `options`                 | `Object` | `{}`    | Optional configuration                             |
| `options.bufferSize`      | `number` | `100`   | Maximum number of meaningful history steps to keep |
| `options.toleranceWindow` | `number` | `20`    | Time window for collapsing intermediate updates    |

### Example

```js
const ledger = new Ledgex({
  bufferSize: 200,
  toleranceWindow: 50
});
```

---

## Core Concepts

### Layers

* Each **layer** is an independent key-value state container.
* Layers can be activated, deactivated, and updated independently.
* History is tracked **per layer**, but undo/redo operates globally.

### Time Travel

* Every meaningful change advances time.
* Undo and redo move backward or forward through **meaningful states only**.
* Repeated updates that do not change state are ignored.

---

## Methods


### `set(updates)`

Applies state updates at the current time.

* Automatically ignores **non-meaningful changes**
* Supports **batch updates**
* Creates a **single undo/redo step**

```js
ledger.set({
  background: { color: '#202020' },
  layer1: { x: 100, y: 200 }
});
```

#### Parameters

| Name      | Type                     | Description                      |
| --------- | ------------------------ | -------------------------------- |
| `updates` | `Object<string, Object>` | Map of `layerId → partial state` |

#### Notes

* Nested objects are merged deeply.
* Only changed properties are recorded.
* If nothing meaningful changes, no history entry is created.

---

### `get(layerIds?, time?)`

Returns the state of one or more layers at a specific time (defaults to the current time).

```js
ledger.get(); // all active layers at current time
ledger.get(['background', 'layer1']); // specific layers at current time
ledger.get(undefined, 5); // all active layers at time step 5 (historical query)
```

#### Parameters

| Name       | Type                  | Description                                            |
| ---------- | --------------------- | ------------------------------------------------------ |
| `layerIds` | `string[]` (optional) | Specific layers to read. Defaults to all active layers. |
| `time`     | `number` (optional)   | Specific time step to query state at.                  |

#### Returns

```ts
Object<string, Object>
```

Only **active layers** at the queried time are included.

---

### `undo()`

Moves to the previous meaningful state.

```js
ledger.undo();
```

#### Returns

```ts
Object<string, Object> | undefined
```

The current state after undo, or `undefined` if undo is not possible.

---

### `redo()`

Moves to the next meaningful state.

```js
ledger.redo();
```

#### Returns

```ts
Object<string, Object> | undefined
```

The current state after redo, or `undefined` if redo is not possible.

---

### `remove(layerId)`

Deactivates a layer at the current time.

```js
ledger.remove('background');
```

#### Parameters

| Name      | Type     | Description         |
| --------- | -------- | ------------------- |
| `layerId` | `string` | Layer to deactivate |

#### Notes

* Deactivation is recorded in history
* Undo will restore the layer

---

### `prune(minTime)`

Removes history entries **older than `minTime`**.

```js
ledger.prune(50);
```

#### Parameters

| Name      | Type     | Description             |
| --------- | -------- | ----------------------- |
| `minTime` | `number` | Earliest time to retain |

#### Notes

* Layers with no remaining state are removed
* Useful for manual memory management

---

### `flush()`

Automatically prunes history based on `bufferSize`.

```js
ledger.flush();
```

#### Behavior

* Keeps only the last `bufferSize` meaningful steps
* Updates internal flush time
* Invoked automatically when history grows too large

---

### `subscribe(callback)`

Subscribes to state changes.

```js
const unsubscribe = ledger.subscribe(() => {
  console.log('State changed:', ledger.get());
});
```

#### Parameters

| Name       | Type       | Description                   |
| ---------- | ---------- | ----------------------------- |
| `callback` | `Function` | Called after any state change |

#### Returns

```ts
() => void
```

Unsubscribe function.

#### Notes

* Callbacks are triggered **asynchronously**
* Safe to read state inside callback

---

## Automatic Behavior

### Auto-Flushing

Ledgex automatically flushes history when:

```
currentTime - lastFlushTime > bufferSize + toleranceWindow
```

This prevents unbounded memory growth during rapid updates.

---

## Usage Example

```js
const ledger = new Ledgex({ bufferSize: 100 });

ledger.set({
  layer1: { x: 10, y: 20 }
});

ledger.set({
  layer1: { x: 15 }
});

ledger.undo(); // reverts x to 10
ledger.redo(); // reapplies x = 15
```

---

## Guarantees

* Only meaningful changes are stored
* Undo/redo is deterministic
* Memory usage scales with change size, not object size
* No duplicate or empty history entries

---

## Intended Use Cases

* Photo / video editors
* Diagram & design tools
* Complex form editors
* Any application requiring **efficient undo/redo**

## Performance & Benchmarks

Ledgex uses a key-level delta commit architecture with memoized state reconstruction, avoiding full object cloning on every update step.

### Benchmark Results (10,000 Attributes over 500 Steps)

Workload configuration: **10,000 total attributes** across 5 layers, updated over **500 sequential ticks** with **15% property mutation** per step.

| Metric | Naive Full-Snapshot | Ledgex (Delta Store) | Difference / Performance Impact |
|---|---|---|---|
| **Memory Footprint** | 221.45 MB | **25.80 MB** | 🟢 **88.3% LESS memory** (~8.5x memory efficiency) |
| **Read (`get()`) Current State** | 848.96 ms (1,000 ops) | **9.84 ms** (1,000 ops) | **~0.009 ms / query** (Instant $O(1)$ cached access) |
| **Read (`get()`) Historical State** | 863.68 ms (1,000 ops) | **1,990.92 ms** (1,000 ops) | Fast enough point-in-time state reconstruction |

### Running Benchmarks Locally

Run the benchmark suite locally with garbage collection flags using:

```bash
npm run bench
```

---

## Under the Hood

For senior developers and architects interested in the internal engine mechanics:

### 1. Key-Level Delta Log Architecture
Unlike traditional snapshot engines (which duplicate full object trees on every change: $O(N)$ memory per tick), Ledgex flattens nested state graphs into normalized dot-notation paths (`"layer.transform.x"`). Only modified keys append a `CommitNode({ t, v })` to an append-only timeline. Memory scales linearly with change size ($O(\Delta)$), not total object complexity.

### 2. Monotonic Logical Timeline
Ledgex manages a shared, monotonically increasing virtual clock ($t$). Undoing or redoing operations simply moves a logical cursor ($p$) across historical timestamps without mutating recorded commit arrays. Branching history (writing after an undo) automatically prunes invalid future branches.

### 3. Structural Tombstoning & Shadowing
When nested properties or parent objects are updated or deleted, Ledgex writes tombstone markers (`undefined` values) at timestamp $t$. This ensures nested object mutations and sub-key cleanups are deterministic across point-in-time queries without requiring complex tree diffing.

### 4. Point-in-Time Reconstruction & Memoization
Querying state at timestamp $t$ performs a binary search (`_findLatestCommit`) over active key timelines to find the latest value $\le t$, then deflattens the object graph. Reconstructed layer states are cached per timestamp and invalidated only when new mutations occur, rendering repeated reads instantaneous ($O(1)$).

### 5. Automated Memory Bounding
Ledgex auto-flushes history beyond a configurable `bufferSize`. During a flush, it retains the latest anchor commit at the cutoff timestamp for every active key while safely discarding obsolete historical nodes.

---

## Support

⭐ **Star the repo** if you find it useful!
🐞 **Report issues** on GitHub

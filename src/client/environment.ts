type GenerationState = {
  now: number;
  latest: boolean;
  inlineRandom?: () => number;
};

// Simple hash function to convert a string to a 32-bit seed
function hashString(str: string): number {
  let hash = 0;
  for (let i = 0; i < str.length; i++) {
    const char = str.charCodeAt(i);
    hash = (hash << 5) - hash + char;
    hash = hash & hash; // Convert to 32-bit integer
  }
  return hash >>> 0; // Ensure unsigned
}

// A simple, fast seeded PRNG
// https://gist.github.com/tommyettinger/46a874533244883189143505d203312c?permalink_comment_id=4854318#gistcomment-4854318
function createSeededRandom(seed: number): () => number {
  return () => {
    seed = (seed + 0x9e3779b9) | 0;
    let t = Math.imul(seed ^ (seed >>> 16), 0x21f0aaad);
    t = Math.imul(t ^ (t >>> 15), 0x735a2d97);
    return ((t ^ (t >>> 15)) >>> 0) / 4294967296;
  };
}

// Testable unit: patches Math object to use seeded random
export function patchMath(math: typeof Math, seed: string): typeof Math {
  const patchedMath = Object.create(Object.getPrototypeOf(math));

  // Copy all properties from original Math
  for (const key of Object.getOwnPropertyNames(math)) {
    if (key !== "random") {
      const descriptor = Object.getOwnPropertyDescriptor(math, key);
      if (descriptor) {
        Object.defineProperty(patchedMath, key, descriptor);
      }
    }
  }

  // Override random to use seeded PRNG
  const seededRandom = createSeededRandom(hashString(seed));
  patchedMath.random = seededRandom;

  return patchedMath;
}

// Testable unit: creates deterministic Date constructor
export function createDeterministicDate(
  originalDate: typeof Date,
  getGenerationState: () => GenerationState,
): typeof Date {
  function DeterministicDate(this: unknown, ...args: unknown[]) {
    // `Date()` was called directly, not as a constructor.
    if (!(this instanceof DeterministicDate)) {
      const date = new (DeterministicDate as typeof Date)();
      return date.toString();
    }
    if (args.length === 0) {
      const { now } = getGenerationState();
      return new originalDate(now) as unknown as Date;
    }
    return new (originalDate as typeof Date)(
      ...(args as ConstructorParameters<typeof Date>),
    ) as unknown as Date;
  }

  DeterministicDate.now = function () {
    const { now } = getGenerationState();
    return now;
  };
  DeterministicDate.parse = originalDate.parse;
  DeterministicDate.UTC = originalDate.UTC;
  DeterministicDate.prototype = originalDate.prototype;
  DeterministicDate.prototype.constructor = DeterministicDate as typeof Date;

  // TODO: Additional methods that should be patched for full determinism:
  // - getTimezoneOffset() - should return 0 (UTC)
  // - toLocaleString() - should use fixed locale (en-US) and UTC timezone
  // - toLocaleDateString() - should use fixed locale (en-US) and UTC timezone
  // - toLocaleTimeString() - should use fixed locale (en-US) and UTC timezone
  // These would require more complex prototype manipulation to work correctly.

  return DeterministicDate as typeof Date;
}

export function setupEnvironment(
  getGenerationState: () => GenerationState,
  workflowId: string,
): () => void {
  const global = globalThis as Record<string, unknown>;

  const patchedKeys = [
    "Math",
    "Date",
    "console",
    "process",
    "Crypto",
    "crypto",
    "CryptoKey",
    "SubtleCrypto",
  ] as const;
  const originals = Object.fromEntries(
    patchedKeys.map((key) => [key, global[key]]),
  );
  const readonlyProperties = new Map<string, PropertyDescriptor>();

  // Patch Math with seeded random based on workflowId
  const math = patchMath(originals.Math as typeof Math, workflowId);
  const workflowRandom = math.random;
  // Inline callbacks are skipped on replay, so their random calls must not
  // advance the workflow handler's deterministic random sequence.
  math.random = () => (getGenerationState().inlineRandom ?? workflowRandom)();
  global.Math = math;

  // Patch Date
  global.Date = createDeterministicDate(
    originals.Date as typeof Date,
    getGenerationState,
  );

  // Patch console
  global.console = createConsole(
    originals.console as Console,
    getGenerationState,
  );

  // Note: we intentionally don't patch fetch, setTimeout, or setInterval.
  // In the real Convex runtime these don't exist (for mutations/queries), so
  // user code already can't call them. Patching them here would break test
  // environments (e.g. convex-test) that share the same JS global scope and
  // rely on these globals internally.

  // Disable non-deterministic globals with assignments so test runtimes can
  // intercept the writes without losing their global isolation accessors.
  for (const key of [
    "process",
    "Crypto",
    "crypto",
    "CryptoKey",
    "SubtleCrypto",
  ]) {
    const descriptor = Object.getOwnPropertyDescriptor(global, key);
    if (
      descriptor &&
      ("writable" in descriptor ? !descriptor.writable : !descriptor.set)
    ) {
      // Convex exposes read-only Crypto/SubtleCrypto constructors and a
      // getter-only crypto. Preserve their descriptors when replacing them.
      readonlyProperties.set(key, descriptor);
      Object.defineProperty(global, key, {
        value: undefined,
        writable: true,
        enumerable: descriptor.enumerable,
        configurable: descriptor.configurable,
      });
    } else {
      global[key] = undefined;
    }
  }

  return () => {
    Object.assign(global, originals);
    for (const [key, descriptor] of readonlyProperties) {
      Object.defineProperty(global, key, descriptor);
    }
  };
}

function noop() {}

// exported for testing
export function createConsole(
  console: Console,
  getGenerationState: () => GenerationState,
): Console {
  const counts: Record<string, number> = {};
  const times: Record<string, number> = {};
  return new Proxy(console, {
    get: (target, prop) => {
      const { now, latest } = getGenerationState();
      switch (prop) {
        case "assert":
        case "clear":
        case "debug":
        case "dir":
        case "dirxml":
        case "error":
        case "info":
        case "log":
        case "table":
        case "trace":
        case "warn":
        case "profile":
        case "profileEnd":
        case "timeStamp":
          if (!latest) {
            return noop;
          }
          return target[prop];
        case "Console":
          throw new Error(
            "console.Console() is not supported within workflows",
          );
        case "count":
          return (label?: string) => {
            const key = label ?? "default";
            counts[key] = (counts[key] ?? 0) + 1;
            if (latest) {
              target.info(`${key}: ${counts[key]}`);
            }
          };
        case "countReset":
          return (label?: string) => {
            const key = label ?? "default";
            counts[key] = 0;
          };
        case "group":
        case "groupCollapsed":
          if (!latest) {
            // Don't print anything if latest is false
            return () => target.group();
          }
          return target[prop];
        case "groupEnd":
          return target[prop];
        case "time":
          if (!latest) {
            return (label?: string) => {
              times[label ?? "default"] = now;
            };
          }
          return target[prop];
        case "timeEnd":
        case "timeLog":
          if (!latest) {
            return noop;
          }
          return (label?: string, ...data: unknown[]) => {
            const key = label ?? "default";
            if (times[key] === undefined) {
              target[prop](label);
            } else {
              target.info(`${key}: ${now - times[key]}ms`, ...data);
            }
          };
      }
      return target[prop as keyof Console];
    },
  });
}

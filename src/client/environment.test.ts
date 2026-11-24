import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { Temporal } from "@js-temporal/polyfill";
import {
  patchMath,
  createDeterministicDate,
  createDeterministicTemporal,
  createConsole,
  setupEnvironment,
} from "./environment.js";

describe("environment patching units", () => {
  describe("setupEnvironment", () => {
    beforeEach(() => vi.stubGlobal("Temporal", Temporal));
    afterEach(() => vi.unstubAllGlobals());

    const disabledKeys = [
      "process",
      "Crypto",
      "crypto",
      "CryptoKey",
      "SubtleCrypto",
    ] as const;

    it.each(
      disabledKeys.flatMap((key) => [
        [key, true] as const,
        [key, false] as const,
      ]),
    )(
      "preserves the %s accessor when disabling and restoring it repeatedly (setter: %s)",
      (key, hasSetter) => {
        const global = globalThis as Record<string, unknown>;
        const descriptor = Object.getOwnPropertyDescriptor(global, key);
        const original = global[key];
        let value = original;
        const writes: unknown[] = [];
        const accessor = {
          configurable: true,
          enumerable: descriptor?.enumerable ?? true,
          get: () => value,
          set: hasSetter
            ? (next: unknown) => {
                writes.push(next);
                value = next;
              }
            : undefined,
        };
        Object.defineProperty(global, key, accessor);
        const snapshots = [];
        try {
          for (let i = 0; i < 2; i++) {
            const restore = setupEnvironment(
              () => ({ now: 1234, latest: true }),
              "accessor-test",
            );
            try {
              snapshots.push({
                value: global[key],
                descriptor: hasSetter
                  ? Object.getOwnPropertyDescriptor(global, key)
                  : undefined,
              });
            } finally {
              restore();
            }
            snapshots.push({
              value: global[key],
              descriptor: Object.getOwnPropertyDescriptor(global, key),
            });
          }
        } finally {
          if (descriptor) {
            Object.defineProperty(global, key, descriptor);
          } else {
            delete global[key];
          }
        }

        // Assert after restoring process/console so failures cannot break Vitest.
        expect(snapshots).toEqual([
          { value: undefined, descriptor: hasSetter ? accessor : undefined },
          { value: original, descriptor: accessor },
          { value: undefined, descriptor: hasSetter ? accessor : undefined },
          { value: original, descriptor: accessor },
        ]);
        expect(writes).toEqual(
          hasSetter ? [undefined, original, undefined, original] : [],
        );
      },
    );

    it.each([false, true])(
      "restores Convex runtime descriptors after repeated setup (throws: %s)",
      (throws) => {
        const global = globalThis as Record<string, unknown>;
        const keys = ["Math", "Date", "Temporal", "console", ...disabledKeys];
        const hostDescriptors = Object.fromEntries(
          keys.map((key) => [
            key,
            Object.getOwnPropertyDescriptor(global, key),
          ]),
        );
        const hostValues = Object.fromEntries(
          keys.map((key) => [key, global[key]]),
        );
        const originalCrypto = global.crypto;
        const runtimeDescriptors = {
          // Match udf-runtime/src/00_crypto.ts: these constructors are read-only.
          Crypto: {
            value: global.Crypto,
            writable: false,
            enumerable: false,
            configurable: true,
          },
          SubtleCrypto: {
            value: global.SubtleCrypto,
            writable: false,
            enumerable: false,
            configurable: true,
          },
          crypto: {
            get: () => originalCrypto,
            set: undefined,
            enumerable: true,
            configurable: true,
          },
        };
        const disabled: boolean[] = [];
        const restored = [];
        const errors = [];
        try {
          Object.defineProperties(global, runtimeDescriptors);
          for (let i = 0; i < 2; i++) {
            const restore = setupEnvironment(
              () => ({ now: 1234, latest: true }),
              "runtime-test",
            );
            try {
              disabled.push(
                disabledKeys.every((key) => global[key] === undefined),
              );
              if (throws) throw new Error("handler failed");
            } catch (error) {
              errors.push(error);
            } finally {
              restore();
            }
            restored.push(
              Object.fromEntries(
                Object.keys(runtimeDescriptors).map((key) => [
                  key,
                  Object.getOwnPropertyDescriptor(global, key),
                ]),
              ),
            );
          }
        } finally {
          // Also clean up partial setup failures so they cannot break Vitest.
          for (const [key, descriptor] of Object.entries(hostDescriptors)) {
            if (descriptor) {
              Object.defineProperty(global, key, descriptor);
              if (descriptor.set) global[key] = hostValues[key];
            } else {
              delete global[key];
            }
          }
        }

        expect(disabled).toEqual([true, true]);
        expect(restored).toEqual([runtimeDescriptors, runtimeDescriptors]);
        expect(errors).toEqual(
          throws
            ? [new Error("handler failed"), new Error("handler failed")]
            : [],
        );
      },
    );

    it("restores the outer environment after a nested environment throws", () => {
      const global = globalThis as Record<string, unknown>;
      const keys = ["Math", "Date", "Temporal", "console", ...disabledKeys];
      const snapshot = () => keys.map((key) => global[key]);
      const original = snapshot();
      const restoreOuter = setupEnvironment(
        () => ({ now: 1000, latest: true }),
        "outer",
      );
      const outer = snapshot();
      let innerTime;
      let innerTemporalTime;
      let outerTemporalTime;
      let restoredOuter;
      let caught;
      try {
        const restoreInner = setupEnvironment(
          () => ({ now: 2000, latest: false }),
          "inner",
        );
        try {
          innerTime = Date.now();
          innerTemporalTime = (global.Temporal as typeof Temporal).Now.instant()
            .epochMilliseconds;
          throw new Error("handler failed");
        } finally {
          restoreInner();
        }
      } catch (error) {
        caught = error;
        restoredOuter = snapshot();
        outerTemporalTime = (global.Temporal as typeof Temporal).Now.instant()
          .epochMilliseconds;
      } finally {
        restoreOuter();
      }

      expect(caught).toEqual(new Error("handler failed"));
      expect(innerTime).toBe(2000);
      expect(innerTemporalTime).toBe(2000);
      expect(outerTemporalTime).toBe(1000);
      restoredOuter!.forEach((value, i) => expect(value).toBe(outer[i]));
      snapshot().forEach((value, i) => expect(value).toBe(original[i]));
    });

    it.each([false, true])(
      "leaves unavailable Temporal unchanged (own property: %s)",
      (hasProperty) => {
        const global = globalThis as Record<string, unknown>;
        if (hasProperty) {
          global.Temporal = undefined;
        } else {
          delete global.Temporal;
        }
        const original = Object.getOwnPropertyDescriptor(global, "Temporal");
        const restore = setupEnvironment(
          () => ({ now: 1234, latest: true }),
          "without-temporal",
        );
        let during;
        try {
          during = Object.getOwnPropertyDescriptor(global, "Temporal");
        } finally {
          restore();
        }
        expect(during).toEqual(original);
        expect(Object.getOwnPropertyDescriptor(global, "Temporal")).toEqual(
          original,
        );
      },
    );
  });

  describe("createDeterministicTemporal", () => {
    const timestamp = 1704067200123; // 2024-01-01T00:00:00.123Z

    it("reads the current generation at call time, including replay", () => {
      const generation = { now: timestamp, latest: false };
      const patched = createDeterministicTemporal(Temporal, () => generation);
      const { instant, plainDateISO } = patched.Now;

      expect(instant().epochMilliseconds).toBe(timestamp);
      expect(instant().epochNanoseconds).toBe(BigInt(timestamp) * 1_000_000n);
      expect(plainDateISO().toString()).toBe("2024-01-01");

      generation.now += 86_400_000;
      generation.latest = true;
      expect(instant().epochMilliseconds).toBe(timestamp + 86_400_000);
      expect(plainDateISO().toString()).toBe("2024-01-02");

      // Replaying the earlier generation must produce the same instant.
      generation.now = timestamp;
      generation.latest = false;
      expect(instant().epochMilliseconds).toBe(timestamp);
    });

    it("uses UTC by default for all calendar and clock methods", () => {
      const original = {
        ...Temporal,
        Now: { ...Temporal.Now, timeZoneId: () => "America/Los_Angeles" },
      };
      const patched = createDeterministicTemporal(original, () => ({
        now: timestamp,
        latest: true,
      }));

      expect(patched.Now.timeZoneId()).toBe("UTC");
      expect(patched.Now.zonedDateTimeISO().toString()).toBe(
        "2024-01-01T00:00:00.123+00:00[UTC]",
      );
      expect(patched.Now.plainDateTimeISO().toString()).toBe(
        "2024-01-01T00:00:00.123",
      );
      expect(patched.Now.plainDateISO().toString()).toBe("2024-01-01");
      expect(patched.Now.plainTimeISO().toString()).toBe("00:00:00.123");
    });

    it.each([
      "America/Los_Angeles",
      "-08:00",
      Temporal.ZonedDateTime.from(
        "2024-06-01T00:00-07:00[America/Los_Angeles]",
      ),
    ])("honors an explicit time zone: %s", (timeZone) => {
      const patched = createDeterministicTemporal(Temporal, () => ({
        now: timestamp,
        latest: false,
      }));

      expect(patched.Now.zonedDateTimeISO(timeZone).epochMilliseconds).toBe(
        timestamp,
      );
      expect(patched.Now.zonedDateTimeISO(timeZone).offset).toBe("-08:00");
      expect(patched.Now.plainDateTimeISO(timeZone).toString()).toBe(
        "2023-12-31T16:00:00.123",
      );
      expect(patched.Now.plainDateISO(timeZone).toString()).toBe("2023-12-31");
      expect(patched.Now.plainTimeISO(timeZone).toString()).toBe(
        "16:00:00.123",
      );
    });

    it("preserves Temporal validation of invalid time zones", () => {
      const patched = createDeterministicTemporal(Temporal, () => ({
        now: timestamp,
        latest: true,
      }));
      for (const method of [
        patched.Now.zonedDateTimeISO,
        patched.Now.plainDateTimeISO,
        patched.Now.plainDateISO,
        patched.Now.plainTimeISO,
      ]) {
        expect(() => method("invalid/timezone")).toThrow(RangeError);
        expect(() => method(null as unknown as string)).toThrow(TypeError);
      }
    });

    it("preserves constructors and descriptors without mutating Temporal.Now", () => {
      const descriptors = Object.getOwnPropertyDescriptors(Temporal);
      const nowDescriptors = Object.getOwnPropertyDescriptors(Temporal.Now);
      const patched = createDeterministicTemporal(Temporal, () => ({
        now: timestamp,
        latest: true,
      }));

      expect(patched).not.toBe(Temporal);
      expect(patched.Now).not.toBe(Temporal.Now);
      expect(patched.Now.instant()).toBeInstanceOf(Temporal.Instant);
      for (const key of Reflect.ownKeys(Temporal)) {
        if (key !== "Now") {
          expect(Object.getOwnPropertyDescriptor(patched, key)).toEqual(
            Object.getOwnPropertyDescriptor(Temporal, key),
          );
        }
      }
      expect(Object.prototype.toString.call(patched.Now)).toBe(
        "[object Temporal.Now]",
      );
      expect(Object.keys(patched.Now)).toEqual([]);
      expect(Object.getOwnPropertyDescriptors(Temporal)).toEqual(descriptors);
      expect(Object.getOwnPropertyDescriptors(Temporal.Now)).toEqual(
        nowDescriptors,
      );
    });
  });

  describe("patchMath", () => {
    it("should preserve all Math methods except random", () => {
      const originalMath = Math;
      const patchedMath = patchMath(originalMath, "test-seed");

      // Should preserve all other methods
      expect(patchedMath.abs).toBe(originalMath.abs);
      expect(patchedMath.sin).toBe(originalMath.sin);
      expect(patchedMath.cos).toBe(originalMath.cos);
      expect(patchedMath.PI).toBe(originalMath.PI);
      expect(patchedMath.E).toBe(originalMath.E);
    });

    it("should replace Math.random with deterministic seeded function", () => {
      const originalMath = Math;
      const patchedMath = patchMath(originalMath, "test-workflow-id");

      // Should return a number between 0 and 1
      const random1 = patchedMath.random();
      expect(random1).toBeGreaterThanOrEqual(0);
      expect(random1).toBeLessThan(1);

      // Should be deterministic - same seed produces same sequence
      const patchedMath2 = patchMath(originalMath, "test-workflow-id");
      const random2 = patchedMath2.random();
      expect(random2).toBe(random1);

      // Different seed produces different sequence
      const patchedMath3 = patchMath(originalMath, "different-workflow-id");
      const random3 = patchedMath3.random();
      expect(random3).not.toBe(random1);
    });

    it("should not mutate the original Math object", () => {
      const originalMath = Math;
      const originalRandom = Math.random;

      patchMath(originalMath, "test-seed");

      // Original Math should be unchanged
      expect(Math.random).toBe(originalRandom);
    });
  });

  describe("createDeterministicDate", () => {
    const mockGetGenerationState = vi.fn();

    beforeEach(() => {
      mockGetGenerationState.mockReturnValue({
        now: 1234567890000,
        latest: true,
      });
    });

    afterEach(() => {
      mockGetGenerationState.mockReset();
    });

    it("should create Date that uses generation state for Date.now()", () => {
      const testTime = 9876543210000;
      mockGetGenerationState.mockReturnValue({ now: testTime, latest: true });

      const DeterministicDate = createDeterministicDate(
        Date,
        mockGetGenerationState,
      );

      expect(DeterministicDate.now()).toBe(testTime);
      expect(mockGetGenerationState).toHaveBeenCalled();
    });

    it("should create new Date with current timestamp when no args", () => {
      const testTime = 1111111111111;
      mockGetGenerationState.mockReturnValue({ now: testTime, latest: true });

      const DeterministicDate = createDeterministicDate(
        Date,
        mockGetGenerationState,
      );
      const date = new DeterministicDate();

      expect(date.getTime()).toBe(testTime);
    });

    it("should create Date with provided args", () => {
      const DeterministicDate = createDeterministicDate(
        Date,
        mockGetGenerationState,
      );
      const date = new DeterministicDate(2023, 0, 1);

      expect(date.getFullYear()).toBe(2023);
      expect(date.getMonth()).toBe(0);
      expect(date.getDate()).toBe(1);
    });

    it("should return string when called without new", () => {
      const DeterministicDate = createDeterministicDate(
        Date,
        mockGetGenerationState,
      );

      const dateString = (DeterministicDate as unknown as () => string)();
      expect(typeof dateString).toBe("string");
    });

    it("should preserve original Date static methods", () => {
      const originalDate = Date;
      const DeterministicDate = createDeterministicDate(
        originalDate,
        mockGetGenerationState,
      );

      expect(DeterministicDate.parse).toBe(originalDate.parse);
      expect(DeterministicDate.UTC).toBe(originalDate.UTC);

      // Prototype should be the same as original (no patching currently)
      expect(DeterministicDate.prototype).toBe(originalDate.prototype);
      expect(DeterministicDate.prototype.constructor).toBe(DeterministicDate);
    });

    it("should not affect the original Date constructor", () => {
      const originalNow = Date.now;

      createDeterministicDate(Date, mockGetGenerationState);

      // Original Date should be unchanged
      expect(Date.now).toBe(originalNow);
    });

    describe("behavior validation vs original Date", () => {
      it("should produce identical outputs for specific dates", () => {
        const DeterministicDate = createDeterministicDate(
          Date,
          mockGetGenerationState,
        );

        // Test with specific timestamps
        const timestamps = [
          0, // Unix epoch
          946684800000, // Y2K
          1640995200000, // 2022-01-01
          2023,
          0,
          15,
          10,
          30,
          45,
          123, // Feb 15, 2023 10:30:45.123
        ];

        for (const ts of [timestamps[0], timestamps[1], timestamps[2]]) {
          const original = new Date(ts);
          const deterministic = new DeterministicDate(ts);

          expect(deterministic.getTime()).toBe(original.getTime());
          expect(deterministic.getFullYear()).toBe(original.getFullYear());
          expect(deterministic.getMonth()).toBe(original.getMonth());
          expect(deterministic.getDate()).toBe(original.getDate());
          expect(deterministic.getHours()).toBe(original.getHours());
          expect(deterministic.getMinutes()).toBe(original.getMinutes());
          expect(deterministic.getSeconds()).toBe(original.getSeconds());
          expect(deterministic.getMilliseconds()).toBe(
            original.getMilliseconds(),
          );
        }

        // Test with constructor args
        const original = new Date(2023, 0, 15, 10, 30, 45, 123);
        const deterministic = new DeterministicDate(
          2023,
          0,
          15,
          10,
          30,
          45,
          123,
        );

        expect(deterministic.getFullYear()).toBe(original.getFullYear());
        expect(deterministic.getMonth()).toBe(original.getMonth());
        expect(deterministic.getDate()).toBe(original.getDate());
        expect(deterministic.getHours()).toBe(original.getHours());
        expect(deterministic.getMinutes()).toBe(original.getMinutes());
        expect(deterministic.getSeconds()).toBe(original.getSeconds());
        expect(deterministic.getMilliseconds()).toBe(
          original.getMilliseconds(),
        );
      });

      it("should produce identical string representations for deterministic dates", () => {
        const DeterministicDate = createDeterministicDate(
          Date,
          mockGetGenerationState,
        );

        const timestamp = 1640995200000; // 2022-01-01T00:00:00.000Z
        const original = new Date(timestamp);
        const deterministic = new DeterministicDate(timestamp);

        expect(deterministic.toISOString()).toBe(original.toISOString());
        expect(deterministic.toUTCString()).toBe(original.toUTCString());
        expect(deterministic.toDateString()).toBe(original.toDateString());
        expect(deterministic.toTimeString()).toBe(original.toTimeString());
        expect(deterministic.toJSON()).toBe(original.toJSON());
        expect(deterministic.valueOf()).toBe(original.valueOf());
        expect(deterministic.getTime()).toBe(original.getTime());
      });

      it("should handle UTC methods identically", () => {
        const DeterministicDate = createDeterministicDate(
          Date,
          mockGetGenerationState,
        );

        const timestamp = 1640995200123; // 2022-01-01T00:00:00.123Z
        const original = new Date(timestamp);
        const deterministic = new DeterministicDate(timestamp);

        expect(deterministic.getUTCFullYear()).toBe(original.getUTCFullYear());
        expect(deterministic.getUTCMonth()).toBe(original.getUTCMonth());
        expect(deterministic.getUTCDate()).toBe(original.getUTCDate());
        expect(deterministic.getUTCHours()).toBe(original.getUTCHours());
        expect(deterministic.getUTCMinutes()).toBe(original.getUTCMinutes());
        expect(deterministic.getUTCSeconds()).toBe(original.getUTCSeconds());
        expect(deterministic.getUTCMilliseconds()).toBe(
          original.getUTCMilliseconds(),
        );
        expect(deterministic.getUTCDay()).toBe(original.getUTCDay());
      });

      it("should handle static methods identically", () => {
        const DeterministicDate = createDeterministicDate(
          Date,
          mockGetGenerationState,
        );

        const dateString = "2023-01-15T10:30:45.123Z";
        const year = 2023;
        const month = 0; // January
        const day = 15;
        const hour = 10;
        const minute = 30;
        const second = 45;
        const ms = 123;

        expect(DeterministicDate.parse(dateString)).toBe(
          Date.parse(dateString),
        );
        expect(
          DeterministicDate.UTC(year, month, day, hour, minute, second, ms),
        ).toBe(Date.UTC(year, month, day, hour, minute, second, ms));
      });

      it("should maintain Date compatibility", () => {
        const DeterministicDate = createDeterministicDate(
          Date,
          mockGetGenerationState,
        );

        const date = new DeterministicDate(2023, 0, 1);

        // Should be an instance of Date (important for type compatibility)
        expect(date instanceof Date).toBe(true);

        // Should have all expected Date methods
        expect(typeof date.getTime).toBe("function");
        expect(typeof date.getFullYear).toBe("function");
        expect(typeof date.toISOString).toBe("function");
        expect(typeof date.getTimezoneOffset).toBe("function");
        expect(typeof date.toLocaleString).toBe("function");
      });

      it("should handle Date modification methods correctly", () => {
        const DeterministicDate = createDeterministicDate(
          Date,
          mockGetGenerationState,
        );

        const timestamp = 1640995200000; // 2022-01-01
        const original = new Date(timestamp);
        const deterministic = new DeterministicDate(timestamp);

        // Test setters
        const newTime = 1641081600000; // 2022-01-02
        original.setTime(newTime);
        deterministic.setTime(newTime);

        expect(deterministic.getTime()).toBe(original.getTime());

        // Test setFullYear
        original.setFullYear(2024);
        deterministic.setFullYear(2024);

        expect(deterministic.getFullYear()).toBe(original.getFullYear());
        expect(deterministic.getTime()).toBe(original.getTime());
      });

      it("should have timezone and locale methods available for future patching", () => {
        const DeterministicDate = createDeterministicDate(
          Date,
          mockGetGenerationState,
        );
        const date = new DeterministicDate(1640995200000); // 2022-01-01T00:00:00.000Z

        // These methods exist but are not yet fully patched for determinism
        // They currently still use system timezone/locale settings
        expect(typeof date.getTimezoneOffset).toBe("function");
        expect(typeof date.toLocaleString).toBe("function");
        expect(typeof date.toLocaleDateString).toBe("function");
        expect(typeof date.toLocaleTimeString).toBe("function");

        // The methods work but results depend on system settings
        const timezoneOffset = date.getTimezoneOffset();
        const localeString = date.toLocaleString();
        const localeDateString = date.toLocaleDateString();
        const localeTimeString = date.toLocaleTimeString();

        expect(typeof timezoneOffset).toBe("number");
        expect(typeof localeString).toBe("string");
        expect(typeof localeDateString).toBe("string");
        expect(typeof localeTimeString).toBe("string");

        // Should be consistent when called multiple times
        expect(date.getTimezoneOffset()).toBe(timezoneOffset);
        expect(date.toLocaleString()).toBe(localeString);
        expect(date.toLocaleDateString()).toBe(localeDateString);
        expect(date.toLocaleTimeString()).toBe(localeTimeString);

        // TODO: These methods should be patched for full determinism:
        // - getTimezoneOffset() should return 0 (UTC)
        // - locale methods should use fixed locale (en-US) and UTC timezone
      });
    });
  });

  describe("createConsole", () => {
    const mockGetGenerationState = vi.fn();
    let mockConsole: {
      log: ReturnType<typeof vi.fn>;
      info: ReturnType<typeof vi.fn>;
      warn: ReturnType<typeof vi.fn>;
      error: ReturnType<typeof vi.fn>;
      debug: ReturnType<typeof vi.fn>;
      group: ReturnType<typeof vi.fn>;
      groupEnd: ReturnType<typeof vi.fn>;
    };

    beforeEach(() => {
      mockConsole = {
        log: vi.fn(),
        info: vi.fn(),
        warn: vi.fn(),
        error: vi.fn(),
        debug: vi.fn(),
        group: vi.fn(),
        groupEnd: vi.fn(),
      };
    });

    afterEach(() => {
      mockGetGenerationState.mockReset();
    });

    it("should allow console methods when latest is true", () => {
      mockGetGenerationState.mockReturnValue({ now: 1000, latest: true });

      const proxiedConsole = createConsole(
        mockConsole as unknown as Console,
        mockGetGenerationState,
      );

      proxiedConsole.log("test");
      proxiedConsole.info("test");
      proxiedConsole.warn("test");
      proxiedConsole.error("test");

      expect(mockConsole.log).toHaveBeenCalledWith("test");
      expect(mockConsole.info).toHaveBeenCalledWith("test");
      expect(mockConsole.warn).toHaveBeenCalledWith("test");
      expect(mockConsole.error).toHaveBeenCalledWith("test");
    });

    it("should return noop function when latest is false", () => {
      mockGetGenerationState.mockReturnValue({ now: 1000, latest: false });

      const proxiedConsole = createConsole(
        mockConsole as unknown as Console,
        mockGetGenerationState,
      );

      // Methods should be functions (noop) but not call the original
      expect(typeof proxiedConsole.log).toBe("function");
      expect(typeof proxiedConsole.info).toBe("function");

      proxiedConsole.log("test");
      proxiedConsole.info("test");

      expect(mockConsole.log).not.toHaveBeenCalled();
      expect(mockConsole.info).not.toHaveBeenCalled();
    });

    it("should throw error for console.Console access", () => {
      mockGetGenerationState.mockReturnValue({ now: 1000, latest: true });

      const proxiedConsole = createConsole(
        mockConsole as unknown as Console,
        mockGetGenerationState,
      );

      expect(() => proxiedConsole.Console).toThrow(
        "console.Console() is not supported within workflows",
      );
    });

    it("should handle console.count with state tracking", () => {
      mockGetGenerationState.mockReturnValue({ now: 1000, latest: true });

      const proxiedConsole = createConsole(
        mockConsole as unknown as Console,
        mockGetGenerationState,
      );

      proxiedConsole.count("test");
      proxiedConsole.count("test");
      proxiedConsole.count(); // default label

      expect(mockConsole.info).toHaveBeenCalledWith("test: 1");
      expect(mockConsole.info).toHaveBeenCalledWith("test: 2");
      expect(mockConsole.info).toHaveBeenCalledWith("default: 1");
    });

    it("should handle console.countReset", () => {
      mockGetGenerationState.mockReturnValue({ now: 1000, latest: true });

      const proxiedConsole = createConsole(
        mockConsole as unknown as Console,
        mockGetGenerationState,
      );

      proxiedConsole.count("test");
      proxiedConsole.count("test");
      proxiedConsole.countReset("test");
      proxiedConsole.count("test");

      expect(mockConsole.info).toHaveBeenCalledWith("test: 1");
      expect(mockConsole.info).toHaveBeenCalledWith("test: 2");
      expect(mockConsole.info).toHaveBeenCalledWith("test: 1");
    });

    it("should always pass through groupEnd", () => {
      mockGetGenerationState.mockReturnValue({ now: 1000, latest: false });

      const proxiedConsole = createConsole(
        mockConsole as unknown as Console,
        mockGetGenerationState,
      );

      proxiedConsole.groupEnd();
      expect(mockConsole.groupEnd).toHaveBeenCalled();
    });

    it("should handle time/timeEnd with generation state", () => {
      const startTime = 1000;
      const endTime = 1500;

      // Mock different return values for different calls
      mockGetGenerationState
        .mockReturnValueOnce({ now: startTime, latest: false }) // for time()
        .mockReturnValueOnce({ now: endTime, latest: true }); // for timeEnd()

      const proxiedConsole = createConsole(
        mockConsole as unknown as Console,
        mockGetGenerationState,
      );

      proxiedConsole.time("test");
      proxiedConsole.timeEnd("test");

      expect(mockConsole.info).toHaveBeenCalledWith("test: 500ms");
    });

    it("should not call console methods for count when latest is false", () => {
      mockGetGenerationState.mockReturnValue({ now: 1000, latest: false });

      const proxiedConsole = createConsole(
        mockConsole as unknown as Console,
        mockGetGenerationState,
      );

      proxiedConsole.count("test");
      proxiedConsole.count("test");

      // Should not call info when latest is false
      expect(mockConsole.info).not.toHaveBeenCalled();
    });
  });
});

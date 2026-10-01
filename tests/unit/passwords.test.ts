import { describe, expect, it } from "vitest";
import { evaluatePassword, isPasswordValid, passwordsMatch } from "../../src/domain/passwords.js";

describe("password rules", () => {
  it("requires length, number, and symbol", () => {
    expect(isPasswordValid("short1!")).toBe(false);
    expect(isPasswordValid("longenough1")).toBe(false);
    expect(isPasswordValid("LongEnough!")).toBe(false);
    expect(isPasswordValid("LongEnough1!")).toBe(true);
    expect(evaluatePassword("LongEnough1!")).toEqual({
      minLength: true,
      number: true,
      symbol: true,
    });
  });

  it("checks confirmation match", () => {
    expect(passwordsMatch("LongEnough1!", "LongEnough1!")).toBe(true);
    expect(passwordsMatch("LongEnough1!", "nope")).toBe(false);
  });
});

export type PasswordRule = {
  id: "minLength" | "number" | "symbol";
  label: string;
  test: (password: string) => boolean;
};

export const PASSWORD_RULES: PasswordRule[] = [
  {
    id: "minLength",
    label: "At least 10 characters",
    test: (password) => password.length >= 10,
  },
  {
    id: "number",
    label: "One number",
    test: (password) => /\d/.test(password),
  },
  {
    id: "symbol",
    label: "One symbol",
    test: (password) => /[^A-Za-z0-9]/.test(password),
  },
];

export function evaluatePassword(password: string): Record<PasswordRule["id"], boolean> {
  return {
    minLength: PASSWORD_RULES[0]!.test(password),
    number: PASSWORD_RULES[1]!.test(password),
    symbol: PASSWORD_RULES[2]!.test(password),
  };
}

export function isPasswordValid(password: string): boolean {
  return PASSWORD_RULES.every((rule) => rule.test(password));
}

export function passwordsMatch(password: string, confirm: string): boolean {
  return password.length > 0 && password === confirm;
}

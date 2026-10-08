import type { ComponentType } from "@prisma/client";

export type DefaultComponentInput = {
  type: ComponentType;
  enabled: boolean;
  weight: number;
};

/** Programme staff default — set by admin; staff do not configure weights in the UI. */
export const DEFAULT_PROGRAMME_COMPONENTS: DefaultComponentInput[] = [
  { type: "PROJECTS", enabled: true, weight: 50 },
  { type: "BD", enabled: true, weight: 15 },
  { type: "TECH_PERSONAL", enabled: true, weight: 25 },
  { type: "COP", enabled: true, weight: 10 },
];

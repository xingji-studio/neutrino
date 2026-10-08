export type RGB = [number, number, number];

export const C = {
  accent: [153, 217, 234] as RGB, // #99D9EA
  highlightBg: [40, 57, 61] as RGB, // #28393D
  black: [0, 0, 0] as RGB,
  dim: [86, 95, 137] as RGB, // #565F89
  user: [169, 177, 214] as RGB, // #A9B1D6
  assistant: [192, 202, 245] as RGB, // #C0CAF5
  toolHeader: [153, 217, 234] as RGB, // cyan
  amber: [224, 175, 104] as RGB, // #E0AF68
  white: [226, 232, 240] as RGB,
  green: [115, 218, 202] as RGB,
  red: [247, 118, 142] as RGB,
  codeBg: [27, 35, 49] as RGB, // dark blue-grey used behind code blocks
} as const;

export interface Style {
  fg?: RGB;
  bg?: RGB;
  bold?: boolean;
  dim?: boolean;
  inverse?: boolean;
  italic?: boolean;
}

export const EMPTY_STYLE: Style = {};

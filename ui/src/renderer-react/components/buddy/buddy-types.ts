export const RARITIES = [
  'common',
  'uncommon',
  'rare',
  'epic',
  'legendary',
] as const;
export type Rarity = (typeof RARITIES)[number];

// Species
export const duck = 'duck' as const;
export const goose = 'goose' as const;
export const blob = 'blob' as const;
export const cat = 'cat' as const;
export const dragon = 'dragon' as const;
export const octopus = 'octopus' as const;
export const owl = 'owl' as const;
export const penguin = 'penguin' as const;
export const turtle = 'turtle' as const;
export const snail = 'snail' as const;
export const ghost = 'ghost' as const;
export const axolotl = 'axolotl' as const;
export const capybara = 'capybara' as const;
export const cactus = 'cactus' as const;
export const robot = 'robot' as const;
export const rabbit = 'rabbit' as const;
export const mushroom = 'mushroom' as const;
export const chonk = 'chonk' as const;

export const SPECIES = [
  duck,
  goose,
  blob,
  cat,
  dragon,
  octopus,
  owl,
  penguin,
  turtle,
  snail,
  ghost,
  axolotl,
  capybara,
  cactus,
  robot,
  rabbit,
  mushroom,
  chonk,
] as const;
export type Species = (typeof SPECIES)[number];

export const EYES = ['·', '✦', '×', '◉', '@', '°'] as const;
export type Eye = (typeof EYES)[number];

export const HATS = [
  'none',
  'crown',
  'tophat',
  'propeller',
  'halo',
  'wizard',
  'beanie',
  'tinyduck',
] as const;
export type Hat = (typeof HATS)[number];

export const STAT_NAMES = [
  'DEBUGGING',
  'PATIENCE',
  'CHAOS',
  'WISDOM',
  'SNARK',
] as const;
export type StatName = (typeof STAT_NAMES)[number];

export type CompanionBones = {
  rarity: Rarity;
  species: Species;
  eye: Eye;
  hat: Hat;
  shiny: boolean;
  stats: Record<StatName, number>;
};

export type CompanionSoul = {
  name: string;
  personality: string;
};

export type Companion = CompanionBones &
  CompanionSoul & {
    hatchedAt: number;
  };

export type StoredCompanion = CompanionSoul & { hatchedAt: number };

export const RARITY_WEIGHTS: Record<Rarity, number> = {
  common: 60,
  uncommon: 25,
  rare: 10,
  epic: 4,
  legendary: 1,
};

export const RARITY_STARS: Record<Rarity, string> = {
  common: '★',
  uncommon: '★★',
  rare: '★★★',
  epic: '★★★★',
  legendary: '★★★★★',
};

export const RARITY_COLORS: Record<Rarity, string> = {
  common: '#9ca3af',
  uncommon: '#22c55e',
  rare: '#3b82f6',
  epic: '#a855f7',
  legendary: '#f59e0b',
};

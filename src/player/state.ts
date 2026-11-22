export type PlayerVitals = {
  hp: number;
  armor: number;
  mag: number;
  reserve: number;
};

export const START_VITALS: PlayerVitals = {
  hp: 100,
  armor: 0,
  mag: 40,
  reserve: 40,
};

export type PlayerListener = (state: PlayerVitals) => void;

export type PlayerStore = {
  get(): PlayerVitals;
  set(patch: Partial<PlayerVitals>): void;
  restart(): void;
  subscribe(listener: PlayerListener): () => void;
};

export function createPlayerState(initial?: Partial<PlayerVitals>): PlayerStore {
  let current: PlayerVitals = { ...START_VITALS, ...initial };
  const listeners = new Set<PlayerListener>();

  function snapshot(): PlayerVitals {
    return {
      hp: current.hp,
      armor: current.armor,
      mag: current.mag,
      reserve: current.reserve,
    };
  }

  function emit(): void {
    const state = snapshot();
    for (const listener of listeners) listener(state);
  }

  return {
    get: snapshot,
    set(patch: Partial<PlayerVitals>): void {
      current = { ...current, ...patch };
      emit();
    },
    restart(): void {
      current = { ...START_VITALS };
      emit();
    },
    subscribe(listener: PlayerListener): () => void {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  };
}

const DEBUG_KEY = "__fragPlayer";

export function exposePlayerDebug(target: object, player: PlayerStore): void {
  Object.defineProperty(target, DEBUG_KEY, {
    configurable: true,
    enumerable: true,
    value: player,
  });
}

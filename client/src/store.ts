// Tiny global store (no external state library). Components subscribe with useStore(selector).
import { useSyncExternalStore } from 'react';
import type { PetInstance, PublicPlayer, RoomEventState, RoomInfo, SaveData, TradeView } from '../../shared/types';

export type PanelId =
  | 'pets' | 'egg' | 'gate' | 'upgrades' | 'golden' | 'rainbow' | 'enchant' | 'daily' | 'index' | 'rebirth'
  | 'quests' | 'achievements' | 'items' | 'teleport' | 'players' | 'trade' | 'settings';

export interface Settings {
  music: number;
  sfx: number;
  reducedEffects: boolean;
  skipHatch: boolean;
  showNames: boolean;
  camSens: number;
  quality: 'auto' | 'low' | 'high';
}

export interface Toast { id: number; text: string; kind: string; at: number }
export interface ChatMsg { id: number; name: string; color: string; text: string; sys?: boolean }
export interface HatchState { zone: number; pets: (PetInstance & { deleted?: boolean })[]; key: number }
export interface Interactable { kind: 'egg' | 'gate' | 'station'; id: string; label: string; zone?: number }

export interface ClientState {
  screen: 'home' | 'loading' | 'game';
  loadingText: string;
  homeError: string;
  me: { id: string; nickname: string; color: string } | null;
  save: SaveData | null;
  room: RoomInfo | null;
  players: Record<string, PublicPlayer>;
  conn: 'connected' | 'connecting' | 'reconnecting' | 'offline';
  events: RoomEventState | null;
  serverOffset: number;
  toasts: Toast[];
  banner: { text: string; kind: string; key: number } | null;
  panel: PanelId | null;
  panelArg: any;
  interact: Interactable | null;
  trade: TradeView | null;
  tradeReqs: { from: string; name: string; expires: number }[];
  hatch: HatchState | null;
  chat: ChatMsg[];
  chatOpen: boolean;
  autoFarm: boolean;
  autoHatch: number | null;
  zone: number;
  settings: Settings;
  devCheats: boolean;
  isTouch: boolean;
  tutorialStep: number;
}

const SETTINGS_KEY = 'cq_settings_v1';
const defaultSettings: Settings = { music: 0.35, sfx: 0.7, reducedEffects: false, skipHatch: false, showNames: true, camSens: 1, quality: 'auto' };

function loadSettings(): Settings {
  try {
    const raw = localStorage.getItem(SETTINGS_KEY);
    if (raw) return { ...defaultSettings, ...JSON.parse(raw) };
  } catch {
    /* storage unavailable */
  }
  return { ...defaultSettings };
}

let state: ClientState = {
  screen: 'home',
  loadingText: '',
  homeError: '',
  me: null,
  save: null,
  room: null,
  players: {},
  conn: 'offline',
  events: null,
  serverOffset: 0,
  toasts: [],
  banner: null,
  panel: null,
  panelArg: null,
  interact: null,
  trade: null,
  tradeReqs: [],
  hatch: null,
  chat: [],
  chatOpen: false,
  autoFarm: false,
  autoHatch: null,
  zone: 0,
  settings: loadSettings(),
  devCheats: false,
  isTouch: typeof window !== 'undefined' && ('ontouchstart' in window || navigator.maxTouchPoints > 0) && matchMedia('(pointer: coarse)').matches,
  tutorialStep: 0,
};

const listeners = new Set<() => void>();

export const store = {
  get: () => state,
  set(patch: Partial<ClientState> | ((s: ClientState) => Partial<ClientState>)) {
    const p = typeof patch === 'function' ? patch(state) : patch;
    state = { ...state, ...p };
    if ('settings' in p) {
      try {
        localStorage.setItem(SETTINGS_KEY, JSON.stringify(state.settings));
      } catch {
        /* ignore */
      }
    }
    for (const l of listeners) l();
  },
  subscribe(l: () => void) {
    listeners.add(l);
    return () => listeners.delete(l);
  },
};

export function useStore<T>(sel: (s: ClientState) => T): T {
  return useSyncExternalStore(store.subscribe, () => sel(state), () => sel(state));
}

let toastSeq = 0;
export function toast(text: string, kind = 'info') {
  const t: Toast = { id: ++toastSeq, text, kind, at: Date.now() };
  store.set((s) => ({ toasts: [...s.toasts.slice(-4), t] }));
  setTimeout(() => store.set((s) => ({ toasts: s.toasts.filter((x) => x.id !== t.id) })), kind === 'error' ? 3500 : 4500);
}

let bannerSeq = 0;
export function banner(text: string, kind = 'info') {
  const key = ++bannerSeq;
  store.set({ banner: { text, kind, key } });
  setTimeout(() => {
    if (store.get().banner?.key === key) store.set({ banner: null });
  }, 5000);
}

let chatSeq = 0;
export function pushChat(m: Omit<ChatMsg, 'id'>) {
  store.set((s) => ({ chat: [...s.chat.slice(-40), { ...m, id: ++chatSeq }] }));
}

export function openPanel(panel: PanelId | null, panelArg: any = null) {
  store.set({ panel, panelArg });
}

export function setSettings(patch: Partial<Settings>) {
  store.set((s) => ({ settings: { ...s.settings, ...patch } }));
}

export const serverNow = () => Date.now() + state.serverOffset;

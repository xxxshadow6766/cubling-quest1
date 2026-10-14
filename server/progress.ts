// Stats, quests, ranks and achievements. All progression is computed on the server.
import { ACHIEVEMENTS, QUESTS, RANKS, ZONES, type QuestTemplate } from '../shared/config';
import { fmt, rankDef } from '../shared/formulas';
import type { QuestState } from '../shared/types';
import type { Player } from './Player';
import { rand } from './rng';

/** Quest types that are driven by stat bumps. */
const QUEST_FOR_STAT: Record<string, string> = {
  breakables: 'break',
  chests: 'breakChest',
  eggs: 'hatch',
  epicHatched: 'hatchEpic',
  coinsEarned: 'earnCoins',
  zonesUnlocked: 'unlockZone',
  goldenMade: 'makeGolden',
  boostsUsed: 'useBoost',
  bossChests: 'bossChest',
  coopBreaks: 'coopBreak',
  gemsEarned: 'earnGems',
};

export function bump(p: Player, stat: string, amount = 1) {
  if (!amount) return;
  const s = p.save.stats;
  s[stat] = (s[stat] ?? 0) + amount;
  const qType = QUEST_FOR_STAT[stat];
  if (qType) {
    for (const q of p.save.quests) {
      const tpl = QUESTS.templates.find((t) => t.id === q.tpl);
      if (tpl?.type === qType && q.progress < q.target) q.progress = Math.min(q.target, q.progress + amount);
    }
  }
  p.metaDirty = true;
  p.dirty = true;
  checkAchievements(p);
}

export function refreshDerivedStats(p: Player) {
  const s = p.save.stats;
  s.maxZone = Math.max(s.maxZone ?? 1, p.save.zone);
  s.indexCount = Object.keys(p.save.index).length;
  s.rank = p.save.rank;
  checkAchievements(p);
}

export function checkAchievements(p: Player) {
  for (const a of ACHIEVEMENTS) {
    let got = p.save.achievements[a.id] ?? 0;
    const val = p.save.stats[a.stat] ?? 0;
    while (got < a.tiers.length && val >= a.tiers[got]) {
      const gems = a.gems[got] ?? 0;
      p.save.gems += gems;
      got++;
      p.save.achievements[a.id] = got;
      p.toast(`${a.icon} Achievement: ${a.name} ${'I'.repeat(Math.min(got, 3))}${got > 3 ? got : ''} — +${fmt(gems)} gems`, 'achievement');
      p.curDirty = p.metaDirty = p.dirty = true;
    }
  }
}

function questTarget(tpl: QuestTemplate, p: Player): number {
  if (tpl.type === 'earnCoins') {
    const next = ZONES[Math.min(ZONES.length - 1, p.save.zone + 1)];
    const ref = p.save.zone >= ZONES.length - 1 ? next.eggCost * 40 : next.gateCost;
    return Math.max(100, Math.round(ref * (tpl.factor ?? 1)));
  }
  return Math.max(1, Math.round((tpl.base ?? 1) + (tpl.perRank ?? 0) * (p.save.rank - 1)));
}

export function makeQuest(p: Player, exclude: Set<string>): QuestState | null {
  const inFriends = p.room?.mode === 'friends';
  const hasItem = Object.values(p.save.items).some((n) => n > 0);
  const pool = QUESTS.templates.filter((t) =>
    !exclude.has(t.id) &&
    (t.minRank ?? 0) <= p.save.rank &&
    (t.minZone ?? 0) <= p.save.zone &&
    (!t.coop || inFriends) &&
    (!t.needsLockedZone || p.save.zone < ZONES.length - 1) &&
    (!t.needsItem || hasItem));
  if (!pool.length) return null;
  const tpl = pool[Math.floor(rand() * pool.length)];
  const target = questTarget(tpl, p);
  return { tpl: tpl.id, target, progress: 0, xp: tpl.xp, gems: tpl.gems, label: tpl.label.replace('{n}', fmt(target)) };
}

export function fillQuests(p: Player) {
  const ex = new Set(p.save.quests.map((q) => q.tpl));
  while (p.save.quests.length < QUESTS.active) {
    const q = makeQuest(p, ex);
    if (!q) break;
    ex.add(q.tpl);
    p.save.quests.push(q);
    p.metaDirty = p.dirty = true;
  }
}

export function addRankXp(p: Player, xp: number) {
  p.save.rankXp += xp;
  while (p.save.rank < RANKS.length && p.save.rankXp >= rankDef(p.save.rank).xp) {
    p.save.rankXp -= rankDef(p.save.rank).xp;
    p.save.rank++;
    const r = rankDef(p.save.rank);
    const rw = r.rewards;
    if (rw.gems) p.save.gems += rw.gems;
    for (const [id, n] of Object.entries(rw.items ?? {})) p.save.items[id] = (p.save.items[id] ?? 0) + n;
    const extras = [
      rw.gems ? `+${fmt(rw.gems)} gems` : '',
      rw.slots ? `+${rw.slots} pet slot` : '',
      rw.enchantSlots ? `+${rw.enchantSlots} enchant slot` : '',
      rw.unlock === 'autoFarm' ? 'Auto Farm unlocked!' : '',
      rw.items ? 'bonus potions' : '',
    ].filter(Boolean).join(', ');
    p.toast(`⭐ Rank up! You are now Rank ${p.save.rank} — ${r.name}. ${extras}`, 'rank');
    p.emit('rankup', { rank: p.save.rank, name: r.name });
  }
  refreshDerivedStats(p);
  p.metaDirty = p.curDirty = p.dirty = true;
}

// Every client request goes through here. Clients only ever *ask*; the server validates
// (ownership, location, currency, cooldowns) and performs the change.
import { BALANCE, BOOSTS_BY_ID, DAILY, ENCHANTS, ENCHANTS_BY_ID, ITEMS, SPECIES_BY_ID, UNLOCKS, UPGRADES_BY_ID, ZONES } from '../shared/config';
import { indexBits, nextRebirth, petName, petPower, rollEgg, upgradeCost, weightedPick } from '../shared/formulas';
import type { PetInstance, Rarity } from '../shared/types';
import { dist2, eggStandPos, gateZ, stationPos, zoneSpawn } from '../shared/world';
import { newId } from './auth';
import type { GameServer } from './GameServer';
import type { Player } from './Player';
import { addRankXp, bump, makeQuest, refreshDerivedStats } from './progress';
import { rand } from './rng';
import { TradeError } from './trade';

export class GameError extends Error {}
const fail = (msg: string): never => {
  throw new GameError(msg);
};

const int = (v: unknown, min: number, max: number): number => {
  const n = typeof v === 'number' ? v : Number.NaN;
  if (!Number.isInteger(n) || n < min || n > max) fail('Invalid request.');
  return n;
};
const str = (v: unknown, max = 64): string => (typeof v === 'string' && v.length > 0 && v.length <= max ? v : fail('Invalid request.'));
const idList = (v: unknown, max: number): string[] => {
  if (!Array.isArray(v) || v.length > max || !v.every((s) => typeof s === 'string' && s.length <= 32)) fail('Invalid request.');
  return [...new Set(v as string[])];
};

const SLACK = 5; // tolerance for latency on proximity checks
function near(p: Player, x: number, z: number, r: number) {
  if (dist2(p.x, p.z, x, z) > r + SLACK) fail('Move closer to use that.');
}
function nearStation(p: Player, id: string) {
  const s = stationPos(id);
  if (!s) fail('Unknown station.');
  near(p, s!.x, s!.z, BALANCE.interactRange);
}
function noTrade(p: Player) {
  if (p.trade) fail('Finish or cancel your trade first.');
}

function afterPetsChanged(p: Player) {
  const owned = new Set(p.save.pets.map((x) => x.id));
  p.save.equipped = p.save.equipped.filter((id) => owned.has(id));
  const eq = new Set(p.save.equipped);
  for (const petId of [...p.targets.keys()]) {
    if (!eq.has(petId)) {
      p.targets.delete(petId);
      p.targetsChanged = true;
    }
  }
  p.petsDirty = p.metaDirty = p.dirty = true;
  p.room?.broadcast('pj', p.publicView());
}

function addPetToIndex(p: Player, pet: Omit<PetInstance, 'id'>) {
  p.save.index[pet.s] = (p.save.index[pet.s] ?? 0) | indexBits(pet);
}

type Handler = (gs: GameServer, p: Player, a: Record<string, unknown>) => Record<string, unknown> | void;

const H: Record<string, Handler> = {
  // ------------------------------------------------------------------ combat
  target(_gs, p, a) {
    const bk = a.bk === null ? null : str(a.bk, 16);
    const r = p.room!.setTarget(p, bk);
    if (!r.ok) fail(r.error!);
    return { toggledOff: !!r.toggledOff };
  },
  autoFarm(_gs, p, a) {
    const on = !!a.on;
    if (on && !p.stats().autoFarm) fail(`Auto Farm unlocks at Rank ${BALANCE.autoFarmUnlockRank}. Complete quests to rank up!`);
    p.autoFarm = on;
    if (!on) {
      p.targets.clear();
      p.targetsChanged = true;
    }
    return { on };
  },

  // ------------------------------------------------------------------ eggs
  hatch(gs, p, a) {
    const zone = int(a.zone, 1, BALANCE.zoneCount);
    const count = int(a.count, 1, 8);
    const now = Date.now();
    const st = p.stats(now);
    if (!st.hatchCounts.includes(count)) fail('Unlock multi-hatch at the Upgrade Station first.');
    if (zone > p.save.zone) fail('Unlock this area first.');
    const egg = eggStandPos(zone);
    near(p, egg.x, egg.z, BALANCE.interactRange);
    if (now - p.lastHatch < st.hatchCooldown * 1000 * 0.8) fail('Hatching too fast!');
    const cost = ZONES[zone].eggCost * count;
    if (p.save.coins < cost) fail('Not enough coins!');
    const results: { pet: PetInstance; deleted: boolean }[] = [];
    for (let i = 0; i < count; i++) {
      const pet: PetInstance = { id: newId(), ...rollEgg(zone, st.luck, rand) };
      const r = SPECIES_BY_ID[pet.s].r;
      const deleted = !pet.hg && !pet.sh && pet.v === 'normal' && p.save.autoDelete.includes(r);
      results.push({ pet, deleted });
    }
    const kept = results.filter((r) => !r.deleted).map((r) => r.pet);
    if (p.save.pets.length + kept.length > st.invCap) fail('Your pet storage is full! Delete some pets or upgrade Pet Storage.');
    p.save.coins -= cost;
    p.save.pets.push(...kept);
    p.lastHatch = now;
    for (const r of results) {
      addPetToIndex(p, r.pet);
      const rar = SPECIES_BY_ID[r.pet.s].r;
      if (['epic', 'legendary', 'mythic', 'secret'].includes(rar)) bump(p, 'epicHatched');
      if (r.pet.hg) bump(p, 'hugeHatched');
      if (r.pet.hg || rar === 'mythic' || rar === 'secret') {
        p.room?.broadcast('evmsg', { text: `🎉 ${p.nickname} hatched a ${r.pet.hg ? 'HUGE ' : ''}${rar === 'secret' ? 'SECRET ' : rar === 'mythic' ? 'Mythic ' : ''}${petName(r.pet)}!`, kind: 'huge' });
      }
    }
    bump(p, 'eggs', count);
    refreshDerivedStats(p);
    p.markAll();
    gs.saveNow(p);
    return { pets: results.map((r) => ({ ...r.pet, deleted: r.deleted })) };
  },

  // ------------------------------------------------------------------ inventory
  equip(_gs, p, a) {
    const id = str(a.id, 32);
    if (!p.pet(id)) fail('Pet not found.');
    if (p.save.equipped.includes(id)) return;
    if (p.save.equipped.length >= p.stats().slots) fail('All pet slots are full. Unequip a pet or buy more slots.');
    p.save.equipped.push(id);
    afterPetsChanged(p);
  },
  unequip(_gs, p, a) {
    const id = str(a.id, 32);
    p.save.equipped = p.save.equipped.filter((x) => x !== id);
    afterPetsChanged(p);
  },
  equipBest(_gs, p) {
    const slots = p.stats().slots;
    const best = [...p.save.pets].sort((x, y) => petPower(y) - petPower(x)).slice(0, slots);
    p.save.equipped = best.map((x) => x.id);
    afterPetsChanged(p);
  },
  lock(gs, p, a) {
    noTrade(p);
    const ids = idList(a.ids, 1000);
    const lock = !!a.locked;
    for (const id of ids) {
      const pet = p.pet(id);
      if (pet) pet.lk = lock || undefined;
    }
    afterPetsChanged(p);
    gs.saveNow(p);
  },
  deletePets(gs, p, a) {
    noTrade(p);
    const ids = new Set(idList(a.ids, 1000));
    const victims = p.save.pets.filter((x) => ids.has(x.id));
    if (!victims.length) fail('No pets selected.');
    if (victims.some((x) => x.lk)) fail('Locked pets cannot be deleted. Unlock them first.');
    if (victims.length >= p.save.pets.length) fail('You must keep at least one pet.');
    p.save.pets = p.save.pets.filter((x) => !ids.has(x.id));
    afterPetsChanged(p);
    if (!p.save.equipped.length) H.equipBest(gs, p, {});
    gs.saveNow(p);
    return { deleted: victims.length };
  },
  golden(gs, p, a) {
    return convert(gs, p, str(a.id, 32), 'golden');
  },
  rainbow(gs, p, a) {
    return convert(gs, p, str(a.id, 32), 'rainbow');
  },
  setAutoDelete(gs, p, a) {
    if (!Array.isArray(a.rarities)) fail('Invalid request.');
    const allowed: Rarity[] = ['common', 'rare', 'epic', 'legendary'];
    const list = [...new Set(a.rarities as unknown[])].filter((r): r is Rarity => allowed.includes(r as Rarity));
    p.save.autoDelete = list;
    p.metaDirty = p.dirty = true;
    gs.saveNow(p);
    return { rarities: list };
  },

  // ------------------------------------------------------------------ world
  unlockZone(gs, p, a) {
    const zone = int(a.zone, 2, BALANCE.zoneCount);
    if (zone !== p.save.zone + 1) fail(zone <= p.save.zone ? 'Already unlocked.' : 'Unlock the previous area first.');
    if (Math.abs(p.z - gateZ(zone)) > 12 + SLACK || Math.abs(p.x) > 14 + SLACK) fail('Walk up to the gate to unlock it.');
    const cost = ZONES[zone].gateCost;
    if (p.save.coins < cost) fail('Not enough coins!');
    p.save.coins -= cost;
    p.save.zone = zone;
    bump(p, 'zonesUnlocked');
    refreshDerivedStats(p);
    p.markAll();
    gs.saveNow(p);
    p.room?.broadcast('pj', p.publicView());
    return { zone };
  },
  teleport(_gs, p, a) {
    const zone = int(a.zone, 0, p.save.zone);
    const pos = zoneSpawn(zone);
    p.x = pos.x;
    p.z = pos.z;
    p.y = 0;
    p.lastMoveAt = Date.now();
    p.targets.clear();
    p.targetsChanged = true;
    p.emit('tp', pos);
    return pos;
  },

  // ------------------------------------------------------------------ shops
  buyUpgrade(gs, p, a) {
    nearStation(p, 'upgrades');
    const def = UPGRADES_BY_ID[str(a.id, 32)];
    if (!def) fail('Unknown upgrade.');
    const lvl = p.save.upgrades[def.id] ?? 0;
    if (lvl >= def.max) fail('Already maxed!');
    const cost = upgradeCost(def, lvl);
    if (def.currency === 'coins') {
      if (p.save.coins < cost) fail('Not enough coins!');
      p.save.coins -= cost;
    } else {
      if (p.save.gems < cost) fail('Not enough gems!');
      p.save.gems -= cost;
    }
    p.save.upgrades[def.id] = lvl + 1;
    p.markAll();
    gs.saveNow(p);
    return { id: def.id, level: lvl + 1 };
  },
  buyUnlock(gs, p, a) {
    nearStation(p, 'upgrades');
    const def = UNLOCKS.find((u) => u.id === a.id);
    if (!def) fail('Unknown unlock.');
    if (p.save.unlocks[def!.id]) fail('Already unlocked!');
    if (def!.requires && !p.save.unlocks[def!.requires]) fail('Unlock the previous hatch upgrade first.');
    if (p.save.gems < def!.cost) fail('Not enough gems!');
    p.save.gems -= def!.cost;
    p.save.unlocks[def!.id] = true;
    p.markAll();
    gs.saveNow(p);
    return { id: def!.id };
  },
  enchantBuy(gs, p) {
    nearStation(p, 'enchant');
    if (p.save.gems < BALANCE.enchantAltarCost) fail('Not enough gems!');
    p.save.gems -= BALANCE.enchantAltarCost;
    const book = weightedPick(ENCHANTS, rand);
    p.save.books[book.id] = (p.save.books[book.id] ?? 0) + 1;
    p.markAll();
    gs.saveNow(p);
    return { book: book.id };
  },
  enchantEquip(gs, p, a) {
    const id = str(a.id, 32);
    if (!ENCHANTS_BY_ID[id]) fail('Unknown enchant.');
    const owned = p.save.books[id] ?? 0;
    const used = p.save.enchants.filter((x) => x === id).length;
    if (used >= owned) fail("You don't have a spare copy of that book.");
    if (p.save.enchants.length >= p.stats().enchantSlots) fail('All enchant slots are in use.');
    p.save.enchants.push(id);
    p.metaDirty = p.dirty = true;
    gs.saveNow(p);
  },
  enchantUnequip(gs, p, a) {
    const i = int(a.index, 0, 20);
    if (i >= p.save.enchants.length) fail('Invalid slot.');
    p.save.enchants.splice(i, 1);
    p.metaDirty = p.dirty = true;
    gs.saveNow(p);
  },
  useItem(gs, p, a) {
    const def = BOOSTS_BY_ID[str(a.id, 32)];
    if (!def) fail('Unknown item.');
    if ((p.save.items[def.id] ?? 0) <= 0) fail("You don't have that item.");
    const now = Date.now();
    p.save.items[def.id]--;
    const cur = Math.max(now, p.save.boosts[def.effect] ?? 0);
    p.save.boosts[def.effect] = Math.min(now + ITEMS.maxStackSec * 1000, cur + def.duration * 1000);
    bump(p, 'boostsUsed');
    p.markAll();
    gs.saveNow(p);
    return { effect: def.effect, until: p.save.boosts[def.effect] };
  },
  claimDaily(gs, p) {
    nearStation(p, 'daily');
    const now = Date.now();
    const d = p.save.daily;
    if (d.last && now - d.last < DAILY.cooldownHours * 3600_000) fail('Come back later for your next gift!');
    const streak = d.last && now - d.last > DAILY.streakResetHours * 3600_000 ? 1 : d.streak + 1;
    const day = DAILY.days[(streak - 1) % DAILY.days.length];
    p.save.daily = { last: now, streak };
    p.save.gems += day.gems;
    for (const [id, n] of Object.entries(day.items)) p.save.items[id] = (p.save.items[id] ?? 0) + n;
    let book: string | null = null;
    if (day.enchant) {
      book = weightedPick(ENCHANTS, rand).id;
      p.save.books[book] = (p.save.books[book] ?? 0) + 1;
    }
    p.markAll();
    gs.saveNow(p);
    return { streak, gems: day.gems, items: day.items, book };
  },

  // ------------------------------------------------------------------ progression
  rebirth(gs, p) {
    nearStation(p, 'rebirth');
    noTrade(p);
    const def = nextRebirth(p.save.rebirths);
    if (p.save.zone < def.requiresZone) fail(`Reach area ${def.requiresZone} to rebirth.`);
    const s = p.save;
    s.coins = 0;
    s.zone = 1;
    for (const u of Object.values(UPGRADES_BY_ID)) if (u.currency === 'coins') delete s.upgrades[u.id];
    s.rebirths++;
    s.gems += def.gems;
    if (def.unlock) s.unlocks[def.unlock] = true;
    if (def.unlock === 'octoHatch') s.unlocks.tripleHatch = true;
    bump(p, 'rebirths');
    refreshDerivedStats(p);
    H.teleport(gs, p, { zone: 0 });
    p.markAll();
    gs.saveNow(p);
    p.room?.broadcast('evmsg', { text: `🔄 ${p.nickname} reached Rebirth ${s.rebirths}!`, kind: 'rebirth' });
    p.room?.broadcast('pj', p.publicView());
    return { rebirths: s.rebirths };
  },
  claimQuest(gs, p, a) {
    const i = int(a.index, 0, 9);
    const q = p.save.quests[i];
    if (!q) fail('Quest not found.');
    if (q.progress < q.target) fail('Quest not complete yet.');
    const ex = new Set(p.save.quests.map((x) => x.tpl));
    p.save.quests.splice(i, 1);
    p.save.gems += q.gems;
    addRankXp(p, q.xp);
    const nq = makeQuest(p, ex);
    if (nq) p.save.quests.splice(i, 0, nq);
    p.markAll();
    gs.saveNow(p);
    return { gems: q.gems, xp: q.xp };
  },
  rerollQuest(gs, p, a) {
    const i = int(a.index, 0, 9);
    const q = p.save.quests[i];
    if (!q) fail('Quest not found.');
    if (p.save.gems < BALANCE.questRerollCost) fail('Not enough gems!');
    const ex = new Set(p.save.quests.map((x) => x.tpl));
    const nq = makeQuest(p, ex);
    if (!nq) fail('No other quests available right now.');
    p.save.gems -= BALANCE.questRerollCost;
    p.save.quests[i] = nq!;
    p.markAll();
    gs.saveNow(p);
  },
  tutorial(gs, p, a) {
    const step = int(a.step, 0, 20);
    if (step > p.save.tutorial) p.save.tutorial = step;
    if (step >= 6 && p.save.zone >= 2 && !p.save.stats.tutorialReward) {
      p.save.stats.tutorialReward = 1;
      p.save.gems += 50;
      p.toast('🎓 Tutorial complete! +50 gems', 'achievement');
    }
    p.markAll();
    gs.saveNow(p);
  },

  // ------------------------------------------------------------------ social
  chat(_gs, p, a) {
    const raw = str(a.text, 300).replace(/[\u0000-\u001f\u007f]/g, '').trim().slice(0, 140);
    if (!raw) fail('Empty message.');
    const now = Date.now();
    if (now - p.lastChat < 800) fail('Slow down!');
    p.lastChat = now;
    p.room!.broadcast('chat', { id: p.id, name: p.nickname, color: p.color, text: raw });
  },
  kick(gs, p, a) {
    const room = p.room!;
    if (room.ownerId !== p.id) fail('Only the room owner can remove players.');
    const id = str(a.id, 32);
    if (id === p.id) fail("You can't remove yourself.");
    const target = room.members.get(id);
    if (!target) fail('Player not in this room.');
    gs.kick(room, target!);
  },
  tradeRequest(gs, p, a) {
    gs.trades.request(p, str(a.to, 32));
  },
  tradeRespond(gs, p, a) {
    gs.trades.respond(p, str(a.from, 32), !!a.accept);
  },
  tradeOffer(gs, p, a) {
    gs.trades.setOffer(p, a.tradeId, a.pets, a.gems);
  },
  tradeReady(gs, p, a) {
    gs.trades.setReady(p, a.tradeId, a.version, a.ready);
  },
  tradeCancel(gs, p, a) {
    if (p.trade && p.trade.id === a.tradeId) gs.trades.cancel(p.trade, `${p.nickname} cancelled the trade.`);
  },

  // ------------------------------------------------------------------ dev only
  cheat(gs, p, a) {
    if (!gs.devCheats) fail('Unknown action.');
    const s = p.save;
    if (typeof a.coins === 'number' && Number.isFinite(a.coins)) s.coins = Math.max(0, a.coins);
    if (typeof a.gems === 'number' && Number.isFinite(a.gems)) s.gems = Math.max(0, Math.floor(a.gems));
    if (typeof a.zone === 'number') s.zone = Math.max(1, Math.min(BALANCE.zoneCount, Math.floor(a.zone)));
    if (typeof a.rank === 'number') s.rank = Math.max(1, Math.min(25, Math.floor(a.rank)));
    if (typeof a.x === 'number' && typeof a.z === 'number') {
      p.x = a.x;
      p.z = a.z;
      p.lastMoveAt = Date.now();
      p.emit('tp', { x: p.x, z: p.z });
    }
    refreshDerivedStats(p);
    p.markAll();
    gs.saveNow(p);
  },
};

function convert(gs: GameServer, p: Player, id: string, kind: 'golden' | 'rainbow') {
  nearStation(p, kind);
  noTrade(p);
  const cfg = kind === 'golden' ? BALANCE.golden : BALANCE.rainbow;
  if (kind === 'rainbow' && p.save.zone < BALANCE.rainbow.requiresZone) fail(`Reach area ${BALANCE.rainbow.requiresZone} to use the Rainbow Machine.`);
  const from = kind === 'golden' ? 'normal' : 'golden';
  const base = p.pet(id);
  if (!base) fail('Pet not found.');
  if (base!.v !== from) fail(kind === 'golden' ? 'Choose a normal pet.' : 'Choose a Golden pet.');
  if (base!.hg) fail('Huge pets cannot be converted.');
  if (base!.lk) fail('That pet is locked. Unlock it first.');
  const eq = new Set(p.save.equipped);
  const same = p.save.pets
    .filter((x) => x.id !== base!.id && x.s === base!.s && x.z === base!.z && x.v === from && !x.hg && !x.lk)
    .sort((x, y) => Number(eq.has(x.id)) - Number(eq.has(y.id)) || Number(!!x.sh) - Number(!!y.sh));
  if (same.length < cfg.count - 1) fail(`You need ${cfg.count} unlocked matching pets (same pet and same ★ tier).`);
  if (p.save.gems < cfg.gemFee) fail('Not enough gems!');
  const used = [base!, ...same.slice(0, cfg.count - 1)];
  const usedIds = new Set(used.map((u) => u.id));
  const wasEquipped = used.some((u) => eq.has(u.id));
  const pet: PetInstance = { id: newId(), s: base!.s, v: kind, z: base!.z, sh: used.some((u) => u.sh) || undefined };
  p.save.gems -= cfg.gemFee;
  p.save.pets = p.save.pets.filter((x) => !usedIds.has(x.id));
  p.save.pets.push(pet);
  p.save.equipped = p.save.equipped.filter((x) => !usedIds.has(x));
  if (wasEquipped) p.save.equipped.push(pet.id);
  addPetToIndex(p, pet);
  bump(p, kind === 'golden' ? 'goldenMade' : 'rainbowMade');
  refreshDerivedStats(p);
  afterPetsChanged(p);
  p.curDirty = true;
  gs.saveNow(p);
  return { pet };
}

/** Actions allowed while not in a room. */
const ROOMLESS = new Set<string>(['setAutoDelete', 'useItem', 'enchantEquip', 'enchantUnequip', 'lock', 'equip', 'unequip', 'equipBest']);

export function handleAction(gs: GameServer, p: Player, msg: unknown): Record<string, unknown> {
  if (!msg || typeof msg !== 'object' || Array.isArray(msg)) return { ok: false, error: 'Malformed request.' };
  const m = msg as Record<string, unknown>;
  const type = m.type;
  const rid = m.rid;
  if (typeof type !== 'string' || !Object.hasOwn(H, type)) return { ok: false, error: 'Unknown action.' };
  if (rid !== undefined && (typeof rid !== 'string' || rid.length > 48)) return { ok: false, error: 'Malformed request.' };
  if (typeof rid === 'string' && p.recent.has(rid)) return p.recent.get(rid) as Record<string, unknown>;
  if (!p.room && !ROOMLESS.has(type)) return { ok: false, error: 'Join a room first.' };
  let res: Record<string, unknown>;
  try {
    res = { ok: true, ...(H[type](gs, p, m) ?? {}) };
  } catch (e) {
    if (e instanceof GameError || e instanceof TradeError) res = { ok: false, error: e.message };
    else {
      console.error(`[action ${type}]`, e);
      res = { ok: false, error: 'Server error.' };
    }
  }
  if (typeof rid === 'string') p.remember(rid, res);
  gs.flush(p, true);
  return res;
}

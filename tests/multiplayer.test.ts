// End-to-end multiplayer verification against a real server process.
// Run: npm test
import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';
import { ACHIEVEMENTS, BALANCE, ZONES } from '../shared/config';
import { TestClient, TestServer, newGuest, sleep } from './helpers';

const PORT = 3900 + Math.floor(Math.random() * 90);
const server = new TestServer(PORT, TestServer.tempDb());
let A: TestClient;
let B: TestClient;
let cookieA = '';
let cookieB = '';
let room = '';

describe('Cubling Quest multiplayer server', { concurrency: false }, () => {
  before(async () => {
    await server.start();
    cookieA = await newGuest(server.base, 'Alice');
    cookieB = await newGuest(server.base, 'Bob');
    assert.notEqual(cookieA, cookieB, 'each guest gets a distinct secret session');
    A = new TestClient(server.base, cookieA, 'A');
    B = new TestClient(server.base, cookieB, 'B');
    await A.connected();
    await B.connected();
  });

  after(async () => {
    A?.close();
    B?.close();
    await server.stop();
  });

  test('guest session API: cookie is HttpOnly, nickname validated, unknown cookie rejected', async () => {
    const r = await fetch(`${server.base}/api/session`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ nickname: 'Valid Name' }) });
    const sc = r.headers.get('set-cookie') ?? '';
    assert.match(sc, /HttpOnly/);
    assert.match(sc, /SameSite=Lax/);
    const bad = await fetch(`${server.base}/api/session`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ nickname: '<script>' }) });
    assert.equal(bad.status, 400);
    const me = await (await fetch(`${server.base}/api/session`, { headers: { cookie: 'cq_guest=forgedforgedforgedforgedforgedforged' } })).json();
    assert.equal(me.ok, false);
  });

  test('two independent sessions join the same friends room', async () => {
    room = await A.createRoom('friends');
    assert.match(room, /^[A-Z0-9]{6}$/);
    const mark = A.mark();
    const r = await B.joinRoom(room);
    assert.equal(r.ok, true);
    const initB = B.events.findLast((e) => e.ev === 'init')!.data;
    assert.equal(initB.players.length, 2);
    assert.ok(initB.players.some((p: any) => p.name === 'Alice'));
    const pj = await A.waitFor('pj', (d) => d.name === 'Bob', 5000, mark);
    assert.equal(pj.pets.length, 1, 'A sees B equipped pet');
    assert.equal(B.save.pets.length, 1, 'new players start with a starter pet');
  });

  test('movement synchronises and is validated', async () => {
    const mark = B.mark();
    A.move(1, 50);
    const snap = await B.waitFor('s', (s: any[]) => s.some((e) => e[0] === A.id && Math.abs(e[3] - 50) < 0.01), 3000, mark);
    assert.ok(snap);
    // teleport-hack is rejected with a correction
    const m2 = A.mark();
    A.move(0, -500);
    const corr = await A.waitFor('corr', () => true, 3000, m2);
    assert.ok(corr.z > 40, 'server kept A at the real position');
  });

  test('both players attack the same breakable and get contribution-based rewards', async () => {
    await A.warp(0, 10);
    await B.warp(2, 10);
    await sleep(400);
    const cands = [...A.breakables.values()].filter((b) => b.zone === 1 && !b.ev && b.maxHp <= 120 && Math.hypot(b.x, b.z - 10) < 40);
    assert.ok(cands.length > 0, 'zone 1 has breakables');
    cands.sort((x, y) => y.maxHp - x.maxHp);
    const target = cands[0];
    const coinsA0 = A.save.coins;
    const mA = A.mark();
    const mB = B.mark();
    const ra = await A.act('target', { bk: target.id });
    const rb = await B.act('target', { bk: target.id });
    assert.equal(ra.ok, true, ra.error);
    assert.equal(rb.ok, true, rb.error);
    const pt = await B.waitFor('pt', (d) => d.id === A.id && Object.values(d.t).includes(target.id), 3000, mB);
    assert.ok(pt, 'B sees where A sent its pets');
    const hp = await B.waitFor('hp', (list: [string, number][]) => list.some(([id, h]) => id === target.id && h < target.maxHp), 15000, mB);
    assert.ok(hp, 'shared health updates reach both players');
    await A.waitFor('bkr', (d) => d.id === target.id, 30000, mA);
    await B.waitFor('bkr', (d) => d.id === target.id, 5000, mB);
    const rwA = await A.waitFor('reward', (d) => d.bk === target.id, 5000, mA);
    const rwB = await B.waitFor('reward', (d) => d.bk === target.id, 5000, mB);
    assert.ok(rwA.share > 0 && rwB.share > 0, 'both contributed');
    assert.ok(Math.abs(rwA.share + rwB.share - 1) < 1e-6, `shares sum to 1 (${rwA.share} + ${rwB.share})`);
    assert.ok(rwA.coins > 0 && rwB.coins > 0);
    const ratio = rwA.coins / rwB.coins;
    assert.ok(Math.abs(ratio - rwA.share / rwB.share) < 0.05, 'coins proportional to contribution');
    await sleep(300);
    assert.ok(Math.abs(A.save.coins - (coinsA0 + rwA.coins)) < 1e-6, 'server credited exactly the announced reward');
    assert.ok(!A.breakables.has(target.id) && !B.breakables.has(target.id), 'destruction synced');
  });

  test('hatching: costs coins, adds pets, enforces cooldown and dedupes repeated requests', async () => {
    await A.act('cheat', { coins: 1_000_000, gems: 20000 });
    await A.warp(-21, 26);
    await sleep(100);
    const coins0 = A.save.coins;
    const n0 = A.pets.length;
    const r = await A.act('hatch', { zone: 1, count: 1 });
    assert.equal(r.ok, true, r.error);
    assert.equal(r.pets.length, 1);
    const fast = await A.act('hatch', { zone: 1, count: 1 });
    assert.equal(fast.ok, false, 'cooldown enforced');
    const multi = await A.act('hatch', { zone: 1, count: 3 });
    assert.equal(multi.ok, false, 'multi-hatch requires unlock');
    await sleep(1800);
    const d1 = await A.act('hatch', { zone: 1, count: 1 }, 'dup-hatch-1');
    const d2 = await A.act('hatch', { zone: 1, count: 1 }, 'dup-hatch-1');
    assert.equal(d1.ok, true, d1.error);
    assert.deepEqual(d1, d2, 'repeated request returns the same result');
    await sleep(300);
    assert.equal(A.pets.length, n0 + 2, 'exactly two pets added');
    assert.equal(A.save.coins, coins0 - 2 * ZONES[1].eggCost, 'charged exactly twice');
    const far = await (async () => { await A.warp(20, 0); return A.act('hatch', { zone: 1, count: 1 }); })();
    assert.equal(far.ok, false, 'must stand at the egg');
  });

  test('equip, equip best, lock and delete with protection', async () => {
    const best = await A.act('equipBest');
    assert.equal(best.ok, true);
    await sleep(200);
    assert.ok(A.save.equipped.length >= 1 && A.save.equipped.length <= BALANCE.baseEquipSlots);
    const victim = A.pets.find((p) => !A.save.equipped.includes(p.id)) ?? A.pets[0];
    await A.act('lock', { ids: [victim.id], locked: true });
    const del = await A.act('deletePets', { ids: [victim.id] });
    assert.equal(del.ok, false, 'locked pets cannot be deleted');
    await A.act('lock', { ids: [victim.id], locked: false });
  });

  test('upgrades and unlocks at the upgrade station', async () => {
    const far = await A.act('buyUpgrade', { id: 'damage' });
    assert.equal(far.ok, false, 'must be at the station');
    await A.warp(-20, 86);
    const c0 = A.save.coins;
    const up = await A.act('buyUpgrade', { id: 'damage' });
    assert.equal(up.ok, true, up.error);
    assert.equal(up.level, 1);
    const tri = await A.act('buyUnlock', { id: 'tripleHatch' });
    assert.equal(tri.ok, true, tri.error);
    await sleep(200);
    assert.equal(A.save.upgrades.damage, 1);
    assert.equal(A.save.coins, c0 - 150);
    await A.warp(-21, 26);
    await sleep(2000);
    const h3 = await A.act('hatch', { zone: 1, count: 3 });
    assert.equal(h3.ok, true, h3.error);
    assert.equal(h3.pets.length, 3);
  });

  test('area unlock at the gate is idempotent for repeated requests', async () => {
    await A.warp(0, -32);
    const c0 = A.save.coins;
    const u1 = await A.act('unlockZone', { zone: 2 }, 'unlock-2');
    const u2 = await A.act('unlockZone', { zone: 2 }, 'unlock-2');
    assert.equal(u1.ok, true, u1.error);
    assert.deepEqual(u1, u2);
    const u3 = await A.act('unlockZone', { zone: 2 });
    assert.equal(u3.ok, false, 'already unlocked');
    await sleep(200);
    assert.equal(A.save.zone, 2);
    assert.equal(A.save.coins, c0 - ZONES[2].gateCost, 'charged once');
    const skip = await A.act('unlockZone', { zone: 4 });
    assert.equal(skip.ok, false, 'cannot skip areas');
  });

  test('golden machine converts 5 matching pets into 1 golden pet', async () => {
    await A.warp(-21, 26);
    let group: string[] = [];
    for (let i = 0; i < 12; i++) {
      const counts = new Map<string, string[]>();
      for (const p of A.pets) if (p.v === 'normal' && !p.hg && !p.lk) counts.set(`${p.s}|${p.z}`, [...(counts.get(`${p.s}|${p.z}`) ?? []), p.id]);
      group = [...counts.values()].find((g) => g.length >= 5) ?? [];
      if (group.length) break;
      await sleep(1800);
      await A.act('hatch', { zone: 1, count: 3 });
      await sleep(150);
    }
    assert.ok(group.length >= 5, 'collected 5 matching pets');
    await A.warp(-20, 70);
    const n0 = A.pets.length;
    const g = await A.act('golden', { id: group[0] });
    assert.equal(g.ok, true, g.error);
    assert.equal(g.pet.v, 'golden');
    await sleep(200);
    assert.equal(A.pets.length, n0 - 4);
    assert.ok(A.pets.some((p) => p.id === g.pet.id && p.v === 'golden'));
  });

  test('trade succeeds atomically with confirmations, version checks and countdown', async () => {
    // make sure A has plenty of unequipped pets to trade in this and the following tests
    await A.warp(-21, 26);
    for (let i = 0; i < 3; i++) {
      await sleep(1800);
      const h = await A.act('hatch', { zone: 1, count: 3 });
      assert.equal(h.ok, true, h.error);
    }
    await sleep(200);
    const offerPet = A.pets.find((p) => !p.lk && !A.save.equipped.includes(p.id))!;
    assert.ok(offerPet, 'A has a spare pet');
    const gemsA0 = A.save.gems;
    const gemsB0 = B.save.gems;
    const mB = B.mark();
    const req = await A.act('tradeRequest', { to: B.id });
    assert.equal(req.ok, true, req.error);
    await B.waitFor('tradeReq', (d) => d.from === A.id, 3000, mB);
    const mA = A.mark();
    const acc = await B.act('tradeRespond', { from: A.id, accept: true });
    assert.equal(acc.ok, true, acc.error);
    let view = await A.waitFor('trade', () => true, 3000, mA);
    const tid = view.id;
    await A.act('tradeOffer', { tradeId: tid, pets: [offerPet.id], gems: 7 });
    await B.act('tradeOffer', { tradeId: tid, pets: [], gems: 3 });
    await sleep(200);
    view = A.events.findLast((e) => e.ev === 'trade')!.data;
    const stale = await A.act('tradeReady', { tradeId: tid, version: view.version - 1, ready: true });
    assert.equal(stale.ok, false, 'stale confirmation rejected');
    await A.act('tradeReady', { tradeId: tid, version: view.version, ready: true });
    // B changes the offer -> both confirmations reset
    await B.act('tradeOffer', { tradeId: tid, pets: [], gems: 2 });
    await sleep(200);
    view = A.events.findLast((e) => e.ev === 'trade')!.data;
    assert.equal(view.ready[A.id], false, 'any change resets confirmations');
    const mEnd = A.mark();
    await A.act('tradeReady', { tradeId: tid, version: view.version, ready: true });
    await B.act('tradeReady', { tradeId: tid, version: view.version, ready: true });
    // duplicate confirm spam must not cause a double execution
    await A.act('tradeReady', { tradeId: tid, version: view.version, ready: true });
    const end = await A.waitFor('tradeEnd', () => true, 10000, mEnd);
    assert.equal(end.completed, true, end.reason);
    await sleep(400);
    assert.ok(!A.pets.some((p) => p.id === offerPet.id), 'A no longer owns the pet');
    assert.equal(B.pets.filter((p) => p.id === offerPet.id).length, 1, 'B owns exactly one copy');
    // first completed trade also unlocks the "Trusted Trader" achievement (+gems) for both players
    const traderBonus = ACHIEVEMENTS.find((a) => a.id === 'trader')!.gems[0];
    assert.equal(A.save.gems, gemsA0 - 7 + 2 + traderBonus);
    assert.equal(B.save.gems, gemsB0 + 7 - 2 + traderBonus);
    const again = await A.act('tradeReady', { tradeId: tid, version: view.version, ready: true });
    assert.equal(again.ok, false, 'finished trade cannot be replayed');
  });

  test('locked pets cannot be offered; cancelling a trade loses nothing', async () => {
    const pet = A.pets.find((p) => !A.save.equipped.includes(p.id))!;
    const mB = B.mark();
    await A.act('tradeRequest', { to: B.id });
    await B.waitFor('tradeReq', () => true, 3000, mB);
    const mA = A.mark();
    await B.act('tradeRespond', { from: A.id, accept: true });
    const view = await A.waitFor('trade', () => true, 3000, mA);
    const lockedPet = A.pets.find((p) => p.id !== pet.id)!;
    // lock is blocked during a trade, so lock is checked via offer of a pet locked earlier:
    const lk = await A.act('lock', { ids: [lockedPet.id], locked: true });
    assert.equal(lk.ok, false, 'inventory changes are blocked during trades');
    await A.act('tradeOffer', { tradeId: view.id, pets: [pet.id], gems: 1 });
    const countA = A.pets.length;
    const countB = B.pets.length;
    const mEnd = A.mark();
    await B.act('tradeCancel', { tradeId: view.id });
    const end = await A.waitFor('tradeEnd', () => true, 3000, mEnd);
    assert.equal(end.completed, false);
    await sleep(200);
    assert.equal(A.pets.length, countA);
    assert.equal(B.pets.length, countB);
    assert.ok(A.pets.some((p) => p.id === pet.id), 'A still owns the pet');
    // now verify a locked pet is refused in an offer
    await A.act('lock', { ids: [pet.id], locked: true });
    const mB2 = B.mark();
    await A.act('tradeRequest', { to: B.id });
    await B.waitFor('tradeReq', () => true, 3000, mB2);
    const mA2 = A.mark();
    await B.act('tradeRespond', { from: A.id, accept: true });
    const v2 = await A.waitFor('trade', () => true, 3000, mA2);
    const off = await A.act('tradeOffer', { tradeId: v2.id, pets: [pet.id], gems: 0 });
    assert.equal(off.ok, false, 'locked pets cannot be traded');
    await A.act('tradeCancel', { tradeId: v2.id });
    await A.act('lock', { ids: [pet.id], locked: false });
  });

  test('disconnect during trade countdown cancels safely; reconnect restores progress', async () => {
    const pet = A.pets.find((p) => !A.save.equipped.includes(p.id))!;
    const mB = B.mark();
    await A.act('tradeRequest', { to: B.id });
    await B.waitFor('tradeReq', () => true, 3000, mB);
    const mA = A.mark();
    await B.act('tradeRespond', { from: A.id, accept: true });
    const v = await A.waitFor('trade', () => true, 3000, mA);
    await A.act('tradeOffer', { tradeId: v.id, pets: [pet.id], gems: 0 });
    await sleep(150);
    const v2 = A.events.findLast((e) => e.ev === 'trade')!.data;
    await A.act('tradeReady', { tradeId: v.id, version: v2.version, ready: true });
    await B.act('tradeReady', { tradeId: v.id, version: v2.version, ready: true });
    const bPetsBefore = B.pets.map((p) => p.id).sort();
    const bCoins = B.save.coins;
    const mEnd = A.mark();
    B.close(); // drop mid-countdown
    const end = await A.waitFor('tradeEnd', () => true, 4000, mEnd);
    assert.equal(end.completed, false);
    await sleep(6000); // past the countdown
    assert.ok(A.pets.some((p) => p.id === pet.id), 'pet not lost');
    B = new TestClient(server.base, cookieB, 'B2');
    await B.connected();
    const j = await B.joinRoom(room);
    assert.equal(j.ok, true, j.error);
    assert.deepEqual(B.pets.map((p) => p.id).sort(), bPetsBefore, 'reconnected with the same pets');
    assert.ok(Math.abs(B.save.coins - bCoins) < 1e-6, 'coins preserved');
    assert.ok(!B.pets.some((p) => p.id === pet.id), 'no duplicated pet');
  });

  test('rebirth resets the right things and keeps pets', async () => {
    await A.act('cheat', { zone: 25, coins: 5000 });
    const far = await A.act('rebirth');
    assert.equal(far.ok, false);
    await A.warp(0, 97);
    const pets0 = A.pets.length;
    const r = await A.act('rebirth');
    assert.equal(r.ok, true, r.error);
    await sleep(300);
    assert.equal(A.save.rebirths, 1);
    assert.equal(A.save.zone, 1);
    assert.equal(A.save.coins, 0);
    assert.equal(A.save.upgrades.damage, undefined, 'coin upgrades reset');
    assert.equal(A.save.unlocks.tripleHatch, true, 'gem unlocks kept');
    assert.equal(A.save.unlocks.autoHatch, true, 'milestone reward granted');
    assert.equal(A.pets.length, pets0, 'pets kept');
  });

  test('daily gift, enchant altar, potions and quests', async () => {
    await A.warp(20, 70);
    const d1 = await A.act('claimDaily');
    assert.equal(d1.ok, true, d1.error);
    const d2 = await A.act('claimDaily');
    assert.equal(d2.ok, false, 'daily gift has a cooldown');
    await sleep(200);
    assert.ok((A.save.items.boost_coins ?? 0) >= 1, 'day-1 potion granted');
    const use = await A.act('useItem', { id: 'boost_coins' });
    assert.equal(use.ok, true, use.error);
    await sleep(200);
    assert.ok(A.save.boosts.coins > Date.now(), 'coin boost active');
    await A.act('cheat', { gems: 1000 });
    await A.warp(20, 86);
    const book = await A.act('enchantBuy');
    assert.equal(book.ok, true, book.error);
    const eq = await A.act('enchantEquip', { id: book.book });
    assert.equal(eq.ok, true, eq.error);
    const eq2 = await A.act('enchantEquip', { id: book.book });
    assert.equal(eq2.ok, false, 'cannot equip more copies than owned / slots');
    await sleep(200);
    assert.deepEqual(A.save.enchants, [book.book]);
    assert.equal(A.save.quests.length, 3, 'three active quests');
    const early = await A.act('claimQuest', { index: 0 });
    assert.equal(early.ok, false, 'unfinished quest cannot be claimed');
    const reroll = await A.act('rerollQuest', { index: 0 });
    assert.equal(reroll.ok, true, reroll.error);
  });

  test('boss chests spawn as shared room events in boss areas', async () => {
    await A.act('cheat', { zone: 5 });
    const m = A.mark();
    await A.warp(0, -260);
    const boss = await A.waitFor('bka', (list: any[]) => list.some((b) => b.ev === 'boss' && b.zone === 5), 20000, m);
    assert.ok(boss);
    const msg = await A.waitFor('evmsg', (d) => d.kind === 'boss', 3000, m);
    assert.match(msg.text, /Boss Chest/);
    await A.warp(0, 50);
  });

  test('malformed and hostile messages are rejected without crashing', async () => {
    const r1 = await A.emitAck('act', null);
    assert.equal(r1.ok, false);
    const r2 = await A.act('hatch', { zone: 'abc', count: 1e9 });
    assert.equal(r2.ok, false);
    const r3 = await A.act('__proto__', {});
    assert.equal(r3.ok, false);
    const r4 = await A.act('cheat_nonexistent', {});
    assert.equal(r4.ok, false);
    A.socket.emit('mv', 'garbage');
    A.socket.emit('mv', [NaN, Infinity, 'x', {}]);
    const r5 = await A.act('target', { bk: { $gt: '' } });
    assert.equal(r5.ok, false);
    const ok = await A.act('equipBest');
    assert.equal(ok.ok, true, 'server still healthy');
  });

  test('solo rooms are private; owner can remove a player', async () => {
    const cookieC = await newGuest(server.base, 'Carol');
    const C = new TestClient(server.base, cookieC, 'C');
    await C.connected();
    const solo = await C.createRoom('solo');
    const j = await A.joinRoom(solo);
    assert.equal(j.ok, false, 'cannot join someone else’s solo room');
    // back into the friends room (A is still a member)
    const back = await A.joinRoom(room);
    assert.equal(back.ok, true, back.error);
    const notOwner = await B.act('kick', { id: A.id });
    assert.equal(notOwner.ok, false, 'only the owner can kick');
    const mB = B.mark();
    const k = await A.act('kick', { id: B.id });
    assert.equal(k.ok, true, k.error);
    await B.waitFor('kicked', () => true, 3000, mB);
    const re = await B.joinRoom(room);
    assert.equal(re.ok, false, 'kicked player cannot rejoin');
    C.close();
  });

  test('progress survives a full server restart', async () => {
    await sleep(300);
    const coins = A.save.coins;
    const petIds = A.pets.map((p) => p.id).sort();
    A.close();
    B.close();
    await sleep(500);
    await server.stop();
    await server.start();
    A = new TestClient(server.base, cookieA, 'A3');
    await A.connected();
    const j = await A.joinRoom(room);
    assert.equal(j.ok, true, `room code still works after restart: ${j.error}`);
    assert.deepEqual(A.pets.map((p) => p.id).sort(), petIds, 'same pets after restart');
    assert.ok(Math.abs(A.save.coins - coins) < 1e-6, 'same coins after restart');
    assert.equal(A.save.rebirths, 1);
  });
});

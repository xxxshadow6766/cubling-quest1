import { useStore } from '../store';
import { EggPanel } from './panels/Egg';
import { AchievementsPanel, IndexPanel, ItemsPanel, QuestsPanel, TeleportPanel } from './panels/Info';
import { InventoryPanel } from './panels/Inventory';
import { PlayersPanel, SettingsPanel, TradePanel } from './panels/Social';
import { DailyPanel, EnchantPanel, GatePanel, MachinePanel, RebirthPanel, UpgradesPanel } from './panels/Stations';

export function Panels() {
  const panel = useStore((s) => s.panel);
  const arg = useStore((s) => s.panelArg);
  const hasSave = useStore((s) => !!s.save);
  if (!panel || !hasSave) return null;
  switch (panel) {
    case 'pets': return <InventoryPanel />;
    case 'egg': return <EggPanel zone={arg?.zone ?? 1} />;
    case 'gate': return <GatePanel zone={arg?.zone ?? 2} />;
    case 'upgrades': return <UpgradesPanel />;
    case 'golden': return <MachinePanel kind="golden" />;
    case 'rainbow': return <MachinePanel kind="rainbow" />;
    case 'enchant': return <EnchantPanel />;
    case 'daily': return <DailyPanel />;
    case 'index': return <IndexPanel />;
    case 'rebirth': return <RebirthPanel />;
    case 'quests': return <QuestsPanel />;
    case 'achievements': return <AchievementsPanel />;
    case 'items': return <ItemsPanel />;
    case 'teleport': return <TeleportPanel />;
    case 'players': return <PlayersPanel />;
    case 'trade': return <TradePanel />;
    case 'settings': return <SettingsPanel />;
    default: return null;
  }
}

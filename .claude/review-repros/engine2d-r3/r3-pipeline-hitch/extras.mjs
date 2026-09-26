export default async ({ page, step, sleep, waitReady }) => {
  const cmd = (c) => page.evaluate((c) => globalThis.__game.applyRuntimeCommand({ id: 'pf', ...c }).then((r) => JSON.stringify(r)), c);
  const act = (a) => cmd({ type: 'debugExecuteAction', action: a });
  const sw = async (s) => {
    await page.evaluate((s) => { globalThis.__pf.phase = 'switch:' + s; }, s);
    await cmd({ type: 'debugSwitchScene', sceneId: s });
    await waitReady(s, 60000);
  };
  const key = async (k) => { await page.keyboard.press(k); };
  const dev = (fn, ...a) => page.evaluate(({ fn, a }) => globalThis.__gameDevAPI[fn](...a), { fn, a });

  await step('x:switch 义庄', () => sw('义庄'), 3000);
  await step('x:vfx dust_motes(beam) at player', () => act({ type: 'playVfx', effect: 'dust_motes', at: 'player' }), 3000);
  await step('x:vfx incense_smoke at player', () => act({ type: 'playVfx', effect: 'incense_smoke', at: 'player' }), 3000);
  await step('x:strikeThreat', () => act({ type: 'strikeThreat' }), 4000);
  await step('x:vfx stats1', async () => { console.log('VFX1', await page.evaluate(() => JSON.stringify(globalThis.__game.vfxSystem.stats))); }, 100);
  await step('x:canvas vfx dust_motes', () => act({ type: 'playCanvasVfx', name: 'pf1', effect: 'dust_motes' }), 3000);
  await step('x:canvas vfx lightning_bolt_01', () => act({ type: 'playCanvasVfx', name: 'pf3', effect: 'lightning_bolt_01' }), 3000);
  await step('x:canvas vfx fireflies', () => act({ type: 'playCanvasVfx', name: 'pf4', effect: 'fireflies' }), 3000);
  await step('x:dialogue start', () => cmd({ type: 'debugStartDialogueGraph', graphId: '线外_街巷_打更人李老三', npcName: '李老三' }), 3000);
  await step('x:dialogue advance', () => cmd({ type: 'debugAdvanceDialogue', maxSteps: 4 }), 3000);
  await step('x:dialogue end', async () => { for (let i = 0; i < 12; i++) { await cmd({ type: 'playerAdvance' }); await sleep(300); } await key('Escape'); }, 2000);
  for (const k of ['KeyI', 'Tab', 'KeyL', 'KeyB', 'KeyM']) {
    await step('x:panel ' + k, async () => { await key(k); }, 2500);
    await step('x:panel close ' + k, async () => { await key('Escape'); }, 1500);
  }
  await step('x:switch test_room_a', () => sw('test_room_a'), 3000);
  await step('x:ignite paper', () => act({ type: 'igniteBurnable', target: 'burn_demo_paper' }), 4000);
  await step('x:ignite candle', () => act({ type: 'igniteBurnable', target: 'burn_demo_candle' }), 3000);
  await step('x:ignite figure', () => act({ type: 'igniteBurnable', target: 'burn_demo_figure' }), 3000);
  await step('x:objectExamine', () => dev('startMinigame', 'objectExamine', 'demo_waterlogged_corpse'), 5000);
  await step('x:oe state', async () => { console.log('OE', JSON.stringify(await dev('getMinigameDebugState')).slice(0, 600)); }, 100);
  await step('x:objectExamine close', async () => { await key('Escape'); }, 2000);
  await step('x:water', () => dev('startMinigame', 'water', 'dev_pond'), 5000);
  await step('x:water state', async () => { console.log('WATER', JSON.stringify(await dev('getMinigameDebugState')).slice(0, 600)); }, 100);
  await step('x:vfx state', async () => { console.log('VFX', await page.evaluate(() => { const g = globalThis.__game; return JSON.stringify({ scene: g.vfxSystem && g.vfxSystem.stats, canvasKeys: Object.keys(g.canvasStageSystem || {}).slice(0, 30) }); })); }, 100);
  await step('x:water close', async () => { await key('Escape'); }, 2000);
  await step('x:sugarWheel', () => dev('startMinigame', 'sugarWheel', 'x'), 3000);
};

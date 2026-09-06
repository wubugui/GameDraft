// Verification-only native keyboard/pointer helpers. Never changes game flags,
// inventory, entities or stored saves. Inspect coordinates, then send real input.
() => {
  window.owKey = async (code) => {
    window.dispatchEvent(new KeyboardEvent('keydown', { code, key: code, bubbles: true }));
    await ow.step(6);
    window.dispatchEvent(new KeyboardEvent('keyup', { code, key: code, bubbles: true }));
  };
  window.owClick = async (x, y) => {
    const g = window.__game, c = g.renderer.app.canvas, r = c.getBoundingClientRect();
    for (const type of ['pointermove', 'pointerdown', 'pointerup']) {
      c.dispatchEvent(new PointerEvent(type, { isPrimary: true, pointerType: 'mouse', pointerId: 1,
        button: 0, bubbles: true, clientX: r.left + x * r.width / g.renderer.screenWidth,
        clientY: r.top + y * r.height / g.renderer.screenHeight, buttons: type === 'pointerdown' ? 1 : 0 }));
    }
    await ow.step(6);
  };
  window.owClickText = async (root, text) => {
    let found = null;
    const walk = o => {
      if (o.text === text && o.worldVisible !== false) found = o;
      for (const child of o.children ?? []) walk(child);
    };
    walk(root);
    if (!found) throw new Error('Visible text missing: ' + text);
    const b = found.getBounds();
    await owClick((b.minX + b.maxX) / 2, (b.minY + b.maxY) / 2);
  };
  return 'Native input helpers installed.';
}

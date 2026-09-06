() => {
  window.ow = {
    log: [],
    view() { return window.__game.getPlayerView(); },
    async step(n = 4) { await window.__game.debugStepTicks(n, 33.33); },
    async settleScene(timeoutMs = 30000) {
      const start = performance.now();
      while (performance.now() - start < timeoutMs) {
        const g = window.__game;
        if (g?.hud && g.sceneManager.currentSceneData?.id && !g.sceneManager.isSwitching &&
            !g.phaseSwapInFlight && !g.pendingPhaseSwap) return this.brief();
        await new Promise(resolve => setTimeout(resolve, 150));
      }
      throw new Error('Scene or time-phase rebuild has not settled; do not treat an empty entity sample as absence.');
    },
    async act(type, args = {}) {
      const result = await window.__game.applyRuntimeCommand({ type, ...args });
      if (!result.ok) throw new Error(JSON.stringify(result));
      await this.step();
      return result;
    },
    async move(x, y, ticks = 160) {
      const p = this.view().player;
      const length = Math.hypot(x - p.x, y - p.y);
      const scale = length > 1 ? (length + 12) / length : 1;
      await this.act('playerMoveTo', { x: p.x + (x-p.x)*scale, y: p.y + (y-p.y)*scale });
      await this.step(ticks);
      return this.brief();
    },
    async interact() {
      const p = this.view().player;
      await this.act('playerMoveTo', { x: p.x, y: p.y });
      await this.act('playerInteract'); return this.brief();
    },
    async advance() {
      await this.act('playerAdvance');
      await new Promise(r => setTimeout(r, 100));
      return this.brief();
    },
    async menu() {
      for (let i = 0; i < 12; i++) {
        const v = this.view();
        if (v.dialogue.choices.length || !v.dialogue.active) return this.brief();
        await this.advance();
      }
      throw new Error('Dialogue did not reach a menu or end');
    },
    async choose(text) {
      const choices = this.view().dialogue.choices;
      const index = choices.findIndex(c => (typeof c === 'string' ? c : c.text).includes(text));
      if (index < 0) throw new Error('Missing choice: ' + text + ' / ' + JSON.stringify(choices));
      await this.act('playerChoose', { index });
      return this.menu();
    },
    brief() {
      const v = this.view();
      const b = { scene: v.scene, mode: v.mode, player: v.player, prompt: v.interactionPrompt,
        dialogue: v.dialogue, hud: v.hud, moving: v.navTargetActive };
      this.log.push(b);
      return b;
    },
  };
  // Navigation diagnostics use the live collision query, including the current phase's
  // ground field and entity polygons. Inputs still go through playerMoveTo.
  window.ow.plan = function (goal, radius = 0) {
    const g = window.__game, view = this.view(), start = [view.player.x, view.player.y];
    const size = g.sceneManager.currentSceneData;
    const dist = (a,b) => Math.hypot(a[0]-b[0],a[1]-b[1]);
    const clear = (a,b) => {
      const n = Math.max(1,Math.ceil(dist(a,b)/3));
      for(let i=1;i<=n;i++) if(g.player.collidesAt(a[0]+(b[0]-a[0])*i/n,a[1]+(b[1]-a[1])*i/n)) return false;
      return true;
    };
    if(clear(start,goal)) return [start,goal];
    const heap=[], costs=new Map([['0,0',0]]), parents=new Map();
    const push=v=>{let i=heap.length;heap.push(v);while(i){const p=(i-1)>>1;if(heap[p][0]<=v[0])break;heap[i]=heap[p];i=p;}heap[i]=v;};
    const pop=()=>{const first=heap[0],last=heap.pop();if(heap.length){let i=0;while(i*2+1<heap.length){let j=i*2+1;if(j+1<heap.length&&heap[j+1][0]<heap[j][0])j++;if(heap[j][0]>=last[0])break;heap[i]=heap[j];i=j;}heap[i]=last;}return first;};
    const point=k=>{const [x,y]=k.split(',').map(Number);return [start[0]+x*8,start[1]+y*8];};
    push([dist(start,goal),0,'0,0']);let end=null;
    while(heap.length&&costs.size<180000){
      const [,paid,key]=pop();if(paid>costs.get(key))continue;
      const p=point(key),[x,y]=key.split(',').map(Number);
      if(radius&&dist(p,goal)<radius){end=key;goal=p;break;}
      if(dist(p,goal)<16&&clear(p,goal)){end=key;break;}
      for(const [dx,dy] of [[1,0],[-1,0],[0,1],[0,-1],[1,1],[1,-1],[-1,1],[-1,-1]]){
        const nk=[x+dx,y+dy].join(','),q=point(nk),nc=paid+8*Math.hypot(dx,dy);
        if(q[0]<0||q[1]<0||q[0]>size.worldWidth||q[1]>size.worldHeight||nc>=(costs.get(nk)??Infinity)||!clear(p,q))continue;
        costs.set(nk,nc);parents.set(nk,key);push([nc+dist(q,goal),nc,nk]);
      }
    }
    if(end===null)throw new Error('No live walkable route to '+goal);
    const points=[goal,point(end)];while(parents.has(end)){end=parents.get(end);points.push(point(end));}points.reverse();
    const route=[points[0]];let i=0;
    while(i<points.length-1){let j=points.length-1;while(j>i+1&&!clear(points[i],points[j]))j--;route.push(points[j]);i=j;}
    return route;
  };
  return 'Player input helpers ready; fixed ticks drive normal physics, no progress overrides.';
}

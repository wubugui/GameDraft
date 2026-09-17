现象：挂件 guarding 的“侧身护火”名称容易被误读为主角已有身体动画；现用 player_anim 没有对应片段，ignite 复用蹲下帧。
证据：HeldPropSystem 的护火／点火只改挂件、挡风、耗材与计时；Player.ts 仍走 idle/walk/run；player_anim 的 69—72 帧在 atlas.meta.json 中归 crouch。核对与新素材见 artifact/Reviews/2026-09-16-night-survival-assets.md。
建议：held-prop-lights 的表现口径区分挂件状态与角色动作；专用护火站立／行走、双手点火片段及挂点接线另列未完成项，不能把教程静图算作动画完成。

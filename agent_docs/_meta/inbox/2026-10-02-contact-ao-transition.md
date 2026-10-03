现象：entity-lighting 仍将接触 AO 描述为逐帧开关，未包含动画切换的浓度过渡及作者时长字段。
现实：ContactAoDef.fadeInMs/fadeOutMs（均1000ms，制作人要求秒级过渡；0..5000，0立即）在玩家/NPC共用 AO 编辑器可调；Game 用暂停感知的 dt 驱动逐角色 ContactAoTransition，方向源保留到淡出结束。
边界：快速反转从当前浓度续接；过渡内沿用已渲染的稳定脚印、脚点照常移动，浓度归零/隐藏/换 owner 清理；投影绑定仍逐帧幂等，不参与此过渡。

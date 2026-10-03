现象：旧过场与挂件机制说明按动作类型一律将 lockPropState 视为持久副作用；现已支持显式临时生命周期。
证据：ActionEffectScope 与 registerScoped 托管逐次执行的清理；lockPropState lifetime=scope 使用不入档的独立锁层，过场结束/跳过/读档均释放。
建议：后续治理同步过场白名单及挂件锁说明，强调仅临时形式可进过场、默认持久行为保持不变，普通批/过场/背景演出共用清理容器。

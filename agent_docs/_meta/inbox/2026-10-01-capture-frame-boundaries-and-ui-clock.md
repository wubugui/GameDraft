现象：RHI 抓帧机制缺少多提交游戏帧的边界约定；HUD、对白淡出不能只暂停 rAF 而遗漏显式步进。
证据：webgpuCaptureClient 在 Game 显式推进前开始捕获；webgpuFrameDiagnostics 逐次收集离屏到画布提交，WGPUCAP metadata.gamedraftCapture.frameSubmissionCounts 供 analysis_report 分帧；HUD/DialogueUI 的淡出状态在普通帧和捕获帧共用。
建议：机制卡补充提交局部内容版本、独立提交的 GPU 计时、显式帧边界校验，以及传输等待冻结/显式帧推进/恢复连续的计时回归口径。

发现：日程说明声称非探索态暂停，但原实现只停止发出新 moveTo；已发出的移动仍推进，隐身居民也能成为闲聊候选。
证据：src/systems/NpcScheduleSystem.ts、src/systems/BubbleChatterSystem.ts；本次补上模态态取消在途移动、显隐准入，并用现有测试及 artifact/OpenWorld/ 实机记录验证。
建议：日程与头顶闲聊机制卡增加“已在途移动、隐藏角色、次日回工位、日程与巡逻抢控制”的联合验收条目。

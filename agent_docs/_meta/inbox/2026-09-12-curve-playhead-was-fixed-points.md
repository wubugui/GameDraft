---
target: entity-trajectory
date: 2026-09-12
session: cameraFollowActor 跟曲线播放头
---

现象: 09-11 把制作人要的"曲线 eval 的实时点"做成了 `curve` 的 start/end/time/progress（按这次播放位置算的**固定点**），播放头根本没有；卡上还据此写了"镜头跟着运动的东西走 = cameraFollowActor 指实体，不是位置引用"，制作人 09-12 当面推翻（"cameraFollowActor 实现得太死，只支持 follow target 不支持引用"）。另：PositionRefField 在实体档说明行折两行时被宿主 FieldsStayAtSizeHint 表单压扁（moveEntityTo 同样中招），model 层测试全绿看不见。
证据: src/utils/positionRef.ts 头注释（已改）、agent_docs/runtime/mechanisms/entity-trajectory.md「镜头跟着曲线走」一节（已改为 at 引用 point:'current' + 相对曲线不许引用）；布局护栏 tools/editor/tests/test_position_ref_field.py::test_wrapped_info_line_is_not_squashed（去掉 `_fit_height` 即红）。
建议: 制作人说"实时 / 跟着"时先问清是"会动的点"还是"这次播放算出的固定点"；"按曲线引用运动对象"（谁类 target）另有任务卡，别再往 cameraFollowActor.target 上堆。

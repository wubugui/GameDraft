// 本机 Blender 替身(制作人 2026-09-24 定:Blender 一律走 Hub,本机禁止运行)。
// 编译:C:\Windows\Microsoft.NET\Framework64\v4.0.30319\csc.exe /nologo /target:exe /out:blender.exe blender_disabled_stub.cs
// 部署:本机每份 blender.exe / blender-launcher.exe 原件改名为 *.local-disabled 留在原处,原位置放本程序。
// 规则正文:E:/GameDev/GameDraft/agent_docs/asset-pipeline/norms.md 不变量 7。
using System;
using System.Text;

static class BlenderDisabled
{
    static int Main(string[] args)
    {
        var err = new System.IO.StreamWriter(Console.OpenStandardError(), new UTF8Encoding(false));
        err.AutoFlush = true;
        err.WriteLine("[本机 Blender 已禁用] 制作人 2026-09-24 定:Blender 一律走局域网 Hub,本机禁止运行任何 Blender。");
        err.WriteLine("改用 http://denghong01:8765 的 backend=blender(4.5.0 / 4.5.13 / 5.2.2),先读 http://denghong01:8765/guide.md 的 Blender 一节,");
        err.WriteLine("或用 inference-hub-generation 技能:项目打 ZIP 上传 -> POST /v1/tasks -> 产物写 HUB_OUTPUT_DIR -> 按 file ID 下载。");
        err.WriteLine("这不是故障:别去修、别改回原件、别下载另一份 Blender。规则正文 E:/GameDev/GameDraft/agent_docs/asset-pipeline/norms.md 不变量 7。");
        return 1;
    }
}

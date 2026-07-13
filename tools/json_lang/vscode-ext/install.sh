#!/bin/sh
# 把本扩展目录符号链接进 VS Code / Cursor 的用户扩展目录(唯一的手动安装步骤)。
# 用法: sh tools/json_lang/vscode-ext/install.sh   之后 Reload Window 生效。
# 卸载: 删除对应符号链接即可。
set -e
SRC="$(cd "$(dirname "$0")" && pwd)"
NAME="gamedraft.json-lang-0.1.0"
installed=0
for DIR in "$HOME/.vscode/extensions" "$HOME/.cursor/extensions"; do
  if [ -d "$DIR" ]; then
    LINK="$DIR/$NAME"
    [ -L "$LINK" ] && rm "$LINK"
    if [ -e "$LINK" ]; then
      echo "跳过 $LINK(已存在且不是符号链接,请手动处理)"
      continue
    fi
    ln -s "$SRC" "$LINK"
    echo "已链接: $LINK -> $SRC"
    installed=1
  fi
done
if [ "$installed" = "1" ]; then
  echo "完成。到 VS Code/Cursor 里执行 Developer: Reload Window 即生效。"
else
  echo "未找到 ~/.vscode/extensions 或 ~/.cursor/extensions,请先启动过一次对应编辑器。"
fi

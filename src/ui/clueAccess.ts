/**
 * 线索通道（玩法需求清单 K7）：正文里 `[clue:id]` 词条的状态查询与采集入口。
 *
 * **模块级单点注入**（Game 启动时给一次，与 `textStyle` 的色板注入同一先例）——
 * 六本册子 + 成书阅读器 + 对话框全走这一个口，不逐壳穿构造签名。
 * 未注入时词条按 fresh 颜色渲染、点击无事发生（jsdom 测试 / 预览态安全）。
 *
 * 之所以单独成模块而不是挂在 `ArchiveBookView` 上（K7 一阶段时它在那儿）：
 * 二阶段把词条落进**对话框**之后，`DialogueUI` 要用它——而对话框去 import 册子组件
 * 只是为了拿一个全局单例，是纯粹的耦合噪音。谁都不拥有它，它就该自己一个文件。
 */
export interface ClueAccess {
  isCollected(id: string): boolean;
  /** 未知 id 由实现方（ClueManager）自己忽略并 dev 警告；调用方不预检 */
  collect(id: string): void;
  /** 该 id 是否在 clues.json 注册表里——没登记的 `[clue:]` 不该画成可点 */
  isKnown(id: string): boolean;
}

let clueAccess: ClueAccess | null = null;

export function setClueAccess(a: ClueAccess | null): void {
  clueAccess = a;
}

export function getClueAccess(): ClueAccess | null {
  return clueAccess;
}

EXTERNAL getFlag(key)

=== start ===
{getFlag("heard_storyteller_intro"):
    -> return_visit
}
-> first_visit

=== first_visit ===
# speaker:说书人张叨叨
哎，这位小兄弟，头一回来？来来来，坐下喝碗茶，听老张给你摆一段。
# action:setFlag:heard_storyteller_intro:true
+ [听他说书]
    -> story_menu
+ [不了，我有事]
    # speaker:说书人张叨叨
    得嘞，有空再来，老张的故事多得很！
    -> END

=== return_visit ===
# speaker:说书人张叨叨
嘿！小兄弟又来了？今天想听点什么？
-> story_menu

=== story_menu ===
+ [听说城隍庙后山闹鬼？]
    -> ghost_story
+ {getFlag("heard_ghost_story")} [再给我讲讲那个阎王岭的事]
    -> yanwang_story
+ {getFlag("heard_ghost_story")} [你知道那唱戏的到底是谁吗]
    -> opera_rumor
+ [算了，没什么想听的]
    # speaker:说书人张叨叨
    成，什么时候想听了再来找老张。
    -> END

=== ghost_story ===
# speaker:说书人张叨叨
嘿，你问这个可就问对人了。这事儿我可是比谁都清楚。
# speaker:说书人张叨叨
要说这城隍庙后山啊，三更天不能去。去了的人，说是看到一个白影子在那儿飘来飘去，还唱戏呢。但没人听清唱的什么。
# speaker:说书人张叨叨
最邪门的是，有个胆大的去看了，回来之后就疯了，整天嘟囔什么"好一似食尽鸟投林"，谁也不认识了。
# action:setFlag:heard_ghost_story:true
# action:giveFragment:frag_ghost_origin_01
# action:addArchiveEntry:lore:lore_ghost_mountain
+ [这也太邪了吧]
    # speaker:说书人张叨叨
    可不是嘛！所以老百姓都说，三更天城隍庙后山，那是鬼在唱堂会。
    -> story_menu
+ [你觉得那是什么东西？]
    # speaker:说书人张叨叨
    我觉得吧……那不是一般的鬼。你想啊，一般的鬼它害人，它不唱戏。能唱戏的鬼，那得是有些来头的人。
    -> story_menu

=== yanwang_story ===
# speaker:说书人张叨叨
阎王岭那个地方，可不能瞎说。你知道为啥叫阎王岭吗？
# speaker:说书人张叨叨
老辈子传下来的话：人死了，魂儿往北走，过了阎王岭就回不来了。但偏偏有些人，活着的时候就往那边跑。
# speaker:说书人张叨叨
有往那边找金子的，有往那边找药的，还有那些个自称能通阴阳的……反正去的人多，回来的人少。渝都卫的老百姓管这帮人叫短命娃娃。
# action:setFlag:heard_yanwang_story:true
# action:addArchiveEntry:lore:lore_yanwang_ridge
+ [还有别的故事吗]
    -> story_menu
+ [行了，我知道了]
    -> END

=== opera_rumor ===
# speaker:说书人张叨叨
这个嘛……我听老一辈的人说，早年间渝都卫有个很有名的戏班子，班主姓柳。后来不知道怎么的就散了。
# speaker:说书人张叨叨
有人说那个唱戏的白影子，就是那个戏班子里的人。但到底是谁，没人知道。
# speaker:说书人张叨叨
你要是真想查，去城隍庙看看，那边的石碑上好像记了不少老事。
# action:setFlag:heard_opera_rumor:true
# action:giveFragment:frag_ghost_origin_02
+ [多谢张大爷]
    # speaker:说书人张叨叨
    客气什么，都是些老掉牙的故事。你小心点就是了。
    -> END

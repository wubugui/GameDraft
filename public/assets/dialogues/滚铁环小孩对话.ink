EXTERNAL getFlag(key)
EXTERNAL getActorName(id)

=== start ===
{ getFlag("铁环小孩_已经获得铁环"):
->已经有铁环
- else:
->没有铁环
}

=== 已经有铁环 ===
@:老子又不要你的，还给你还给你。
%:哇哇哇哇哇哇哇哇哇哇哇哇......
不理你......
-> END


=== 没有铁环 ===
# action:playNpcAnimation:npc_ringboy:boy_stand_ring
{ not getFlag("foreigner_crate_event_done"):
    -> branch_before_event_done
- else:
    -> branch_after_event_done
}

=== branch_before_event_done ===
@: 小娃儿，这圈圈有点东西，借给老子耍哈撒。
%: 你谁啊？不给......
@: （嗤笑）切~个破铁环当传家宝，送老子，老子都不要！
{ not getFlag("archive_book_entry_erta_geo_iron_ring"):
    -> grant_iron_hoop_doc
}
-> END

=== grant_iron_hoop_doc ===
# action:addArchiveEntry:bookEntry:erta_geo_iron_ring
-> END

=== branch_after_event_done ===
小孩护着铁环看着你，不知道你要干什么......
+ [要铁环。] -> opt_ask_ring
+ [抢铁环。] -> opt_snatch_ring

=== opt_ask_ring ===
@: 小娃儿，这玩意儿你滚了一天怕该歇歇了。\n让老子滚一滚撒。
%: ......
-> opt_ask_ring_fade_then_narration

=== opt_ask_ring_fade_then_narration ===
# action:persistNpcDisablePatrol:npc_ringboy
# action:fadeWorldToBlack:550
# action:waitMs:500
-> opt_ask_ring_narration

=== opt_ask_ring_narration ===
（小孩儿丢下铁环跑了......）
-> opt_ask_ring_after_narration

=== opt_ask_ring_after_narration ===
# action:persistNpcEntityEnabled:npc_ringboy:false
# action:fadeWorldFromBlack:550
# action:giveItem:iron_hoop:1
# action:appendFlag:书籍_风物志_铁环标注:"捡了一个铁环。"
# action:showNotification:获得铁环:item
# action:setFlag:铁环小孩_已经获得铁环:true
# action:updateQuest:支线-归还小孩铁环-归还铁环
-> END

=== opt_snatch_ring ===
@: 喂！这圈圈老子玩玩！
你伸手一把夺过铁环，恶狠狠地向小孩儿呸了一口。
# action:giveItem:iron_hoop:1
# action:appendFlag:书籍_风物志_铁环标注:"你从小孩那儿抢了一个铁环。"
# action:showNotification:获得铁环:item
# action:persistNpcDisablePatrol:npc_ringboy
# action:persistNpcAnimState:npc_ringboy:boy_cry
# action:waitMs:500
# action:setFlag:铁环小孩_已经获得铁环:true
# action:updateQuest:支线-归还小孩铁环-归还铁环
-> END

EXTERNAL getFlag(key)

=== start ===
{getFlag("got_iron_box"):
    -> after_box
}
{getFlag("waiter_met"):
    -> return_visit
}
-> first_visit

=== first_visit ===
# speaker:小二
哟，关二狗，今儿又来蹭茶气？先说好，赊着的那两碗茶钱我可都记着呢。
# action:setFlag:waiter_met:true
+ [少废话，瞎子李今天怎么来了]
    # speaker:小二
    刚摸进来没多久。你要真有事求他，先让张叨叨把那段书摆完，省得那老瞎子嫌你心浮气躁。
    -> END
+ [张叨叨今天讲什么呢]
    # speaker:小二
    还不是那些神仙道士、坟里头爬出来的怪东西。可偏偏茶客就爱听这个。
    -> END

=== return_visit ===
# speaker:小二
又来啦？今儿这茶馆可没什么空位，想听书就自己挤一挤。
+ [瞎子李好说话吗]
    # speaker:小二
    谁知道呢，那老瞎子看着和气，真要不顺心，嘴比刀子还快。你自己掂量着点说。
    -> END
+ [城隍庙那边最近闹什么怪]
    # speaker:小二
    你还真问着了。前些天有人翻出一张旧戏单，说当年柳家班就在城隍庙戏台唱过堂会，后来班里那个最红的旦角，说没就没了。
    # speaker:小二
    这几日城里又有人说，夜里从庙后头过，能听见女人吊着嗓子唱戏。有人说她是在害人，也有人说她像是在找人。
    # action:setFlag:heard_waiter_ghost_talk:true
    # action:setFlag:heard_opera_rumor:true
    -> END
+ [没事，我随便转转]
    # speaker:小二
    转吧转吧，别碰翻茶碗就成。
    -> END

=== after_box ===
# speaker:小二
咦，你怎么一副魂不守舍的样子？刚才不是还在瞎子李那儿赔笑么。
+ [没事，先走了]
    # speaker:小二
    行，走路看着点，别又把自己摔沟里去。
    -> END
+ [给我倒碗凉茶压压惊]
    # speaker:小二
    稀奇，关二狗也有肯掏钱喝茶的时候？算了，这碗先记账上。
    -> END

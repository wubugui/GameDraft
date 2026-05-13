EXTERNAL getFlag(key)

=== start ===
{getFlag("peddler_met"):
    -> return_visit
}
-> first_visit

=== first_visit ===
# speaker:货郎
哟，小兄弟，来看看？南边来的好货，驱邪避凶保平安！
# action:setFlag:peddler_met:true
+ [你都卖些什么]
    # speaker:货郎
    桃木片、糯米、艾草、烧酒、黄纸符，应有尽有！便宜着呢！
    + + [看看你的货]
        # action:openShop:peddler_shop
        -> END
    + + [不了不了]
        # speaker:货郎
        得嘞，随时来找我！
        -> END
+ [你从哪儿来的]
    # speaker:货郎
    南边来的，翻八面山过来的。那边太平，但是没啥生意做。听说你们这边不太平，这些东西好卖。
    # speaker:货郎
    小兄弟，我跟你说，这些东西都是管用的。我在路上碰过不干净的东西，全靠这些保住了小命。
    # action:setFlag:peddler_story_heard:true
    + + [你碰到了什么]
        # speaker:货郎
        别提了，翻八面山的时候，夜里看到路边有个人影站着，一动不动。我以为是赶夜路的，走近一看——那人脸惨白惨白的，眼珠子不会动！
        # speaker:货郎
        我当时就撒了把糯米，那东西"嗷"的一声就跑了。你信不信？
        # action:giveFragment:frag_zombie_fire_01
        +++ [那白毛的用火也行？] # ruleHint:rule_zombie_fire
            # speaker:货郎
            嘿，你也听说过？没错没错，白毛的最怕火，桃木点了最好使！我这儿桃木片管够，要不要来两片？
            -> first_visit_end
        +++ [你运气不错]
            # speaker:货郎
            可不是嘛，命大！
            -> first_visit_end
    + + [算了，不想听]
        -> first_visit_end

=== first_visit_end ===
+ [看看你的货]
    # action:openShop:peddler_shop
    -> END
+ [走了]
    # speaker:货郎
    再来啊小兄弟！
    -> END

=== return_visit ===
# speaker:货郎
小兄弟又来了？看看货？
+ [看看]
    # action:openShop:peddler_shop
    -> END
+ [不了]
    # speaker:货郎
    得嘞！
    -> END

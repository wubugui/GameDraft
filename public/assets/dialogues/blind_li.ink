EXTERNAL getFlag(key)

=== start ===
{getFlag("got_iron_box"):
    -> after_box
}
{getFlag("heard_teahouse_story"):
    -> first_talk
}
-> too_early

=== too_early ===
# speaker:瞎子李
老张那段还没摆完呢。你小子耳朵都没竖起来，就先往我这儿凑，能学成个什么？
-> END

=== first_talk ===
# speaker:瞎子李
茶就免了，有事说事。
# action:setFlag:met_blind_li:true
# action:addArchiveEntry:character:blind_li
+ [李先生，我想拜你为师，学算命]
    # speaker:瞎子李
    学算命？
    # speaker:瞎子李
    你是想拯救苍生于水火，还是看中这碗饭好吃？
    ++ [自然是想学门吃饭的手艺]
        -> honest_motive
    ++ [救人于危难，济世于乱时]
        -> false_motive
+ [没事，我就来扶你坐坐]
    # speaker:瞎子李
    人扶到了，嘴里的话还没落地。你有求于我，脸上都写着呢。
    -> END

=== false_motive ===
# speaker:瞎子李
放屁。你关二狗要真有这份心，城里早给你立长生牌位了。
# speaker:瞎子李
直说吧，你就是觉得这门手艺不费本钱，嘴皮子一翻就能混口饭。
-> honest_motive

=== honest_motive ===
# speaker:关二狗
李先生明鉴。我就是想混口比跑腿更体面的饭吃。
# speaker:瞎子李
这还像句人话。
# speaker:瞎子李
命不是谁都能算的。光靠嘴皮子，那叫坑蒙拐骗，不叫本事。
# speaker:瞎子李
你要真想跟我学，先看看你有没有这个命。
# action:giveItem:iron_box
# action:setFlag:got_iron_box:true
# action:setFlag:box_taboo_active:true
# action:showNotification:获得关键道具：铁盒子:info
# speaker:瞎子李
这个盒子你拿着，七天之内不许打开。若七天之后它还是好好的，就在最后一晚带着它去渝都卫水库桥下找我。
+ [这差事就这么简单？]
    # speaker:瞎子李
    简单不简单，要看你手贱不手贱。
    -> ask_warning
+ [为什么不能打开]
    -> ask_warning

=== ask_warning ===
# speaker:瞎子李
你开开试试，出了大事我可不管。
# speaker:关二狗
……
# speaker:瞎子李
记住了，七天，莫开。到时候桥下见我。
-> END

=== after_box ===
# speaker:瞎子李
盒子还在吧？
+ [在。你这玩意儿到底装了什么]
    # speaker:瞎子李
    你若忍得住，七天后自然知道。忍不住，现在就能坏事。
    -> END
+ [我记着呢，七天不能开]
    # speaker:瞎子李
    记着就好。别跟自己的命开玩笑。
    -> END

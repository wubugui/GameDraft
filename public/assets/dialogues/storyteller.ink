EXTERNAL getFlag(key)

=== start ===
{getFlag("heard_teahouse_story"):
    -> return_visit
}
-> first_visit

=== first_visit ===
# speaker:说书人张叨叨
话说这崂山道士捡了本天书，正要上神仙顶，不想半路撞见一伙倒斗摸金的，从古墓里放出个大旱魃来。
# speaker:说书人张叨叨
那道士掐诀念咒，和旱魃大战三百回合，直打得山摇地动，最后一把火把那东西烧成了黑炭。摸金的千恩万谢，非要拿重金酬谢，道士却只一拂袖，人就不见了。
+ [坐下听他说完]
    # speaker:关二狗
    这道士挣钱倒真容易。
    # speaker:说书人张叨叨
    那可不？要是真有这门手艺，银钱还不自己往怀里钻。
    # action:setFlag:heard_teahouse_story:true
    # action:addArchiveEntry:lore:lore_li_tiangou_story
    # speaker:说书人张叨叨
    你小子要是听得心痒，不如去问问那边的瞎子李。那老东西满口神神鬼鬼，兴许真会点门道。
    -> END
+ [只听个热闹就算了]
    # speaker:关二狗
    热闹是热闹，可也不能当饭吃。
    # action:setFlag:heard_teahouse_story:true
    # speaker:说书人张叨叨
    饭不好吃，故事总得听两耳朵。你要真惦记能糊口的本事，去问问那边刚坐下的瞎子李。
    -> END

=== return_visit ===
# speaker:说书人张叨叨
今天这段先摆到这儿。怎么着，听够了？还是已经看上别的门道了？
+ [瞎子李真会算命？]
    # speaker:说书人张叨叨
    会不会我可不敢打包票。不过那老瞎子见的人多，嘴皮子也利索。你要是想求个出路，和他搭两句总不亏。
    -> END
+ [没事，我就再听两句]
    # speaker:说书人张叨叨
    那就搬张板凳，老张这肚子里还有的是怪事。
    -> END

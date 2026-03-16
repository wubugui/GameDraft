EXTERNAL getFlag(key)

=== start ===
{getFlag("waiter_met"):
    -> return_visit
}
-> first_visit

=== first_visit ===
# speaker:小二
嘿！客官里边请！喝茶还是吃点东西？咱这儿的花生米是一绝！
# action:setFlag:waiter_met:true
+ [来碗茶]
    # speaker:小二
    得嘞！盖碗茶一碗！
    # speaker:小二
    客官头一回来渝都卫？不像本地人啊。
    + + [我就是来逛逛]
        # speaker:小二
        也好也好，不过要是逛的话，天黑前可得回来。最近城里不太太平。
        -> tips
    + + [这里有什么好玩的吗]
        # speaker:小二
        好玩的？那可多了。张叨叨的说书就不错，每天下午都在那边角落里摆龙门阵。
        -> tips
+ [不了，我就问个事]
    # speaker:小二
    客官请说。
    -> tips

=== return_visit ===
# speaker:小二
客官又来了！老位子坐？
+ [随便坐坐]
    -> tips
+ [有什么新鲜事没]
    -> tips

=== tips ===
+ [最近城里有什么事没有]
    -> city_news
+ {getFlag("heard_ghost_story")} [你听说城隍庙闹鬼的事了吗]
    -> ghost_talk
+ [你这儿有什么东西卖吗]
    -> shop
+ {getFlag("encounter_ghost_done")} [后山的事我去看过了……]
    -> after_ghost
+ [算了，走了]
    # speaker:小二
    客官慢走！下次再来！
    -> END

=== city_news ===
# speaker:小二
事儿可多了。城外的难民又多了一批，城门口天天挤满了人。城防署的兵丁烦得很。
# speaker:小二
对了，前两天有个南边来的货郎在城里摆摊，卖的东西稀奇古怪的，不知道还在不在。
# action:setFlag:heard_city_news:true
-> tips

=== ghost_talk ===
# speaker:小二
哎呀客官您可别提这个！我一个人晚上收摊子的时候都不敢往那边看。
# speaker:小二
前阵子有个外地来的书生非要去看，说什么世上没有鬼。结果呢？第二天一早人家发现他坐在城隍庙门口，眼睛直勾勾的，嘴里不停地哼曲子。
# speaker:小二
后来他清醒了点，跟人说他看到一个穿白衣裳的女人在唱戏，唱得可好了，好到他都走不动了。
# action:setFlag:heard_waiter_ghost_talk:true
# action:giveFragment:frag_ghost_origin_03
+ [那后来呢]
    # speaker:小二
    后来？后来那书生就走了呗。但走之前说了句奇怪的话：她不是在害人，她是在找人。
    -> tips
+ [好了我知道了]
    -> tips

=== shop ===
# speaker:小二
有有有！别看我们这是茶馆，该有的东西都有。客官您看看。
# action:openShop:teahouse_shop
-> END

=== after_ghost ===
# speaker:小二
您、您真去了？！
# speaker:小二
我的天，客官您胆子也太大了。您……您没事吧？
+ [我没事，就是看到了一些东西]
    # speaker:小二
    啥？！您看到了？那……那白影子？
    # speaker:小二
    哎，客官您等着，我给您找本东西。之前有个住店的客人走的时候忘了拿，是一本什么风物志。里面好像提到过城隍庙的事。
    # action:addArchiveEntry:book:book_erta_guide
    # action:showNotification:获得《渝都卫风物志》:info
    -> tips
+ [不想提了]
    -> tips

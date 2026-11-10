// Made by scripts/build-rare-patterns.mjs from scripts/data/cs-money-rare-patterns.json: the CS.MONEY Wiki's rare patterns
// (https://wiki.cs.money/rare-patterns), fetched 2026-11-10. That script says where it all comes from. Don't edit it by hand.
//   RARE_PATTERNS: { [weapon id]: { [paint kit]: { set, groups: { [group]: seeds } } or { set: 'Fade', fade } } }
// set is what patterns.js's RARE table goes by: the finish, or a pair of gloves' whole name. A group is the wiki's type, then a /
// and its tier when it has one ('diamond/1', 'max-purple'). seeds: two base-32 digits a seed, 0-1000 like CS2's Pattern Template.
//   RARE_FADES: { [fade]: { p } }: every seed's real fade percentage (p: two base-32 digits a seed, in tenths), once for all the
// skins that share the pattern.
export const RARE_FADES = {
  // AWP | Fade, ★ Karambit | Fade, ★ Talon Knife | Fade
  0: {
    p: 'tntnqutptgunq0t1uqu6r5phpusrurs2v6s8qeratbpoq7qet5rgrlu9uepdprt3uppup5rvrqq7r7sprjp2tjpnsptgpeq4v1tbr4rergqvtmrirmqjupsuu5qutuqlpmr3tar4ukrdrmu4ssprrnsmptsnqmqbpjrqrdskperbrkp1t8ptubr8rvp1pvr0tfr6trrrrus6tlpvqap6t5p8urpvu5qeuttbqqsjt3qdqqsvruuis7rprhu7v2sbrlv3pns3shrasvs6piphtpr4r3phtktgs1pnv6p9trulpbtdv4ssq5pvugqas6sdtbq6tiqltgujt1qpprsbu0ulpmpmt5r5qbuhunqcs3pkv0u6tbtgseqeuptat1q3rmt7sruau4sasarprip8uou7v0p4uirasasuq1ppq2uprdrou3tft8setbshu1pmpds3t8q3r1pkuusmucuqu1t6pgsluirqqqv5s7upsjrltcrvsmpntbquv0tlu8r5p5rktfstprs4thsdrqstu3rls4tkrmqsr0qiurs5q5qepcsmtmv5pppot6q3t3uks1qbsvqqv5q6qtprtlrbqpqfr5qsptt4ttrusgu3phu4tftjqjpipju4rpsiqrrrs5u2rmqmq5t9p1rbu2uds9rpv3u2tptoq5ups4sautp1qjquv4pcrhrbp3snrlubsotntoskutr1pjv7ssq4s7rhu0rcrtrktut5ujsqudtat2pdqdprupr5p7poqfsrtgtosjtjtmqar5rtq8v7t5pepau9sip8u3phufp1u9uruns7srt1sptrv8tuqvttq8s6rqt2s4qgp6stq2tcruqtp8pvpsqisvq6sopktkqqtur4puudq6t3uutuq8pmu5p7t9tmuuqouqpis6v0ptu9riunpltut6pgpos7p1sqquuuseu9s4qtsdt7sftftcpupju9shu3pcq7pqtrsqqrt6ump7rvu1sdt2ujs1rpsks2t5s0u4tipqs4slpoqoq2potqujp7qqsfp1p2uvsirlprt2p3qct5tet3tfr8seu1ppu9q4uotgv6s9rnsguiuhtlrbqmp6t7tguer3tpqssasguet5uasdrtpuropor9pqtptrp7plqst9p0p5p7uvthtgrvu1p5qpsbq2q6qmuhuauiqmtrt5srqfpitipfssp3v7spqqtutpuvpjs2tbtlq3rburrot6r4rsrbrmuts1s2tprgu9t7v3r8tsuuudqmshrip0ulsspbpkr6thrprdqct3u7p6v7sjp2v0urqqulujpgqdstv0qqrettp7poqitrp4s7trs4ujv5u4sjr3prtgsdtbs8s0uqsrv0ppq4v6tdpdu2s6tisqr1uoqgq6t8rbv7uppis2v0ujrisctgu9skpirnp3svtdtvrbq2srsgrgttrnuepjucuqr5t8siuqtgr1r2v1qkr2sgqar8p4v5t9p9tup8s5ptt2pdq9ucpbrtudqbq9pnqlutq0p0ugr7ujtlrtqbuqrusluuqarntcv4r9rvv1peq5tdsiubrmv2scpfpvufv3patvurs8r8prrdp8qqqhuqqluaqjp3qbubueq8tpplrdq6t1uku9rataqctqr7p8p8urpcqrr0rerfv0rtp6qdrir8phsuper4rntaugtrtsrip6perdqet3thunsgpasuuessq6susfq7qmt4qeurugu7resip9usv2q4utraq6rkrlpkrqsnqkqmqcpurfrbsgpmp4sttnqassp0q4tqrgqkqjqsr1rcrqtov2u8p1p2qssrpbptqgpiv3t1qnqgumv2qmp7slsgsqtdu9u0rkqarpt3p8rvrptipoubqip6p5rqqor0u1upr9t0seq5svqbpcrmu0umq0p1u9rar8s1uor3pdt2rcuouessqep6ucuhqsq6u6p8uushqdrvsjs7uvu5qcqot6qav4qdqtumt9t3uq' },
  // Glock-18 | Fade, UMP-45 | Fade, ★ Bayonet | Fade, ★ Bowie Knife | Fade, ★ Butterfly Knife | Fade
  // ★ Classic Knife | Fade, ★ Falchion Knife | Fade, ★ Flip Knife | Fade, ★ Huntsman Knife | Fade
  // ★ Kukri Knife | Fade, ★ M9 Bayonet | Fade, ★ Nomad Knife | Fade, ★ Paracord Knife | Fade, ★ Shadow Daggers | Fade
  // ★ Skeleton Knife | Fade, ★ Stiletto Knife | Fade, ★ Survival Knife | Fade, ★ Ursus Knife | Fade
  1: {
    p: 'qhqhtaqfqophu8r7peq2t3unuardpds6p2s0tqsuqtugu1tqr3sosjpvpqurudr5pfuav3s9seu1t1rfslv6qluhrfqouqu4p7qtt4sqsot9qismsitlpfraq3taqatjuit5qut4pksrsiq4rcudshriubrhtittulsesrrkuqstskv7r0ubptt0s9v7u9t8qpt2qdsdsas2qju9tuv2r3v0pdu9q3tqpbqtterlr5trter9sapms1sfsnq1p6rtsjp5uhs5rnsur9s2umunqft4t5unqkqos7uhp2uvqdpjutqrp4rcu3u9potus2rrqtu2qmtjqoplr7tfudrtq8pjuiuir3t3ttpnphtss5ukp8q2qtqorqtqpfqur7u5sir1rdpuq4rurusfsmv0pgq1p8v4pmsururau7ufu6pfsrsgq5qpr0rqqtrnq7uiurs5r0u5t7ukparipspeq7r2uorjpmsetep3s1pfrlsjqss9riuhqttap8qjq0t3v3skqprbuds4qnrrserbq5sjs4qksitct8tmpds3u3tqusriqip3ufugr2u5r5pks7ttr9tep3u2tbudqjsttftpt3tcubr4qbsaroq5unq4qpqltlumulq4sfrmtdsds3q6sitiu3qvv7stq6prrvsfp5q6qfqgu3pfs4rupbv7tltap4ussnstv5rhsjptrgqhqgrkpbt7ulp1rcu4s1snq8sssbskqar3plreprqur6urtrudpft3v1ugtprdqoqgrlqlqitut3sbu0p1r3uquupvrmv0q5unppv7pvpdphs1rdr7rfqdp0qat9qbu0s2ser6s4tov2rbu6qssatbv0u9uctmr9u2rgukqkteqat4uapru2r5paqau0uiq3v1qvqipatgpeums2p8ubpvsmphujqar2uougs1v7retaparqpvs4tbrrr1rpqpqsuaulpvrnq5usu1ueqdretdr2piv1s9q7rrr6pls7sfrks6r3s8q4qmues4rjugtgu6ugqeplv1terpv7v6p9rmsjudr6v5tsr3qqr5qpt0rqq7ufpvu4pgqop2rvshropmpnqjsttiv2r1qopqt5qftcruropqr3purrsbuasgugsvueqfqdv1ujtcqvv8v3v1p9qnqos9q7v3tfrtu6u2tipnpupmtiqdr3rdtpumqmuprcv5p1rfteqaqfp9uls6qtqju5stpdsgr2t4scstsipbs7s6qfsopvr1p5t0qcpaprtirnsmv8pjrcutukt2qnsfsrtsr5q1v2p1rlv6p8pdtepjpluotrrbp8tesqqbv1ugtmqdv4s1qds4plp3q4rlt5udqorrqts0s8perdp8ufu4p2qrurq6s2qmret7pgtou2r0stp1pfums6p8plsmrsqopvrkumshv5r9qrq9stu6rdrosoqbshpqulpspet3r0rmpeqot7t6p7tkt6rotut0v4p3qvuvqav0s3ubr6urtvpsutsbprtttvuhtjpbu8v8pot1plqjsbttpesarjpatushqsp4svs9p7uqu3qrrmptsip6rsupu9ppp5uuq9pds0t0udsrv0tetnpetjputlv5ttptpqu0qfujsru2r7pkpvsuqutsqet1v0v0pdustdt8sqspp8sbv2trsmt0unrauqt4shqupoqdqcsmv2uqsrtqr5qnphrouurapqrcu2rarpu1tir4tqpdpoq1sqrmuvpcp6u4pbsuu2sksjukserhtktitsuaspstrouiv4rbqhturcv8u4qesotktltct7ssseqgp6q0v7v6tcrdutubtoump5r7thtopip6tiv1rjroreqrpvq8sktusfr5v0s9sfqmugpttmv2v3setgt8q7pfsvr8rqu3r9ttussiq8piu8v7pvsut0s7pgt5urr6sspgpqrctqv2pspntcu2q2v0parntrs9rls1p9q3tstgr2tup4trtbpiqvr5pe' },
  // M4A1-S | Fade
  2: {
    p: 'rjrjr5ukpmq3qppppeq7t6p4uathuctbqru2r8toq9pau1p8tfq9p0rnr6plp8tkqhtdppueu3rltkqftcuarur2qoterssnqmrqpmrir1paqgsps6v2tntmp2saptp3uasttntbr6qnpfr9sdv6r3p9qjqnp0t1v7sut1q8t1qgumt2uhu2tmuhriq3untisrpmqgufukrstluht1t8psurumtqv2rbuvudssp3ubs9t2tbputlttq2uguquepau0r5p0ubt1r4qit4pttrtarmuvq6tosapos4rbpquutdp4pus9rurcr8v2qup8qmqushqhp1ujtppjp2ucrlsetbutqas4pnqbudp6par5rip0pdqqpbubpppgqtrvq3p4sjtqq4u6u4u7saqos1u0rlu2s0p3u7qrutusspter9s8suu7rfsip2s8r1rptbtlt8qapbsfu1p6pbuirhp1qnustprrslp4u8qjtgpiv0rku5sbptqsursrqlsktcq6s2t2pqsssjp3urpmq0u0qjtsp6p9p1puqdr5ulscpuupv8uitkp5pcrnqsp1s2t6s0pcp9v0rbp8qkpvr4survqhr5tor3uupar8v4sjs4qou8usqarkqms6uupfuhtgt5s9p1ttppqgqtr4srr9usqdt8p5pdv4q8p1tcpsq6t5qgujumu4u1qdthu8pouvuuqctju2u6psqjv0s6unseqlu8u4spumtir6s6qdqsv8p0rjp5prtdpsphv6ugshtjp4pds9pjp1umspulqmsju7roqkr6qrplpatqt5set9prr5sruoulr4s8seqjsmruqcurqus6stprqfurrvpcpaupp7plursfsru5ukqap4peqtv7p1popfsrufuntqv3qlujr8qvqkrjrbpvptsbugrftcv3thsaqtv1umplssqmteqqultpqgsiuurdt8u5sms5tjp4qhtpqft9p3pfq9uip1pnsdr1s0qites6qmrormqvrupdugtosqurriq4s0p8plscuut7qfr0p4spq6pdq4reqiq9rltdquthupumsaqnuetesjq0p3pgpltup1ump2p8upslt1p9qmv5s4qvt8tesnr9peudutv0qkpms2sesordsgttrkurv3uarrthqku8ulp6utstqjqtr2sfs3t2qct0p2pgp1t9p2tes0tmueupslp6qnsashqvuir8qtv2sau0s0tlr7q3uesgqhpjugqhu4qmtnsutiplqmrut9r7sjs9smteppu6ppsmubpnp2puulslp2s5uurtu2qks8p5qopescqvpkp1p3siv7tkp3s9ukqhqjqguju1q9tdqcspsbrip2s2qoplrft7qaqtuppmuppltmsbs2smp1ttu1s0ulqtrjq3tnsnrsp5qpsrroqvquustiq3rrt7sdqtrpqvsvrqscs7rrq2ssurr0q6qpueqqtkplp0u8tdqjs6trrcrbrvpppdp1rjtdrbqtpkuhubtburrfp5qpq0r3r0s8rhrotsuusrpgpiv6rcp4t4q6qcpcsup4v5pkv2v7qjqsrbu3r1ruplsmumsft4p1p3toscp0p9spqntdukr6s1svqmqnp4qqtdqfr0tiufpvrdqpsesrs1sbrqrgueu7uqt5pirks7uhtmpcsvquths9t2pls5upqur3ursup5rfp3pot8s5q2pltcu4pmsksptmp4qruhpqr0usr4udv6sss2pus1pfs8stpgs1t0qmsfu4pat5sapqp4r0raqfv2qlulqjtepnqaqjp7p5s3rpqurhsks5s3qqtjs8utqep3qsttp5r0ufu2sksmv0rlt9s2ssslsuqqpqprufp3qcslrpquq7rgr2p4utqrtiqtsmrsujs1uhp9t4v2tputqtumulqrslr9rtqotdp3qst9upr0t7qoqqt8qrr9qbs3q1t3sus4tsu9rvs0skpoqephqlttr4t5t2ssq6' },
};
export const RARE_PATTERNS = {
  leather_handwraps: {
    handwrap_red_slaughter: { set: 'Hand Wraps | Slaughter', groups: {
      'double-diamond': '032e3q5m8nbuc6dpejoutqujv8',
      'diamond/1': '0p0q1k1l2d3741425l78797a8t8uaeahaib5b7b8btc5dqefeifdfefqh1h2hvilimk9kao7o8q5q6tott',
      'diamond/2': '0b16171r1s262j2l333s454s536o73767n8e8l8m8r939j9t9ub6crcvd8dddkdvekfrfug7gthui1isitkckjl6lqo4oeohoiotqcqir4rrs0s6skslsut7tntru1uduv',
    } },
  },
  motorcycle_gloves: {
    motorcycle_triangle_blue: { set: 'Moto Gloves | Cool Mint', groups: {
      'ice-blue': '1o2c2n3d6p6u9vanb9cod2jsloogovpmq7t7um',
      'max-white': '041f1h1p2o3e3f475u616a6k8pajb6babdbvc7cme4eoetg0i2injdk8nvp3puqfqqqrslu1u2uh',
    } },
  },
  specialist_gloves: {
    specialist_emerald_web: { set: 'Specialist Gloves | Emerald Web', groups: {
      'emerald-double-web/1': '6ga3aao6olr2sqt8',
      'emerald-double-web/2': '2p416a8tbaced4gbgmh3hjkglnmintorp0pbr5s7sd',
      'emerald-right-hand-web': '292a2f2q323b3j3k3r424a4j5j5t6d6h6t7g7q8n8u949p9safaob0b4bhcrd0due2e6g1hthvi5iqitkbkmkplaljlqlrlvmqn9ndnvo0pgpkpqq1qds8sbsesitftgthtktuu8us',
      'emerald-left-hand-web': '020h243t40454c5c6465667479878j999i9ncaeievfjfofsgkgph6hahhhri8ibicj2j7kflcm6memhmsmvn7niokptpuq5qsris1sasgshsvt5tcudujv4',
    } },
  },
  sporty_gloves: {
    glove_sport_tech_gradient_bright: { set: 'Sport Gloves | Ultra Violent', groups: {
      'max-pink/1': '005354bkfshkmmmqpbptqvr8tj',
      'max-blue/1': '1t3l3m456baoe7g7gogui3khnsro',
      'max-blue/2': '495o7g8v9rbfgagvhbihjqmbrttlufug',
      'max-pink/2': '070j0l151d1k3u4f4i5g5h5v6061646k6l8g8t9haqc4d5dtepfngeh2hlitiuivj5jfk0k1k4kdkekfknkokplgm4mtmunjosp9qbrrscsltiu0ucud',
      'max-blue/3': '020e0o1n1u2g3e444k4l4m5c6a777b7d7h7p7s8p90aaabacagbmcicjd2dcdddgdjdkeef3f8f9g6gbhchdi0igiijkjojpkikjkkkslbnpoopnpqq1q2r1r2rksrtctdte',
      'max-pink/3': '060c0k0t0u1j1l2a343738393g3h474e4g4h4s51525557585m5q656g6h6i6j7273798b8c8f9293969g9t9ua1a2a6a7a8atavbbbsbtbuc3cacfcgcocpdue2egeiejemeneof0fvg0gdghh1h9hrhuj3jajbk9kqkul6ldlfljlom5m9mnn8n9ncndnmnno6oaobocohoqorotp1p2papfq6q9qaqcqnqur4r7r9rarqs5sbsgtgthtntptvu3uiujv3',
      symmetric: '1g262k2l2s5e6r8m9j9mb6d1dni8n0nvo2ovqeqlstt9u8ulum',
      'blue-left-pink-right': '030i1c3j3n5p63687l8s9sahapbndee8ecfifkg2glh8ilinjtk3ktmsnto9rpt0',
      'pink-left-blue-right': '01041e202o2u353k4j626e8494b0cldaedfjimiojsk2k5kgmamrodompurssdsmsvtkusv8',
    } },
    sporty_jaguar: { set: 'Sport Gloves | Nocts', groups: {
      'full-leopard': '0f23444a6k9ea9bheofggjhghqj9jqm7mgmkn8ngq7t4tku4ue',
      'full-black': '0g0l122l2t323a3r3v5p6377898l9uanbcd8dce2epfrh0hijfk0k7munjs0smt7u0v2',
      'right-hand-black': '0d13182n2q33363p3s6465696n749naqatb3b4b9c8cbcpdidjdtduebf0fuglhjhsi5ipiqj6k3kdktlrltmqn7nmo1oqp6piptpuq3qdqrsqtntpubupuq',
    } },
  },
  weapon_ak47: {
    aq_oiled: { set: 'Case Hardened', groups: {
      '1': 'kl',
      'rank-1': '4n585ja1c3hbigkunop9tr',
      'rank-2': '040d0s10212a2i2s373q4b4j5c5t6d7480a3aldadedqefevg0gdgegkgthri2itj9jjlnlqm4m9nengonpsqcr4rnrorss7s9sqtmu9uiv4',
      'rank-3': '122h3g8m9mbbbtctdcdde2g7hdiaj2k7ldlhlimtnio2pjpnqoqur8ret7v8',
      'gold-gem/1': '6rog',
      'gold-gem/2': '7sepgqob',
      'gold-gem/3': '2j5u63a7h0hahikrn2s0u3v7',
    } },
  },
  weapon_awp: {
    aa_awp_fade: { set: 'Fade', fade: 0 },
  },
  weapon_bayonet: {
    aa_fade: { set: 'Fade', fade: 1 },
    am_marble_fade: { set: 'Marble Fade', groups: {
      '1st-max': 'cs',
      '2nd-max': '0g4i7hb7c9gtiqk9lglt',
      '4th-max': '1g3u41acocojrascsmsr',
      '3rd-max': '4o8p94aojkl1n7o9oov2',
      '5th-max': '5m6c7se9gai2kckkldm1n0q0us',
      '8th-max': '055i5s6aahbqcmedgrloluqmu6ub',
      '6th-max': '3g76akb4dse4enivjdjnnpo5r9rcum',
      '10th-max': '0s4s5h7ecih1h2h9hfidifmlnsonpaqcqqr4ucuh',
      '9th-max': '243p4l555b6e8vbifdfjg4jtkfkgl0m2nuphsqtvv5',
      '7th-max': '080e101q3c6l797j8icle6j6kdlbmomso2orp3pqr3tl',
      ffi: '090r2q3e3t5n636b787ua9avbkcdckdpe0ebepf3gphhiejijok7m6mnnhnkohp5p9pir5sdt2tdu2ugukut',
    } },
    am_marked_up: { set: 'Freehand', groups: {
      'max-black': '0c222i2m366o7v8c9e9laqcjcrdadkf7fvhchqi1kem2noroto',
      'max-purple': '1j3g4q6b7g7sbjcdd0d3dgdie8f5g6hkkplpo0oepvq2r1r6v3',
    } },
    am_zebra: { set: 'Slaughter', groups: {
      'diamond-double-heart/1': '0210hmntskv4',
      'double-diamond/1': '2q3c3k3s55c1dvkcls',
      'diamond-heart/1': '070915283j3o4o5j5n7e9293afcif3fbfih7hrkqllmnnhqarbrhsasit3tp',
      'double-diamond/2': '8oegq9qetuu8',
      'diamond-double-heart/2': '417i8tbcggobs2',
      'diamond-heart/2': '2h6n7u90g4j5lflqmimkpsqotmtru5ue',
    } },
    an_tiger_orange: { set: 'Tiger Tooth', groups: {
      'straight-stripes/1': '1i1v294d535f8d8e8nbibuchdfdvefejelhnhpk6mdmlndnjnoo1oppaqhqtspteu1',
      'straight-stripes/2': '050d0q2e4u5a5d72787p9ua4b3b8bsc3dddkdpe0ekgvi1imkonro5odouplqeqlrkrpslsrtottu6',
      'straight-stripes/3': '0001031l21323c3s424s6t7a7c7g7t8o8u979cb5c6crcsfgh9hviukal5lgm9nfojp3p6pfqfqqr1r7s5sutgv7',
    } },
    aq_oiled: { set: 'Case Hardened', groups: {
      '1': 'hb',
      'gold-gem/1': 'cbsg',
      'blue-gem/1': '4n5j74a1hbigj9klkulnnopstr',
      'blue-gem/2': '53586hc3u9',
      'gold-gem/2': 'b7meqgstuv',
      'gold-gem/3': '9da7bcdth3hqimkrlcmun1nlnrqdsmtjtotvu3',
      'blue-gem/3': '090s2a2e2t6a6f6o73839oa5b0btc1deevg0g8isitjok4onqcr4rnrsrus9spsqv4',
    } },
    hy_webs: { set: 'Crimson Web', groups: {
      'triple-web/1': 'argohokjleua',
      'double-web/1': '3d8h8valdeh5pupvsb',
      'web/1': '131e1t1v212h3r5j5t6k7h7k7makbfche7g5gfgrh7hqi5inivj2j6jqkakeknl9lflrm4m7mtn6napfq0tktutvuuuv',
      'quad-web/2': 'pa',
    } },
  },
  weapon_glock: {
    aa_fade: { set: 'Fade', fade: 1 },
  },
  weapon_knife_butterfly: {
    aa_fade: { set: 'Fade', fade: 1 },
    am_marble_fade: { set: 'Marble Fade', groups: {
      'orange-tip': '05080e0g0r0s101g1q242q3c3g3p3u414i4l4o4s555b5h5i5m5s636a6c6e6l7678797e7h7j7s8i8p8v94a9acahakaoavb4b7bibkbqc9cdcickclcmcsdpdse4e6e9ebedenfdfjg4gagpgrgth1h2h9hfi2idieifiqivj6jdjijkjnjojtk9kckdkfkgkkl0l1lbldlgloltlum1m2m6mlmnmomsn0n7nhnknpnsnuo2o5o9ocohojonooorp3p5p9paphpipqq0qcqmqqr3r4r9rarcscsmsqsrt2tdtltvu2u6ubucuguhumusv2v5v8',
      'blue-tip': '060b0c0l0m0t0u111215191b1e1f20292c2f2g2k2n2p2t2u3738393b3d3l4248494d4h4j4m4q4r4t51585c5d5g5j5l5v696d6i6j6k6v7073757c7p80848k8m8q8r8t9195979e9k9p9qa4a6agalapasb6b9bnbpbsbtc5c8cbcccfchcjd0d6d8dcdddedhdjdodqdudve1e7eaeeeheiekf1f2f6f7f8fefsfvg1g2g5g8g9gdgfgggogqh6hkhmhohrhshvi0i1i7iaibilinipj0j4jsjvk0k5k8kbkhkikokpksl5lelflilqlvm8mamfmmn4n6n9nbndnfngninlnmnnnqnro1o6odoeolomopoup0p7p8pbpdpfplpoppprq2q3q6q8qgqhqoqsqvr8rbrerhrmrnrrrsrvs1s2sesfsisjslstt5t8tctftgtptrtsu0u1u8ufujuluuv1v3',
      'red-tip': '0001030407090d0k0o0v171a1c1d1h1m1r1s1u2227282b2d2o3032363a3e3h3k3n3t464a4e4f4k4n4p505254565a5e5n5o5p5t5u6162646b6h6o6p6q6s6u72777a7b7m7o7q7t7u828386898a8d8n8o8s8u92989f9g9j9l9m9n9ra1a5a8adaeafatb0b1b2b8bcbgbhbjblbmbvc0c1c3c4cacgcocpcqcrctcvd3d7d9dgdidkdmdrdte0e2e3efegelepetevf0f3f5f9fafcfgfifofqfrg3geghgigjgkgngsh3h7h8hbhghhhphqhui3i4i6ihiiijimioiritiuj2j3j8jgjjjmjuk2k6k7kjknkrkul2l6l8lclhljlllmlrm5mbmcmdmgmjmqmtn8nanenvo8ofoqpcpgpkpmq7qbqdqeqkqlqpqrqtr1r5rjrtrus0s3sbsdshsnt0t1t3t7tbtktntqtuu9udukutv0v6v7',
    } },
    am_marked_up_90: { set: 'Freehand', groups: {
      '1-max-purple': '49',
      'max-purple': '0j1a272u30494f5q617n8k8p91a1ardddje4gqnlotp9pjq7u1',
      'max-black': '1u313l3v4c7t8796c2d1d4e7i8kglcldm6meokr2rqsft5tvut',
    } },
    am_zebra: { set: 'Slaughter', groups: {
      'diamond/1': 'b4i5l3',
      'heart/1': '0k0p1m4v97ahanb2esf8jhl0ojpbta',
      'heart/2': '2c2l3r4663808388989m9racakalasbqcacvd8e2e6enfcfjg1gpi4iujbk0k5kfm1mpmtmuoapgrcsgt6v0',
    } },
    an_tiger_orange: { set: 'Tiger Tooth', groups: {
      'straight-stripes/1': '1t3d4g626i6qbec0c5ccd0dbdcffh0ivj1jdjik2k9kkkpljlpmankp1pnqfqss9v1',
      'straight-stripes/2': '125q5s606t8m9vaob5btcqdmf1f5fkgdi1inirjfjnjsjtkhlam9mfmjp4pepkpuqrrermsesju7ua',
      'straight-stripes/3': '1h2k3u55585t686o6s787h7n9ganarbbbdc8d1d5dee6eqgoi4i6isjkjmk3kbknlilslum5n0n4nupmprtgtqtv',
    } },
    aq_oiled: { set: 'Case Hardened', groups: {
      '1': '5m',
      'gold-gem/1': '192bink9su',
      'blue-gem/1': '5m628raafelmlvq6rrshsl',
      'gold-gem/2': '788nhskato',
      'blue-gem/2': '0t6m87bjccceeuf8fuj4jukcmdndp0r4rht0',
      'gold-gem/3': '2k3j495beejsnnogu3v5',
      'blue-gem/3': '0r161a28292s323g424j647o808h9nacafb6d8dadge9eaegeieqfjgmhvjajkjljnk3kolrm4m7mhnvo0o2oeouovp9pbq7q9qqrlrusbsnssu4u5',
    } },
    hy_webs: { set: 'Crimson Web', groups: {
      'triple-web/1': '55aqarhopu',
      'web/1': '3844484b4e4m4pakbmie',
      'double-web/1': '19979oaiamejfah3lkovr4',
      'quad-web/3': 'uh',
    } },
    sp_dapple: { set: 'Scorched', groups: {
      'black-gem/1': '76ds',
      'black-gem/2': '21416o7djvnvpvr3uq',
      'black-gem/3': '0a0q0s3o437e9paab3c6d2hciqjqkj',
    } },
  },
  weapon_knife_canis: {
    aa_fade: { set: 'Fade', fade: 1 },
  },
  weapon_knife_cord: {
    aa_fade: { set: 'Fade', fade: 1 },
    am_marble_fade: { set: 'Marble Fade', groups: {
      'orange-tip': '0i0m0n151f1p1v2e2f383f3l4q4t51535g5j5r5v6i6k738h8k8l8t91959b9oa3a4agamb9bobuc5c8d0d5d8dfdhdqduf7g1gggqh5iaibicigikj4jpk5kikqlflplqmfn1n4ngnlnmnoo1o6oep2p4p6p8pbpfplq3qjqsqvr0r2rbrerkrlrmrvs2s5s6skspsst5tetptru0ueujuouuv1v3',
      'red-tip': '060b0c0l0t0u1112191b1e20292c2g2k2n2p2t2u37393b3d4248494d4h4j4m4r585c5d5l696d6j6v70757c7p80848m8q8r979e9k9p9qa6alapasb6bnbpbsbtcbcccfchcjd6dcdddedjdodve1e7eaeeeheiekf1f2f6f8fefsfvg2g5g8g9gdgfgoh6hkhmhohrhshvi0i1i7ilinipj0jsjvk0k8kbkhkokpksl5lelilvm8mammn6n9nbndnfninnnqnrodolomopoup0p7pdpoppprq2q6q8qgqhqor8rhrnrrrss1sesfsisjslstt8tctftgtsu1u8uful',
      'yellow-tip': '020a0f0h0j0p0q131416181i1j1k1l1n1o1t212325262a2h2i2j2l2m2r2s2v313334353i3j3m3o3q3r3s3v40434445474b4c4g4u4v57595f5k5q60656667686f6g6m6n6r6t71747f7g7i7k7l7n7r7v818587888b8c8e8f8g8j909396999a9c9d9h9i9s9t9u9va0a2a7aaabaiajanaqaraub5babbbdbebfbrc2c6c7cecncud1d2d4dadbdldne5e8ecejemeoeqereseuf4fbfffhfkflfmfnfpftg0g6g7gbgcglgmgugvh0h4hahchdhehihjhlhnhti5i8i9isj1j5j7j9jajbjcjejfjhjljqjrk1k3k4kakeklkmktkvl3l4l7l9lalklnlsm0m3m4m7m9memhmimkmpmrmumvn2n3n5ncnjnto0o3o7oaobogoiokosotovp1pepjpnpsptpupvq1q4q5q9qaqfqiqnqur6r7rdrfrgrirorprqs4s7s8s9sasgsosvt4t6t9tathtitjtmtottu3u4u5u7uauiunupuquruvv4',
      'blue-tip': '00010304050708090d0e0g0k0o0r0s0v101a1d1g1h1m1q1r1s1u2224272o2q3032363a3c3e3g3h3k3n3p3t3u41464a4e4f4i4k4l4n4o4p4s50525455565a5b5e5h5i5m5n5o5p5s5t5u6163646a6b6c6e6h6l6o6p6q6s6u727678797a7b7e7h7j7m7q7s7t7u8286898a8d8i8o8p8s8u8v9294989f9g9j9l9m9n9ra1a5a8a9acadaeafahakaoavb1b2b4b7bcbgbhbibkblbmbqbvc0c1c3c4c9cacdcgcickclcmcpcrcsctcvd3d7d9dgdkdmdpdrdsdte0e2e3e4e6e9ebedefegelenepetevf0f3f5f9fcfdfgfifjfofqfrg3g4gageghgigjgkgngpgrgsgth1h2h3h7h8h9hbhfhghhhphqhui2i3i4i6idieifihiiimiqitiuivj2j3j6j8jdjgjijjjkjmjnjojtjuk2k6k7k9kckdkfkgkjkkknkrkul0l1l2l6l8lblcldlglhljlllolrltlum1m2m5m6mbmcmdmgmjmlmnmomqmsmtn0n7n8nanenhnknpnsnunvo2o5o8o9ocofohojonoooqorp3p5p9papcpgphpipkpmpqq0q7qbqcqdqeqkqlqmqpqqqtr1r3r4r5r9rarcrtrus3sbscsdshsmsnsqsrt1t2t3t7tbtdtktltntqtutvu2u6u9ubucuguhukumusutv0v2v5v6v7v8',
    } },
  },
  weapon_knife_css: {
    aa_fade: { set: 'Fade', fade: 1 },
    am_zebra: { set: 'Slaughter', groups: {
      'diamond/1': '0k0p9pand2esghl4l6oata',
      'heart/1': '212n30447s9abfckd6diemf2fuh8i9jljum3m7o3odpapoq7qirjt2v7',
      'diamond/2': '2j5d80ahalb2gc',
      'heart/2': '0a1n383m7fdthqjsmqqvsst4uo',
    } },
    hy_webs: { set: 'Crimson Web', groups: {
      'triple-web/1': '42',
      'double-web/1': '0j1b293b6vafciei',
      'web/1': '07082k3l3n3s495i5j6b7t818r8s9qanc1cecfclcvdsdte7epevf5gkgngth5i1iniuj6j7jtlhlvmamhmumvnuo2o5onpcpiq2qmr0rbrjs6s7tftgtpu8ufus',
    } },
  },
  weapon_knife_falchion: {
    aa_fade: { set: 'Fade', fade: 1 },
    am_marble_fade: { set: 'Marble Fade', groups: {
      'red-tip': '0508090e0g0r0s101g1q1s1u24272q3c3e3g3p3t3u414i4l4o4s555a5b5h5i5m5n5s63646a6b6c6e6l6o6u7678797a7e7h7j7s7u8a8i8p8v949g9j9l9ra1a8a9acadahakaoavb4b7bcbibkbqc9cdcgcickclcmcscvdmdpdsdte0e4e6e9ebedefenepf3f5f9fdfgfjfqg4gagngpgrgth1h2h9hfhhhqi2i6idieifiqitivj6jdjijkjmjnjojtk7k9kckdkfkgkkknkul0l1l2lbldlgljloltlum1m2m6mdmlmnmomsn0n7nhnknpnsnuo2o5o9ocohojonoooqorp3p5p9paphpipqq0qcqmqqr3r4r5r9rarcscsdsmsqsrt2t3tdtktltutvu2u6ubucuguhukumusutv2v5v8',
      'blue-tip': '02060a0b0c0i0j0l0m0n0p0q0t0u1112151618191b1e1f1i1j1k1l1n1o1p1t1v2021232526292c2e2f2g2i2k2l2m2n2p2r2t2u2v313738393b3d3f3i3l3m3s40424548494b4c4d4h4j4m4q4r4t515357585c5d5f5g5j5l5r5v68696d6f6i6j6k6m6v707374757c7g7l7p7r7v8081848b8e8f8g8h8k8l8m8q8r8t9193959697999a9b9c9d9e9k9o9p9q9ua3a4a6a7agalamanapaqarasaub5b6b9bbbdbfbnbobpbrbsbtbuc5c6c8cbcccfchcjcud0d5d6d8dbdcdddedfdhdjdldndodqdudve1e5e7eaeceeeheiekemerf1f2f6f7f8fbfefsfvg0g1g2g5g6g8g9gcgdgfggglgogqgvh4h5h6hahchkhmhnhohrhshthvi0i1i7i8iaibicigikilinipisj0j4j5j9jbjcjhjljpjrjsjvk0k1k4k5k8kbkekhkiklkmkokpkqksl4l5lelflilnlplqlslvm3m8mamemfmimmmpmumvn1n2n4n5n6n9nbndnfngninlnmnnnonqnrnto1o6o7oaodoeoiolomopotouovp0p1p2p4p6p7p8pbpdpepfpjplpnpoppprpsptpupvq2q3q4q5q6q8q9qfqgqhqiqjqoqsqvr0r2r6r8rbrdrerfrgrhrkrlrmrnrorprrrsrvs1s2s4s5s6s7s8s9sesfsgsisjskslsospssstt4t5t8tctetftgtitjtmtptrtsttu0u1u3u4u7u8uaueufuiujuluouuuvv1v3v4',
    } },
    am_zebra: { set: 'Slaughter', groups: {
      'heart/1': '808388898lalavbqe9geghgtk0l4m1pkr4t7uv',
      'diamond/1': '0j223n4e7v8c9eb4brdjf7h1j9jvkel3m2n8pis3sn',
      'diamond/2': '0m3p8ailn5v3',
      'heart/2': '0k0p122j3a4g568g989pacahd7d8eagcjhk5l6oaogpgqcrqta',
    } },
    an_tiger_orange: { set: 'Tiger Tooth', groups: {
      'straight-stripes/1': '0s334u6b7n8e909tarc9e0e3eheqetgfgni0ifihiqjuk3krlfm3mmndo0p7q4ueuq',
      'straight-stripes/2': '1a1j2i2r4k545l5s6i7ma2a4agbgboeghohtjcjnjpl9lrm7momrn4o1o3ojq2rcrorvs8tftstvu8',
      'straight-stripes/3': '1f373s4h576e6h6j6n6o74819ka9btc2e9ekf1fnftgbglhlirkcknl7lembnannqirgrms0sesnsrthtitku9uu',
    } },
    aq_oiled: { set: 'Case Hardened', groups: {
      '1': 'fe',
      'gold-gem/1': '8nhssu',
      'blue-gem/1': '3g4262aabjf8fehvjukolmouq6r4rrsl',
      'gold-gem/2': '363jc2ivjbk9',
      'blue-gem/2': '161a292s3k5m6m7k8q8rafcedae5fjfugah3jmjnkckfm7m9mdmhndo2p0p3p9q9rhrls6shsnu4u5ut',
      'gold-gem/3': '2k2u337ncpeeg7inkakkmfqbts',
      'blue-gem/3': '0k0r0t1t2p325f7u80878h8p9nacaebncccrdgeieqeug3ijikj4j7jajkk2k3k4lalvm4n7nvo0p8pbpnq7qcqeqlqmqqrtsbsksst0up',
    } },
  },
  weapon_knife_flip: {
    aa_fade: { set: 'Fade', fade: 1 },
    am_marble_fade: { set: 'Marble Fade', groups: {
      '1st-max': 'cs',
      '2nd-max': '0g4i7hb7c9gtiqk9lglt',
      '4th-max': '1g3u41acocojrascsmsr',
      '3rd-max': '4o8p94aojkl1n7o9oov2',
      '5th-max': '5m6c7se9gai2kckkldm1n0q0us',
      '8th-max': '055i5s6aahbqcmedgrloluqmu6ub',
      '6th-max': '3g76akb4dse4enivjdjnnpo5r9rcum',
      '10th-max': '0s4s5h7ecih1h2h9hfidifmlnsonpaqcqqr4ucuh',
      '9th-max': '243p4l555b6e8vbifdfjg4jtkfkgl0m2nuphsqtvv5',
      '7th-max': '080e101q3c6l797j8icle6j6kdlbmomso2orp3pqr3tl',
      ffi: '090r2q3e3t5n636b787ua9avbkcdckdpe0ebepf3gphhiejijok7m6mnnhnkohp5p9pir5sdt2tdu2ugukut',
    } },
    am_marked_up: { set: 'Freehand', groups: {
      'max-black': '070922262j363t7v8f8l8tbcc7g4geggm1o4oaoiqcqes2truv',
      'max-purple': '171m46507bb7c8cgdfe5fffmh0iaj4jejul1m3onoppbpgu3uf',
    } },
    am_zebra: { set: 'Slaughter', groups: {
      'diamond-heart/1': '282h6n90f3gbh7lfmkt3',
      'lozenge-diamond/1': '2a6p959qcscud1e7iuplrfut',
      'diamond/1': '02157efihhhrnhnintrbsatpv4',
      'heart/1': '0t313j3k43abc2g3j5kckqldlklrs4srtvu9',
      'diamond-heart/2': 'a9hgqasi',
      'diamond/2': '106g79fohmibkgsk',
      'heart/2': '1u2g3s5p6h9396cidvfjlqmrq9u8ue',
    } },
    an_tiger_orange: { set: 'Tiger Tooth', groups: {
      'straight-stripes/1': '050q1l1n2e3c4d727a8n9uaeb7b8bkbuc6d6dqefejfeh2j5jemlndo8ouqerrsltt',
      'straight-stripes/2': '1i1v32393s424s4u535m7k7s8e8h8r8u9c9ja5aibfdkdldvhqi9imitjbjokakcl1lgm3nfqdtetv',
      'straight-stripes/3': '0e17485d5e6j6u717f8sabadaparb9ccdie2emflfnfrg2g9hviejukdkqlblklolqltm4mgnjnrodpaq6quruus',
    } },
    aq_oiled: { set: 'Case Hardened', groups: {
      '1': 'ku',
      'gold-gem/1': 'h9hakr',
      'blue-gem/1': '4na1hbigklku',
      'gold-gem/2': '93c2dkfbmrn1qdqq',
      'blue-gem/2': '37585jbbc3nenoonpnpsqcr4tr',
      'gold-gem/3': '2b393r5l9ra7bccbcgfigfh4hqkglcm2muoiqgsgsttouuuv',
      'blue-gem/3': '090d0s212a2e2h2i3g3q4l53595d5t686a6h6n6o6s73749o9va5btccdadcdee5e8evf1g0g7gdgegkhehmi1itj2j9jkk7lhlnm9mbmkmtngnio2p6p9qfqur8rerfrnrorss9sqt7u9uauiujukupv4',
    } },
    hy_webs: { set: 'Crimson Web', groups: {
      'triple-web/1': 'gd',
      'double-web/1': '8vbkj5kjn6papuq7qis3',
      'web/1': '0f0k0o13171a1t20212b2d2h3g3h3r484g5e5j5m5r6c6n757h7k8e8n8o8s9d9r9va3a9akalavb4bfbtc3cbchcncqctcudbe2e3e7flfmfrg5gfgrh7hghohti5ihiqiriuj2j4j8j9jfjjjpjqk1k8k9kekokslelflllrm3m4m7momtnanvp3pcpfpqptpvq0r1sbsgskslt6tbtktrtuuauruuuv',
    } },
  },
  weapon_knife_karambit: {
    aa_fade: { set: 'Fade', fade: 0 },
    am_marble_fade: { set: 'Marble Fade', groups: {
      '1st-max': 'cs',
      '2nd-max': '0g4i7hb7c9gtiqk9lglt',
      '4th-max': '1g3u41acocojrascsmsr',
      '3rd-max': '4o8p94aojkl1n7o9oov2',
      '5th-max': '5m6c7se9gai2kckkldm1n0q0us',
      '8th-max': '055i5s6aahbqcmedgrloluqmu6ub',
      '6th-max': '3g76akb4dse4enivjdjnnpo5r9rcum',
      '10th-max': '0s4s5h7ecih1h2h9hfidifmlnsonpaqcqqr4ucuh',
      '9th-max': '243p4l555b6e8vbifdfjg4jtkfkgl0m2nuphsqtvv5',
      '7th-max': '080e101q3c6l797j8icle6j6kdlbmomso2orp3pqr3tl',
      'max-fake': '090r2q3e3t5n636b787ua9avbkcdckdpe0ebepf3gphhiejijok7m6mnnhnkohp5p9pir5sdt2tdu2ugukut',
      ffi: '1s1u27324k5a646o6u7a8a9g9j9l9ra1a8adbcbgcgcrctcvdmdteff5f9fgfqgnhqi6ihitjmknkrkul2ljmdmjnaoqpmqdqet3tktu',
      tricolor: '00010304070k0o0v1a1d1h1m222o30363a3h3k3n464a4e4f4n505254565e5o5p5t5u616p6q6s727b7m7q7t82868d8o8s8u92989f9m9na5aeafb1b2bhblbmc0c1c3c4cacpd3d9dgdkdre2e3egetevf0fcfifofrg3geghgigjgkgsh3h7h8hbhghphui3i4iiimiuj2j3j8jgjjk2k6l6l8lhlllrm5mbmcmqmtn8nenvo8ofpcpgpkqbqkqlr1rus3sbt1t7tbtntqu9v0v6v7',
    } },
    am_marked_up_fine: { set: 'Freehand', groups: {
      'max-black': '0q2e2m425m7a7l8uaib0b8bucrd9dke1efejekfvhbhvn3tott',
      'max-purple': '2l3a4j5r8g9ccacvd7d8dreagcgkgphaickfmdmsqprks5spum',
    } },
    am_zebra: { set: 'Slaughter', groups: {
      'heart/1': 'eilhsg',
      'diamond/1': '11397182adatb3pftkv5',
      'heart/2': '2l9mcacvd8gpkfl0m6okt5',
      'diamond/2': '142f2r3375858aa4e0hfi9omrlssstt2uq',
    } },
    an_tiger_orange: { set: 'Tiger Tooth', groups: {
      'straight-stripes/1': '020s1t416gced4dofhfjgphdibklkqlclelsm6mhnintokonq8qgr2r5rssbt5tdv4',
      'straight-stripes/2': '0g1j1k1q2l30323j505l5o667q9fasbocacve5epf2h0hahljkl9lqm3nqnvo0osp0q2r0smtbu3ui',
      'straight-stripes/3': '12373f3q3s404g4q5g6a6b7f7m878o8t97b4blc5d8edfffkgfgvi8ijjfjmjnk2k5kmkrljm0q5qvrtrvt8uuv0',
    } },
    aq_oiled: { set: 'Case Hardened', groups: {
      '1': 'c3',
      'rank-1': '04298dd1dqefemo8p9qlr4ros6s9',
      'rank-2': '122a2i424m4o7c80869fa1a2aqbncmcte5fefnfrftfugth6ipk3kllqmno2pbpnpssitr',
      'rank-3': '090b0k0p0u1p1r2s3g4a4b4q5j5m6o7m898h8q9i9ma3aaalbecgdadde2fafjg3gih9hvi4jnkfkokum7m9mhouq6q9qcqhqkqorrslu5ut',
      'rank-4': '162l2o3a3d3q404i62637k839raeafb2bjbmbtceclcnd4dee7eof5f7f8gagrhbhjhrijj7j8jtjujvk4kel4lmmonuoeosp3papepmsksnsst7tetvu1uaue',
      'gold-gem/1': '0ac4omtb',
      'gold-gem/2': '20262e4s6377aigvnjs0',
      'gold-gem/3': '1k25343c3o4h6b8b9ua8ajc7dndtfkgoh0h4hfkdlknfpfus',
    } },
    hy_webs: { set: 'Crimson Web', groups: {
      'double-web/1': '5bmi',
      'web/1': '0a0l1r1s2m2s3g4k525c5t7b7r819l9ma4aeafakbpbuc6c7crd1e5ecedg3gkhrifjllhlkoboiosp3pdqaqes8sftuu4uhun',
    } },
    sp_dapple: { set: 'Scorched', groups: {
      'black-gem/1': '8fo4rqts',
      'black-gem/2': '4j6n77i8jek8',
      'black-gem/3': '2d3o424v8vapctd0d7e8fcfuj4jrkjkrolphu1v7',
    } },
  },
  weapon_knife_kukri: {
    aa_fade: { set: 'Fade', fade: 1 },
  },
  weapon_knife_m9_bayonet: {
    aa_fade: { set: 'Fade', fade: 1 },
    am_marble_fade: { set: 'Marble Fade', groups: {
      'orange-tip': '0b0c0f0l0t0u111213191b1e20292c2g2k2n2p2s2t3437393b3d3o424348494d4g4h4j4m4r585c5d5k5l696d6j6v7071757c7n7p8084858c8m8q8r90979e9h9k9p9qa6aialapasb6bebnbpbsbtcbcccfchcjd4d6dadcdedjdodve1e7eaeeeheiekeqf1f2f6f8fefffkfnfpfsftfvg2g5g8g9gdgfgoh6hjhkhmhohrhshvi0i1i5i7ilinipj0j1jajejfjsjvk0k8kbkhkokpksl5lalelilvm0m8mammn6n9nbndnfninnnro0o3obodolomopoup0p7pdpoppprq2q6q8qgqhqor8rhrnrrrss1sesfsisjslstt8t9tctftgtsu1u5u8ufulup',
      'yellow-tip': '02060a0i0j0m0n0p0q141516181f1i1j1k1l1n1o1p1t1v212325262a2e2f2h2i2l2m2r2u2v3133383f3i3l3m3r3s40454b4c4q4t5153575f5g5j5r5v6067686f6i6k6m6n73747f7g7l7r7v81888b8e8f8g8h8k8l8t91939596999a9b9c9d9o9s9u9va2a3a4a7abagamanaqaraub5b9bbbdbfbobrbuc5c6c7c8cud0d2d5d8dbdddfdhdldndqdue5ecemerf7fbflg0g1g6gcggglgqgvh4h5hahchlhnhti8iaibicigikisj4j5j7j9jbjcjhjljpjrk1k3k4k5kekiklkmkql4lflnlplqlsm3m9memfmimkmpmumvn1n2n4n5ngnjnlnmnonqnto1o6o7oaoeoiotovp1p2p4p6p8pbpepfpjplpnpsptpupvq1q3q4q5q9qaqfqiqjqsqvr0r2r6rbrdrerfrgrirkrlrmrorprvs2s4s5s6s7s8s9sasgsksospsst4t5t6tatethtitjtmtptrttu0u3u4u7uaueuiujuouuuvv1v3v4',
      'blue-tip': '00010304050708090d0e0k0o0r0s0v10171a1c1d1h1m1q1r1s1u222427282b2d2j2o2q3032363a3c3e3h3j3k3n3p3t44464a4e4f4k4l4n4p4s50525455565a5b5e5h5i5n5o5p5s5t5u616263646a6b6e6h6l6o6p6q6s6t6u727778797a7b7d7e7j7k7m7o7q7t7u828386898a8d8n8o8s8u8v92989f9g9i9j9l9m9n9r9ta1a5a8a9adaeafahatavb0b1b2b3b8bcbgbhbibjbkblbmbqbvc0c1c2c3c4cacdcecgcickclcmcocpcqcrctcvd3d7d9dgdidkdmdpdrdte0e2e3e6ebedefegelepetevf0f3f4f5f9fafcfdfgfifjfmfofqfrfug3g4gbgeghgigjgkgngpgrgsh0h1h2h3h7h8h9hbhehfhghhhphqhui3i4i6idieifihiiijimioiritiuj2j3j6j8jgjijjjmjojqjtjuk2k6k7kakfkgkjknkrkul0l2l3l6l8lblclhljlllmlolrlum2m5m6m7mbmcmdmgmhmjmlmnmomqmrmsmtn3n8nanenhnknsnunvo2o4o8ofogohonoqorp3p5p9papcpgphpipkpmpqq7qbqcqdqeqkqlqmqnqpqqqrqtr1r3r4r5r7rjrqrtrus0s3sbsdshsnsqsusvt0t1t2t3t7tbtdtktltntqtutvu2u6u9ubucuduguhukunuqutv0v5v6v7v8',
    } },
    am_marked_up_90: { set: 'Freehand', groups: {
      'max-black': '1g25586l6r7c8d8m9ra5cofpg1ghh9hljak6kvmpqgqhsotdui',
      'max-purple': '404c5p666h7h878j8va9b5cudse7ebh6hji8j2lnm7osrisrtv',
    } },
    am_zebra: { set: 'Slaughter', groups: {
      'diamond/1': '3a485fa5akchcnelhnkmopqqqtt6',
      'heart/1': '1t3l516s8k8v9sa2b9bbc4cud5ehgogsivjdjtkbkkmmnuosp1pnq3rfsesf',
      'diamond/2': '1ibsc3dfgvnjo4o5qcr4rqt7uv',
      'heart/2': '284f5e6q819b9lbjc0cldhg2g5hchoidieioj8ktl8looopqqaqdqosiupusut',
    } },
    an_tiger_orange: { set: 'Tiger Tooth', groups: {
      'straight-stripes/1': '0l112d323v4o506n719cadd7dof3fijekgmnnbnvonpfppq8qarbrdsit1t4tntpul',
      'straight-stripes/2': '0n2f2m393t5c5d6972778287a7a9d9dadlevfvh6h7hgi8iaj8mkn9oqosp3qoqvrisbsmsst3tdub',
      'straight-stripes/3': '0s17181s284c4d595i6l73859faoatb7c7cuebeufhfmg9gbguhdjokoktlgltnqqbqgqlrks7tetmu2u5upv5v8',
    } },
    aq_oiled: { set: 'Case Hardened', groups: {
      '1': 'ip',
      'rank-1': '1q3b4m7f7tatb2cjcmd1e1fng5gbh6i9jql3s1ti',
      'rank-2': '0l2r3l56576a708d8p90agaqb3bedej5jkmboppdr3rg',
      'rank-3': '04191r2o3c3s4d4t5d6c6i73757j7p8u95979a9vapb4bkc9esfagdghglh2h9imj2neomplq5qrr2rnscsesjt5tv',
      'rank-4': '021v2031373h484a4s525g5h5j6h7m7r949kavb1bhchctdteperfgfqfrg4g6gcgehchkhtjbjokbl2l9lqm2mvnnnsobofoqp8pbq3r5r7s6s8sktdtru3u8ut',
      'gold-gem/1': 'enn3',
      'gold-gem/2': '5l779cl1ojv2',
      'gold-gem/3': '284p8a9gb7cbdjdmg9iljsl5o0o4pepfq7qgu5',
    } },
    hy_webs: { set: 'Crimson Web', groups: {
      'triple-web/1': '0d28454h4p99d7dpebelmenkqp',
      'double-web/1': '00010g4i5d5k7h8caobtc9d4f8hviqj3lpm0oaqqt9ucv2',
      'web/1': '081l4a4m575s70808pa5b3bqcccle5f9g6gggjisj6k2kilfm5mcmdmjn9njo5p0p8pqq0r8t3totptrtu',
    } },
    sp_dapple: { set: 'Scorched', groups: {
      'black-gem/1': '5u8neaq0',
      'black-gem/2': 'kjn8rr',
      'black-gem/3': '0v35494n547j8e96a5bkc3d3ioj2k6kul1n4nko9rau2ul',
    } },
  },
  weapon_knife_outdoor: {
    aa_fade: { set: 'Fade', fade: 1 },
    am_marble_fade: { set: 'Marble Fade', groups: {
      'orange-tip': '0b0t12191e2g2k2n2t393b48494d4j4m5l696d707c808m9k9pa6alapasbnbscbcccfchcjd6dce1e7ehekf2f6feg5g8g9gfh6hrhvi0i1i7ilinipj0jsjvk8kbkhkokslilvm8mammn6n9nbnfninrodolopp0p7poppprq2q6q8qgqhqor8rss1sesfsislstt8tftgtsu1u8uful',
      'yellow-tip': '02060a0c0i0j0l0m0n0p0q0u111516181b1f1i1j1k1l1n1o1p1t1v2021232526292a2c2e2f2i2l2m2p2r2u2v3137383d3f3i3l3m3s4042454b4c4h4q4r4t515357585c5d5f5g5j5r5v60686f6i6j6k6m6n6v7374757g7l7p7r7v81848b8e8f8g8h8k8l8q8r8t9193959697999a9b9c9d9e9o9q9ua2a3a4a7agamanaqaraub5b6b9bbbdbfbobpbrbtbuc5c6c8cud0d5d8dbdddedfdhdjdldndodqdudve5eaeceeeiemerf1f7f8fbfsfvg0g1g2g6gcgdggglgogqgvh4h5hahchkhlhmhnhohshti8iaibicigikisj4j5j7j9jbjcjhjljpjrk0k1k4k5kekiklkmkpkql4l5lelflnlplqlsm3m9memfmimkmpmumvn1n2n4n5ndngnlnmnnnonqnto1o6o7oaoeoiomotouovp1p2p4p6p8pbpdpepfpjplpnpsptpupvq3q4q5q9qaqfqiqjqsqvr0r2r6rbrdrerfrgrhrkrlrmrnrorprrrvs2s4s5s6s7s8s9sgsjsksospsst4t5tatctetitjtmtptrttu0u3u4u7uaueuiujuouuuvv1v3v4',
      'blue-tip': '00010304050708090d0e0f0h0k0o0r0s0v1013171a1c1d1h1m1q1r1s1u222427282b2d2j2o2q2s303235363a3c3e3g3h3j3k3n3o3p3q3t3v434446474a4e4f4g4k4l4n4p4s4u4v5052545556595a5b5e5h5i5k5m5n5o5p5q5s5t5u6162636465666a6b6c6e6g6h6l6o6p6q6r6s6t6u7172767778797a7b7d7e7i7j7k7m7n7o7q7s7t7u8283858687898a8c8d8i8j8n8o8s8u8v9092989f9g9i9j9l9m9n9r9ta0a1a5a8a9aaadaeafahaiajakatavb0b1b2b3b4b8babcbgbhbibjbkblbmbqbvc0c1c2c3c4cacdcecgcickclcmcncocpcqcrctcvd1d3d4d7d9dadgdidkdmdpdrdsdte0e2e3e4e6e8e9ebedefegejeleneoepeqeseteuevf0f3f4f5f9fafcfdfffgfhfifjfkfmfnfofpfqfrftfug3g4g7gagbgeghgigjgkgmgngpgrgsguh0h1h2h3h7h8h9hbhdhehfhghhhihphqhui2i3i4i6i9idieifihiiijimioiritiuivj1j2j3j6j8jdjejfjgjijjjmjnjojqjtjuk2k6k7kakckdkfkgkjkkknkrktkukvl0l2l3l6l7l8l9lalblcldlhljlklllmlolrlum0m1m2m4m5m6m7mbmcmdmgmhmjmlmnmomqmrmsmtn0n3n8nancnenhnknpnsnunvo2o4o5o8obofogohokonoqorosp3p5p9papcpgphpipkpmpqq0q7qbqcqdqeqkqlqmqnqpqqqrqtqur1r3r4r5r7r9rcrjrqrtrus0s3sbsdshsnsqsrsusvt0t1t2t3t7tbtdtktltntotqtutvu2u5u6u9ubucuduguhukumunupuqurusutv0v5v6v7v8',
    } },
    am_zebra: { set: 'Slaughter', groups: {
      'mirror-diamond/1': 'j3jajrp8uj',
      'diamond/1': '4v7b9mcgeilhmupbsguf',
      'heart/1': '0d0f0o114a4latb3gjgrhfjql5n5p6pftk',
      'diamond/2': '1m469racf8i4kfkvl0pgpmtj',
      'mirror-diamond/2': '1b458i999d9iaacoevj4n9olud',
      'heart/2': '181d2q38393p555b70717va1adamc1f0g7ippaq0ubv5',
    } },
    an_tiger_orange: { set: 'Tiger Tooth', groups: {
      'straight-stripes/1': '2d3k3p4e4f4t696o6t789c9pard2gcgejbjnjolvm1m9mamjncnroopjsntgtlumv3',
      'straight-stripes/2': '0m0u122v373q4m5q7n898a98ahb2bedhe9f1gahli1i5iajejik0kmlgm8o2oaphpkppqprms5shu0',
      'straight-stripes/3': '0d191n1q1s2j2u3g7t838la0a3anavbpbqccesffg1gvh1jhk2khl3l6ltmdmpn4nbo6oiojovq5qfqur4spt9tq',
    } },
    aq_oiled: { set: 'Case Hardened', groups: {
      'gold-gem/1': '1787h5q2',
      'blue-gem/1': '1n595r9scje8i1jkksl9m0qisq',
      'gold-gem/2': '0o4i51biegmimluc',
      'blue-gem/2': '0d0e37565k6i868p96agbvdddqdvfggdghhei7i9icjgjojqlqlsmjotr8rgtr',
      'gold-gem/3': '39hahomento1sgsi',
      'blue-gem/3': '0a1q2k2r3s3u414g4n52585a5j5t6a6k6l737b7f858u909a9maeapavbbbhbkc3c9dce1e2fffmg4g7gegkglgvhchghriuivjbjfjrjsk0k1k8k9kbkpl8lhlumfn4nep6pcpipsrfrmrns6sesjskt7tatctqudum',
    } },
    hy_webs: { set: 'Crimson Web', groups: {
      'double-web/1': '5i6h8uj5pv',
      'web/1': '0g0r0t0u1c1r323m40464f4v5168696j6m737d8h8i8k8qahamb1bpbrc5ckcmctdfdodre3e6enfbfefjfngqi3iaisj3jbjlk2k8kfljmdn5nbnjo8pgpppsq0smsqt9tqu3ulv1v2',
    } },
  },
  weapon_knife_push: {
    aa_fade: { set: 'Fade', fade: 1 },
  },
  weapon_knife_skeleton: {
    aa_fade: { set: 'Fade', fade: 1 },
    am_marble_fade: { set: 'Marble Fade', groups: {
      'orange-tip': '020a0i0n161i1l1p1t1v21232e2f2v313f3i3l3m4b4c4t53575f5g5j5r747g7r7v8f8g8h8l9193969a9b9c9d9o9ua3amanb5bobrbuc5c6cud5dbdfdldne5emerfbg0g6ggh5hahchti8icigikisj9jpk1k5kekiklkql4lnlpmpmumvn1n2n4nlnonto1o6otp1p2p4p6p8plpnpsptq3q9qjr0r2rkrlrmrvs5s6s7s8sgsksospsst5tetitjtru7ueuiuouuuvv3v4',
      'red-tip': '060b0c0l0m0t0u1112151b1e1f20292c2g2k2p2u3738393b3d4248494d4h4j4m4q4r51585c5d5l5v696i6j6k6v7073757c7p80848k8m8q8r8t95979e9k9p9qa4agapb6b9bnbpbsbtc8cbcccfchd0d6d8dcdddedhdjdodqdudve1e7eaeeeheif1f2f6f7f8fefsfvg1g2g5gdgogqh6hkhmhohrhsi0i1iaibilinj0j4jvk0k8khkokpl5lelflilqlvm8mfmmn9nbndnfngninmnnnqodoeolomopoup0pbpdpfpoppprq2q6q8qgqhqoqsqvr8rbrerhrnrrs2sisjslstt8tctftgtptsu0u8ufujulv1',
      'yellow-tip': '0d0f0h0j0p0q131417181c1j1k1n1o2526282a2b2d2h2i2j2l2m2r2s3334353j3o3q3r3s3v40434445474g4p4u4v595k5q6062656667686f6g6m6n6r6t71777d7f7i7k7l7n7o81838587888b8c8e8j8n90999h9i9s9t9va0a2a7aaabaiajaqarataub0b3b8babbbdbebfbjbvc2c7cecncocqd1d2d4dadie8ecejeleoeqeseuf4fafffhfkflfmfnfpftfug7gbgcglgmgugvh0h4hdhehihjhlhni5i9ijioirj1j5j7jajbjcjejfjhjljqjrjuk3k4kakjkmktkvl3l7l9lalclklmlsm0m3m4m7m9memgmhmimkmrn3n5ncnjo0o3o4o7oaobogoiokosovpepjpupvq1q4q5qaqfqiqnqrqur6r7rdrfrgrirjrorprqs0s4s9sashsusvt0t4t6t9tathtmtottu3u4u5uaudunupuqur',
      'blue-tip': '000103040508090e0g0k0o0r0s0v101a1d1g1h1m1q1s1u2224272o2q3032363a3c3e3g3h3k3p3t3u414a4e4f4i4k4l4n4o4s505254555a5b5e5h5i5m5n5o5p5s5t6163646a6b6c6e6l6o6p6q6s6u727678797a7b7e7h7j7m7q7s7t7u82868a8d8i8o8p8s8v94989f9g9j9l9m9n9ra1a5a8a9acadaeafahakaoavb1b2b4b7bcbgbhbibkblbqc0c1c3c4c9cacdcgcickclcmcrcsctcvd9dkdmdpdsdte0e2e3e4e6e9ebedefegenepetevf0f3f5f9fcfdfgfjfofqfrg3g4gaghgigjgkgngpgrgsgth1h2h3h7h8h9hbhfhghhhphqhui2i3i4i6idieifihiiimiqitiuivj2j3j6j8jdjgjijjjkjmjnjojtk2k6k7k9kckdkfkgkkknkrkul0l1l2l6l8lbldlglhljlllolrltlum1m2m5m6mcmdmjmlmnmomqmsmtn0n7n8nanhnknpnsnunvo2o5o8o9ocofohojonoooqorp3p5p9papcphpipkpmpqq0qbqcqdqeqlqmqqr1r3r4r5r9rarcrus3sbscsdsmsqsrt1t2t3tbtdtktltutvu2u6ubucuguhukumusutv0v2v5v6v7v8',
    } },
    am_zebra: { set: 'Slaughter', groups: {
      'heart/1': '0f393n4a4l717va1adambrf0g7gjheiljqjvn5o9pav5',
      'diamond/1': '1c4v687b9m9rcge6eieni4l0lhlvmun0pbpepmsgtju7uf',
      'diamond/2': '5t8089anf8ghj4jhkvl4pgua',
      'heart/2': '0a11212f303m6j82grh8jlm3nmodp6pipoq0q7qbqvrjt2t4u4ubv7',
    } },
    an_tiger_orange: { set: 'Tiger Tooth', groups: {
      'straight-stripes/1': '1h4c545k5q7d7e9gakb4bgbvc3djeceqg6gngohkifj9kkl3lpm9n8o5p4r6rvs9t6',
      'straight-stripes/2': '3s484h6t7r8o8pa5a7a9aqaubiblcne7f3gmhni1inknkplamdnanqnrnup1pcphpnqesitlu0u8v3',
      'straight-stripes/3': '0j0r13142a373q495f5v6f6kabb6c0c8csd0dve2ehekeoergri5ihkgmjmnoeq4qpr1r9rcsmtgtotqtvumunur',
    } },
    aq_oiled: { set: 'Case Hardened', groups: {
      'gold-gem/1': '6dg9sitf',
      'blue-gem/1': '1q599scje8i1l9',
      'gold-gem/2': '175f79gfgunaqosm',
      'blue-gem/2': '1n5k6i868papavdve1hci7ksm0qirgsq',
      'gold-gem/3': '4v61halamln8q2sg',
      'blue-gem/3': '0a232k2o2r373b3s4t56575a5j5r6a6b6k7f90969a9baeagbkbmbvc9dddedqfgfmfnfog4g7gdghglgpi9icioipiuivjbjgjkjojqk0kbkkktl3l8lhlllqlsmfn4p6pcpiplq5r3r8rns6sesfsjsktdtitqtr',
    } },
    hy_webs: { set: 'Crimson Web', groups: {
      'double-web/1': '6ftd',
      'web/1': '020c0j0s0t0v1b1c292k353o42494n4r4t4v5h5v68696j737s8r9b9e9ma7aibuckctd1e3eiejf5fjfqg3g8gqgthainj6j7jpl2lhljlmm2nbnto3o5o9p4ppqfrbshsot0t1tgtru3ulumv4',
    } },
    sp_dapple: { set: 'Scorched', groups: {
      'black-gem/1': '0sdufhub',
      'black-gem/2': '0g5ie8f7m0nfoeont8',
      'black-gem/3': '080b0q3s5g7c8h9499bme3fbfcg1h2nao4',
    } },
  },
  weapon_knife_stiletto: {
    aa_fade: { set: 'Fade', fade: 1 },
    am_marble_fade: { set: 'Marble Fade', groups: {
      'blue-tip': '12192n2t394j6d80a6alasbscje1ekfeg5g8g9gfh6hrhvi0i1i7ipjsk8kbkoksman6nbnrp7ppq2qgrss1sesfstt8tftgu1uful',
      'red-tip': '0508090e0g0r0s101g1q1s1u24272q323c3e3g3p3t3u414a4i4k4l4o4s555a5b5h5i5m5n5s63646a6b6c6e6l6o6u7678797a7e7h7j7s7u8a8i8p8v949g9j9l9ra1a8a9acadaeafahakaoavb4b7bcbgbibkbqc9cdcgcickclcmcrcsctcvdmdpdsdte0e4e6e9ebedefenepf3f5f9fdfgfjfqg3g4gagngpgrgth1h2h9hfhhhphqi2i6idieifihiqitiuivj6jdjgjijkjmjnjojtk7k9kckdkfkgkkknkrkul0l1l2lbldlgljloltlum1m2m6mdmjmlmnmomsn0n7nanhnknpnsnuo2o5o9ocohojonoooqorp3p5p9papcphpipmpqq0qcqdqeqmqqr3r4r5r9rarcs3scsdsmsqsrt2t3tdtktltutvu2u6ubucuguhukumusutv2v5v8',
    } },
    am_zebra: { set: 'Slaughter', groups: {
      'diamond/1': '6ab4j7',
      'heart/1': '1c4v687b9m9rancge2e6jhlhmupbpmsgtju7uf',
      'diamond/2': '0h406c8jaqkeor',
      'heart/2': '2l6g7t97ascacecvenfjgpiujjl0lcm6n0pcper2rks0u0ua',
    } },
    an_tiger_orange: { set: 'Tiger Tooth', groups: {
      'straight-stripes/1': '1l1v3o4u53575n6e8d8e8n8r9uaedmfcfffrh0k2kjknkoljllndneo8ouq6s8slth',
      'straight-stripes/2': '070q1h1u292e2t3g5m5s5u8u9tagb9btc6d3dgdpdqf5fbg4h4h9i0itk6k7prpvrhrrs4s9t9tru2',
      'straight-stripes/3': '09122g2o2v424b4k4s5g5j606h7a7c7k929h9jafaib6bnbuc2cid1effeh2igimkakhlilmlumvp4pushsuutv1',
    } },
    aq_oiled: { set: 'Case Hardened', groups: {
      'gold-gem/1': '0f148ck9',
      'blue-gem/1': '5m6m8raabjcecnfendq6sht0u5',
      'gold-gem/2': '3j5q6rejiojsmjog',
      'blue-gem/2': '2a2s3ga2e5kom9our4rrsl',
      'gold-gem/3': '262b3678f4hsinmr',
      'blue-gem/3': '121a294j4n626a6o80899ia1acalbabnc3d4daefemeqfug3gagthbhvjnkflmm4m7mdmhmnnvo2oep0p3p8p9pbqcqkqordrlrosisstethue',
    } },
    hy_webs: { set: 'Crimson Web', groups: {
      'web/1': '050d0q171l202c2d2q3237383f4d4j757m8h8p9pa9acatb1b3bbcsd2dqekf5fgfmgnh7hpjkjnjvkekiklkoksl2l3lom9o4oaodogp2p6poq4qqs4sbsnu1',
    } },
    sp_dapple: { set: 'Scorched', groups: {
      'black-gem/1': '8sdue3onuk',
      'black-gem/2': '0q3g457k979afcgvt1ttv0',
      'black-gem/3': '0h0s1c2f515t8a99bme9g1guhtknt8',
    } },
  },
  weapon_knife_survival_bowie: {
    aa_fade: { set: 'Fade', fade: 1 },
    am_marble_fade: { set: 'Marble Fade', groups: {
      'orange-tip': '0508090e0g0r0s101g1q242q3c3e3g3p3t3u414i4l4o4s555b5h5i5m5n5s636a6b6c6e6l7678797e7h7j7s7u8i8p8v94a9acahakaoavb4b7bibkbqc9cdcickclcmcsdpdse4e6e9ebedenepf3fdfjg4gagpgrgth1h2h9hfhhi2idieifiqivj6jdjijkjnjojtk7k9kckdkfkgkkl0l1lbldlgloltlum1m2m6mlmnmomsn0n7nhnknpnsnuo2o5o9ocohojonooorp3p5p9paphpipqq0qcqmqqr3r4r5r9rarcscsdsmsqsrt2tdtltvu2u6ubucuguhukumusutv2v5v8',
      'red-tip': '00010304070d0k0o0v171a1c1d1h1m1r1s1u2227282b2d2j2o3032363a3h3k3n464a4e4f4k4n4p505254565a5e5o5p5t5u6162646h6o6p6q6s6u72777a7b7d7m7o7q7t828386898a8d8n8o8s8u92989f9g9j9l9m9n9ra1a5a8adaeafatb0b1b2b3b8bcbgbhbjblbmbvc0c1c3c4cacgcocpcqcrctcvd3d7d9dgdidkdmdrdte0e2e3efegeletevf0f5f9fafcfgfifofqfrfug3geghgigjgkgngsh3h7h8hbhghphqhui3i4i6ihiiijimioiritiuj2j3j8jgjjjmjuk2k6kakjknkrkul2l6l8lclhljlllmlrm5m7mbmcmdmgmjmqmtn8nanenvo4o8ofoqpcpgpkpmq7qbqdqeqkqlqpqrqtr1rjrtrus0s3sbshsnsut0t1t3t7tbtktntqtuu9udv0v6v7',
      'blue-tip': '02060a0b0c0f0h0i0j0l0m0n0p0q0t0u11121314151618191b1e1f1i1j1k1l1n1o1p1t1v2021232526292a2c2e2f2g2h2i2k2l2m2n2p2r2s2t2u2v313334353738393b3d3f3i3l3m3o3q3r3s3v404243454748494b4c4d4g4h4j4m4q4r4t4u51535758595c5d5f5g5j5k5l5r5v6065666768696d6f6g6i6j6k6m6n6v70717374757c7f7g7i7l7n7p7r7v8081848587888b8c8e8f8g8h8j8k8l8m8q8r8t909193959697999a9b9c9d9e9h9k9o9p9q9s9u9va0a2a3a4a6a7aaabagaiajalamanapaqarasaub5b6b9babbbdbebfbnbobpbrbsbtbuc5c6c7c8cbcccfchcjcncud0d1d2d4d5d6d8dadbdcdddedfdhdjdldndodqdudve1e5e7e8eaeceeeheiejekemeqerf1f2f6f7f8fbfefffkflfnfpfsftfvg0g1g2g5g6g8g9gcgdgfggglgogqgugvh4h5h6hahchdhihjhkhlhmhnhohrhshthvi0i1i5i7i8i9iaibicigikilinipisj0j1j4j5j7j9jajbjcjejfjhjljpjrjsjvk0k1k3k4k5k8kbkekhkiklkmkokpkqksktkvl4l5l9lalelflilklnlplqlslvm0m3m4m8m9mamemfmimkmmmpmumvn1n2n4n5n6n9nbncndnfngninjnlnmnnnonqnrnto0o1o3o6o7oaobodoeoiokolomoposotouovp0p1p2p4p6p7p8pbpdpepfpjplpnpoppprpsptpupvq1q2q3q4q5q6q8q9qaqfqgqhqiqjqoqsqvr0r2r6r8rbrdrerfrgrhrirkrlrmrnrorprrrsrvs1s2s4s5s6s7s8s9sasesfsgsisjskslsospssstt4t5t6t8t9tatctetftgthtitjtmtptrtsttu0u1u3u4u5u7u8uaueufuiujuluoupuruuuvv1v3v4',
    } },
    am_zebra: { set: 'Slaughter', groups: {
      'diamond/1': '0c0e1319202o2u343h3u54585h65666f9vaoaubdbvc7c9duecfdfsgqhji5j2jcjgk1k4kul2nknlnnptpur8sqt8u2ur',
      'heart/1': '0g1c1g252c2d4v505t686t7b7t979m9ra7ancge2e5e6eienepg9iuj1j4jhjjjol0lhlvm9mamjmun0ojp5pbpcpepmq8qfs0sbsgsmtdtju0u3u7uaufui',
      'diamond/2': '2r33bge3eqgniqp7q4',
      'heart/2': '06171b1k1m3245464t525o7i7q8b8i999c9d9fa6a8b2b7blcfcoe4esf8fhfmfpgphahdi4iajajekfkikvl1m6msn6okonp8phrkrsrus2s6t5tgtludugujv2',
    } },
  },
  weapon_knife_tactical: {
    aa_fade: { set: 'Fade', fade: 1 },
    am_marble_fade: { set: 'Marble Fade', groups: {
      'red-tip': '0508090e0g0r0s101g1q1s1u24272q3c3e3g3p3t3u414i4l4o4s555a5b5h5i5m5n5s63646a6b6c6e6l6o6u7678797a7e7h7j7s7u8a8i8p8v949j9l9ra1a8a9acadahakaoavb4bcbgbibkbqcdcgcickclcmdpdsdte0e4e6e9ebedefenepf3f5fdfgfjfqg4gagngpgrgth1h2h9hfhhi2i6idieifitivj6jdjijkjnjojtk7kckdkfkgkkknl0l1l2lbldlgljloltlum1m2m6mdmlmnmomsn0n7nanhnknpnsnuo2o5o9ocohojonoooqorp3p5p9paphpipqq0qcqmqqr3r4r5r9rarcscsdsmsqsrt2t3tdtktltutvu2u6ubucuguhukumusutv2v5v8',
      'blue-tip': '02060a0b0c0f0h0i0j0l0m0n0p0q0t0u11121314151618191b1e1f1i1j1k1l1n1o1p1t1v2021232526292a2c2e2f2g2h2i2k2l2m2n2p2r2s2t2u2v313334353738393b3d3f3i3l3m3o3q3r3s404243454748494b4c4d4g4h4j4m4q4r4t4u515357585c5d5f5g5j5k5l5r5v606768696d6f6i6j6k6m6n6v70717374757c7f7g7l7n7p7r7v80818485888b8c8e8f8g8h8j8k8l8m8q8r8t909193959697999a9b9c9d9e9h9k9o9p9q9s9u9va0a2a3a4a6a7abagaialamanapaqarasaub5b6b9babbbdbebfbnbobpbrbsbtbuc5c6c7c8cbcccfchcjcncud0d1d2d4d5d6d8dadbdcdddedfdhdjdldndodqdudve1e5e7e8eaeceeeheiejekemeqerf1f2f6f7f8fbfefffkflfnfpfsftfvg0g1g2g5g6g8g9gcgdgfggglgogqgvh4h5h6hahchjhkhlhmhnhohrhshthvi0i1i5i7i8iaibicigikilinipisj0j1j4j5j7j9jajbjcjejfjhjljpjrjsjvk0k1k3k4k5k8kbkekhkiklkmkokpkqkskvl4l5l9lalelflilklnlplqlslvm0m3m8m9mamemfmimkmmmpmumvn1n2n4n5n6n9nbncndnfngninjnlnmnnnonqnrnto0o1o3o6o7oaobodoeoiolomopotouovp0p1p2p4p6p7p8pbpdpepfpjplpnpoppprpsptpupvq1q2q3q4q5q6q8q9qaqfqgqhqiqjqoqsqvr0r2r6r8rbrdrerfrgrhrirkrlrmrnrorprrrsrvs1s2s4s5s6s7s8s9sasesfsgsisjskslsospssstt4t5t6t8t9tatctetftgthtitjtmtptrtsttu0u1u3u4u5u7u8uaueufuiujuluoupuruuuvv1v3v4',
    } },
    am_zebra: { set: 'Slaughter', groups: {
      'diamond/1': '0v1q222n2v383n44477j7v9ea0brckf4fkg7heiljmjvlmm2ngnmo9q5qiqnrgs3sht0',
      'heart/1': '1i484j565f7p8388avbqbsc3c5chd7dfdre9elgtgvhnjnk0k5kmn2ncnjnrogopqcqmqpqqqtrqumuv',
      'diamond/2': '0a1r3d3m62erftjkkrn1p0r0',
      'heart/2': '04080k0l0n0p0t0u121s1u262b2j2t313a3o4m4n5i5p5r5s5v7273777k80898f8g8l8q96989pa3a5ahakalb6bpbtcndbdldndseafaffg1g3gcgdgeghguh0h5h9hii7ijjfk2khksl4l6ldljm1mdmpmtn3npo4o5oaocovp3pdpkq1qjrcrerns5s7t6t9v1v8',
    } },
    an_tiger_orange: { set: 'Tiger Tooth', groups: {
      'straight-stripes/1': '050m1a202u323f4e596f6l727u91bgboc9dle5fdgfgui2jbjgk1k4l2mdnvqptmur',
      'straight-stripes/2': '3b3v5d5i73778a8f8t979c9kb0bmddg1g9gnhljejokul7nlnpnroionp7p9pqq4rvs7tdtfu3ukum',
      'straight-stripes/3': '0414181d2d4q5052545b5h5o5v7k7m7n7t9pa6abarcldse8hfi7iajikclemompmrn3n4nnnqojr9rks5sbteug',
    } },
    aq_oiled: { set: 'Case Hardened', groups: {
      '1': 'ja',
      'blue-gem/1': '0tjakc',
      'gold-gem/1': '192kkats',
      'gold-gem/2': '0233hsl8nn',
      'blue-gem/2': '3g427o8r9iaabjf8fefpfuhvi0jululvmho2ouq6rhrrsl',
      'blue-gem/3': '2829324j4p5f5m62647v87aecue9eaegfjjljnk3kokvlmm3m4m7n5ndoep0p9puqcqmr4rusbsnsv',
    } },
  },
  weapon_knife_ursus: {
    aa_fade: { set: 'Fade', fade: 1 },
    am_marble_fade: { set: 'Marble Fade', groups: {
      'red-tip': '05080e0g0r0s101g1q1s24272q3c3e3g3p3t3u414i4l4o4s555b5h5i5m5n5s63646a6b6c6e6l6o7678797e7h7j7s7u8a8i8p8v949j9l9ra1a8a9acadahakaoavb4b7bcbibkbqc9cdcgcickclcmcsdpdse0e4e6e9ebedenepf3f5fdfgfjfqg4gagngpgrgth1h2h9hfhhi2i6idieifiqivj6jdjijkjnjojtk7k9kckdkfkgkkl0l1l2lbldlgljloltlum1m2m6mlmnmomsn0n7nhnknpnsnuo2o5o9ocohojonoooqorp3p5p9paphpipqq0qcqmqqr3r4r5r9rarcscsdsmsqsrt2tdtktltvu2u6ubucuguhukumusutv2v5v8',
      'blue-tip': '02060a0b0c0f0i0j0l0m0n0p0q0t0u11121314151618191b1e1f1i1j1k1l1n1o1p1t1v2021232526292a2c2e2f2g2h2i2k2l2m2n2p2r2s2t2u2v3133343738393b3d3f3i3l3m3o3r3s4042434548494b4c4d4g4h4j4m4q4r4t515357585c5d5f5g5j5l5r5v606768696d6f6i6j6k6m6n6v70717374757c7f7g7l7n7p7r7v80818485888b8c8e8f8g8h8k8l8m8q8r8t909193959697999a9b9c9d9e9h9k9o9p9q9s9u9va2a3a4a6a7abagalamanapaqarasaub5b6b9bbbdbebfbnbobpbrbsbtbuc5c6c7c8cbcccfchcjcud0d2d5d6d8dadbdcdddedfdhdjdldndodqdudve1e5e7eaeceeeheiekemerf1f2f6f7f8fbfefffkflfnfpfsfvg0g1g2g5g6g8g9gcgdgfggglgogqgvh4h5h6hahchjhkhlhmhnhohrhshthvi0i1i5i7i8iaibicigikilinipisj0j1j4j5j7j9jajbjcjejfjhjljpjrjsjvk0k1k3k4k5k8kbkekhkiklkmkokpkqksl4l5lalelflilnlplqlslvm0m3m8m9mamemfmimkmmmpmumvn1n2n4n5n6n9nbndnfngninjnlnmnnnonqnrnto0o1o3o6o7oaobodoeoiolomopotouovp0p1p2p4p6p7p8pbpdpepfpjplpnpoppprpsptpupvq1q2q3q4q5q6q8q9qaqfqgqhqiqjqoqsqvr0r2r6r8rbrdrerfrgrhrirkrlrmrnrorprrrsrvs1s2s4s5s6s7s8s9sasesfsgsisjskslsospssstt4t5t6t8t9tatctetftgthtitjtmtptrtsttu0u1u3u4u5u7u8uaueufuiujuluoupuuuvv1v3v4',
    } },
    am_zebra: { set: 'Slaughter', groups: {
      'diamond/1': '0a2n383m44a1amckf0h8o9paq0',
      'heart/1': '0812264g5683888lc5ffgdh0ijjfjnk0k2k5ljn2o4ogq1qcr4rerquvv1',
      'diamond/2': '212f3n4a82g7gjheiljqnmq7qnrjt0v7',
      'heart/2': '0l0n0t313a5p5r5s777p89989havbqbsbtchd7dbdcdedrdse9gvh5hihnkmldmdncopp3pkqmqqqtrns4so',
    } },
    an_tiger_orange: { set: 'Tiger Tooth', groups: {
      'straight-stripes/1': '0s17324e4o50596d6l819ca7b7e5iajel1lemkmnnenvq8qaqorkrus7sbsismt4v2',
      'straight-stripes/2': '1319262f2h2s3f3p4p7u9la9ataub3dafmgbh1hcjoktmonpnqoionpgpqqgqvr9sntdtku3upv3v5',
      'straight-stripes/3': '0m0r141a282d2g33393v4k5h5l777l8fadb4bkdse1edgqh7i2i5iqkgknl7minlnno4oqqbqjrtt3tatmtptvui',
    } },
  },
  weapon_knife_widowmaker: {
    aa_fade: { set: 'Fade', fade: 0 },
    am_marble_fade_widow: { set: 'Marble Fade', groups: {
      'fire-and-ice/1': '192n2ta6alascjekg8g9gfhvipjskbnrs1sesfu1',
      'fake-fire-and-ice/1': '060c0u11292c2p2u373d4r585v6i6k84979ebpd8dddedoeaf1f8fsg1gdgohkhoial5lemfndnqomournsju0',
      'fire-and-ice/2': '12393b4j696d80bscfd6dce1feg5h6hri0i1i7k8koksman6n9nbp0p7poppq2qgrsstt8tftguful',
      'tricolor/2': '1p1v2e3f3i3m53577g8h939a9b9oa3ambud5dfe5g0h5i8icigikisjpkekqlpn1nop1p2p4p6r0rkrls5s6sksospsstetiuv',
      'fake-fire-and-ice/2': '0i0m0n151f2f383l4q4t515g5j5r738k8l8t9195a4agb9boc5c8d0dhdqduf7gggqibj4k5kilflqn4ngnlnmo1o6oep8pbpfplq3qjqsqvr2rbrermrvs2t5tptrueujuouuv1v3',
      'tricolor/3': '021l1t21232v4b4c747r8f8g969d9uanb5cudbdlemerfbg6hahchtj9kll4lnmumvn2pspts7s8sgtju7uiv4',
      'fire-and-ice/3': '0b0l0t1b1e202g2k4248494d4h4m5c5d5l6j6v70757c7p8m8q8r9k9p9qapb6bnbtcbccchdjdve7eeeheif2f6fvg2hmhsilinj0jvk0khkplilvm8mmnfninnodoloppdprq6q8qhqor8rhrrsisltctsu8',
      'red-tip': '0g4i94b7c9csgtiqk9lgltn7',
      'orange-tip': '000103040508090e0k0o0r0s0v101a1d1g1h1m1q1s1u2224272o2q3032363a3c3e3g3h3k3p3t3u414a4e4f4k4l4n4o4s505254555a5b5e5h5i5m5n5o5p5s5t6163646a6b6c6e6l6o6p6q6s6u727678797a7b7e7h7j7m7q7s7t7u82868a8d8i8o8p8s8u8v989f9g9j9l9m9n9ra1a5a8a9acadaeafahakaoavb1b2b4bcbgbhbibkblbqc0c1c3c4cacdcgcickclcmcrctcvd3d9dkdmdpdrdsdte0e2e3e4e6e9ebedefegenepetevf0f3f5f9fcfdfgfifjfofqfrg3g4gaghgigjgkgngpgrgsh1h2h3h7h8h9hbhfhghhhphqhui2i3i4i6idieifihiiimitiuivj2j3j6j8jdjgjijjjkjmjnjojtk2k6k7kckdkfkgkkknkrkul0l1l2l6l8lbldlhljlllolrlum1m2m5m6mcmdmjmlmnmomqmsmtn0n8nanenhnknpnsnunvo2o5o8o9ocofohojonoooqorp3p5p9papcphpipkpmpqq0qbqcqdqeqkqlqmqqr1r3r4r5r9rarcrus3sbscsdsmsqsrt1t2t3t7tbtdtktltutvu2u6ubucuguhukumusutv0v2v5v6v7v8',
      'yellow-tip': '02070a0d0f0h0i0j0n0p0q13141617181c1i1j1k1l1n1o1p1r1t1v21232526282a2b2d2e2f2h2i2j2l2m2r2s2v31333435383f3i3j3l3m3n3o3q3r3s3v4043444546474b4c4g4p4t4u4v535657595f5g5j5k5q5r5u6062656667686f6g6h6m6n6r6t7174777d7f7g7i7k7l7n7o7r7v8183858788898b8c8e8f8g8h8j8l8n9091929396999a9b9c9d9h9i9o9s9t9u9va0a2a3a7aaabaiajamanaqarataub0b3b5b8babbbdbebfbjbmbobrbubvc2c5c6c7cecncocpcqcud1d2d4d5d7dadbdfdgdidldne5e8ecejelemeoeqereseuf4fafbfffhfkflfmfnfpftfug0g6g7gbgcgeggglgmgugvh0h4h5hahchdhehihjhlhnhti5i8i9icigijikioirisj1j5j7j9jajbjcjejfjhjljpjqjrjuk1k3k4k5kakekikjklkmkqktkvl3l4l7l9lalclklmlnlplsm0m3m4m7m9mbmemgmhmimkmpmrmumvn1n2n3n4n5ncnjnlnmnonto0o1o3o4o6o7oaobogoiokosotovp1p2p4p6p8pepgpjplpnpsptpupvq1q3q4q5q7q9qaqfqiqjqnqpqrqtqur0r2r6r7rdrfrgrirjrkrlrmrorprqrtrvs0s4s5s6s7s8s9sasgshsksnsospsssusvt0t4t5t6t9tatethtitjtmtntotqtrttu3u4u5u7u9uaudueuiunuoupuquruuuvv1v3v4',
    } },
    am_zebra: { set: 'Slaughter', groups: {
      'heart/1': '64659nd3mvo2pvt8',
      'heart/2': '1p2o3e3g407goer1u2',
    } },
    an_tiger_orange: { set: 'Tiger Tooth', groups: {
      'straight-stripes/1': '05171i1j252d484b4d505u5v6s7k8h8qa7b7bke8g1g9jejsl1lgm0mpnjnqnrnsp1q8qlruuiuk',
      'straight-stripes/2': '0s0v1g1l1v212n323r444i4n4q5362636l6r7g7j8d8e9ua0a5a6akbbbnchcmcncudfe5elepfmgihniaioisivjbjok6kplpmtn6nknuo0o3o5o7oeonq2qir7rgs9scsfsmu3',
      'straight-stripes/3': '040a0g1h1p1t292o2p2v3d3g3m474h4u5f5l6465666b6q6v7c7m7q8v9c9n9o9vb9boc0ccckd5dgdpf4f6fkfqgagfhdhohujdjmjpk9kikokrlmlumvndngnmo2oposp0p5prpupvq5qgqnqsr0r1rcsbsesht0t6tdtfunv2v6v8',
    } },
    aq_oiled: { set: 'Case Hardened', groups: {
      'gold-gem/1': '4i4onlq2',
      'blue-gem/1': '030a1n5p6u7h9nggiqp5pjq5s3sr',
      'gold-gem/2': '072l7qbll4pqqfqp',
      'blue-gem/2': '0e1o2g3i5a5g5k5q678r959b9savb5bdbrekepflfpfqhqi0j1jdkhm3pfr2r9u0ug',
      'gold-gem/3': '3p4u6892clo9ohq1',
      'blue-gem/3': '0i0j1e1q262b2c2d2v343f3j3k42494a585s6b7v93949g9pa8amaparbfbmbvc7ckcrdff1f8fbfofrglh3h8i7iminivjajfjpkikkktllmqndnpocoup7pkpuq3q6rdrjrqrrslt5tdts',
    } },
    hy_webs: { set: 'Crimson Web', groups: {
      'web/1': '020t1s223t4v5o71979fbac5c6dkenfaimljn0o0pdpsq4r4r6rvs2s8scsrtgv1v4',
    } },
    sp_dapple: { set: 'Scorched', groups: {
      'black-gem/1': '0u286la3rv',
      'black-gem/2': '1b4rbpcuf3jnm9meobqn',
      'black-gem/3': '0h2135398mamenlimpokqor0stu9uv',
    } },
  },
  weapon_m4a1_silencer: {
    aa_fade_m4a1s: { set: 'Fade', fade: 2 },
  },
  weapon_ump45: {
    aa_fade_ump: { set: 'Fade', fade: 1 },
  },
};

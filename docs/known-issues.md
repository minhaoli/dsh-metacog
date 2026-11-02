# 宸茬煡闂

宸茬‘璁ゃ€佷絾**鏈夋剰鏆備笉淇**鐨勭己闄枫€傛瘡鏉￠兘瑕佽兘瀹氫綅鍒颁唬鐮併€佽娓呯幇鐘躲€佽鏄庝负浠€涔堝厛涓嶅姩銆佷互鍙婁慨鐨勬椂鍊欏摢浜涙柇瑷€浼氱炕銆?
## K1 `core_bypass` 鎶娿€屾病鏈夊€欓€夌洰鏍囥€嶈鎴愩€屽洖閬裤€?
**浣嶇疆**锛歚src/analysis/drift.ts`锛宍detectCoreBypass()` 鍐呰绠?`avoiding` 鐨?filter锛堢害 L218鈥揕231锛夈€?
**鐜扮姸**锛?
```ts
const avoiding = activities.filter((activity) => {
  if (!inWindow(activity.timestamp, now, window)) return false
  if (activity.decision === 'aligned' || activity.decision === 'exploratory') return false
  if (activity.decision === 'scope_drift') return true
  return !activity.candidateGoalIds.some((id) => goalIds.has(id))
})
```

鏈€鍚庝竴琛屾槸銆?*娌℃湁**姝ｅ悜鎸囧悜灏辩畻鍥為伩銆嶃€傝€岀揣閭荤殑娉ㄩ噴鍐欑殑鏄浉鍙嶇殑鎰忔€濓細

> `uncertain` records are kept unless they positively point at a goal the contradiction binds, because an unjudged activity cannot be said to avoid anything.

鎸夋敞閲婏紝`uncertain` 鍙湪**鎸囧悜**琚粦瀹氱洰鏍囨椂鎵嶅簲琚帓闄わ紱鎸変唬鐮侊紝鍑?*涓嶆寚鍚?*鐨勯兘琚畻浣滃洖閬裤€?
**鍚庢灉**锛氫竴鏉?`decision: 'uncertain'`銆乣candidateGoalIds: []` 鐨勬椿鍔ㄤ細琚鍏?`avoiding`锛涙敀澶?`thresholds.repeatThreshold`锛堥粯璁?3锛夊嵆浜у嚭 `core_bypass` 淇″彿锛屽彲鍗囪嚦 Level 2 骞查鍗°€傘€屾病鍒ゅ嚭鏉ャ€嶈褰撴垚銆屽湪鍥為伩銆嶃€?
**涓轰粈涔堟殏涓嶄慨**锛氫慨姝ｅ畠绛変簬鏀瑰彉鍗囩骇璇箟锛堝摢浜涙椿鍔ㄦ瀯鎴愬洖閬匡級锛岄渶鍗曠嫭璇勫銆傛敼鏋氫妇涓虹浜斿€?`unbound` 鏃跺彂鐜版闂锛岀‘璁ゅ畠鏃╀簬 `unbound` 瀛樺湪锛屼笉鏄偅娆℃敼鍔ㄥ紩鍏ョ殑銆?
**宸插仛鐨勯殧绂?*锛歚src/analysis/service.ts` 鍦ㄨ皟鐢?`detectCoreBypass` 鍓嶈繃婊ゆ帀 `decision === 'unbound'` 鐨勬椿鍔ㄢ€斺€斻€屾棤娉曞綊灞炪€嶄笉鏄€屽洖閬裤€嶇殑璇佹嵁銆傝闅旂**鍙鐩?`unbound`**锛屼笉瑕嗙洊 `uncertain`銆?
**娴嬭瘯鍥哄畾**锛歚test/path-alignment.test.mjs` 鐨?`[known defect]` 娈佃惤鏂█褰撳墠琛屼负銆備慨濂?K1 鏃惰鏂█搴斿綋缈昏浆鈥斺€旈偅鏄埢鎰忕殑琛屼负鍙樻洿锛屼笉鏄洖褰掋€?
**淇硶鍙傝€?*锛氳鏈鍙妸姝ｅ悜鎸囧悜锛堟垨 `scope_drift`锛夊綋浣滃洖閬胯瘉鎹紝渚嬪鍦ㄥ厹搴曞墠鏄惧紡澶勭悊 `uncertain`锛涘悓姝ユ洿鏂颁笂杩版柇瑷€锛屽苟澶嶆牳 `docs/architecture.md` 涓?core_bypass 鐨勫垽鎹弿杩般€?
//
//  CJKScript.swift
//  LTXVideoDirector
//
//  Traditional vs Simplified Chinese script classifier, native Swift, no ML
//  model. Whisper's `detected_lang` only ever returns generic "zh" — it
//  cannot tell zh-TW from zh-CN — and there was no discriminator anywhere in
//  this repo (Python or Swift) before this file. Han unification means most
//  CJK characters share one Unicode codepoint across both scripts, so a
//  codepoint-RANGE test can't separate them; this uses a curated table of the
//  ~150 highest-frequency characters that actually differ between the two
//  scripts (simplified codepoint != traditional codepoint) and scores which
//  side the input leans toward.
//

import Foundation

public enum ScriptVariant: String, Codable {
    case traditional
    case simplified
    case ambiguous  // no distinguishing characters found (or a tie)
}

public struct ScriptClassification: Codable {
    public let variant: ScriptVariant
    public let simplifiedHits: Int
    public let traditionalHits: Int
}

public enum CJKScript {
    /// Simplified -> Traditional for the highest-frequency characters whose
    /// simplified and traditional forms are DIFFERENT codepoints (characters
    /// unified across both scripts, e.g. 人/你/我/是, are intentionally
    /// omitted — they carry no discriminating signal).
    private static let simplifiedToTraditional: [Character: Character] = [
        "国": "國", "学": "學", "华": "華", "语": "語", "电": "電", "车": "車",
        "门": "門", "关": "關", "长": "長", "图": "圖", "书": "書", "说": "說",
        "会": "會", "义": "義", "农": "農", "从": "從", "众": "眾", "儿": "兒",
        "认": "認", "计": "計", "让": "讓", "时": "時", "后": "後", "经": "經",
        "现": "現", "发": "發", "变": "變", "应": "應", "还": "還", "这": "這",
        "来": "來", "动": "動", "数": "數", "头": "頭", "实": "實", "业": "業",
        "与": "與", "万": "萬", "个": "個", "为": "為", "无": "無", "网": "網",
        "觉": "覺", "见": "見", "议": "議", "讨": "討", "论": "論", "识": "識",
        "词": "詞", "谈": "談", "记": "記", "许": "許", "设": "設", "访": "訪",
        "证": "證", "传": "傳", "声": "聲", "处": "處", "备": "備", "复": "複",
        "团": "團", "归": "歸", "击": "擊", "势": "勢", "单": "單", "卫": "衛",
        "卖": "賣", "买": "買", "属": "屬", "层": "層", "岁": "歲", "币": "幣",
        "师": "師", "帮": "幫", "广": "廣", "库": "庫", "开": "開", "张": "張",
        "强": "強", "读": "讀", "写": "寫", "线": "線", "组": "組", "织": "織",
        "统": "統", "总": "總", "样": "樣", "标": "標", "构": "構", "术": "術",
        "机": "機", "队": "隊", "员": "員", "务": "務", "问": "問",
        "间": "間", "阳": "陽", "阴": "陰", "陆": "陸", "际": "際", "边": "邊",
        "达": "達", "过": "過", "运": "運", "远": "遠", "连": "連", "进": "進",
        "选": "選", "适": "適", "尽": "盡", "监": "監",
        "盘": "盤", "画": "畫", "医": "醫", "药": "藥", "疗": "療",
        "养": "養", "亲": "親", "邻": "鄰", "闻": "聞", "闭": "閉", "阅": "閱",
        "阔": "闊", "党": "黨", "职": "職",
        "价": "價", "货": "貨", "购": "購",
        "贸": "貿", "贵": "貴", "费": "費", "资": "資", "财": "財", "账": "賬",
        "赛": "賽", "赢": "贏", "输": "輸", "较": "較", "轻": "輕",
        "转": "轉", "轮": "輪", "软": "軟",
        "钱": "錢", "银": "銀", "铁": "鐵", "钢": "鋼", "针": "針", "锁": "鎖",
        "错": "錯", "锋": "鋒", "镇": "鎮", "录": "錄", "飞": "飛",
        "风": "風", "飘": "飄", "马": "馬", "骑": "騎", "验": "驗", "驱": "驅",
        "鸟": "鳥", "鸡": "雞", "鱼": "魚", "鲜": "鮮", "鲁": "魯", "龙": "龍",
        "齐": "齊", "岛": "島", "灵": "靈", "顶": "頂", "项": "項", "须": "須",
        "顺": "順", "预": "預", "领": "領", "颜": "顏", "题": "題", "额": "額",
        "颗": "顆", "颁": "頒", "颂": "頌", "颈": "頸", "频": "頻", "颖": "穎",
        "显": "顯", "县": "縣", "参": "參", "丛": "叢",
        "汉": "漢", "汇": "匯", "涨": "漲", "满": "滿", "浊": "濁", "泽": "澤",
        "湾": "灣", "灭": "滅", "灯": "燈",
    ]

    private static let traditionalCounterparts: Set<Character> = Set(simplifiedToTraditional.values)

    /// Classify a piece of CJK text as Traditional or Simplified Chinese by
    /// scoring hits against the discriminating-character table above.
    /// Non-discriminating characters (unified across both scripts, or
    /// non-CJK) are simply skipped.
    public static func classify(_ text: String) -> ScriptClassification {
        var simplifiedHits = 0
        var traditionalHits = 0
        for ch in text {
            if simplifiedToTraditional[ch] != nil {
                simplifiedHits += 1
            } else if traditionalCounterparts.contains(ch) {
                traditionalHits += 1
            }
        }
        let variant: ScriptVariant
        if simplifiedHits == 0 && traditionalHits == 0 {
            variant = .ambiguous
        } else if simplifiedHits > traditionalHits {
            variant = .simplified
        } else if traditionalHits > simplifiedHits {
            variant = .traditional
        } else {
            variant = .ambiguous
        }
        return ScriptClassification(variant: variant, simplifiedHits: simplifiedHits, traditionalHits: traditionalHits)
    }
}

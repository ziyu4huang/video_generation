---
title: DocAgent: Components and Methodology
doc: [[2025.emnlp-main.893]]
page: 3
kind: paper
section: Method
---

![[page-003.png]]

（前頁延伸內容）
...並將其分配給 worker agents 進行處理。然而，這種 fragmentation 可能導致難以維持 long-distance dependency，進而影響整體的 comprehension 與 consistency。此外，為了克服 text length constraint，研究引入了 retrieval augmented generation (Xu et al., 2023)。例如，PDFnaTriad (Saad-Falcon et al., 2024) 使用 text 來從文件中檢索資訊。然而，其方法受限於 language model 的處理能力，以及處理 images 與 charts 的能力。Wang et al. (2023) 提出遞迴地 summarize textual contexts 以克服 text constraints。儘管已有進展，如何提升 LLM 在 multi-modal long context 下的 efficiency 仍是一個尚未被充分探索的領域。

### 3 Method
我們提出的 DocAgent 由四個 components 組成：
1. **Outline construction module**：生成結構化且簡潔的文件佈局，作為 agent 的導航指南。
2. **Agent**：利用 online tool 介面檢索相關內容並生成答案。
3. **Retriever**：驗證並檢索初始答案以確保 response 的可靠性。
4. **Memory module**：透過 reflection 儲存 task-agnostic knowledge，以促進跨任務的 knowledge transfer。
整體模型的架構如 Fig. 1 所示。

#### 3.1 Outline Construction from Document
為了協助 LLM agent 有效地導航文件並定位證據以進行問答，我們從文件中構建一個 outline。
具體來說，我們首先使用 Adobe PDF Extract (Adobe, 2023) 解析並提取內容。我們注意到有一些 open-source alternatives 可用於文件內容提取，例如 DocXuan (Yan, 2023) 與 PyMuPDF (Artifex, 2024)。
接著，我們構建一個 hierarchical XML tree 來表示文件的結構。這涉及系統化地將文件組織成一個 nested tree format，以提供清晰且結構化的表示。具體而言，每個 section 作為 parent node，其相關的 headers, subsections, paragraphs, images 與 tables 被排列為 child nodes，形成一個 well-defined hierarchy。
為了促進精確的導航，每個 section 都包含關於起始與結束頁碼的 attributes，讓 agent 能有效定位相關內容。為了優化 context length，段落的 context remains hidden，僅提供該段落 element 的首句作為 attribute，以提供 agent 必要的 context string。同樣地，圖片的視覺內容也會被省略，僅包含其 caption 作為 image element 的 attribute。此外，每個 section, image 與 table 都被分配一個 unique identifier，使 agent 在必要時能檢索完整的內容。

#### 3.2 Actor Agent
Actor $M_a$ 使用 LLM 作為其 reasoning engine。在每個 timestep $n$，agent 會接收狀態觀測 $o_n$ 以及來自 prompt 的問題 $Q, I_A$ 等資訊。基於這些輸入，actor 會從 policy $\rho_a$ 中採樣一個 action $a_n$，該動作可能涉及工具呼叫以從文件中檢索額外證據，或直接給出答案以終止迴圈。其形式化定義如下：
$$a_n \sim \rho_a(a_n | s_n, Q, I_A, \dots) \quad (1)$$
為了促進 multi-modal content 的高效查詢與檢索，我們設計了一個文件介面，包含兩個工具來讓 agent 有效地與文件互動（工具描述見 Table 1）。當這些工具被執行時，其輸出會持續被整合進 agent 的 observation state $s_n$ 中，進而深化其對文件的理解。

#### 3.3 Reviewer Agent
鑑於文件內容常跨越多個模態且具有重疊內容（例如：相同的資訊同時出現在圖片與文字中）[Hassan et al., 2023]，我們引入了 reviewer $M_R$ 來驗證 actor 的初始回應。Reviewer 會交叉引用來自不同來源或模態的額外證據，以確保所提供答案的正確性與完整性。具體而言，在每個 timestep $n$，reviewer 會處理三個輸入：問題 $Q$、reviewer 的指令 $I_R$，以及 actor 的軌跡 $T_A$（包含最初提出的答案）。基於這些輸入，reviewer 會採樣一個動作 $a_n$ —— 例如呼喚額外的工具...

---
title: DocAgent: An Agentic Framework for Multi-Modal Long-Context Document Understanding
doc: [[2025.emnlp-main.893]]
page: 1
kind: paper
section: Abstract / Introduction
---

![[page-001.png]]

# DocAgent: An Agentic Framework for Multi-Modal Long-Context Document Understanding

**Authors:** Li Sun¹, Liu He², Shuyue Jia¹, Yangfan He³, Chenyu You⁴
**Affiliations:** ¹Boston University, ²Purdue University, ³University of Minnesota, ⁴Stony Brook University

### Abstract
Recent advances in large language models (LLMs) have demonstrated significant promise in document understanding and question-answering. Despite the progress, existing approaches can only process documents for limited context length or fail to fully leverage multi-modal information. In this work, we introduce DocAgent, a multi-agent framework for long-context document understanding that mitigates the human reading practice. Specifically, we first construct a structured, text-formatted outline that enables relevant sections to help agents identify density information. Further, we develop an interactive re-reading interface that enables agents to query and retrieve various types of content dynamically.

### 1 Introduction
理解多模態文件對於多種現實世界的應用（如法律報告、學術論文、技術報告等）至關重要。

目前面臨的主要挑戰包括：
- **多模態資訊整合**：文件包含多種模態，如文字、表格與圖像 (Ma et al., 2024)。
- **上下文長度限制**：現有的方法受限於有限的上下文長度，或無法充分利用多模態資訊。
- **文件複雜度**：文件包含複雜的結構（如表格），且內容長度可能達數百頁。

儘管已有研究嘗試透過 OCR 提取文字 (Xiao et al., 2020; Huang et al., 2022; Peng et al., 2022; Kim et al., 2022; Lee et al., 2023) 來處理文件，但如何有效整合這些資訊仍是目前的主要挑戰。
